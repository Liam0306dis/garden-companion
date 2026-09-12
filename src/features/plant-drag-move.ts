import type { CompanionPage } from '../types.js';
import { noteRoomSocketClosed, noteRoomSocketOpened } from '../connection-state.js';
import { state } from '../state.js';
import { ensureToolReady, freeInventorySlots, holdTool, shackToolCount } from '../pets.js';
import { setQuinoaEngine } from '../quinoa-engine.js';

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
        gardenInfoCard: null,
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
        } else if (system?.name === 'gardenInfoCard' && system.view) {
            // The crop value / turtle timer inject into this system's view. Bundle 1141 removed the
            // engine atom the estimates used to reach it through, so hand it over here - the same
            // registry hook the farm systems already ride - as a minimal engine the estimates expect.
            if (live.gardenInfoCard === system) return;
            live.gardenInfoCard = system;
            setQuinoaEngine({ getSystem: (name: string) => (name === 'gardenInfoCard' ? live.gardenInfoCard : undefined) });
            log('Native garden info card connected.');
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
        if (live.tapToMove && live.tileSystem && live.petSystem && live.worldTapRouter && live.gardenInfoCard) {
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

    /**
     * The label is a list, not a name. Build 1029 renamed the inventory atom for its prediction and
     * rollback work - myOptimisticInventoryItemsAtom to myPredictedInventoryItemsAtom - and a hook
     * that knows one name simply stops firing, which is how a plant move started reporting that
     * there was no Planter Pot while the inventory was full of them.
     */
    function hookAtom(labels, onValue) {
        const wanted = Array.isArray(labels) ? labels : [labels];
        const debugLabel = wanted[0];
        const map = atomMap();
        if (!map || typeof map.values !== 'function') return false;

        for (const atom of map.values()) {
            if (!wanted.includes(atom?.debugLabel) || typeof atom.read !== 'function') continue;
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
            [['myPredictedInventoryItemsAtom', 'myOptimisticInventoryItemsAtom'], value => {
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
        // Empty tiles take a plain move; a tile already holding one of your plants takes a swap. Both
        // are valid drops, so both highlight - only a foreign tile or a non-plant object is refused.
        const isValid = tile
            && tile.userSlotIdx === live.ownUserSlotIdx
            && tile.localTileIndex !== activePress.source?.localTileIndex
            && (!tile.object || tile.object.objectType === 'plant');
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

    /** How many Planter Pots are loose in the inventory right now (a stack counts as its quantity). */
    function planterPotCount() {
        return inventoryItems().reduce((sum, item) =>
            item?.itemType === 'Tool' && item?.toolId === 'PlanterPot'
                ? sum + Math.max(0, item?.quantity ?? 1)
                : sum, 0);
    }

    /** Whether the inventory already holds at least `amount` pots - a swap needs two, a move one. */
    function hasPlanterPot(amount = 1) {
        return planterPotCount() >= amount;
    }

    /**
     * `amount` pots to hand, or that many between the inventory and the Tool Shack. The press only
     * checks that a move is possible - the fetching itself waits for the hold to finish, since it
     * needs to wait on the server and a press has to answer now.
     */
    function canGetPlanterPot(amount = 1) {
        return planterPotCount() + shackToolCount('PlanterPot') >= amount;
    }

    /**
     * Read from the state the game reports rather than from the atom mirror.
     *
     * Build 1029 turned the inventory atom into a derived one: it used to be written on every
     * change, and is now computed only when something evaluates it. An observer on its read
     * therefore stops hearing about changes nobody is currently looking at, which left this
     * watching a mirror that had gone quiet - the pot went out, the plant came back, and nothing
     * here ever saw it. The slot state arrives with every patch and cannot go stale that way.
     */
    function inventoryItems() {
        const items = state.slot?.data?.inventory?.items;
        return Array.isArray(items) && items.length ? items : live.inventoryItems;
    }

    function isSamePlant(candidate, source) {
        if (candidate?.species !== source?.species) return false;
        if (source?.plantedAt != null && candidate?.plantedAt !== source.plantedAt) return false;
        if (source?.maturedAt != null && candidate?.maturedAt !== source.maturedAt) return false;
        return true;
    }

    /** The item we named on the way out, once it has come back. */
    function findPottedPlant(plantItemId) {
        return inventoryItems().find(item => item?.itemType === 'Plant' && item?.id === plantItemId);
    }

    function sendMessage(message) {
        const socket = live.activeSocket;
        if (!socket || socket.readyState !== pageWindow.WebSocket.OPEN) {
            throw new Error('Game WebSocket is not connected');
        }
        socket.send(JSON.stringify(message));
    }

    /**
     * The id of the potted plant is ours to choose, not the server's to report.
     *
     * Build 1029 moved item creation into a reducer both sides run, so the client can predict the
     * result before the server answers - and for that to agree, the client names the item. Sending
     * no plantItemId meant the plant was created under an id of undefined, which is why nothing that
     * looked for it afterwards ever found it. Naming it also means there is nothing to search for:
     * the item that comes back is the one we asked for.
     */
    function sendPotPlant(slot, plantItemId) {
        const requestId = pageWindow.crypto.randomUUID();
        // No sequence here: it is stamped on the way out of the socket, from the same counter the
        // game's own commands are renumbered by.
        sendMessage({
            scopePath: ['Room', 'Quinoa'],
            type: 'QuinoaCommand',
            requestId,
            command: { type: 'PotPlant', slot, plantItemId },
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
        // Only whether a move is possible. Fetching a pot out of the Tool Shack waits on the server,
        // and this runs on the hold finishing, so the fetch itself happens in commitHeldMove.
        if (!canGetPlanterPot()) throw new Error('No Planter Pot is available in your inventory');

        activePress.source = source;
        activePress.phase = 'dragging';
        fadeSourcePlant(activePress);
        showToast('Drag to a highlighted tile and release - drop on a plant to swap them.', 'success', 0);
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
        if (destination.localTileIndex === activePress.source.localTileIndex) {
            throw new Error('That is where the plant already is');
        }
        // A plant on the tile is a swap, not a blocker. Anything else - decor, an egg - has no swap
        // to offer and still blocks the drop.
        if (destination.object && destination.object.objectType !== 'plant') {
            throw new Error('The destination tile holds something that is not a plant, so there is nothing to swap');
        }
        return destination;
    }

    /**
     * Pot the plant off one tile and hand back the inventory item it becomes, named by us so it can
     * be found again (see sendPotPlant). Throws if the server never returns it.
     */
    async function potPlant(tile) {
        const plantItemId = pageWindow.crypto.randomUUID();
        showToast(`Picking up ${tile.object?.species ?? 'plant'}...`, 'normal', 0);
        sendPotPlant(tile.localTileIndex, plantItemId);
        const plantItem = await waitFor(() => findPottedPlant(plantItemId), POT_TIMEOUT_MS);
        if (!plantItem) throw new Error('The server did not return the potted plant');
        return plantItem;
    }

    async function commitHeldMove(activePress) {
        const destination = getValidDestination(activePress);
        activePress.destination = destination;
        // A plant already on the destination is swapped with the one being moved, not treated as a block.
        const swap = Boolean(destination.object);
        activePress.phase = 'potting';
        // A swap lifts two plants at once, so it wants two pots and two free slots; a plain move one
        // of each. Pots stack into a single slot, so only the plants handed back claim inventory room.
        const potsNeeded = swap ? 2 : 1;
        const slotsNeeded = swap ? 2 : 1;
        // Held for the whole move, not just the fetch: a pot is spent by each PotPlant, and auto-store
        // filing one back in between is what would make a drag fail outright.
        const releasePot = holdTool('PlanterPot');
        let sourcePlant;
        let destPlant = null;
        try {
            try {
                if (!hasPlanterPot(potsNeeded) && !await ensureToolReady('PlanterPot', potsNeeded, 1)) {
                    throw new Error(swap
                        ? 'A swap needs two Planter Pots - add another to your inventory or Tool Shack.'
                        : 'No Planter Pot could be taken from the Tool Shack. Make room in your inventory.');
                }
                if (freeInventorySlots() < slotsNeeded) {
                    throw new Error(swap
                        ? 'A swap needs two free inventory slots for the plants it lifts.'
                        : 'Your inventory is full, so the plant has nowhere to go');
                }

                // Lift both plants into the inventory before planting either. Should a later placement
                // fail, both are recoverable from the inventory rather than one stranded on a tile.
                sourcePlant = await potPlant(activePress.source);
                restoreSourcePlant(activePress);
                if (swap) destPlant = await potPlant(destination);
                activePress.plantItem = sourcePlant;
                activePress.phase = 'ready';
            } finally {
                releasePot();
            }

            // The moved plant takes the destination; on a swap the destination's plant takes the
            // now-empty source tile. Both tiles are empty by now, so neither placement blocks the other.
            await placePlant(activePress.source.object, destination, sourcePlant.id, activePress);
            if (swap && destPlant) {
                await placePlant(destination.object, activePress.source, destPlant.id, activePress);
            }
        } finally {
            moveBusy = false;
        }
    }

    /**
     * Plant an inventory item onto a tile and confirm the server placed it. `plantObject` is the tile
     * data the plant was lifted from, used only to recognise it once it lands. Returns whether it settled.
     */
    async function placePlant(plantObject, destination, plantId, activePress) {
        if (activePress.cancelled) return false;
        const currentObject = live.tileSystem?.getTileDataAt({ x: destination.x, y: destination.y });
        if (currentObject) {
            activePress.cancelled = true;
            showToast('Move stopped: a tile became occupied. Your plants are safe in your inventory.', 'error', 5000);
            return false;
        }

        activePress.phase = 'placing';
        showToast('Placing plant...', 'normal', 0);
        sendPlantGardenPlant(destination.localTileIndex, plantId);

        const placed = await waitFor(() => {
            const object = live.tileSystem?.getTileDataAt({ x: destination.x, y: destination.y });
            const itemStillHeld = inventoryItems().some(item => item?.id === plantId);
            return !itemStillHeld && object?.objectType === 'plant'
                && isSamePlant(object, plantObject);
        }, PLACE_TIMEOUT_MS, 150);

        if (placed) {
            showToast('Plant moved.', 'success');
            log(`Placed ${plantObject?.species ?? 'plant'} on slot ${destination.localTileIndex}.`);
        } else {
            showToast('Placement was not confirmed. Check your inventory before retrying.', 'error', 5000);
        }
        return placed;
    }

    function activatePress(activePress) {
        if (press !== activePress || activePress.cancelled || activePress.released) return;
        if (!isEnabled()) {
            activePress.cancelled = true;
            clearPress(activePress);
            return;
        }
        // Checked here rather than on the press. A move needs a pot; an ordinary click does not, and
        // the press is only a move once it has been held - so testing it any earlier answered every
        // click in the game with a toast about a tool the click was never going to use.
        if (live.inventoryReady && !canGetPlanterPot()) {
            activePress.cancelled = true;
            showToast('A Planter Pot is required to move plants.', 'error', 4500);
            log('Move unavailable: no Planter Pot in inventory.');
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
            // Clear the press and its highlight too: without this the press stays live and, since it
            // was already activated, pointermove keeps drawing the drag to a move that was refused.
            clearFallbackHighlight();
            clearPress(activePress);
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
        // A press that was refused (e.g. the source was not a plant) is left only to be torn down on
        // release - it must not keep drawing a drag in the meantime.
        if (activePress.cancelled) return;

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
