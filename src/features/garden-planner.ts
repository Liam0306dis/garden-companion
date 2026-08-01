import type { CompanionPage, GardenTile } from '../types.js';
import { DECOR_CATALOG, MUTATION_CATALOG, PLANT_CATALOG } from '../constants.js';

/**
 * Layout planner. Nothing is sent to the game server: planned plants are fed to the
 * game's own tile system as if the server had reported them, so the game draws them
 * with the correct sprite, slots, size and mutation overlays. Leaving edit mode
 * restores every tile from live state.
 */
export function initGardenPlanner(): void {
  'use strict';

  const page = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage;
  const PLANTS = PLANT_CATALOG;
  const MUTATIONS = MUTATION_CATALOG;
  const DECOR = DECOR_CATALOG;
  const LAYOUT_KEY = 'gardenCompanion.layouts.v1';
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

  /**
   * Pedestals and stools can display a harvested crop, which the game stores on the tile as a
   * mountedCrop carrying its own species, size and mutations.
   */
  function plannedDecor(): GardenTile {
    const tile = { objectType: 'decor', decorId: planner.decorId, rotation: decorRotation() } as GardenTile;
    if (DECOR[planner.decorId]?.mountable && planner.mountedSpecies) {
      tile.mountedCrop = {
        id: crypto.randomUUID(),
        species: planner.mountedSpecies,
        itemType: 'Produce',
        scale: scaleFor(planner.mountedSpecies),
        mutations: [...planner.mutations],
      };
    }
    return tile;
  }

  /** Planned size for a species, defaulting to its maximum and clamped to the legal range. */
  function scaleFor(species: string): number {
    const max = Number(PLANTS[species]?.crop?.maxScale || 1);
    if (planner.scale === null) return max;
    return Math.min(max, Math.max(1, planner.scale));
  }

  function mutationIcon(id: string): string {
    const sprite = page.__gardenCompanionMutationSprites?.[id];
    const name = MUTATIONS[id]?.name || id;
    return sprite ? `<img src="${sprite}" alt="${name}">` : `<b>${name.slice(0, 2)}</b>`;
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
    mountedSpecies: string;
    scale: number | null;
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
    mountedSpecies: '',
    scale: null,
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

  /**
   * Planned tiles are keyed "dirt:3" or "board:3" because dirt and boardwalk tiles number
   * separately, and decor can sit on either.
   */
  function ownTileIndexes(): Record<string, number> {
    const slot = ownSlotIndex();
    const map = tileSystem()?.map;
    if (slot === null || !map) return {};
    const indexes: Record<string, number> = {};
    for (const [local, global] of Object.entries(map.userSlotIdxAndDirtTileIdxToGlobalTileIdx?.[slot] ?? {})) {
      indexes[`dirt:${local}`] = global as number;
    }
    for (const [local, global] of Object.entries(map.userSlotIdxAndBoardwalkTileIdxToGlobalTileIdx?.[slot] ?? {})) {
      indexes[`board:${local}`] = global as number;
    }
    return indexes;
  }

  function liveTiles(): Record<string, GardenTile> {
    const garden = companionState()?.slot?.data?.garden ?? {};
    const tiles: Record<string, GardenTile> = {};
    for (const [local, tile] of Object.entries((garden.tileObjects ?? {}) as Record<string, GardenTile>)) tiles[`dirt:${local}`] = tile;
    for (const [local, tile] of Object.entries((garden.boardwalkTileObjects ?? {}) as Record<string, GardenTile>)) tiles[`board:${local}`] = tile;
    return tiles;
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
        targetScale: scaleFor(PLANTS[species]?.slotSpecies?.[slotId] || species),
        mutations: [...mutations],
        slotId,
        ...(isPatch ? patchSlotOffset(slotId, slots) : {}),
      })),
    } as GardenTile;
  }

  /**
   * Push one tile's planned state (or the live one when clearing) into the game. Re-pushing data a
   * view already holds makes it rebuild, which reads as a flash on plants and eggs that are growing,
   * so an unchanged tile is skipped.
   */
  function applyTile(localIndex: string, force = false): void {
    const system = tileSystem();
    const globalIndex = ownTileIndexes()[localIndex];
    if (!system || globalIndex === undefined) return;
    const data = planner.open ? planner.tiles.get(localIndex) : liveTiles()[localIndex];
    if (!force && system.tileViews?.get?.(globalIndex)?.tileObject === (data ?? undefined)) return;
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
    const globalIndex = x + y * map.cols;
    const dirt = map.globalTileIdxToDirtTile?.[globalIndex];
    if (dirt && dirt.userSlotIdx === ownSlotIndex()) return `dirt:${dirt.dirtTileIdx}`;
    // Boardwalk tiles hold decor only, so plants are not offered there.
    const boardwalk = map.globalTileIdxToBoardwalk?.[globalIndex];
    if (boardwalk && boardwalk.userSlotIdx === ownSlotIndex() && planner.mode === 'decor') {
      return `board:${boardwalk.boardwalkTileIdx}`;
    }
    return null;
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

  // The game's crop info card and its harvest controls would still pop up while planning,
  // so they are hidden for the duration and restored on exit.
  const NATIVE_UI_LABELS = ['GardenInfoCardSystem', 'ActionHud', 'PetActionButtons'];
  const hiddenNodes = new Map<Record<string, any>, boolean>();

  function pixiStage(): Record<string, any> | null {
    const capture = page.__GARDEN_COMPANION_PIXI__ as { app?: any; renderer?: any } | undefined;
    return capture?.app?.stage ?? capture?.renderer?.lastObjectRendered ?? null;
  }

  let cinematicApplied = false;

  function hideNativeCardUi(): void {
    // The game's cinematic mode clears its whole HUD, which is exactly what planning wants.
    if (cinematicApplied || page.__gardenCompanionSetCinematic?.(true)) {
      cinematicApplied = true;
      return;
    }
    const stage = pixiStage();
    if (!stage) return;
    const stack = [stage];
    while (stack.length) {
      const node = stack.pop() as Record<string, any>;
      if (!node || typeof node !== 'object') continue;
      if (typeof node.label === 'string' && NATIVE_UI_LABELS.includes(node.label)) {
        if (!hiddenNodes.has(node)) hiddenNodes.set(node, node.visible !== false);
        node.visible = false;
        continue;
      }
      if (Array.isArray(node.children)) stack.push(...node.children);
    }
  }

  function restoreNativeCardUi(): void {
    if (cinematicApplied) {
      page.__gardenCompanionSetCinematic?.(false);
      cinematicApplied = false;
    }
    for (const [node, visible] of hiddenNodes) {
      try { node.visible = visible; } catch {}
    }
    hiddenNodes.clear();
  }

  function open(): void {
    if (planner.open || !tileSystem()) return;
    planner.open = true;
    planner.tiles = new Map(Object.entries(liveTiles()).filter(([, tile]) => tile?.objectType === 'plant' || tile?.objectType === 'decor'));
    applyAllTiles();
    hideNativeCardUi();
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
    restoreNativeCardUi();
    document.body.classList.remove('gc-planning');
    window.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('pointerup', onPointerUp, true);
    window.removeEventListener('contextmenu', blockEvent, true);
    document.getElementById('gc-planner')?.remove();
  }

  /** Keeps the size slider in step with the selected crop, whose maximum differs per species. */
  function refreshScaleControl(panel: HTMLElement): void {
    const species = planner.mode === 'decor' ? planner.mountedSpecies || planner.species : planner.species;
    const slider = panel.querySelector<HTMLInputElement>('[data-plan-scale]');
    if (!slider) return;
    const max = Number(PLANTS[species]?.crop?.maxScale || 1);
    const value = scaleFor(species);
    slider.max = max.toFixed(2);
    slider.value = value.toFixed(2);
    slider.disabled = max <= 1;
    const label = panel.querySelector<HTMLElement>('[data-plan-scale-value]');
    if (label) label.textContent = max <= 1 ? 'fixed' : `${value.toFixed(2)}x`;
    const maxButton = panel.querySelector<HTMLButtonElement>('[data-plan-scale-max]');
    if (maxButton) maxButton.dataset.active = String(planner.scale === null);
  }

  /**
   * Layouts are stored as a recipe per tile rather than the expanded payload: a full garden of
   * patch plants is about 210KB expanded but a few KB as recipes, and rebuilding on load keeps
   * saved layouts working when the game changes its slot layouts.
   */
  interface TileRecipe {
    p?: string;
    d?: string;
    r?: number;
    m?: string[];
    s?: number;
    c?: string;
  }

  const MAX_LAYOUTS = 25;

  function round2(value?: number): number | undefined {
    return typeof value === 'number' ? Math.round(value * 100) / 100 : undefined;
  }

  function toRecipe(tile: GardenTile): TileRecipe {
    if (tile.objectType === 'decor') {
      return {
        d: tile.decorId,
        r: tile.rotation,
        ...(tile.mountedCrop ? { c: tile.mountedCrop.species, m: tile.mountedCrop.mutations, s: round2(tile.mountedCrop.scale) } : {}),
      };
    }
    const slot = tile.slots?.[0];
    // Sizes are rounded: the game rolls scales like 1.0000916889895834, and keeping every digit
    // bloats saved layouts for no visible difference.
    return { p: tile.species, m: slot?.mutations ?? [], s: round2(slot?.targetScale) };
  }

  function fromRecipe(recipe: TileRecipe): GardenTile | null {
    const previousScale = planner.scale;
    try {
      planner.scale = recipe.s ?? null;
      if (recipe.d) {
        const tile = { objectType: 'decor', decorId: recipe.d, rotation: recipe.r ?? 0 } as GardenTile;
        if (recipe.c) {
          tile.mountedCrop = {
            id: crypto.randomUUID(),
            species: recipe.c,
            itemType: 'Produce',
            scale: recipe.s ?? scaleFor(recipe.c),
            mutations: recipe.m ?? [],
          };
        }
        return tile;
      }
      return recipe.p ? plannedTile(recipe.p, recipe.m ?? []) : null;
    } finally {
      planner.scale = previousScale;
    }
  }

  function savedLayouts(): Record<string, Record<string, TileRecipe>> {
    try {
      const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}');
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
  }

  /** Returns a problem to show the user, or an empty string when the layout was stored. */
  function storeLayouts(layouts: Record<string, Record<string, TileRecipe>>): string {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layouts));
      return '';
    } catch {
      return 'Layout could not be saved: browser storage is full.';
    }
  }

  function showPlannerNotice(message: string): void {
    const notice = document.querySelector<HTMLElement>('#gc-planner [data-plan-notice]');
    if (notice) notice.textContent = message;
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
          `<button class="gc-planner-mutation" data-plan-mutation="${id}" data-group="${group}" data-active="${planner.mutations.has(id)}" title="${mutation.name} x${mutation.coinMultiplier}">${mutationIcon(id)}</button>`)
        .join('');
      return `<div class="gc-planner-mutation-group">${buttons}</div>`;
    }).join('');
    const decorOptions = sortedDecor().map(id => {
      const sprite = page.__gardenCompanionShopSprites?.[id] || '';
      const details = DECOR[id];
      return `<button data-plan-decor="${id}" data-rarity="${details?.rarity || 'Common'}" data-active="${id === planner.decorId}" title="${details?.name || id}">${sprite ? `<img src="${sprite}" alt="">` : `<i>${(details?.name || id).slice(0, 1)}</i>`}</button>`;
    }).join('');
    const decorMode = planner.mode === 'decor';
    const layoutNames = Object.keys(savedLayouts()).sort();
    const scaleSpecies = decorMode ? planner.mountedSpecies || planner.species : planner.species;
    const scaleMax = Number(PLANTS[scaleSpecies]?.crop?.maxScale || 1);
    const scaleValue = scaleFor(scaleSpecies);
    const previousScroll = panel.querySelector<HTMLElement>('.gc-planner-grid:not(.gc-planner-mount)')?.scrollTop ?? 0;
    panel.innerHTML = `<header><b>Layout planner</b><span data-plan-count>${planner.tiles.size} planned</span><button data-plan-close>Exit</button></header>
<div class="gc-planner-body"><small data-plan-notice>Left click places, right click removes. Drag to fill. Nothing here is sent to the game.</small>
<div class="gc-planner-modes"><button data-plan-mode="plants" class="${decorMode ? '' : 'active'}">Plants</button><button data-plan-mode="decor" class="${decorMode ? 'active' : ''}">Decor</button></div>
<div class="gc-planner-grid">${decorMode ? decorOptions : options}</div>
${decorMode && DECOR[planner.decorId]?.mountable
  ? `<div class="gc-planner-row"><b>Display crop</b><div class="gc-planner-mutations"><div class="gc-planner-mutation-group"><button data-plan-mount="" data-active="${!planner.mountedSpecies}">None</button></div></div></div>
