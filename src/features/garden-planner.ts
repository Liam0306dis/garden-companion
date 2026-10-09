import { page } from '../page.js';
import type { GardenTile } from '../types.js';
import { DECOR_CATALOG, MUTATION_CATALOG, PLANT_CATALOG, plantName } from '../constants.js';
import { maxSizeMultiplier, sizeFromScale, slotScale } from '../crop-size.js';
import { createTicker } from '../ticker.js';
import { NUMBER_LOCALE } from '../utils.js';
import { onSpritesReady } from '../pets.js';

/**
 * Layout planner. Nothing is sent to the game server: planned plants are fed to the
 * game's own tile system as if the server had reported them, so the game draws them
 * with the correct sprite, slots, size and mutation overlays. Leaving edit mode
 * restores every tile from live state.
 */
export function initGardenPlanner(): void {
  const PLANTS = PLANT_CATALOG;
  const MUTATIONS = MUTATION_CATALOG;
  const DECOR = DECOR_CATALOG;
  const LAYOUT_KEY = 'gardenCompanion.layouts.v1';
  // One mutation per group can be on a crop, so picking one replaces the group's current choice.
  const MUTATION_GROUPS = [...new Set(Object.values(MUTATIONS).map(mutation => mutation.group))];
  const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Legendary', 'Mythic', 'Divine', 'Celestial'];
  // Storage buildings the game only ever lets you own one of, so the plan holds one of each too:
  // placing another moves the one already down rather than adding a second.
  const UNIQUE_DECOR = new Set(['FeedingTrough', 'DecorShed', 'PetHutch', 'SeedSilo', 'ToolShack']);

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
      // A mounted crop carries both its own `scale` and its `size`.
      const mountedCrop = PLANTS[planner.mountedSpecies]?.crop;
      const scale = scaleFor(planner.mountedSpecies);
      tile.mountedCrop = {
        id: crypto.randomUUID(),
        species: planner.mountedSpecies,
        itemType: 'Produce',
        scale,
        size: sizeFromScale(maxSizeMultiplier(mountedCrop), scale),
        mutations: [...planner.mutations],
      };
    }
    return tile;
  }

  /** Planned scale multiplier for a species, defaulting to its maximum and clamped to the legal range. */
  function scaleFor(species: string): number {
    const max = maxSizeMultiplier(PLANTS[species]?.crop);
    if (planner.scale === null) return max;
    return Math.min(max, Math.max(1, planner.scale));
  }

  /** The size field a planned crop slot carries, fed to the game's own tile system. */
  function slotSizeFields(species: string): { size: number } {
    return { size: sizeFromScale(maxSizeMultiplier(PLANTS[species]?.crop), scaleFor(species)) };
  }

  function formatWeight(weight: number): string {
    const digits = weight < 1 ? 2 : weight < 10 ? 1 : 0;
    return weight.toLocaleString(NUMBER_LOCALE, { minimumFractionDigits: digits, maximumFractionDigits: digits });
  }

  /**
   * The game's own size figure rather than the internal scale multiplier, so the slider reads the
   * way a crop's card does, plus the weight it works out to. Matches the crop value calculator. A
   * crop that cannot grow has no size to speak of, so it stays "fixed".
   */
  function sizeSummary(scale: number, species: string): string {
    const max = maxSizeMultiplier(PLANTS[species]?.crop);
    if (max <= 1) return 'fixed';
    const percent = `${sizeFromScale(max, scale)}%`;
    const baseWeight = Number(PLANTS[species]?.crop?.baseWeight || 0);
    return baseWeight > 0 ? `${percent} · ${formatWeight(scale * baseWeight)}kg` : percent;
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

  /** One decor on an edge. Edge decor has no rotation, only a mirror. */
  interface EdgeObject {
    objectType: 'decor';
    decorId: string;
    mirrored: boolean;
  }

  /**
   * What the game stores per edge in garden.edgeObjects: an edge holds a `line` (string lights) and
   * a `hanging` decor (a lantern or windchime) side by side, and at least one of them.
   */
  type EdgeParts = Partial<Record<EdgePart, EdgeObject>>;

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
    /** Edge decor by the game's edge key, `h:x:y` or `v:x:y` (see edgeKey). */
    edges: Map<string, EdgeParts>;
    painting: boolean;
    erasing: boolean;
    /** Weather to preview the garden under: 'live' leaves it be, 'clear' forces clear skies. */
    weather: string;
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
    edges: new Map(),
    painting: false,
    erasing: false,
    weather: 'live',
  };

  // Weather preview: the scene draws every system from one shared frame context whose `weatherId`
  // decides the sky, lighting and how plants and decor render. The planner forces that value
  // client-side - Rain, Snow, Dawn and the rest - without the server ever changing the weather.
  // 'live' passes through; leaving the planner drops back to it.
  const WEATHER_CHOICES: ReadonlyArray<{ id: string; label: string }> = [
    { id: 'live', label: 'Live' },
    { id: 'clear', label: 'Clear' },
    { id: 'Rain', label: 'Rain' },
    { id: 'Frost', label: 'Snow' },
    { id: 'Thunderstorm', label: 'Storm' },
    { id: 'Dawn', label: 'Dawn' },
    { id: 'AmberMoon', label: 'Amber' },
  ];

  /**
   * The scene object holding the frame context is out of reach, but the garden system is handed that
   * same context on every draw. Its weatherId is turned into an accessor the first time it passes
   * through: the scene still writes the real weather into it each frame, and everything that reads it
   * afterwards (the weather presence that drives rain and sky, every tile view) gets the planner's
   * choice while one is set. This replaced a wrap of engine.callDraw, which the game no longer has.
   */
  let weatherContext: Record<string, any> | null = null;

  function overrideContextWeather(context: Record<string, any>): void {
    weatherContext = context;
    let real = context.weatherId;
    Object.defineProperty(context, 'weatherId', {
      configurable: true,
      enumerable: true,
      get: () => planner.open && planner.weather !== 'live' ? (planner.weather === 'clear' ? null : planner.weather) : real,
      set: (value: unknown) => { real = value; },
    });
  }

  function patchWeatherDraw(): void {
    const system = tileSystem() as Record<string, any> | null;
    if (!system || typeof system.draw !== 'function' || system.__gcPlannerWeatherPatched) return;
    const original = system.draw;
    system.__gcPlannerWeatherPatched = true;
    system.draw = function(this: unknown, context: any, ...rest: unknown[]) {
      if (context && typeof context === 'object' && context !== weatherContext) {
        try { overrideContextWeather(context); } catch {}
      }
      return original.call(this, context, ...rest);
    };
  }

  function systems() {
    return page.__gardenCompanionFarmSystems ?? null;
  }

  function tileSystem(): Record<string, any> | null {
    const system = systems()?.tileSystem;
    return system?.map && typeof system.updateTileData === 'function' ? system : null;
  }

  // Set while the planner itself is pushing a tile, so the updateTileData hook lets our own writes
  // through instead of treating them as a server redraw to override.
  let applyingOwn = false;
  // Global tile index -> planner key, so the hook can tell a server redraw of one of our tiles from
  // any other tile the game updates. Rebuilt when the planner opens and on each poll.
  let globalToLocal = new Map<number, string>();

  function rebuildTileIndex(): void {
    globalToLocal = new Map(Object.entries(ownTileIndexes()).map(([local, global]) => [global, local]));
  }

  /**
   * The game redraws a tile from real server state on every state patch, which flashed the live
   * garden over the plan until the next poll re-applied it. Wrapping updateTileData substitutes the
   * planned tile in the same call the redraw happens, so the plan never blinks out. Our own writes
   * (flagged by applyingOwn) and tiles that are not ours pass straight through.
   */
  function patchTileUpdates(): void {
    const system = tileSystem();
    if (!system || (system as any).__gcPlannerOriginalUpdate) return;
    const original = system.updateTileData.bind(system) as (globalIndex: number, data: unknown) => unknown;
    (system as any).__gcPlannerOriginalUpdate = original;
    system.updateTileData = (globalIndex: number, data: unknown) => {
      if (planner.open && !applyingOwn) {
        const local = globalToLocal.get(globalIndex);
        if (local !== undefined) return original(globalIndex, planner.tiles.get(local));
      }
      return original(globalIndex, data);
    };
  }

  function unpatchTileUpdates(): void {
    const system = systems()?.tileSystem;
    const original = system && (system as any).__gcPlannerOriginalUpdate;
    if (!original) return;
    system.updateTileData = original;
    delete (system as any).__gcPlannerOriginalUpdate;
  }

  /**
   * Lanterns, string lights and windchimes hang on the edge between two tiles rather than on a
   * tile. Only game builds that know about edges have this method, so on older builds edge decor
   * just keeps going on tiles as before.
   */
  function edgeSupported(): boolean {
    return typeof tileSystem()?.updateEdgeObjectData === 'function';
  }

  function edgeDecorSelected(): boolean {
    return planner.mode === 'decor' && Boolean(DECOR[planner.decorId]?.edge) && edgeSupported();
  }

  /**
   * The edge counterpart of patchTileUpdates. The game redraws our own edges from its predicted
   * garden through updateAllEdgeObjectsInSlot, which calls this for every edge it holds or shows,
   * so substituting the planned edge here covers additions and removals alike.
   */
  function patchEdgeUpdates(): void {
    const system = tileSystem();
    if (!system || !edgeSupported() || (system as any).__gcPlannerOriginalEdgeUpdate) return;
    const original = system.updateEdgeObjectData.bind(system) as (slot: number, key: string, data: unknown) => unknown;
    (system as any).__gcPlannerOriginalEdgeUpdate = original;
    system.updateEdgeObjectData = (slot: number, key: string, data: unknown) => {
      if (planner.open && !applyingOwn && slot === ownSlotIndex()) return original(slot, key, planner.edges.get(key));
      return original(slot, key, data);
    };
  }

  function unpatchEdgeUpdates(): void {
    const system = systems()?.tileSystem;
    const original = system && (system as any).__gcPlannerOriginalEdgeUpdate;
    if (!original) return;
    system.updateEdgeObjectData = original;
    delete (system as any).__gcPlannerOriginalEdgeUpdate;
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

  function liveEdges(): Record<string, EdgeParts> {
    return (companionState()?.slot?.data?.garden?.edgeObjects ?? {}) as Record<string, EdgeParts>;
  }

  function edgeDecorCount(): number {
    let count = 0;
    for (const parts of planner.edges.values()) count += Object.keys(parts).length;
    return count;
  }

  function selectedEdgePart(): EdgePart {
    return DECOR[planner.decorId]?.edge ?? 'hanging';
  }

  /**
   * Edge keys count tiles from the top-left corner of the box around the garden's dirt and
   * boardwalk tiles, not from the world grid, which is how the game works them out too.
   */
  function gardenBounds(): { x: number; y: number; cols: number; rows: number } | null {
    const slot = ownSlotIndex();
    const map = tileSystem()?.map;
    if (slot === null || !map) return null;
    const globals = [
      ...Object.values(map.userSlotIdxAndDirtTileIdxToGlobalTileIdx?.[slot] ?? {}),
      ...Object.values(map.userSlotIdxAndBoardwalkTileIdxToGlobalTileIdx?.[slot] ?? {}),
    ] as number[];
    if (!globals.length) return null;
    const xs = globals.map(index => index % map.cols);
    const ys = globals.map(index => Math.floor(index / map.cols));
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    return { x, y, cols: Math.max(...xs) - x + 1, rows: Math.max(...ys) - y + 1 };
  }

  type Side = 'up' | 'right' | 'down' | 'left';

  /** The edge on one side of a garden-relative tile: `h` edges run along a tile's top, `v` edges down its left. */
  function edgeKey(x: number, y: number, side: Side): string {
    switch (side) {
      case 'up': return `h:${x}:${y}`;
      case 'down': return `h:${x}:${y + 1}`;
      case 'left': return `v:${x}:${y}`;
      case 'right': return `v:${x + 1}:${y}`;
    }
  }

  /** The edge on one side of one of our tiles, keyed "dirt:3" or "board:3". */
  function tileEdgeKey(localIndex: string, side: Side): string | null {
    const bounds = gardenBounds();
    const global = ownTileIndexes()[localIndex];
    const cols = tileSystem()?.map?.cols;
    if (!bounds || global === undefined || !cols) return null;
    return edgeKey(global % cols - bounds.x, Math.floor(global / cols) - bounds.y, side);
  }

  /**
   * How the game turns a held decor's rotation (flip included, see decorRotation) into an edge: the
   * side of the tile it hangs on and whether it is mirrored. Turning it walks it round the tile.
   */
  const ROTATION_TO_EDGE: ReadonlyArray<[number, Side, boolean]> = [
    [0, 'up', false], [-360, 'up', true], [90, 'right', true], [-90, 'right', false],
    [180, 'down', true], [-180, 'down', false], [270, 'left', false], [-270, 'left', true],
  ];

  function edgeFromRotation(rotation: number): { side: Side; mirrored: boolean } {
    const [, side, mirrored] = ROTATION_TO_EDGE.find(([angle]) => angle === rotation) ?? ROTATION_TO_EDGE[0];
    return { side, mirrored };
  }

  const SIDE_LABELS: Record<number, string> = { 0: 'Top', 90: 'Right', 180: 'Bottom', 270: 'Left' };

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

  function patchCapacity(species: string): number {
    const slots = Math.max(1, Number(PLANTS[species]?.slots || 1));
    return slots > 1 && !PLANTS[species]?.regrows ? slots : 0;
  }

  /**
   * The rare variants grow in their common cousin's patch rather than a patch of their own, which
   * is how the game stores them: the tile is a Snowdrop, and one of its slots is a SnowdropDouble.
   * Either species can host, so both directions are listed.
   */
  const PATCH_VARIANTS: Record<string, string> = {
    Snowdrop: 'SnowdropDouble', SnowdropDouble: 'Snowdrop',
    Daisy: 'PurpleDaisy', PurpleDaisy: 'Daisy',
    Clover: 'FourLeafClover', FourLeafClover: 'Clover',
    Cattail: 'VariegatedCattail', VariegatedCattail: 'Cattail',
  };

  function sharesPatch(host: string, species: string): boolean {
    return host === species || PATCH_VARIANTS[host] === species;
  }

  /**
   * `slotSpecies` grows a patch a crop at a time, and lets a patch hold a mix of a species and its
   * rare variant. Offsets are still calculated against the full capacity, so crops already down
   * keep their positions and each new one lands in a gap rather than the patch rearranging itself.
   */
  function plannedTile(species: string, mutations: string[], slotSpecies?: string[]): GardenTile {
    const now = Date.now();
    const capacity = Math.max(1, Number(PLANTS[species]?.slots || 1));
    const isPatch = patchCapacity(species) > 0;
    const contents = isPatch && slotSpecies?.length ? slotSpecies.slice(0, capacity) : null;
    const slots = contents?.length ?? capacity;
    // Displayed size is size x growth progress, and progress divides by the growth window,
    // so start and end must differ. Both sit in the past to render the plant fully grown.
    const started = now - 3_600_000;
    const matured = now - 60_000;
    return {
      objectType: 'plant',
      species,
      plantedAt: started,
      maturedAt: matured,
      slots: Array.from({ length: slots }, (_, slotId) => {
        const grown = contents?.[slotId] || PLANTS[species]?.slotSpecies?.[slotId] || species;
        return {
          species: grown,
          startTime: started,
          endTime: matured,
          ...slotSizeFields(grown),
          mutations: [...mutations],
          slotId,
          ...(isPatch ? patchSlotOffset(slotId, capacity) : {}),
        };
      }),
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
    applyingOwn = true;
    try { system.updateTileData(globalIndex, data); } catch {} finally { applyingOwn = false; }
  }

  function applyAllTiles(): void {
    for (const localIndex of Object.keys(ownTileIndexes())) applyTile(localIndex);
    applyAllEdges();
  }

  /**
   * Pushes every edge at once: the game's slot-wide update also removes edges it is showing that
   * the data no longer holds. Edge views compare data before rebuilding, so re-pushing an unchanged
   * edge costs nothing.
   */
  function applyAllEdges(): void {
    const system = tileSystem();
    const slot = ownSlotIndex();
    if (!system || slot === null || !edgeSupported()) return;
    const data = planner.open ? Object.fromEntries(planner.edges) : liveEdges();
    applyingOwn = true;
    try { system.updateAllEdgeObjectsInSlot(slot, data); } catch {} finally { applyingOwn = false; }
  }

  function applyEdge(key: string): void {
    const system = tileSystem();
    const slot = ownSlotIndex();
    if (!system || slot === null || !edgeSupported()) return;
    applyingOwn = true;
    try { system.updateEdgeObjectData(slot, key, planner.edges.get(key)); } catch {} finally { applyingOwn = false; }
  }

  /** The world position under the pointer in tiles, the fraction saying where inside the tile. */
  function worldTileAtPointer(event: PointerEvent | MouseEvent): { x: number; y: number } | null {
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
    return { x: world.x / 256, y: world.y / 256 };
  }

  /**
   * The edge the held decor would hang on, as in the game: the tile under the pointer picks the
   * tile, and the chosen facing picks which of its four sides.
   */
  function edgeAtPointer(event: PointerEvent | MouseEvent): string | null {
    const localIndex = tileAtPointer(event);
    return localIndex === null ? null : tileEdgeKey(localIndex, edgeFromRotation(decorRotation()).side);
  }

  function tileAtPointer(event: PointerEvent | MouseEvent): string | null {
    const system = tileSystem();
    const point = worldTileAtPointer(event);
    if (!system || !point) return null;
    const x = Math.floor(point.x);
    const y = Math.floor(point.y);
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
    if (label) label.textContent = `${planner.tiles.size + edgeDecorCount()} planned`;
  }

  /**
   * A patch is built up a crop at a time: the first click starts it, each further click on the same
   * tile adds one. `fill` skips straight to a full patch, which is what dragging across tiles and
   * shift-clicking both want. Anything that is not a patch is unchanged and lands whole.
   */
  function place(localIndex: string, fill = false): void {
    if (planner.mode === 'decor') {
      if (UNIQUE_DECOR.has(planner.decorId)) {
        // Move the one already planned instead of adding a second: clear any other tile holding it.
        for (const key of [...planner.tiles.keys()]) {
          if (key !== localIndex && planner.tiles.get(key)?.decorId === planner.decorId) {
            planner.tiles.delete(key);
            applyTile(key);
          }
        }
      }
      planner.tiles.set(localIndex, plannedDecor());
    } else {
      const existing = planner.tiles.get(localIndex);
      // The host keeps its own species, so dropping a rare variant into a common patch adds a crop
      // to that patch rather than turning the whole tile into the variant.
      const host = patchCapacity(planner.species) > 0 && !fill && existing?.objectType === 'plant' && existing.species
        && sharesPatch(existing.species, planner.species) ? existing.species : planner.species;
      // Measured on the host, since that is the tile the slots are being sliced against.
      const capacity = patchCapacity(host);
      const current = host === existing?.species ? (existing?.slots ?? []).map(slot => slot.species || host) : [];
      // A full patch has nowhere to append, so the click swaps the last crop instead. Without this
      // the new species is sliced back off and the click looks like it did nothing at all.
      const grown = host === planner.species && (fill || capacity === 0)
        ? undefined
        : current.length >= capacity
          ? [...current.slice(0, capacity - 1), planner.species]
          : [...current, planner.species];
      planner.tiles.set(localIndex, plannedTile(host, [...planner.mutations], grown));
    }
    applyTile(localIndex);
    updateCount();
  }

  function erase(localIndex: string): void {
    planner.tiles.delete(localIndex);
    applyTile(localIndex);
    updateCount();
  }

  /** Puts the selected decor in its part of the edge, leaving the other part as it was. */
  function placeEdge(key: string): void {
    const decor: EdgeObject = { objectType: 'decor', decorId: planner.decorId, mirrored: edgeFromRotation(decorRotation()).mirrored };
    planner.edges.set(key, { ...planner.edges.get(key), [selectedEdgePart()]: decor });
    applyEdge(key);
    updateCount();
  }

  /** Clears the selected decor's part of the edge, the way the game picks up one part at a time. */
  function eraseEdge(key: string): void {
    const parts = { ...planner.edges.get(key) };
    delete parts[selectedEdgePart()];
    if (Object.keys(parts).length) planner.edges.set(key, parts);
    else planner.edges.delete(key);
    applyEdge(key);
    updateCount();
  }

  function fromPlannerUi(event: Event): boolean {
    const target = event.target as HTMLElement | null;
    return Boolean(target?.closest?.('#gc-planner'));
  }

  function onPointerDown(event: PointerEvent): void {
    if (!planner.open || fromPlannerUi(event)) return;
    if (edgeDecorSelected()) {
      const key = edgeAtPointer(event);
      if (key === null) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.button === 2) {
        planner.erasing = true;
        eraseEdge(key);
      } else if (event.button === 0) {
        planner.painting = true;
        placeEdge(key);
      }
      return;
    }
    const localIndex = tileAtPointer(event);
    if (localIndex === null) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.button === 2) {
      planner.erasing = true;
      erase(localIndex);
    } else if (event.button === 0) {
      planner.painting = true;
      place(localIndex, event.shiftKey);
    }
  }

  function onPointerMove(event: PointerEvent): void {
    if (!planner.open || fromPlannerUi(event) || (!planner.painting && !planner.erasing)) return;
    if (edgeDecorSelected()) {
      const key = edgeAtPointer(event);
      if (key === null) return;
      const current = planner.edges.get(key)?.[selectedEdgePart()];
      if (planner.erasing) {
        if (current) eraseEdge(key);
      } else if (current?.decorId !== planner.decorId || current.mirrored !== edgeFromRotation(decorRotation()).mirrored) {
        placeEdge(key);
      }
      return;
    }
    const localIndex = tileAtPointer(event);
    if (localIndex === null) return;
    if (planner.erasing) {
      if (planner.tiles.has(localIndex)) erase(localIndex);
    } else if (planner.mode === 'decor'
      ? planner.tiles.get(localIndex)?.decorId !== planner.decorId
      : !sharesPatch(planner.tiles.get(localIndex)?.species ?? '', planner.species)) {
      // Dragging lays out an area rather than filling one tile, so each tile it crosses gets a
      // whole patch. Building one crop at a time is what clicking a single tile is for.
      place(localIndex, true);
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
    if (cinematicApplied || page.__gardenCompanionSetCinematic?.(true, 'gardenPlanner')) {
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
      page.__gardenCompanionSetCinematic?.(false, 'gardenPlanner');
      cinematicApplied = false;
    }
    for (const [node, visible] of hiddenNodes) {
      try { node.visible = visible; } catch {}
    }
    hiddenNodes.clear();
  }

  /**
   * The updateTileData hook keeps the plan in place synchronously; this is a backstop for any redraw
   * path that bypasses it, and keeps the native card UI hidden and the tile index fresh. It runs only
   * while the planner is open.
   */
  const backstop = createTicker(() => {
    if (!planner.open) return;
    rebuildTileIndex();
    patchTileUpdates();
    patchEdgeUpdates();
    patchWeatherDraw();
    applyAllTiles();
    hideNativeCardUi();
  }, 1000);

  // Opening asks for those sprites, so the palette is redrawn once they arrive rather than left blank.
  onSpritesReady(() => { if (planner.open) renderPanel(); });

  function open(): void {
    // Decor and growing-plant artwork is only decoded on demand, and the planner draws decor and full plants.
    page.__gardenCompanionLoadSpriteGroup?.('deferred');
    if (planner.open || !tileSystem()) return;
    planner.open = true;
    planner.tiles = new Map(Object.entries(liveTiles()).filter(([, tile]) => tile?.objectType === 'plant' || tile?.objectType === 'decor'));
    planner.edges = new Map(Object.entries(liveEdges()));
    rebuildTileIndex();
    patchTileUpdates();
    patchEdgeUpdates();
    patchWeatherDraw();
    applyAllTiles();
    hideNativeCardUi();
    document.body.classList.add('gc-planning');
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('pointerup', onPointerUp, true);
    window.addEventListener('contextmenu', blockEvent, true);
    renderPanel();
    backstop.start();
  }

  function close(): void {
    if (!planner.open) return;
    planner.open = false;
    backstop.stop();
    // Back to the real weather. The draw wrapper stays installed but passes straight through now.
    planner.weather = 'live';
    unpatchTileUpdates();
    unpatchEdgeUpdates();
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
    const max = maxSizeMultiplier(PLANTS[species]?.crop);
    const value = scaleFor(species);
    slider.max = max.toFixed(2);
    slider.value = value.toFixed(2);
    slider.disabled = max <= 1;
    const label = panel.querySelector<HTMLElement>('[data-plan-scale-value]');
    if (label) label.textContent = sizeSummary(value, species);
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
    /** Slot species for a part-filled or mixed patch. Absent means a full patch of `p`. */
    v?: string[];
    /** Set on a mirrored edge decor. Edge decor is saved under "edge:<part>:<the game's edge key>". */
    f?: 1;
  }

  const EDGE_PREFIX = 'edge:';

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
    const host = tile.species ?? '';
    const capacity = patchCapacity(host);
    const grown = (tile.slots ?? []).map(entry => entry.species || host);
    // Only stored when it differs from a full patch of the host species, which is the common case.
    const custom = capacity > 0 && grown.length > 0
      && (grown.length < capacity || grown.some(name => name !== host));
    return {
      p: tile.species,
      m: slot?.mutations ?? [],
      // Stored as a scale multiplier, which keeps older saved layouts readable. plannedTile turns
      // it back into `size`.
      s: round2(slotScale(PLANTS[host]?.crop, slot)),
      ...(custom ? { v: grown } : {}),
    };
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
      return recipe.p ? plannedTile(recipe.p, recipe.m ?? [], recipe.v) : null;
    } finally {
      planner.scale = previousScale;
    }
  }

  /** A saved layout's recipes as the planner's tiles and edges. */
  function layoutFromRecipes(layout: Record<string, TileRecipe>): { tiles: Map<string, GardenTile>; edges: Map<string, EdgeParts> } {
    const tiles = new Map<string, GardenTile>();
    const edges = new Map<string, EdgeParts>();
    const edgesWork = edgeSupported();
    const addEdge = (edge: string, decorId: string, mirrored: boolean) => {
      const part = DECOR[decorId]?.edge ?? 'hanging';
      const parts = edges.get(edge) ?? {};
      if (!parts[part]) edges.set(edge, { ...parts, [part]: { objectType: 'decor', decorId, mirrored } });
    };
    for (const [key, recipe] of Object.entries(layout)) {
      if (key.startsWith(EDGE_PREFIX)) {
        // The part comes from the decor itself, so the one in the key is only there to keep a line
        // and a hanging decor on the same edge apart.
        if (recipe.d) addEdge(key.slice(EDGE_PREFIX.length).replace(/^(line|hanging):/, ''), recipe.d, recipe.f === 1);
        continue;
      }
      // Layouts saved before edges existed hold lanterns and windchimes on tiles, where the game no
      // longer takes them. They move to the edge their facing pointed at, the way the game maps a
      // held decor's rotation onto an edge.
      if (edgesWork && recipe.d && DECOR[recipe.d]?.edge) {
        const { side, mirrored } = edgeFromRotation(recipe.r ?? 0);
        const edge = tileEdgeKey(key, side);
        if (edge) addEdge(edge, recipe.d, mirrored);
        continue;
      }
      const tile = fromRecipe(recipe);
      if (tile) tiles.set(key, tile);
    }
    return { tiles, edges };
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
      const label = `${plantName(name)} (${PLANTS[name]?.rarity || 'Common'}${slots > 1 ? `, ${slots} per tile` : ''})`;
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
    const scaleMax = maxSizeMultiplier(PLANTS[scaleSpecies]?.crop);
    const scaleValue = scaleFor(scaleSpecies);
    const previousScroll = panel.querySelector<HTMLElement>('.gc-planner-grid:not(.gc-planner-mount)')?.scrollTop ?? 0;
    panel.innerHTML = `<header><b>Layout planner</b><span data-plan-count>${planner.tiles.size + edgeDecorCount()} planned</span><button data-plan-close>Exit</button></header>
<div class="gc-planner-body"><small data-plan-notice>${edgeDecorSelected()
  ? 'Hangs on the side of the tile picked under Side. Left click places, right click removes. Nothing here is sent to the game.'
  : 'Left click places, right click removes. Drag to fill. Nothing here is sent to the game.'}</small>
<div class="gc-planner-modes"><button data-plan-mode="plants" class="${decorMode ? '' : 'active'}">Plants</button><button data-plan-mode="decor" class="${decorMode ? 'active' : ''}">Decor</button></div>
<div class="gc-planner-row"><b>Weather</b><div class="gc-planner-mutations"><div class="gc-planner-mutation-group gc-planner-weather">${WEATHER_CHOICES.map(choice => {
  const sprite = page.__gardenCompanionWeatherSprites?.[choice.id];
  return `<button data-plan-weather="${choice.id}" data-active="${planner.weather === choice.id}" title="${choice.label}">${sprite ? `<img src="${sprite}" alt="${choice.label}">` : choice.label}</button>`;
}).join('')}</div></div></div>
<div class="gc-planner-grid">${decorMode ? decorOptions : options}</div>
${decorMode && DECOR[planner.decorId]?.mountable
  ? `<div class="gc-planner-row"><b>Display crop</b><div class="gc-planner-mutations"><div class="gc-planner-mutation-group"><button data-plan-mount="" data-active="${!planner.mountedSpecies}">None</button></div></div></div>
<div class="gc-planner-grid gc-planner-mount">${sortedSpecies().map(name => {
  const sprite = page.__gardenCompanionProduceSprites?.[name] || page.__gardenCompanionShopSprites?.[name] || '';
  return `<button data-plan-mount="${name}" data-rarity="${PLANTS[name]?.rarity || 'Common'}" data-active="${name === planner.mountedSpecies}" title="${plantName(name)}">${sprite ? `<img src="${sprite}" alt="">` : `<i>${name.slice(0, 1)}</i>`}</button>`;
}).join('')}</div>
<div class="gc-planner-row"><b>Mutations</b><div class="gc-planner-mutations">${mutations}</div></div>`
  : ''}
${decorMode
  ? `${DECOR[planner.decorId]?.rotates || edgeDecorSelected()
      ? `<div class="gc-planner-row"><b>${edgeDecorSelected() ? 'Side' : 'Facing'}</b><div class="gc-planner-mutations"><div class="gc-planner-mutation-group">${[0, 90, 180, 270].map(angle => `<button data-plan-rotation="${angle}" data-active="${planner.rotation === angle}">${edgeDecorSelected() ? SIDE_LABELS[angle] : angle}</button>`).join('')}</div></div></div>`
      : ''}<div class="gc-planner-row"><b>Flip</b><div class="gc-planner-mutations"><div class="gc-planner-mutation-group"><button data-plan-flip="false" data-active="${!planner.flipped}">Normal</button><button data-plan-flip="true" data-active="${planner.flipped}">Flipped</button></div></div></div>`
  : `<div class="gc-planner-row"><b>Mutations</b><div class="gc-planner-mutations">${mutations}</div></div>`}
${decorMode && !DECOR[planner.decorId]?.mountable ? '' : `<div class="gc-planner-row"><b>Size</b><input class="gc-planner-scale" type="range" min="1" max="${scaleMax.toFixed(2)}" step="0.01" value="${scaleValue.toFixed(2)}" data-plan-scale><span data-plan-scale-value>${sizeSummary(scaleValue, scaleSpecies)}</span><button data-plan-scale-max data-active="${planner.scale === null}">Max</button></div>`}
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
      planner.edges.clear();
      applyAllTiles();
      updateCount();
    };
    panel.querySelector<HTMLButtonElement>('[data-plan-reset]')!.onclick = () => {
      planner.tiles = new Map(Object.entries(liveTiles()).filter(([, tile]) => tile?.objectType === 'plant' || tile?.objectType === 'decor'));
      planner.edges = new Map(Object.entries(liveEdges()));
      applyAllTiles();
      updateCount();
    };
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-mode]').forEach(button => button.onclick = () => {
      planner.mode = button.dataset.planMode as PlannerState['mode'];
      renderPanel();
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-weather]').forEach(button => button.onclick = () => {
      planner.weather = button.dataset.planWeather!;
      patchWeatherDraw();
      panel!.querySelectorAll<HTMLButtonElement>('[data-plan-weather]').forEach(other => {
        other.dataset.active = String(other.dataset.planWeather === planner.weather);
      });
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-plan-decor]').forEach(button => button.onclick = () => {
      const previous = planner.decorId;
      planner.decorId = button.dataset.planDecor!;
      if (!DECOR[planner.decorId]?.rotates && !DECOR[planner.decorId]?.edge) planner.rotation = 0;
      panel!.querySelectorAll<HTMLButtonElement>('[data-plan-decor]').forEach(other => {
        other.dataset.active = String(other.dataset.planDecor === planner.decorId);
      });
      // Redraw when the facing or display-crop rows need to appear or disappear.
      if (Boolean(DECOR[previous]?.rotates) !== Boolean(DECOR[planner.decorId]?.rotates)
        || Boolean(DECOR[previous]?.mountable) !== Boolean(DECOR[planner.decorId]?.mountable)
        || Boolean(DECOR[previous]?.edge) !== Boolean(DECOR[planner.decorId]?.edge)) renderPanel();
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
      const recipes: Record<string, TileRecipe> = Object.fromEntries([...planner.tiles].map(([key, tile]) => [key, toRecipe(tile)]));
      for (const [key, parts] of planner.edges) {
        for (const [part, edge] of Object.entries(parts)) {
          recipes[`${EDGE_PREFIX}${part}:${key}`] = { d: edge.decorId, ...(edge.mirrored ? { f: 1 as const } : {}) };
        }
      }
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
      ({ tiles: planner.tiles, edges: planner.edges } = layoutFromRecipes(layout));
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
      if (label) label.textContent = sizeSummary(Number(scaleInput.value), scaleSpecies);
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


  page.__gardenCompanionTogglePlanner = () => (planner.open ? close() : open());
  page.__gardenCompanionPlannerOpen = () => planner.open;
}
