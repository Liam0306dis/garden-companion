import type { CompanionPage, GardenTile } from '../types.js';

/**
 * Layout planner. Nothing is sent to the game server: planned plants are fed to the
 * game's own tile system as if the server had reported them, so the game draws them
 * with the correct sprite, slots, size and mutation overlays. Leaving edit mode
 * restores every tile from live state.
 */
export function initGardenPlanner(): void {
  'use strict';

  const page = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage;
  const PLANTS = __PLANT_CATALOG__;
  const MUTATIONS = __MUTATION_CATALOG__;
  const DECOR = __DECOR_CATALOG__;
  // One mutation per group can be on a crop, so picking one replaces the group's current choice.
  const MUTATION_GROUPS = [...new Set(Object.values(MUTATIONS).map(mutation => mutation.group))];
  const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Legendary', 'Mythic', 'Divine', 'Celestial'];

  function rarityRank(species: string): number {
    const rank = RARITY_ORDER.indexOf(PLANTS[species]?.rarity || 'Common');
    return rank < 0 ? RARITY_ORDER.length : rank;
  }

  function sortedDecor(): string[] {
    return Object.keys(DECOR).sort((left, right) =>
      rarityIndex(DECOR[left]?.rarity) - rarityIndex(DECOR[right]?.rarity) || (DECOR[left]?.name || left).localeCompare(DECOR[right]?.name || right));
  }

  function rarityIndex(rarity?: string): number {
    const rank = RARITY_ORDER.indexOf(rarity || 'Common');
    return rank < 0 ? RARITY_ORDER.length : rank;
  }

  /**
   * The game stores a decor's facing and flip in one number: a negative rotation means flipped,
   * and -360 is "unrotated but flipped". Only decor with rotation variants changes sprite when
   * turned, but every decor can be flipped.
   */
  function decorRotation(): number {
    if (!planner.flipped) return planner.rotation;
    return planner.rotation === 0 ? -360 : -planner.rotation;
  }

  function plannedDecor(): GardenTile {
    return { objectType: 'decor', decorId: planner.decorId, rotation: decorRotation() } as GardenTile;
  }

  function sortedSpecies(): string[] {
    // Component species (stormcaps) only grow inside another plant's slots, so they get no button.
    return Object.keys(PLANTS)
      .filter(name => !PLANTS[name]?.component)
      .sort((left, right) => rarityRank(left) - rarityRank(right) || left.localeCompare(right));
  }

  interface PlannerState {
    open: boolean;
    mode: 'plants' | 'decor';
    species: string;
    decorId: string;
    rotation: number;
    flipped: boolean;
    mutations: Set<string>;
    tiles: Map<string, GardenTile>;
    painting: boolean;
    erasing: boolean;
  }

  const planner: PlannerState = {
    open: false,
    mode: 'plants',
    species: Object.keys(PLANTS)[0] || 'Carrot',
    decorId: Object.keys(DECOR)[0] || '',
    rotation: 0,
    flipped: false,
    mutations: new Set(),
    tiles: new Map(),
    painting: false,
    erasing: false,
  };

  function systems() {
    return page.__gardenCompanionFarmSystems ?? null;
  }

  function tileSystem(): Record<string, any> | null {
    const system = systems()?.tileSystem;
    return system?.map && typeof system.updateTileData === 'function' ? system : null;
  }

  function companionState(): Record<string, any> | null {
    return (page.__gardenCompanionState as Record<string, any>) ?? null;
  }

  function ownSlotIndex(): number | null {
    const captured = systems()?.ownUserSlotIdx;
    if (typeof captured === 'number') return captured;
    const index = companionState()?.slotIndex;
    return typeof index === 'number' ? index : null;
  }

  /** Local dirt tile index -> global tile index for the player's own garden. */
  function ownTileIndexes(): Record<string, number> {
    const slot = ownSlotIndex();
    const map = tileSystem()?.map;
    if (slot === null || !map?.userSlotIdxAndDirtTileIdxToGlobalTileIdx) return {};
    return map.userSlotIdxAndDirtTileIdxToGlobalTileIdx[slot] ?? {};
  }

  function liveTiles(): Record<string, GardenTile> {
    return (companionState()?.slot?.data?.garden?.tileObjects as Record<string, GardenTile>) ?? {};
  }

  /**
   * Patch plants (clover, daisy, snowdrop, cattail) are single-harvest plants whose slots each
   * carry their own x, y and rotation. Without those the game draws a single crop in the middle,
   * so positions are scattered here the way the server would supply them.
   */
  function patchSlotOffset(index: number, count: number): { x: number; y: number; rotation: number } {
    const radius = .42 * Math.sqrt((index + .5) / count);
    const angle = index * 2.399963;
    return {
      x: Number((radius * Math.cos(angle)).toFixed(4)),
      y: Number((radius * Math.sin(angle) * .62).toFixed(4)),
      rotation: (index * 47) % 31 - 15,
    };
  }

  function plannedTile(species: string, mutations: string[]): GardenTile {
    const now = Date.now();
    const slots = Math.max(1, Number(PLANTS[species]?.slots || 1));
    const isPatch = slots > 1 && !PLANTS[species]?.regrows;
    // Displayed size is targetScale x growth progress, and progress divides by the growth window,
    // so start and end must differ. Both sit in the past to render the plant fully grown.
    const started = now - 3_600_000;
    const matured = now - 60_000;
    return {
      objectType: 'plant',
      species,
      plantedAt: started,
      maturedAt: matured,
      slots: Array.from({ length: slots }, (_, slotId) => ({
        species: PLANTS[species]?.slotSpecies?.[slotId] || species,
        startTime: started,
        endTime: matured,
        targetScale: Number(PLANTS[PLANTS[species]?.slotSpecies?.[slotId] || species]?.crop?.maxScale || 1),
        mutations: [...mutations],
        slotId,
        ...(isPatch ? patchSlotOffset(slotId, slots) : {}),
      })),
    } as GardenTile;
  }

  /** Push one tile's planned state (or the live one when clearing) into the game. */
  function applyTile(localIndex: string): void {
    const system = tileSystem();
    const globalIndex = ownTileIndexes()[localIndex];
    if (!system || globalIndex === undefined) return;
    const data = planner.open ? planner.tiles.get(localIndex) : liveTiles()[localIndex];
    try { system.updateTileData(globalIndex, data); } catch {}
  }

  function applyAllTiles(): void {
    for (const localIndex of Object.keys(ownTileIndexes())) applyTile(localIndex);
  }

  function tileAtPointer(event: PointerEvent | MouseEvent): string | null {
    const system = tileSystem();
    const canvas = document.querySelector('.QuinoaCanvas canvas') as HTMLCanvasElement | null;
    const renderer = systems()?.tapToMove?.renderer;
    if (!system?.worldContainer || !canvas || !renderer?.screen) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const global = {
      x: (event.clientX - rect.left) * renderer.screen.width / rect.width,
      y: (event.clientY - rect.top) * renderer.screen.height / rect.height,
    };
    const world = system.worldContainer.toLocal(global);
    const x = Math.floor(world.x / 256);
    const y = Math.floor(world.y / 256);
    const map = system.map;
    if (x < 0 || y < 0 || x >= map.cols || y >= map.rows) return null;
    const dirt = map.globalTileIdxToDirtTile?.[x + y * map.cols];
    if (!dirt || dirt.userSlotIdx !== ownSlotIndex()) return null;
    return String(dirt.dirtTileIdx);
  }

  function updateCount(): void {
    const label = document.querySelector<HTMLElement>('#gc-planner [data-plan-count]');
    if (label) label.textContent = `${planner.tiles.size} planned`;
  }

  function place(localIndex: string): void {
    planner.tiles.set(localIndex, planner.mode === 'decor' ? plannedDecor() : plannedTile(planner.species, [...planner.mutations]));
    applyTile(localIndex);
    updateCount();
  }

  function erase(localIndex: string): void {
    planner.tiles.delete(localIndex);
    applyTile(localIndex);
    updateCount();
  }

  function fromPlannerUi(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return Boolean(target?.closest?.('#gc-planner'));
  }

  function onPointerDown(event: PointerEvent): void {
    if (!planner.open || fromPlannerUi(event)) return;
    const localIndex = tileAtPointer(event);
    if (localIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 2) {
      planner.erasing = true;
      erase(localIndex);
    } else if (event.button === 0) {
      planner.painting = true;
      place(localIndex);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!planner.open || fromPlannerUi(event) || (!planner.painting && !planner.erasing)) return;
    const localIndex = tileAtPointer(event);
    if (localIndex === null) return;
    if (planner.erasing) {
      if (planner.tiles.has(localIndex)) erase(localIndex);
    } else if (planner.mode === 'decor'
      ? planner.tiles.get(localIndex)?.decorId !== planner.decorId
      : planner.tiles.get(localIndex)?.species !== planner.species) {
      place(localIndex);
    }
  }

  function onPointerUp(): void {
    planner.painting = false;
    planner.erasing = false;
  }

  function blockEvent(event: Event): void {
    if (planner.open && !fromPlannerUi(event)) { event.preventDefault(); event.stopPropagation(); }
  }

  function open(): void {
    if (planner.open || !tileSystem()) return;
    planner.open = true;
    planner.tiles = new Map(Object.entries(liveTiles()).filter(([, tile]) => tile?.objectType === 'plant' || tile?.objectType === 'decor'));
    applyAllTiles();
    document.body.classList.add('gc-planning');
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('contextmenu', blockEvent, true);
    renderPanel();
  }

  function close(): void {
    if (!planner.open) return;
    planner.open = false;
    applyAllTiles();
    document.body.classList.remove('gc-planning');
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('contextmenu', blockEvent, true);
    document.getElementById('gc-planner')?.remove();
  }

  function renderPanel(): void {
    if (!planner.open) return;
    let panel = document.getElementById('gc-planner');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'gc-planner';
      document.body.appendChild(panel);
      panel.addEventListener('pointerdown', event => event.stopPropagation(), true);
    }
    const options = sortedSpecies().map(name => {
      const sprite = page.__gardenCompanionProduceSprites?.[name] || page.__gardenCompanionShopSprites?.[name] || '';
      const slots = Math.max(1, Number(PLANTS[name]?.slots || 1));
      const label = `${name} (${PLANTS[name]?.rarity || 'Common'}${slots > 1 ? `, ${slots} per tile` : ''})`;
      return `<button data-plan-species="${name}" data-rarity="${PLANTS[name]?.rarity || 'Common'}" data-active="${name === planner.species}" title="${label}">${sprite ? `<img src="${sprite}" alt="">` : `<i>${name.slice(0, 1)}</i>`}</button>`;
    }).join('');
    const mutations = MUTATION_GROUPS.map(group => {
      const buttons = Object.entries(MUTATIONS)
        .filter(([, mutation]) => mutation.group === group)
        .sort((left, right) => left[1].coinMultiplier - right[1].coinMultiplier)
        .map(([id, mutation]) =>
          `<button data-plan-mutation="${id}" data-group="${group}" data-active="${planner.mutations.has(id)}" title="${mutation.name} x${mutation.coinMultiplier}">${mutation.name}</button>`)
        .join('');
      return `<div class="gc-planner-mutation-group">${buttons}</div>`;
    }).join('');
    const decorOptions = sortedDecor().map(id => {
      const sprite = page.__gardenCompanionShopSprites?.[id] || '';
      const details = DECOR[id];
      return `<button data-plan-decor="${id}" data-rarity="${details?.rarity || 'Common'}" data-active="${id === planner.decorId}" title="${details?.name || id}">${sprite ? `<img src="${sprite}" alt="">` : `<i>${(details?.name || id).slice(0, 1)}</i>`}</button>`;
    }).join('');
    const decorMode = planner.mode === 'decor';
    panel.innerHTML = `<header><b>Layout planner</b><span data-plan-count>${planner.tiles.size} planned</span><button data-plan-close>Exit</button></header>
<div class="gc-planner-body"><small>Left click places, right click removes. Drag to fill. Nothing here is sent to the game.</small>
<div class="gc-planner-modes"><button data-plan-mode="plants" class="${decorMode ? '' : 'active'}">Plants</button><button data-plan-mode="decor" class="${decorMode ? 'active' : ''}">Decor</button></div>
<div class="gc-planner-grid">${decorMode ? decorOptions : options}</div>
${decorMode
  ? `${DECOR[planner.decorId]?.rotates
      ? `<div class="gc-planner-row"><b>Facing</b><div class="gc-planner-mutations"><div class="gc-planner-mutation-group">${[0, 90, 180, 270].map(angle => `<button data-plan-rotation="${angle}" data-active="${planner.rotation === angle}">${angle}</button>`).join('')}</div></div></div>`
      : ''}<div class="gc-planner-row"><b>Flip</b><div class="gc-planner-mutations"><div class="gc-planner-mutation-group"><button data-plan-flip="false" data-active="${!planner.flipped}">Normal</button><button data-plan-flip="true" data-active="${planner.flipped}">Flipped</button></div></div></div>`
  : `<div class="gc-planner-row"><b>Mutations</b><div class="gc-planner-mutations">${mutations}</div></div>`}
<div class="gc-planner-row"><button data-plan-reset>Reset to garden</button><button data-plan-clear>Clear all</button></div></div>`;

    panel.querySelector<HTMLButtonElement>('[data-plan-close]')!.onclick = close;
    // Selections update in place so the plant list keeps its scroll position.
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-species]').forEach(button => button.onclick = () => {
      planner.species = button.dataset.planSpecies!;
      panel!.querySelectorAll<HTMLButtonElement>('[data-plan-species]').forEach(other => {
        other.dataset.active = String(other.dataset.planSpecies === planner.species);
      });
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-mutation]').forEach(button => button.onclick = () => {
      const mutation = button.dataset.planMutation!;
      const chosen = !planner.mutations.has(mutation);
      for (const [id, details] of Object.entries(MUTATIONS)) {
        if (details.group === button.dataset.group) planner.mutations.delete(id);
      }
      if (chosen) planner.mutations.add(mutation);
      panel!.querySelectorAll<HTMLButtonElement>('[data-plan-mutation]').forEach(other => {
        other.dataset.active = String(planner.mutations.has(other.dataset.planMutation!));
      });
    });
    panel.querySelector<HTMLButtonElement>('[data-plan-clear]')!.onclick = () => {
      planner.tiles.clear();
      applyAllTiles();
      updateCount();
    };
    panel.querySelector<HTMLButtonElement>('[data-plan-reset]')!.onclick = () => {
      planner.tiles = new Map(Object.entries(liveTiles()).filter(([, tile]) => tile?.objectType === 'plant' || tile?.objectType === 'decor'));
      applyAllTiles();
      updateCount();
    };
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-mode]').forEach(button => button.onclick = () => {
      planner.mode = button.dataset.planMode as PlannerState['mode'];
      renderPanel();
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-decor]').forEach(button => button.onclick = () => {
      const previous = planner.decorId;
      planner.decorId = button.dataset.planDecor!;
      if (!DECOR[planner.decorId]?.rotates) planner.rotation = 0;
      panel!.querySelectorAll<HTMLButtonElement>('[data-plan-decor]').forEach(other => {
        other.dataset.active = String(other.dataset.planDecor === planner.decorId);
      });
      // Only redraw when the facing row needs to appear or disappear.
      if (Boolean(DECOR[previous]?.rotates) !== Boolean(DECOR[planner.decorId]?.rotates)) renderPanel();
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-flip]').forEach(button => button.onclick = () => {
      planner.flipped = button.dataset.planFlip === 'true';
      panel!.querySelectorAll<HTMLButtonElement>('[data-plan-flip]').forEach(other => {
        other.dataset.active = String((other.dataset.planFlip === 'true') === planner.flipped);
      });
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-rotation]').forEach(button => button.onclick = () => {
      planner.rotation = Number(button.dataset.planRotation);
      panel!.querySelectorAll<HTMLButtonElement>('[data-plan-rotation]').forEach(other => {
        other.dataset.active = String(Number(other.dataset.planRotation) === planner.rotation);
      });
    });
  }

  // Server patches redraw tiles from real state, so planned tiles are re-applied.
  setInterval(() => { if (planner.open) applyAllTiles(); }, 1000);

  page.__gardenCompanionTogglePlanner = () => (planner.open ? close() : open());
  page.__gardenCompanionPlannerOpen = () => planner.open;
}