<div class="gc-planner-grid gc-planner-mount">${sortedSpecies().map(name => {
  const sprite = page.__gardenCompanionProduceSprites?.[name] || page.__gardenCompanionShopSprites?.[name] || '';
  return `<button data-plan-mount="${name}" data-rarity="${PLANTS[name]?.rarity || 'Common'}" data-active="${name === planner.mountedSpecies}" title="${name}">${sprite ? `<img src="${sprite}" alt="">` : `<i>${name.slice(0, 1)}</i>`}</button>`;
}).join('')}</div>
<div class="gc-planner-row"><b>Mutations</b><div class="gc-planner-mutations">${mutations}</div></div>`
  : ''}
${decorMode
  ? `${DECOR[planner.decorId]?.rotates
      ? `<div class="gc-planner-row"><b>Facing</b><div class="gc-planner-mutations"><div class="gc-planner-mutation-group">${[0, 90, 180, 270].map(angle => `<button data-plan-rotation="${angle}" data-active="${planner.rotation === angle}">${angle}</button>`).join('')}</div></div></div>`
      : ''}<div class="gc-planner-row"><b>Flip</b><div class="gc-planner-mutations"><div class="gc-planner-mutation-group"><button data-plan-flip="false" data-active="${!planner.flipped}">Normal</button><button data-plan-flip="true" data-active="${planner.flipped}">Flipped</button></div></div></div>`
  : `<div class="gc-planner-row"><b>Mutations</b><div class="gc-planner-mutations">${mutations}</div></div>`}
${decorMode && !DECOR[planner.decorId]?.mountable ? '' : `<div class="gc-planner-row"><b>Size</b><input class="gc-planner-scale" type="range" min="1" max="${scaleMax.toFixed(2)}" step="0.01" value="${scaleValue.toFixed(2)}" data-plan-scale><span data-plan-scale-value>${scaleValue.toFixed(2)}x</span><button data-plan-scale-max data-active="${planner.scale === null}">Max</button></div>`}
<div class="gc-planner-row"><button data-plan-reset>Reset to garden</button><button data-plan-clear>Clear all</button></div>
<div class="gc-planner-row"><input data-plan-name placeholder="Layout name" maxlength="24" spellcheck="false"><button data-plan-save>Save</button></div>
${layoutNames.length ? `<div class="gc-planner-row"><select data-plan-load><option value="">Load a layout...</option>${layoutNames.map(name => `<option value="${name}">${name}</option>`).join('')}</select><button data-plan-delete>Delete</button></div>` : ''}</div>`;

    const grid = panel.querySelector<HTMLElement>('.gc-planner-grid:not(.gc-planner-mount)');
    if (grid) grid.scrollTop = previousScroll;
    panel.querySelector<HTMLButtonElement>('[data-plan-close]')!.onclick = close;
    // Selections update in place so the plant list keeps its scroll position.
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-species]').forEach(button => button.onclick = () => {
      planner.species = button.dataset.planSpecies!;
      panel!.querySelectorAll<HTMLButtonElement>('[data-plan-species]').forEach(other => {
        other.dataset.active = String(other.dataset.planSpecies === planner.species);
      });
      refreshScaleControl(panel!);
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
      // Redraw when the facing or display-crop rows need to appear or disappear.
      if (Boolean(DECOR[previous]?.rotates) !== Boolean(DECOR[planner.decorId]?.rotates)
        || Boolean(DECOR[previous]?.mountable) !== Boolean(DECOR[planner.decorId]?.mountable)) renderPanel();
    });
    // The game reads movement and hotkeys from window in the bubble phase, so stopping the event
    // at the field keeps typed names out of the game while still typing normally.
    const nameInput = panel.querySelector<HTMLInputElement>('[data-plan-name]');
    if (nameInput) {
      for (const type of ['keydown', 'keyup', 'keypress'] as const) {
        nameInput.addEventListener(type, event => event.stopPropagation());
      }
    }
    panel.querySelector<HTMLButtonElement>('[data-plan-save]')?.addEventListener('click', () => {
      const name = nameInput?.value.trim();
      if (!name) return;
      const layouts = savedLayouts();
      if (!layouts[name] && Object.keys(layouts).length >= MAX_LAYOUTS) {
        showPlannerNotice(`You can keep ${MAX_LAYOUTS} layouts. Delete one first.`);
        return;
      }
      const recipes = Object.fromEntries([...planner.tiles].map(([key, tile]) => [key, toRecipe(tile)]));
      const problem = storeLayouts({ ...layouts, [name]: recipes });
      if (problem) {
        showPlannerNotice(problem);
        return;
      }
      renderPanel();
    });
    panel.querySelector<HTMLSelectElement>('[data-plan-load]')?.addEventListener('change', event => {
      const layout = savedLayouts()[(event.target as HTMLSelectElement).value];
      if (!layout) return;
      planner.tiles = new Map(Object.entries(layout).flatMap(([key, recipe]) => {
        const tile = fromRecipe(recipe);
        return tile ? [[key, tile] as [string, GardenTile]] : [];
      }));
      applyAllTiles();
      updateCount();
    });
    panel.querySelector<HTMLButtonElement>('[data-plan-delete]')?.addEventListener('click', () => {
      const name = panel!.querySelector<HTMLSelectElement>('[data-plan-load]')?.value;
      if (!name) return;
      const layouts = savedLayouts();
      delete layouts[name];
      storeLayouts(layouts);
      renderPanel();
    });
    refreshScaleControl(panel);
    const scaleInput = panel.querySelector<HTMLInputElement>('[data-plan-scale]');
    if (scaleInput) scaleInput.oninput = () => {
      planner.scale = Number(scaleInput.value);
      const label = panel!.querySelector<HTMLElement>('[data-plan-scale-value]');
      if (label) label.textContent = `${Number(scaleInput.value).toFixed(2)}x`;
      const maxButton = panel!.querySelector<HTMLButtonElement>('[data-plan-scale-max]');
      if (maxButton) maxButton.dataset.active = 'false';
    };
    panel.querySelector<HTMLButtonElement>('[data-plan-scale-max]')?.addEventListener('click', () => {
      planner.scale = null;
      renderPanel();
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-mount]').forEach(button => button.onclick = () => {
      planner.mountedSpecies = button.dataset.planMount || '';
      panel!.querySelectorAll<HTMLButtonElement>('[data-plan-mount]').forEach(other => {
        other.dataset.active = String((other.dataset.planMount || '') === planner.mountedSpecies);
      });
      refreshScaleControl(panel!);
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
  setInterval(() => {
    if (!planner.open) return;
    applyAllTiles();
    hideNativeCardUi();
  }, 1000);

  page.__gardenCompanionTogglePlanner = () => (planner.open ? close() : open());
  page.__gardenCompanionPlannerOpen = () => planner.open;
}
