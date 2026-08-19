import type { CompanionPage } from '../types.js';
import { noteRoomSocketClosed, noteRoomSocketOpened } from '../connection-state.js';

export function initPlantDragMove(): void {
    'use strict';

    const pageWindow = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage & typeof globalThis;
    const HOLD_MS = 1000;
    const HOLD_MOVE_TOLERANCE_PX = 12;
    const POT_TIMEOUT_MS = 10_000;
    const PLACE_TIMEOUT_MS = 12_000;
    const TILE_SIZE = 256;
    const NATIVE_INPUT_GRACE_MS = 1500;
    /** How long the global capture hooks may stay installed waiting for a system that never comes. */
    const HOOK_RELEASE_TIMEOUT_MS = 60_000;
    const WRAPPED_FLAG = '__plantDragMoverWrapped';

    const live = {
        tapToMove: null,
        tileSystem: null,
        petSystem: null,
        worldTapRouter: null,
        inventoryItems: [],
        inventoryReady: false,
        ownUserSlotIdx: null,
        currentGlobalTile: null,
        currentGardenTile: null,
        isInMyGarden: false,
        hudSuppressed: false,
        nativeActionHolding: false,
        blockDragUntil: 0,
        activeSocket: null,
        fallbackHighlight: null,
    };

    let press = null;
    let toastTimer = 0;
    let lastLoggedPlanterPotCount = null;
    let openedRoomSocketCount = 0;
    let moveBusy = false;

    function isEnabled() {
        return pageWindow.__gardenCompanionFeature?.('dragMove') !== false;
    }

    function log(message, detail?) {
        if (detail === undefined) console.log(`[PlantDrag] ${message}`);
        else console.log(`[PlantDrag] ${message}`, detail);
    }

    // The game recreates both systems after an in-page reconnect. Keep the
    // defineProperty observer installed and briefly re-arm its two field traps
    // whenever a replacement socket opens.
    const objectCtor = pageWindow.Object;
    const objectProto = objectCtor.prototype;
    const originalDefineProperty = objectCtor.defineProperty;
    let originalMapSet: typeof Map.prototype.set | undefined;
    let hookReleaseTimer = 0;
    const armedSystemFields = new Set();

    function resetPrivateSystems(reason) {
        live.fallbackHighlight?.destroy?.();
        live.tapToMove = null;
        live.tileSystem = null;
        live.petSystem = null;
        live.worldTapRouter = null;
        live.fallbackHighlight = null;
        live.ownUserSlotIdx = null;
        live.currentGardenTile = null;
        live.isInMyGarden = false;
        live.hudSuppressed = false;
        live.nativeActionHolding = false;
        armPrivateSystemCapture();
        log(`${reason}; waiting for the rebuilt farm systems.`);
    }

    function watchTileSystemTeardown(system) {
        const originalDestroy = system?.destroy;
        if (typeof originalDestroy !== 'function' || originalDestroy[WRAPPED_FLAG]) return;

        function watchedDestroy(this: unknown, ...args) {
            if (live.tileSystem === system || live.tileSystem === null) {
                resetPrivateSystems('Quinoa engine teardown detected');
            }
            return originalDestroy.apply(this, args);
        }
        watchedDestroy[WRAPPED_FLAG] = true;
        system.destroy = watchedDestroy;
    }

    function disarmPrivateField(key) {
        armedSystemFields.delete(key);
        try {
            delete objectProto[key];
        } catch {}
    }

    function captureNamedSystem(system) {
        if (system?.name === 'tapToMove') {
            if (live.tapToMove === system) return;
            live.tapToMove = system;
            disarmPrivateField('lastHoverGridX');
            log('Native tap-to-move highlight connected.');
        } else if (system?.name === 'tileObject' && system.tileViews instanceof pageWindow.Map) {
            if (live.tileSystem === system) return;
            live.tileSystem = system;
            live.ownUserSlotIdx = null;
            watchTileSystemTeardown(system);
            disarmPrivateField('tileViews');
            log('Native farm tile map connected.');
        } else if (system?.name === 'pet' && system.views instanceof pageWindow.Map) {
            live.petSystem = system;
            log('Native active-pet system connected.');
        } else if (system?.name === 'worldTapRouter' && Array.isArray(system.registeredClaimants)) {
            if (live.worldTapRouter === system) return;
            live.worldTapRouter = system;
            disarmPrivateField('registeredClaimants');
            log('Native canvas UI hit testing connected.');
        } else return;
        releaseGlobalHooksIfIdle();
    }

    function capturePrivateSystem(target, key, value) {
        if (key === 'lastHoverGridX' && target?.name === 'tapToMove') {
            captureNamedSystem(target);
        } else if (key === 'tileViews' && target?.name === 'tileObject' && value instanceof pageWindow.Map) {
            captureNamedSystem(target);
        } else if (key === 'registeredClaimants' && target?.name === 'worldTapRouter' && Array.isArray(value)) {
            captureNamedSystem(target);
        }
    }

    /**
     * Object.defineProperty and Map.prototype.set are patched to catch the engine's private farm
     * systems as they are built. Both are extremely hot: a bundler defines a property per module
     * export, and the game fills Maps constantly, so every call in the whole page pays for our
     * wrapper for as long as it is installed. Accessors on Object.prototype are worse again - they
     * sit on the prototype chain of every object in the page.
     *
     * So the hooks are treated as a net cast during startup and hauled back in the moment the last
     * system is caught, and re-cast only when a reconnect rebuilds them.
     */
    function installDefinePropertyCapture() {
        if ((objectCtor.defineProperty as any)?.[WRAPPED_FLAG]) return;
        function watchedDefineProperty(this: unknown, target, key, descriptor) {
            const result = originalDefineProperty.call(this, target, key, descriptor);
            if (armedSystemFields.has(key)) capturePrivateSystem(target, key, descriptor?.value);
            return result;
        }
        watchedDefineProperty[WRAPPED_FLAG] = true;
        (objectCtor as any).defineProperty = watchedDefineProperty;
    }

    function restoreDefinePropertyCapture() {
        if ((objectCtor.defineProperty as any)?.[WRAPPED_FLAG]) objectCtor.defineProperty = originalDefineProperty;
    }

    function restoreSystemRegistryCapture() {
        const mapProto = pageWindow.Map?.prototype;
        if (mapProto && (mapProto.set as any)?.[WRAPPED_FLAG] && typeof originalMapSet === 'function') {
            mapProto.set = originalMapSet;
        }
    }

    /**
     * Every global hook exists only to catch something. Once there is nothing left to catch they
     * are pure overhead on the game's own hot paths, so they come straight back off.
     */
    function releaseGlobalHooksIfIdle() {
        if (armedSystemFields.size === 0) restoreDefinePropertyCapture();
        if (live.tapToMove && live.tileSystem && live.petSystem && live.worldTapRouter) {
            restoreSystemRegistryCapture();
            if (hookReleaseTimer) { clearTimeout(hookReleaseTimer); hookReleaseTimer = 0; }
        }
    }

    /**
     * A system that never arrives must not cost the page a permanently patched Object and Map. The
     * game is long since loaded by now, so anything still missing is not coming without a
     * reconnect - and a reconnect re-arms all of this from scratch.
     */
    function scheduleHookRelease() {
        if (hookReleaseTimer) clearTimeout(hookReleaseTimer);
        hookReleaseTimer = pageWindow.setTimeout(() => {
            hookReleaseTimer = 0;
            if (armedSystemFields.size) {
                for (const key of [...armedSystemFields]) disarmPrivateField(key);
                log('Gave up waiting for the remaining farm systems; global hooks removed.');
            }
            restoreDefinePropertyCapture();
            restoreSystemRegistryCapture();
        }, HOOK_RELEASE_TIMEOUT_MS);
    }

    function armPrivateSystemCapture() {
        installDefinePropertyCapture();
        installSystemRegistryCapture();
        scheduleHookRelease();
        for (const key of ['lastHoverGridX', 'tileViews', 'registeredClaimants']) {
            if (armedSystemFields.has(key)) continue;
            armedSystemFields.add(key);
            originalDefineProperty.call(objectCtor, objectProto, key, {
                configurable: true,
                get() { return undefined; },
                set(value) {
                    originalDefineProperty.call(objectCtor, this, key, {
                        configurable: true,
                        enumerable: true,
                        writable: true,
                        value,
                    });
                    capturePrivateSystem(this, key, value);
                },
            });
        }
    }

    armPrivateSystemCapture();
    // The layout planner reuses these captured farm systems instead of hooking them a second time.
    pageWindow.__gardenCompanionFarmSystems = live;

    function installSystemRegistryCapture() {
        const mapProto = pageWindow.Map?.prototype;
        const originalSet = mapProto?.set;
        if (typeof originalSet !== 'function' || originalSet[WRAPPED_FLAG]) return;
        originalMapSet = originalSet;

        function watchedMapSet(this: unknown, key, value) {
            const result = originalSet.call(this, key, value);
            const system = value?.system;
            if (system?.name === key) captureNamedSystem(system);
            return result;
        }

        watchedMapSet[WRAPPED_FLAG] = true;
        mapProto.set = watchedMapSet;
        log('Engine system registry capture installed.');
    }

    installSystemRegistryCapture();

    function captureGameSocket() {
        const OriginalWebSocket = pageWindow.WebSocket;
        if (!OriginalWebSocket || OriginalWebSocket[WRAPPED_FLAG]) return;

        function PlantDragWebSocket(...args: ConstructorParameters<typeof WebSocket>) {
            const socket = new OriginalWebSocket(...args);
            const isRoomSocket = String(args[0] ?? '').includes('/api/rooms/');
            if (!isRoomSocket) return socket;

            live.activeSocket = socket;
            socket.addEventListener('open', () => {
                openedRoomSocketCount++;
                // Published for everything that diffs game state, not just this feature.
                noteRoomSocketOpened();
                if (openedRoomSocketCount > 1) {
                    armPrivateSystemCapture();
                    log('Reconnect detected; private farm-system capture armed.');
                }
            });
            socket.addEventListener('close', noteRoomSocketClosed);
            return socket;
        }

        PlantDragWebSocket.prototype = OriginalWebSocket.prototype;
        objectCtor.setPrototypeOf(PlantDragWebSocket, OriginalWebSocket);
        PlantDragWebSocket[WRAPPED_FLAG] = true;
        pageWindow.WebSocket = PlantDragWebSocket as unknown as typeof WebSocket;
    }

    captureGameSocket();

    function ensureToast() {
        let toast = document.getElementById('mg-plant-drag-toast');
        if (toast) return toast;

        toast = document.createElement('div');
        toast.id = 'mg-plant-drag-toast';
        toast.style.cssText = [
            'position:fixed',
            'top:18px',
            'left:50%',
            'transform:translateX(-50%) translateY(-12px)',
            'z-index:2147483647',
            'max-width:min(420px,calc(100vw - 32px))',
            'padding:9px 13px',
            'border:1px solid rgba(255,255,255,.2)',
            'border-radius:6px',
            'background:rgba(12,18,24,.94)',
            'box-shadow:0 6px 24px rgba(0,0,0,.45)',
            'color:#f4f7f8',
            'font:600 12px/1.35 system-ui,sans-serif',
            'letter-spacing:0',
            'text-align:center',
            'opacity:0',
            'pointer-events:none',
            'transition:opacity .16s ease,transform .16s ease',
        ].join(';');
        document.documentElement.appendChild(toast);
        return toast;
    }

    function showToast(message, tone = 'normal', duration = 2200) {
        if (!document.documentElement) return;
        const toast = ensureToast();
        toast.textContent = message;
        toast.style.borderColor = tone === 'error'
            ? 'rgba(248,113,113,.65)'
            : tone === 'success'
                ? 'rgba(74,222,128,.55)'
                : 'rgba(255,255,255,.2)';
        toast.style.color = tone === 'error' ? '#fecaca' : tone === 'success' ? '#bbf7d0' : '#f4f7f8';
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(-50%) translateY(0)';
        clearTimeout(toastTimer);
        if (duration > 0) {
            toastTimer = window.setTimeout(() => {
                toast.style.opacity = '0';
                toast.style.transform = 'translateX(-50%) translateY(-12px)';
            }, duration);
        }
    }

    function atomMap() {
        const cache = pageWindow.jotaiAtomCache;
        if (cache instanceof Map) return cache;
        return cache?.cache ?? null;
    }

    function hookAtom(debugLabel, onValue) {
        const map = atomMap();
        if (!map || typeof map.values !== 'function') return false;

        for (const atom of map.values()) {
            if (atom?.debugLabel !== debugLabel || typeof atom.read !== 'function') continue;
            const flag = `${WRAPPED_FLAG}:${debugLabel}`;
            if (atom[flag]) return true;

            const originalRead = atom.read;
            atom.read = function(get, ...args) {
                const value = originalRead.call(this, get, ...args);
                try { onValue(value); } catch (error) { console.warn('[PlantDrag] Atom observer failed:', error); }
                return value;
            };
            atom[flag] = true;
            return true;
        }
        return false;
    }

    function refreshOwnUserSlot() {
        if (!live.isInMyGarden) return;
        const userSlotIdx = live.currentGardenTile?.userSlotIdx;
        if (userSlotIdx != null) live.ownUserSlotIdx = userSlotIdx;
    }

    function installAtomHooks() {
        const hooks = [
            ['myOptimisticInventoryItemsAtom', value => {
                if (Array.isArray(value)) {
                    live.inventoryItems = value;
                    live.inventoryReady = true;
                    const planterPotCount = value.reduce((total, item) =>
                        item?.itemType === 'Tool' && item?.toolId === 'PlanterPot'
                            ? total + (item.quantity ?? 1)
                            : total, 0);
                    if (planterPotCount !== lastLoggedPlanterPotCount) {
                        lastLoggedPlanterPotCount = planterPotCount;
                        log(`Planter Pots in inventory: ${planterPotCount}`);
                    }
                }
            }],
            ['myCurrentGlobalTileIndexAtom', value => {
                live.currentGlobalTile = value;
            }],
            ['myCurrentGardenTileAtom', value => {
                live.currentGardenTile = value;
            }],
            ['isInMyGardenAtom', value => {
                live.isInMyGarden = value === true;
                refreshOwnUserSlot();
            }],
            ['hudSuppressedByOverlayAtom', value => {
                live.hudSuppressed = value === true;
                if (live.hudSuppressed) {
                    live.blockDragUntil = Math.max(live.blockDragUntil, performance.now() + NATIVE_INPUT_GRACE_MS);
                }
            }],
            ['actionHoldVisualStateAtom', value => {
                live.nativeActionHolding = value?.kind === 'holding';
                if (live.nativeActionHolding) {
                    live.blockDragUntil = Math.max(live.blockDragUntil, performance.now() + NATIVE_INPUT_GRACE_MS);
                }
                if (!live.nativeActionHolding || !press) return;

                const nativePress = press;
                nativePress.cancelled = true;
                restoreSourcePlant(nativePress);
                moveBusy = false;
                if (nativePress.activated) {
                    showToast('Plant move cancelled for the game action.', 'normal', 2200);
                }
                clearPress(nativePress);
                log('Native hold action claimed the pointer; plant drag cancelled.');
            }],
        ];

        let installed = 0;
        for (const [label, handler] of hooks) {
            if (hookAtom(label, handler)) installed++;
        }
        return installed === hooks.length;
    }

    const atomHookInterval = setInterval(() => {
        if (installAtomHooks()) {
            clearInterval(atomHookInterval);
            log('Native inventory state connected.');
        }
    }, 250);

    function isGameCanvas(target) {
        // Our own panels draw on canvases too, and these listeners run in the capture phase, so a
        // companion window cannot stop them by other means. Anything inside our UI is not the game.
        return target?.tagName === 'CANVAS' && !target.closest?.('[data-gc-ui]');
    }

    function waitFor(condition, timeoutMs, intervalMs = 100) {
        const started = performance.now();
        return new Promise(resolve => {
            const poll = setInterval(() => {
                let value = null;
                try { value = condition(); } catch { value = null; }
                if (value || performance.now() - started >= timeoutMs) {
                    clearInterval(poll);
                    resolve(value || null);
                }
            }, intervalMs);
        });
    }

    function clientToGameGlobal(clientX, clientY, canvas) {
        const renderer = live.worldTapRouter?.renderer ?? live.tapToMove?.renderer;
        if (!renderer) return null;
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        return {
            x: (clientX - rect.left) * renderer.screen.width / rect.width,
            y: (clientY - rect.top) * renderer.screen.height / rect.height,
        };
    }

    function isPointerOverGameUi(event) {
        const router = live.worldTapRouter;
        const global = clientToGameGlobal(event.clientX, event.clientY, event.target);
        if (!router?.isWorldPointerSuppressed || !global) return false;
        try {
            return router.isWorldPointerSuppressed(global, event.pointerType) === true;
        } catch (error) {
            log('Native canvas UI hit test failed.', error);
            return false;
        }
    }

    function pointToFarmTile(clientX, clientY, canvas) {
        const tapToMove = live.tapToMove;
        const tileSystem = live.tileSystem;
        if (!tapToMove?.renderer || !tileSystem?.worldContainer || !tileSystem?.map) return null;

        const global = clientToGameGlobal(clientX, clientY, canvas);
        if (!global) return null;
        const world = tileSystem.worldContainer.toLocal(global);
        const x = Math.floor(world.x / TILE_SIZE);
        const y = Math.floor(world.y / TILE_SIZE);
        const map = tileSystem.map;
        if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) return null;

        const globalIndex = x + y * map.cols;
        const dirt = map.globalTileIdxToDirtTile?.[globalIndex];
        if (!dirt) return null;
        return {
            x,
            y,
            globalIndex,
            userSlotIdx: dirt.userSlotIdx,
            localTileIndex: dirt.dirtTileIdx,
            object: tileSystem.getTileDataAt({ x, y }) ?? null,
        };
    }

    function ensureFallbackHighlight() {
        if (live.fallbackHighlight) return live.fallbackHighlight;
        const nativeMarker = live.tapToMove?.hoverMarker;
        const worldContainer = live.tileSystem?.worldContainer;
        if (!nativeMarker?.constructor || !worldContainer) return null;

        try {
            const marker = new nativeMarker.constructor();
            marker.eventMode = 'none';
            marker.visible = false;
            marker.zIndex = 1_000_000;
            marker.roundRect(-128, -128, 256, 256, 16)
                .fill({ color: 0x22c55e, alpha: 0.28 })
                .stroke({ color: 0x052e16, width: 16, alpha: 0.55 });
            marker.roundRect(-128, -128, 256, 256, 16)
                .stroke({ color: 0x86efac, width: 8, alpha: 0.9 });
            worldContainer.addChild(marker);
            live.fallbackHighlight = marker;
            return marker;
        } catch (error) {
            log('Could not create fallback tile highlight.', error);
            return null;
        }
    }

    function updateFallbackHighlight(activePress, clientX, clientY) {
        if (live.tapToMove?.isTapToMoveEnabled !== false) return;
        const marker = ensureFallbackHighlight();
        if (!marker) return;

        const tile = pointToFarmTile(clientX, clientY, activePress.target);
        const isValid = tile
            && tile.userSlotIdx === live.ownUserSlotIdx
            && !tile.object;
        marker.visible = Boolean(isValid);
        if (isValid) marker.position.set(tile.x * TILE_SIZE + TILE_SIZE / 2, tile.y * TILE_SIZE + TILE_SIZE / 2);
    }

    function clearFallbackHighlight() {
        if (live.fallbackHighlight) live.fallbackHighlight.visible = false;
    }

    function fadeSourcePlant(activePress) {
        const tileView = live.tileSystem?.tileViews?.get(activePress.source.globalIndex);
        const displayObject = tileView?.displayObject;
        if (!displayObject) return;
        activePress.fadedDisplayObject = displayObject;
        activePress.sourceAlpha = displayObject.alpha;
        const startedAt = performance.now();
        const fromAlpha = displayObject.alpha;
        const toAlpha = Math.min(fromAlpha, 0.28);
        const animate = now => {
            if (activePress.fadedDisplayObject !== displayObject || displayObject.destroyed) return;
            const progress = Math.min(1, (now - startedAt) / 180);
            displayObject.alpha = fromAlpha + (toAlpha - fromAlpha) * progress;
            if (progress < 1) activePress.fadeFrame = pageWindow.requestAnimationFrame(animate);
        };
        activePress.fadeFrame = pageWindow.requestAnimationFrame(animate);
    }

    function restoreSourcePlant(activePress) {
        if (activePress.fadeFrame) pageWindow.cancelAnimationFrame(activePress.fadeFrame);
        const displayObject = activePress.fadedDisplayObject;
        if (displayObject && !displayObject.destroyed && activePress.sourceAlpha != null) {
            displayObject.alpha = activePress.sourceAlpha;
        }
        activePress.fadedDisplayObject = null;
        activePress.sourceAlpha = null;
        activePress.fadeFrame = 0;
    }

    function hasPlanterPot() {
        return live.inventoryItems.some(item =>
            item?.itemType === 'Tool'
            && item?.toolId === 'PlanterPot'
            && (item?.quantity ?? 1) > 0);
    }

    function inventoryIds() {
        return new Set(live.inventoryItems.map(item => item?.id).filter(Boolean));
    }

    function isSamePlant(candidate, source) {
        if (candidate?.species !== source?.species) return false;
        if (source?.plantedAt != null && candidate?.plantedAt !== source.plantedAt) return false;
        if (source?.maturedAt != null && candidate?.maturedAt !== source.maturedAt) return false;
        return true;
    }

    function findNewPlant(beforeIds, source) {
        return live.inventoryItems.find(item =>
            item?.itemType === 'Plant'
            && isSamePlant(item, source)
            && item?.id
            && !beforeIds.has(item.id));
    }

    function sendMessage(message) {
        const socket = live.activeSocket;
        if (!socket || socket.readyState !== pageWindow.WebSocket.OPEN) {
            throw new Error('Game WebSocket is not connected');
        }
        socket.send(JSON.stringify(message));
    }

    function sendPotPlant(slot) {
        const requestId = pageWindow.crypto.randomUUID();
        // No sequence here: it is stamped on the way out of the socket, from the same counter the
        // game's own commands are renumbered by.
        sendMessage({
            scopePath: ['Room', 'Quinoa'],
            type: 'QuinoaCommand',
            requestId,
            command: { type: 'PotPlant', slot },
        });
        log(`Sent PotPlant for farm slot ${slot}.`, { requestId });
    }

    function sendPlantGardenPlant(slot, itemId) {
        // The native v730 client still sends PlantGardenPlant through its legacy
        // fire-and-forget path; unlike PotPlant, it is not a QuinoaCommand RPC.
        sendMessage({
            scopePath: ['Room', 'Quinoa'],
            type: 'PlantGardenPlant',
            slot,
            itemId,
        });
        log(`Sent PlantGardenPlant for farm slot ${slot}.`, { itemId });
    }

    function prepareHeldPlant(activePress) {
        const source = pointToFarmTile(activePress.startX, activePress.startY, activePress.target);
        if (!source || source.object?.objectType !== 'plant') {
            throw new Error('That is not a Plant!');
        }
        if (live.ownUserSlotIdx == null) {
            throw new Error('Stand on a tile in your own garden first so ownership can be verified');
        }
        if (source.userSlotIdx !== live.ownUserSlotIdx) {
            throw new Error('That plant is not in your garden');
        }
        if (!hasPlanterPot()) throw new Error('No Planter Pot is available in your inventory');

        activePress.source = source;
        activePress.phase = 'dragging';
        fadeSourcePlant(activePress);
        showToast('Drag to a highlighted empty tile and release.', 'success', 0);
    }

    function getValidDestination(activePress) {
        const destination = pointToFarmTile(
            activePress.releaseX,
            activePress.releaseY,
            activePress.target,
        );
        if (!destination) throw new Error('Release over one of your farm tiles');
        if (destination.userSlotIdx !== live.ownUserSlotIdx) {
            throw new Error('That tile is not in your garden');
        }
        if (destination.object) throw new Error('The destination tile is occupied');
        return destination;
    }

    async function commitHeldMove(activePress) {
        const destination = getValidDestination(activePress);
        activePress.destination = destination;
        activePress.phase = 'potting';
        const species = activePress.source.object.species;
        const beforeIds = inventoryIds();
        showToast(`Picking up ${species ?? 'plant'}...`, 'normal', 0);
        sendPotPlant(activePress.source.localTileIndex);

        const plantItem = await waitFor(() => findNewPlant(beforeIds, activePress.source.object), POT_TIMEOUT_MS);
        restoreSourcePlant(activePress);
        if (!plantItem) throw new Error('The server did not return the potted plant');

        activePress.plantItem = plantItem;
        activePress.phase = 'ready';
        await placeHeldPlant(activePress, destination);
    }

    async function placeHeldPlant(activePress, destination) {
        if (activePress.phase === 'placing' || activePress.cancelled) return;
        try {
            const currentObject = live.tileSystem?.getTileDataAt({ x: destination.x, y: destination.y });
            if (currentObject) {
                activePress.cancelled = true;
                showToast('Move stopped: the destination became occupied. The plant remains in inventory.', 'error', 5000);
                return;
            }

            activePress.phase = 'placing';
            showToast('Placing plant...', 'normal', 0);
            sendPlantGardenPlant(destination.localTileIndex, activePress.plantItem.id);

            const placed = await waitFor(() => {
                const object = live.tileSystem?.getTileDataAt({ x: destination.x, y: destination.y });
                const itemStillHeld = live.inventoryItems.some(item => item?.id === activePress.plantItem.id);
                return !itemStillHeld && object?.objectType === 'plant'
                    && isSamePlant(object, activePress.source.object);
            }, PLACE_TIMEOUT_MS, 150);

            if (placed) {
                showToast('Plant moved.', 'success');
                log(`Moved ${activePress.source.object.species} from slot ${activePress.source.localTileIndex} to ${destination.localTileIndex}.`);
            } else {
                showToast('Placement was not confirmed. Check your inventory before retrying.', 'error', 5000);
            }
        } finally {
            moveBusy = false;
        }
    }

    function activatePress(activePress) {
        if (press !== activePress || activePress.cancelled || activePress.released) return;
        if (!isEnabled()) {
            activePress.cancelled = true;
            clearPress(activePress);
            return;
        }
        activePress.activated = true;
        document.documentElement.style.cursor = 'grabbing';

        if (!live.tapToMove || !live.tileSystem) {
            activePress.cancelled = true;
            showToast('Move unavailable: waiting for the farm to finish loading.', 'error', 4000);
            return;
        }

        moveBusy = true;
        try {
            prepareHeldPlant(activePress);
        } catch (error) {
            activePress.cancelled = true;
            moveBusy = false;
            restoreSourcePlant(activePress);
            log('Move cancelled.', error);
            showToast(`Move cancelled: ${error.message}.`, 'error', 4500);
        }
    }

    function clearPress(activePress) {
        clearTimeout(activePress.holdTimer);
        if (press === activePress) press = null;
        clearFallbackHighlight();
        document.documentElement.style.cursor = '';
    }

    document.addEventListener('pointerdown', event => {
        if (!isEnabled() || press || event.button !== 0 || !event.isPrimary || !isGameCanvas(event.target)) return;
        if (isPointerOverGameUi(event)) {
            log('Ignored plant drag input over a native canvas control.');
            return;
        }
        if (live.nativeActionHolding) return;
        if (live.hudSuppressed) {
            log('Ignored plant drag input while a game overlay is open.');
            return;
        }
        if (performance.now() < live.blockDragUntil) {
            log('Ignored plant drag input during the native-action grace period.');
            return;
        }
        if (moveBusy) {
            showToast('Finish the current plant move before starting another.', 'error', 3500);
            return;
        }
        if (live.inventoryReady && !hasPlanterPot()) {
            showToast('A Planter Pot is required to move plants.', 'error', 4500);
            log('Move unavailable: no Planter Pot in inventory.');
            return;
        }

        const activePress = {
            target: event.target,
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            releaseX: event.clientX,
            releaseY: event.clientY,
            activated: false,
            released: false,
            cancelled: false,
            phase: 'holding',
            holdTimer: 0,
        };
        activePress.holdTimer = window.setTimeout(() => activatePress(activePress), HOLD_MS);
        press = activePress;
    }, true);

    document.addEventListener('pointermove', event => {
        const activePress = press;
        if (!activePress || event.pointerId !== activePress.pointerId) return;

        if (!isEnabled()) {
            activePress.cancelled = true;
            restoreSourcePlant(activePress);
            moveBusy = false;
            clearPress(activePress);
            return;
        }

        if (live.hudSuppressed) {
            activePress.cancelled = true;
            restoreSourcePlant(activePress);
            moveBusy = false;
            if (activePress.activated) showToast('Plant move cancelled because a menu opened.', 'error', 3000);
            clearPress(activePress);
            return;
        }

        if (!activePress.activated) {
            const distance = Math.hypot(event.clientX - activePress.startX, event.clientY - activePress.startY);
            if (distance > HOLD_MOVE_TOLERANCE_PX) {
                activePress.cancelled = true;
                clearPress(activePress);
            }
        } else {
            updateFallbackHighlight(activePress, event.clientX, event.clientY);
        }
        // Leave pointer movement visible to Pixi so its native tile highlight follows the drag.
    }, true);

    document.addEventListener('pointerup', event => {
        const activePress = press;
        if (!activePress || event.pointerId !== activePress.pointerId) return;

        if (!isEnabled()) {
            activePress.cancelled = true;
            restoreSourcePlant(activePress);
            moveBusy = false;
            clearPress(activePress);
            return;
        }

        if (live.hudSuppressed) {
            activePress.cancelled = true;
            restoreSourcePlant(activePress);
            moveBusy = false;
            if (activePress.activated) {
                event.preventDefault();
                event.stopImmediatePropagation();
                showToast('Plant move cancelled because a menu opened.', 'error', 3000);
            }
            clearPress(activePress);
            return;
        }

        activePress.releaseX = event.clientX;
        activePress.releaseY = event.clientY;
        activePress.released = true;

        if (!activePress.activated) {
            clearPress(activePress);
            return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        if (activePress.phase === 'dragging') {
            commitHeldMove(activePress).catch(error => {
                activePress.cancelled = true;
                moveBusy = false;
                restoreSourcePlant(activePress);
                log('Move failed.', error);
                showToast(`Move stopped: ${error.message}.`, 'error', 4500);
            });
        }
        clearPress(activePress);
    }, true);

    document.addEventListener('pointercancel', event => {
        const activePress = press;
        if (!activePress || event.pointerId !== activePress.pointerId) return;
        activePress.cancelled = true;
        restoreSourcePlant(activePress);
        if (activePress.activated) {
            moveBusy = false;
            showToast('Plant move cancelled.', 'error', 3000);
        }
        clearPress(activePress);
    }, true);

    document.addEventListener('contextmenu', event => {
        if (!press?.activated) return;
        event.preventDefault();
        event.stopImmediatePropagation();
    }, true);

    log(`Loaded. Hold a plant for ${HOLD_MS / 1000} second before dragging.`);
}
