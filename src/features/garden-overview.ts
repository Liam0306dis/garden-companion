import type { CompanionPage, PlantSlot, PlayerSlot, RoomState } from '../types.js';
import { PET_CATALOG, PLANT_CATALOG } from '../constants.js';

interface PlantCatalogEntry {
  crop?: { baseSellPrice?: number; maxScale?: number };
}

interface OverviewRuntimeState {
  slot?: PlayerSlot | null;
  room?: RoomState | null;
}

interface SpeciesStats {
  species: string;
  plants: number;
  crops: number;
  mature: number;
  value: number;
  mutations: Map<string, number>;
}

interface OverviewStats {
  plants: number;
  crops: number;
  mature: number;
  value: number;
  mutations: Map<string, number>;
  species: SpeciesStats[];
  nextMatureAt: number | null;
  allMatureAt: number | null;
  targetProgress: Record<string, number>;
  granterEtas: Array<{ mutation: string; pets: number; missing: number; total: number | null; meanSeconds: number; totalSeconds: number; countOnly?: boolean }>;
  unmutated: number;
  notMaxSize: number;
  allCrops: number;
  allTargetProgress: Record<string, number>;
  friendBonus: number;
}

const FILTER_KEY = 'gardenCompanion.overviewSpecies.v1';
const STYLE_ID = 'gc-overview-style';
const PANEL_ID = 'gc-overview-panel';
const BUTTON_ID = 'gc-overview-button';
const MUTATION_KEY = 'gardenCompanion.overviewMutations.v2';
const VIEW_KEY = 'gardenCompanion.overviewView.v1';
const FOCUS_KEY = 'gardenCompanion.overviewFocus.v1';
const SHORTCUT_KEY = 'gardenCompanion.overviewShortcut.v1';
const POSITION_KEY = 'gardenCompanion.overviewPosition.v1';
const DEFAULT_TARGETS = ['Rainbow', 'Gold', 'Frozen', 'Thunderstruck', 'Thundercharged', 'Wet', 'Chilled', 'Dawnlit', 'Dawncharged', 'Ambershine', 'Ambercharged'];
const GRANTERS: Record<string, { mutation: string; chance: number }> = {
  RainbowGranter: { mutation: 'Rainbow', chance: .72 },
  GoldGranter: { mutation: 'Gold', chance: .72 },
  FrostGranter: { mutation: 'Frozen', chance: 6 },
  ThunderstruckGranter: { mutation: 'Thunderstruck', chance: 5 },
  RainDance: { mutation: 'Wet', chance: 10 },
  SnowGranter: { mutation: 'Chilled', chance: 8 },
  DawnlitGranter: { mutation: 'Dawnlit', chance: 4 },
  AmberlitGranter: { mutation: 'Ambershine', chance: 2 },
};

interface MutationConfig {
  wet: boolean;
  chilled: boolean;
  frozen: boolean;
  amberlit: boolean;
  dawnlit: boolean;
  dawncharged: boolean;
  ambercharged: boolean;
  thunderstruck: boolean;
  thundercharged: boolean;
  rainbow: boolean;
  gold: boolean;
  none: boolean;
  combineRainbow: boolean;
  combineAmberDawn: boolean;
  combineDawnAmbercharged: boolean;
  combineFrozenThunderstruck: boolean;
  granterAllGarden: boolean;
  ignorePreserved: boolean;
}

const MUTATION_DEFAULTS: MutationConfig = {
  wet: false, chilled: false, frozen: true, amberlit: true, dawnlit: true, dawncharged: true, ambercharged: false,
  thunderstruck: false, thundercharged: false, rainbow: true, gold: true, none: true,
  combineRainbow: true, combineAmberDawn: true, combineDawnAmbercharged: false, combineFrozenThunderstruck: false,
  granterAllGarden: true, ignorePreserved: true,
};

const MUTATION_IDS: Record<keyof Pick<MutationConfig, 'wet' | 'chilled' | 'frozen' | 'amberlit' | 'dawnlit' | 'dawncharged' | 'ambercharged' | 'thunderstruck' | 'thundercharged' | 'rainbow' | 'gold'>, string> = {
  wet: 'Wet', chilled: 'Chilled', frozen: 'Frozen', amberlit: 'Ambershine', dawnlit: 'Dawnlit', dawncharged: 'Dawncharged', ambercharged: 'Ambercharged', thunderstruck: 'Thunderstruck', thundercharged: 'Thundercharged', rainbow: 'Rainbow', gold: 'Gold',
};

function loadMutationConfig(): MutationConfig {
  try {
    const stored = JSON.parse(localStorage.getItem(MUTATION_KEY) || 'null');
    if (Array.isArray(stored)) {
      const selected = new Set(stored);
      return { ...MUTATION_DEFAULTS, ...Object.fromEntries(Object.entries(MUTATION_IDS).map(([key, id]) => [key, selected.has(id)])) };
    }
    return { ...MUTATION_DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  } catch { return { ...MUTATION_DEFAULTS }; }
}

function saveMutationConfig(config: MutationConfig): void {
  try { localStorage.setItem(MUTATION_KEY, JSON.stringify(config)); } catch {}
}

function selectedMutations(config: MutationConfig): Set<string> {
  return new Set(Object.entries(MUTATION_IDS).filter(([key]) => config[key as keyof MutationConfig]).map(([, id]) => id));
}

interface FocusConfig {
  enabled: boolean;
  scope: string;
  mutations: string[];
  mutationRule: 'all' | 'any' | 'none';
  invert: boolean;
  opacity: number;
}

function loadFocus(): FocusConfig {
  try { return { enabled: false, scope: 'tracked', mutations: [], mutationRule: 'all', invert: false, opacity: .2, ...JSON.parse(localStorage.getItem(FOCUS_KEY) || '{}') }; }
  catch { return { enabled: false, scope: 'tracked', mutations: [], mutationRule: 'all', invert: false, opacity: .2 }; }
}

function saveFocus(config: FocusConfig): void {
  try { localStorage.setItem(FOCUS_KEY, JSON.stringify(config)); } catch {}
}

function installPlantFocus(
  page: CompanionPage,
  runtime: () => OverviewRuntimeState & { slotIndex?: number | null },
  selectedSpecies: () => Set<string> | null,
  focusConfig: () => FocusConfig,
  ignorePreserved: () => boolean,
): () => void {
  let tileSystem: any = null;
  const originalAlpha = new WeakMap<object, number>();
  const desiredAlpha = new WeakMap<object, number>();
  const managed = new Set<any>();
  const systemsByViews = new WeakMap<object, any>();

  function restore(display: any): void {
    if (!display || !originalAlpha.has(display)) return;
    if (!display.destroyed) display.alpha = originalAlpha.get(display);
    originalAlpha.delete(display);
    desiredAlpha.delete(display);
    managed.delete(display);
  }

  function restoreAll(): void {
    [...managed].forEach(restore);
  }

  function fade(display: any, opacity: number, seen: Set<any>): void {
    if (!display) return;
    if (!originalAlpha.has(display)) originalAlpha.set(display, Number.isFinite(display.alpha) ? display.alpha : 1);
    managed.add(display);
    const alpha = (originalAlpha.get(display) ?? 1) * opacity;
    desiredAlpha.set(display, alpha);
    display.alpha = alpha;
    seen.add(display);
  }

  function enforce(display: any): void {
    if (!display || !managed.has(display)) return;
    if (display.destroyed) {
      originalAlpha.delete(display);
      desiredAlpha.delete(display);
      managed.delete(display);
      return;
    }
    const alpha = desiredAlpha.get(display);
    if (Number.isFinite(alpha) && display.alpha !== alpha) display.alpha = alpha;
  }

  function cropContainer(crop: any): any {
    return crop?.cropVisual?.container || crop?.container || null;
  }

  function armView(view: any): void {
    if (!view || typeof view.draw !== 'function' || view.__gardenCompanionFocusDrawWrapped) return;
    const originalDraw = view.draw;
    view.__gardenCompanionFocusDrawWrapped = true;
    view.draw = function(...args: any[]) {
      const result = originalDraw.apply(this, args);
      enforce(view.childView?.plantVisual?.container);
      const crops = view.childView?.plantVisual?.getCropVisuals?.() || [];
      crops.forEach((crop: any) => enforce(cropContainer(crop)));
      return result;
    };
  }

  function matches(tile: any, slot: PlantSlot, config: FocusConfig): boolean {
    if (ignorePreserved() && slot.preserved) return false;
    const selected = selectedSpecies();
    const scopeMatches = config.scope === 'all' || config.scope === 'tracked' && (!selected || selected.has(tile.species)) || config.scope === tile.species;
    const mutations = slot.mutations || [];
    const mutationMatches = config.mutationRule === 'none'
      ? config.mutations.every(name => !mutations.includes(name))
      : config.mutationRule === 'any'
        ? config.mutations.some(name => mutations.includes(name))
        : config.mutations.length ? config.mutations.every(name => mutations.includes(name)) : mutations.length === 0;
    const result = scopeMatches && mutationMatches;
    return config.invert ? !result : result;
  }

  function capture(system: any): void {
    if (!system?.tileViews || !system?.map?.globalTileIdxToDirtTile || system === tileSystem) return;
    restoreAll();
    tileSystem = system;
    if (typeof system.destroy === 'function' && !system.__gardenCompanionFocusDestroyWrapped) {
      const originalDestroy = system.destroy;
      system.__gardenCompanionFocusDestroyWrapped = true;
      system.destroy = function(...args: any[]) {
        if (tileSystem === system) {
          restoreAll();
          tileSystem = null;
          setTimeout(armTileViewsCapture, 0);
        }
        return originalDestroy.apply(this, args);
      };
    }
    setTimeout(apply, 0);
  }

  const PageMap = page.Map as MapConstructor;
  const PageObject = page.Object as ObjectConstructor & { __gardenCompanionFocusDefineWrapped?: boolean };

  function armTileViewsCapture(): void {
    if (tileSystem) return;
    const prototype = PageObject.prototype as object;
    const existing = PageObject.getOwnPropertyDescriptor(prototype, 'tileViews');
    const existingGetter = existing?.get as (() => unknown) & { __gardenCompanionFocusTrap?: boolean } | undefined;
    if (existingGetter?.__gardenCompanionFocusTrap || existing && !existing.configurable) return;
    let storedValue: unknown;
    const getter = function(this: any) { return existingGetter ? existingGetter.call(this) : storedValue; } as (() => unknown) & { __gardenCompanionFocusTrap?: boolean };
    getter.__gardenCompanionFocusTrap = true;
    PageObject.defineProperty(prototype, 'tileViews', {
      configurable: true,
      get: getter,
      set: function(this: any, value: unknown) {
        if (existing?.set) existing.set.call(this, value);
        else PageObject.defineProperty(this, 'tileViews', { configurable: true, enumerable: true, writable: true, value });
        if (this?.name === 'tileObject' && value instanceof PageMap) capture(this);
      },
    });
  }

  const mapPrototype = PageMap?.prototype as Map<unknown, unknown> & { set: (...args: any[]) => any; __gardenCompanionFocusWrapped?: boolean };
  if (mapPrototype && !mapPrototype.__gardenCompanionFocusWrapped) {
    const originalSet = mapPrototype.set;
    mapPrototype.set = function(key: unknown, value: any) {
      const result = originalSet.call(this, key, value);
      try {
        const map = value?.map;
        const looksLikeTileView = Number.isInteger(key) && value?.globalTileIdx === key && value?.displayObject &&
          'tileObject' in value && typeof value.onDataChanged === 'function' && map?.globalTileIdxToDirtTile && map?.globalTileIdxToBoardwalk;
        if (looksLikeTileView && tileSystem?.tileViews !== this) {
          let system = systemsByViews.get(this);
          if (!system) { system = { name: 'tileObject', tileViews: this, map }; systemsByViews.set(this, system); }
          capture(system);
        }
      } catch {}
      return result;
    };
    mapPrototype.__gardenCompanionFocusWrapped = true;
  }

  if (!PageObject.__gardenCompanionFocusDefineWrapped) {
    const originalDefineProperty = PageObject.defineProperty;
    const wrappedDefineProperty = function(this: ObjectConstructor, target: object, property: PropertyKey, attributes: PropertyDescriptor & ThisType<any>): object {
      const result = originalDefineProperty(target, property, attributes) as object;
      try {
        if (property === 'tileViews' && (target as any)?.name === 'tileObject' && attributes?.value instanceof PageMap) capture(target);
      } catch {}
      return result;
    };
    PageObject.defineProperty = wrappedDefineProperty as typeof Object.defineProperty;
    PageObject.__gardenCompanionFocusDefineWrapped = true;
  }

  armTileViewsCapture();

  function apply(): void {
    const config = focusConfig();
    const slotIndex = runtime().slotIndex;
    const views = tileSystem?.tileViews;
    const dirtMap = tileSystem?.map?.globalTileIdxToDirtTile;
    if (!config.enabled || slotIndex == null || !(views instanceof PageMap) || !dirtMap) {
      restoreAll();
      return;
    }
    const seen = new Set<any>();
    views.forEach((view: any, globalIndex: number) => {
      const dirt = typeof dirtMap.get === 'function' ? dirtMap.get(globalIndex) : dirtMap[globalIndex];
      const tile = view?.tileObject;
      if (!dirt || dirt.userSlotIdx !== slotIndex || tile?.objectType !== 'plant') return;
      const slots: PlantSlot[] = tile.slots || [];
      const visible = new Map(slots.map(slot => [slot.slotId, matches(tile, slot, config)]));
      const plantVisual = view.childView?.plantVisual;
      const crops = plantVisual?.getCropVisuals?.() || [];
      armView(view);
      if (![...visible.values()].some(Boolean)) {
        fade(plantVisual?.container, config.opacity, seen);
        crops.forEach((crop: any) => restore(cropContainer(crop)));
      } else {
        restore(plantVisual?.container);
        crops.forEach((crop: any) => visible.get(crop?.slotId) === false ? fade(cropContainer(crop), config.opacity, seen) : restore(cropContainer(crop)));
      }
    });
    [...managed].forEach(display => { if (!seen.has(display)) restore(display); });
  }

  setInterval(apply, 600);
  return apply;
}

const COLOR_MULTIPLIERS: Record<string, number> = { Gold: 25, Rainbow: 50 };
const WEATHER_MULTIPLIERS: Record<string, number> = {
  Wet: 2,
  Chilled: 2,
  Frozen: 6,
  Thunderstruck: 5,
  Thundercharged: 7,
};
const TIME_MULTIPLIERS: Record<string, number> = {
  Dawnlit: 4,
  Dawnbound: 7,
  Dawncharged: 7,
  Ambershine: 6,
  Amberbound: 10,
  Ambercharged: 10,
};
const COMBINED_MULTIPLIERS: Record<string, number> = {
  'Wet+Dawnlit': 5,
  'Chilled+Dawnlit': 5,
  'Wet+Ambershine': 7,
  'Chilled+Ambershine': 7,
  'Frozen+Dawnlit': 9,
  'Frozen+Dawnbound': 12,
  'Frozen+Dawncharged': 12,
  'Frozen+Ambershine': 11,
  'Frozen+Amberbound': 15,
  'Frozen+Ambercharged': 15,
  'Thunderstruck+Dawnlit': 8,
  'Thunderstruck+Dawnbound': 11,
  'Thunderstruck+Dawncharged': 11,
  'Thunderstruck+Ambershine': 10,
  'Thunderstruck+Amberbound': 14,
  'Thunderstruck+Ambercharged': 14,
  'Thundercharged+Dawnlit': 10,
  'Thundercharged+Dawnbound': 13,
  'Thundercharged+Dawncharged': 13,
  'Thundercharged+Ambershine': 12,
  'Thundercharged+Amberbound': 16,
  'Thundercharged+Ambercharged': 16,
};

function loadFilter(): Set<string> | null {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return null;
    const values = JSON.parse(raw) as unknown;
    return Array.isArray(values) ? new Set(values.filter(value => typeof value === 'string')) : null;
  } catch {
    return null;
  }
}

function saveFilter(filter: Set<string>): void {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify([...filter].sort())); } catch {}
}

function loadStringSet(key: string, fallback: string[]): Set<string> {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    return Array.isArray(value) ? new Set(value.filter(item => typeof item === 'string')) : new Set(fallback);
  } catch { return new Set(fallback); }
}

function saveStringSet(key: string, value: Set<string>): void {
  try { localStorage.setItem(key, JSON.stringify([...value])); } catch {}
}

function loadView(): { ignorePreserved: boolean; mutationsOpen: boolean; plantsOpen: boolean; zoom: number; alarm: boolean } {
  try { return { ignorePreserved: true, mutationsOpen: true, plantsOpen: true, zoom: 1, alarm: false, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; }
  catch { return { ignorePreserved: true, mutationsOpen: true, plantsOpen: true, zoom: 1, alarm: false }; }
}

function saveView(view: { ignorePreserved: boolean; mutationsOpen: boolean; plantsOpen: boolean; zoom: number; alarm: boolean }): void {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {}
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character] ?? character);
}

function displayName(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function mutationMultiplier(mutations: readonly string[]): number {
  let color = 1;
  let weather: string | null = null;
  let time: string | null = null;
  for (const mutation of mutations) {
    color = Math.max(color, COLOR_MULTIPLIERS[mutation] ?? 1);
    if (WEATHER_MULTIPLIERS[mutation] && (!weather || WEATHER_MULTIPLIERS[mutation] > WEATHER_MULTIPLIERS[weather])) weather = mutation;
    if (TIME_MULTIPLIERS[mutation] && (!time || TIME_MULTIPLIERS[mutation] > TIME_MULTIPLIERS[time])) time = mutation;
  }
  const condition = weather && time
    ? COMBINED_MULTIPLIERS[`${weather}+${time}`] ?? Math.max(WEATHER_MULTIPLIERS[weather], TIME_MULTIPLIERS[time])
    : weather ? WEATHER_MULTIPLIERS[weather] : time ? TIME_MULTIPLIERS[time] : 1;
  return color * condition;
}

function countMutation(target: Map<string, number>, mutation: string): void {
  target.set(mutation, (target.get(mutation) ?? 0) + 1);
}

function calculateStats(
  runtime: OverviewRuntimeState,
  catalog: Record<string, PlantCatalogEntry> | null,
  filter: Set<string> | null,
  trackedMutations: Set<string>,
  ignorePreserved: boolean,
  mutationConfig: MutationConfig,
): OverviewStats {
  const result: OverviewStats = { plants: 0, crops: 0, mature: 0, value: 0, mutations: new Map(), species: [], nextMatureAt: null, allMatureAt: null, targetProgress: {}, granterEtas: [], unmutated: 0, notMaxSize: 0, allCrops: 0, allTargetProgress: {}, friendBonus: 1 };
  const bySpecies = new Map<string, SpeciesStats>();
  const tiles = runtime.slot?.data?.garden?.tileObjects ?? {};
  const friendCount = Math.min(5, Math.max(0, (runtime.room?.players?.length ?? 1) - 1));
  const friendMultiplier = 1 + friendCount * 0.1;
  result.friendBonus = friendMultiplier;
  const now = Date.now();
  const allMissing: Record<string, number> = {};
  const trackedMissing: Record<string, number> = {};
  const eligibleSlots: Array<{ slot: PlantSlot; species: string; tracked: boolean }> = [];

  function recordMissing(target: Record<string, number>, mutations: string[]): void {
    const thunder = mutations.includes('Thunderstruck') || mutations.includes('Thundercharged');
    const frozen = mutations.includes('Frozen');
    const wet = mutations.includes('Wet');
    const chilled = mutations.includes('Chilled');
    const noWeather = !thunder && !frozen && !wet && !chilled;
    const noTime = !mutations.some(name => ['Ambershine', 'Ambercharged', 'Amberbound', 'Dawnlit', 'Dawncharged', 'Dawnbound'].includes(name));
    const increment = (name: string, missing: boolean) => { if (missing) target[name] = (target[name] ?? 0) + 1; };
    increment('Rainbow', !mutations.includes('Rainbow') && !mutations.includes('Gold'));
    increment('Gold', !mutations.includes('Gold') && !mutations.includes('Rainbow'));
    increment('Frozen', !frozen && !thunder);
    increment('Thunderstruck', noWeather);
    increment('Wet', !wet && !thunder && !frozen);
    increment('Chilled', !chilled && !thunder && !frozen);
    increment('Ambershine', noTime);
    increment('Dawnlit', noTime);
  }

  for (const tile of Object.values(tiles)) {
    if (tile.objectType !== 'plant' || !tile.species || !Array.isArray(tile.slots)) continue;
    for (const slot of tile.slots as PlantSlot[]) {
      if (ignorePreserved && slot.preserved) continue;
      result.allCrops++;
      for (const mutation of slot.mutations ?? []) result.allTargetProgress[mutation] = (result.allTargetProgress[mutation] ?? 0) + 1;
      recordMissing(allMissing, slot.mutations ?? []);
      eligibleSlots.push({ slot, species: slot.species ?? tile.species, tracked: !filter || filter.has(slot.species ?? tile.species) });
    }
    if (filter && !filter.has(tile.species)) continue;
    let species = bySpecies.get(tile.species);
    if (!species) {
      species = { species: tile.species, plants: 0, crops: 0, mature: 0, value: 0, mutations: new Map() };
      bySpecies.set(tile.species, species);
    }
    result.plants++;
    species.plants++;
    for (const slot of tile.slots as PlantSlot[]) {
      if (ignorePreserved && slot.preserved) continue;
      result.crops++;
      species.crops++;
      recordMissing(trackedMissing, slot.mutations ?? []);
      const endTime = Number(slot.endTime ?? 0);
      if (endTime <= now) { result.mature++; species.mature++; }
      else {
        result.nextMatureAt = result.nextMatureAt === null ? endTime : Math.min(result.nextMatureAt, endTime);
        result.allMatureAt = result.allMatureAt === null ? endTime : Math.max(result.allMatureAt, endTime);
      }
      for (const mutation of slot.mutations ?? []) {
        countMutation(result.mutations, mutation);
        countMutation(species.mutations, mutation);
      }
      const slotMutations = slot.mutations ?? [];
      if (slotMutations.some(name => name === 'Rainbow' || name === 'Gold')) result.targetProgress.RainbowGold = (result.targetProgress.RainbowGold ?? 0) + 1;
      if (slotMutations.some(name => name === 'Frozen' || name === 'Thunderstruck')) result.targetProgress.FrozenThunderstruck = (result.targetProgress.FrozenThunderstruck ?? 0) + 1;
      if (slotMutations.some(name => name === 'Ambershine' || name === 'Dawnlit')) result.targetProgress.AmberDawn = (result.targetProgress.AmberDawn ?? 0) + 1;
      if (slotMutations.some(name => ['Dawncharged', 'Dawnbound', 'Ambercharged', 'Amberbound'].includes(name))) result.targetProgress.DawnAmbercharged = (result.targetProgress.DawnAmbercharged ?? 0) + 1;
      if (!(slot.mutations || []).length) result.unmutated++;
      const maximumScale = catalog?.[slot.species ?? tile.species]?.crop?.maxScale;
      if (maximumScale && Number(slot.targetScale ?? 1) < maximumScale) result.notMaxSize++;
      const base = catalog?.[slot.species ?? tile.species]?.crop?.baseSellPrice ?? 0;
      const value = Math.round(base * Number(slot.targetScale ?? 1) * mutationMultiplier(slot.mutations ?? []) * friendMultiplier);
      result.value += value;
      species.value += value;
    }
  }
  result.species = catalog
    ? Object.keys(catalog).map(species => bySpecies.get(species)).filter((row): row is SpeciesStats => Boolean(row))
    : [...bySpecies.values()];
  for (const target of trackedMutations) result.targetProgress[target] = result.mutations.get(target) ?? 0;
  const activePets = runtime.slot?.data?.petSlots ?? [];
  const inventoryPets = runtime.slot?.data?.inventory?.items?.filter(item => item.itemType === 'Pet') ?? [];
  const storedPets = runtime.slot?.data?.inventory?.storages?.flatMap(storage => storage.items?.filter(item => item.itemType === 'Pet') ?? []) ?? [];
  const availablePets = [...activePets, ...inventoryPets, ...storedPets];

  function petStrength(pet: (typeof activePets)[number]): number {
    const info = PET_CATALOG[pet.petSpecies];
    if (!info?.maxScale || !info.hoursToMature) return 87;
    const xpPerLevel = Math.floor(3600 * info.hoursToMature / 30);
    const xp = Math.min(Math.floor(Number(pet.xp ?? 0) / xpPerLevel), 30);
    const scale = Math.floor(((Number(pet.targetScale ?? 1) - 1) / (info.maxScale - 1)) * 20 + 80) - 30;
    return Math.max(0, Math.min(100, xp + scale));
  }

  function addEta(mutation: string, ability: string | string[], chance: number, missing: number, total: number | null, countOnly = false): void {
    const abilities = Array.isArray(ability) ? ability : [ability];
    const pets = activePets.filter(pet => pet.hunger > 0 && pet.abilities?.some(name => abilities.includes(name)));
    if (!pets.length) return;
    const combinedTickRate = 1 - pets.reduce((remaining, pet) => {
      const chancePerMinute = chance * petStrength(pet) / 100;
      return remaining * (1 - (1 - Math.pow(1 - chancePerMinute / 100, 1 / 60)));
    }, 1);
    if (combinedTickRate <= 0) return;
    const meanSeconds = 1 / combinedTickRate;
    result.granterEtas.push({ mutation, pets: pets.length, missing, total, meanSeconds, totalSeconds: missing * meanSeconds, countOnly });
  }

  const missingPool = mutationConfig.granterAllGarden ? allMissing : trackedMissing;
  const poolTotal = mutationConfig.granterAllGarden ? result.allCrops : result.crops;
  for (const [ability, rule] of Object.entries(GRANTERS)) {
    addEta(rule.mutation, ability, rule.chance, missingPool[rule.mutation] ?? 0, poolTotal);
  }

  function boostsUntilMax(ability: string | string[], baseBoost: number, cap: number): number {
    const abilities = Array.isArray(ability) ? ability : [ability];
    const strengths = availablePets.filter(pet => pet.abilities?.some(name => abilities.includes(name))).map(petStrength).sort((a, b) => b - a).slice(0, 3);
    const average = strengths.length ? strengths.reduce((sum, value) => sum + value, 0) / strengths.length : 87;
    const multiplier = 1 + baseBoost * average / 100;
    let maximum = 0;
    for (const candidate of eligibleSlots) {
      if (!mutationConfig.granterAllGarden && !candidate.tracked) continue;
      const maxScale = catalog?.[candidate.species]?.crop?.maxScale;
      if (!maxScale) continue;
      let scale = Number(candidate.slot.targetScale ?? 1);
      let boosts = 0;
      while (scale < maxScale && boosts <= cap) { scale *= multiplier; boosts++; }
      maximum = Math.max(maximum, boosts);
    }
    return maximum;
  }

  const maxSizeBoosts = boostsUntilMax(['ProduceScaleBoostII', 'Crop Size Boost II'], .1, 20);
  const beeSizeBoosts = boostsUntilMax('ProduceScaleBoost', .06, 200);
  addEta('Max Size', ['ProduceScaleBoostII', 'Crop Size Boost II'], .4, maxSizeBoosts, null, true);
  addEta('Bee Size', 'ProduceScaleBoost', .3, beeSizeBoosts, null, true);
  return result;
}

function injectStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_ID}{position:fixed;left:10px;bottom:10px;z-index:99988;width:32px;height:32px;padding:0;display:grid;place-items:center;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:8px;background:var(--gc-raised,#121219);color:var(--gc-text,#e4e4e7);font-size:16px;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.45)}
    #${BUTTON_ID}:hover{border-color:rgba(167,139,250,.35);background:rgba(167,139,250,.12)}
    #${PANEL_ID}{position:fixed;inset:0;z-index:999994;display:grid;place-items:center;padding:18px;box-sizing:border-box;background:transparent;pointer-events:none;color:var(--gc-text,#e4e4e7);font:12px/1.45 system-ui,sans-serif}
    #${PANEL_ID}[hidden]{display:none}
    #${PANEL_ID} .go-stage{display:flex;align-items:flex-start;gap:8px;pointer-events:none}
    #${PANEL_ID} .go-card{width:min(344px,94vw);max-height:90vh;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:12px;background:var(--gc-bg,#0c0c11);box-shadow:0 30px 90px rgba(0,0,0,.8),inset 0 1px rgba(255,255,255,.035)}
    #${PANEL_ID} .go-config-card{width:300px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden;pointer-events:auto;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:12px;background:var(--gc-bg,#0c0c11);box-shadow:0 30px 90px rgba(0,0,0,.8)}
    #${PANEL_ID} header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;color:#fafafa;background:linear-gradient(180deg,rgba(255,255,255,.035),transparent);border-bottom:1px solid var(--gc-line,rgba(255,255,255,.075));cursor:move}
    #${PANEL_ID} h2{flex:0 0 auto;margin:0;white-space:nowrap;font:700 14px/1.2 system-ui,sans-serif;letter-spacing:.02em}
    #${PANEL_ID} header .go-actions{display:flex;flex:0 0 auto;align-items:center;gap:4px}
    #${PANEL_ID} header button,#${PANEL_ID} button{padding:5px 9px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:6px;background:rgba(255,255,255,.03);color:var(--gc-text,#e4e4e7);cursor:pointer;font:700 10px system-ui,sans-serif}
    #${PANEL_ID} header button{width:26px;min-width:26px;height:26px;padding:0;border-radius:7px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:12px}
    #${PANEL_ID} header button[data-zoom]{width:34px;font-size:9px}
    #${PANEL_ID} header button[data-close]{border-radius:50%;color:var(--gc-muted,rgba(255,255,255,.72));background:transparent}
    #${PANEL_ID} header button[data-close]:hover{color:#fff;background:rgba(255,255,255,.07)}
    #${PANEL_ID} header button:hover,#${PANEL_ID} button:hover{color:#ddd6fe;border-color:rgba(167,139,250,.3);background:rgba(167,139,250,.1)}
    #${PANEL_ID} header button[data-active=true]{color:#ddd6fe;border-color:rgba(167,139,250,.5);background:rgba(167,139,250,.16)}
    #${PANEL_ID} .go-body{min-height:0;overflow:auto;padding:0;scrollbar-width:thin;scrollbar-color:rgba(255,255,255,.1) transparent}
    #${PANEL_ID} .go-config-body{min-height:0;overflow:auto;padding:0 12px 12px}
    #${PANEL_ID} .go-section{padding:11px 14px;border-bottom:1px solid var(--gc-line,rgba(255,255,255,.075))}#${PANEL_ID} .go-growth,#${PANEL_ID} .go-estimates{padding:12px 14px}
    #${PANEL_ID} .go-section-title{display:flex;align-items:center;justify-content:space-between;margin-bottom:7px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
    #${PANEL_ID} .go-section-title::after{content:'';height:1px;flex:1;margin-left:8px;background:var(--gc-line,rgba(255,255,255,.075))}
    #${PANEL_ID} .go-section-title>span:last-child{order:2;margin-left:8px;white-space:nowrap;font-size:9px;font-weight:400;letter-spacing:0}
    #${PANEL_ID} .go-summary{display:grid;grid-template-columns:repeat(2,1fr);gap:6px;margin:0}
    #${PANEL_ID} .go-metric{padding:8px 9px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:8px;background:var(--gc-soft,rgba(255,255,255,.035))}
    #${PANEL_ID} .go-metric small{display:block;color:var(--gc-muted,rgba(255,255,255,.72));font-size:9px;text-transform:uppercase;letter-spacing:.08em}#${PANEL_ID} .go-metric b{color:var(--gc-green,#34d399);font:700 15px/1.3 system-ui,sans-serif}
    #${PANEL_ID} .go-metric.go-growing b{color:var(--gc-gold,#fbbf24);font-size:17px}#${PANEL_ID} .go-metric.go-size b{color:#fb923c;font-size:17px}
    #${PANEL_ID} .go-progress{padding:5px 0}
    #${PANEL_ID} .go-progress>div{display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;color:var(--gc-text,#e4e4e7);font-size:12px}
    #${PANEL_ID} .go-progress span{display:flex;align-items:center;gap:7px}#${PANEL_ID} .go-progress span i{width:6px;height:6px;flex:0 0 auto;border-radius:50%}
    #${PANEL_ID} .go-progress b{font:700 12px system-ui,sans-serif}#${PANEL_ID} .go-progress>i{display:block;height:5px;overflow:hidden;border-radius:3px;background:rgba(255,255,255,.07)}
    #${PANEL_ID} .go-progress>i u{display:block;height:100%;border-radius:3px;text-decoration:none}
    #${PANEL_ID} .go-section-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:5px}#${PANEL_ID} .go-section-head .go-section-title{flex:1;margin:0}
    #${PANEL_ID} .go-section-head button{width:26px;height:26px;padding:0;font-size:13px}
    #${PANEL_ID} .go-eta-detail{padding:8px 0;color:var(--gc-text,#e4e4e7)}#${PANEL_ID} .go-eta-detail>div,#${PANEL_ID} .go-eta-done{display:flex;align-items:center;justify-content:space-between}#${PANEL_ID} .go-eta-detail span,#${PANEL_ID} .go-eta-done span{display:flex;align-items:center;gap:7px;font-size:12px}#${PANEL_ID} .go-eta-detail span i,#${PANEL_ID} .go-eta-done span i{width:6px;height:6px;flex:0 0 auto;border-radius:50%}#${PANEL_ID} .go-eta-detail b{font-size:12px}#${PANEL_ID} .go-eta-detail em{color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px;font-weight:400;font-style:normal;opacity:.7}#${PANEL_ID} .go-eta-detail>u{display:block;height:5px;margin-top:6px;overflow:hidden;border-radius:3px;background:rgba(255,255,255,.07);text-decoration:none}#${PANEL_ID} .go-eta-detail>u i{display:block;height:100%;border-radius:3px}#${PANEL_ID} .go-eta-detail>small{display:block;margin-top:5px;color:var(--gc-muted,rgba(255,255,255,.72));text-align:right;font-size:10px;opacity:.7}#${PANEL_ID} .go-eta-done{padding:6px 0;color:var(--gc-text,#e4e4e7)}#${PANEL_ID} .go-eta-done span i{background:var(--gc-green,#34d399)}#${PANEL_ID} .go-eta-done b{color:var(--gc-green,#34d399);font-size:12px}
    #${PANEL_ID} .go-plants{padding-left:10px}#${PANEL_ID} .go-plant-row{display:flex;justify-content:space-between;padding:3px 0;color:var(--gc-text,#e4e4e7);font-size:12px}
    #${PANEL_ID} .go-plant-row b{font-weight:700}
    #${PANEL_ID} .go-footer{display:flex;align-items:center;justify-content:space-between;padding:9px 14px;background:rgba(0,0,0,.18);border-top:1px solid var(--gc-line,rgba(255,255,255,.075));color:var(--gc-muted,rgba(255,255,255,.72))}
    #${PANEL_ID} .go-footer span{display:flex;align-items:center;gap:8px}#${PANEL_ID} .go-footer span small{padding:2px 7px;border-radius:5px;border:1px solid var(--gc-line,rgba(255,255,255,.075));background:rgba(255,255,255,.03);color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px}#${PANEL_ID} .go-footer b{color:var(--gc-gold,#fbbf24);font-size:19px}
    #${PANEL_ID} .go-filter{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;max-height:250px;margin:8px 0 12px;overflow:auto}#${PANEL_ID} .go-filter label{display:flex;align-items:center;gap:6px;padding:7px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:8px;background:var(--gc-soft,rgba(255,255,255,.035));color:var(--gc-text,#e4e4e7);cursor:pointer}
    #${PANEL_ID} .go-filter label:hover{border-color:rgba(255,255,255,.13)}
    #${PANEL_ID} .go-tools{display:flex;align-items:center;justify-content:space-between;gap:6px;margin:0 0 8px}#${PANEL_ID} .go-search{width:100%;box-sizing:border-box;height:32px;margin-bottom:8px;padding:0 10px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:7px;outline:none;background:#08080c;color:var(--gc-text,#e4e4e7);font:11px system-ui,sans-serif}
    #${PANEL_ID} .go-pill-list{max-height:320px;overflow:auto}#${PANEL_ID} .go-pill-section{margin:9px 0}#${PANEL_ID} .go-pill-section>b{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}#${PANEL_ID} .go-pill-section>b button{padding:3px 8px;font-size:9px;text-transform:none}#${PANEL_ID} .go-pill-section>div{display:flex;flex-wrap:wrap;gap:4px}
    #${PANEL_ID} button.go-pill{display:inline-flex;align-items:center;gap:5px;padding:5px 9px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:6px;background:rgba(255,255,255,.03);color:var(--gc-text,#e4e4e7);font-size:10px;white-space:nowrap}#${PANEL_ID} button.go-pill.on{color:#ddd6fe;border-color:rgba(167,139,250,.5);background:rgba(167,139,250,.16)}#${PANEL_ID} button.go-pill i{color:var(--gc-accent,#a78bfa);font-size:9px;font-style:normal}#${PANEL_ID} button.go-pill small{opacity:.5;font-size:9px}
    #${PANEL_ID} .go-search:focus{border-color:rgba(167,139,250,.5);box-shadow:0 0 0 2px rgba(167,139,250,.09)}#${PANEL_ID} .go-collapsible{cursor:pointer;margin:0}#${PANEL_ID} .go-muted{color:var(--gc-muted,rgba(255,255,255,.72));font-size:10px;opacity:.7}
    #${PANEL_ID} .go-config-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 0;border-top:1px solid var(--gc-line,rgba(255,255,255,.075))}
    #${PANEL_ID} .go-config-row select{max-width:150px;height:30px;padding:0 8px;border:1px solid var(--gc-line,rgba(255,255,255,.075));border-radius:7px;background:#08080c;color:var(--gc-text,#e4e4e7);font:11px system-ui,sans-serif;cursor:pointer}
    @media(max-width:760px){#${PANEL_ID}{padding:6px}#${PANEL_ID} .go-stage{max-height:100%;flex-direction:column;overflow:auto}#${PANEL_ID} .go-card{width:min(344px,94vw)}#${PANEL_ID} .go-config-card{width:min(300px,94vw)}#${PANEL_ID} header{padding:10px}#${PANEL_ID} header .go-actions{gap:2px}}
  `;
  document.head.appendChild(style);
}

function compactNumber(value: number): string {
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString();
}

function durationUntil(timestamp: number | null): string {
  if (!timestamp) return 'Ready';
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

export function initGardenOverview(): void {
  const page = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage;
  // Catalogs are captured once at start-up and shared, so this is simply the live view.
  const getCatalog = () => PLANT_CATALOG;
  let filter = loadFilter();
  let mutationConfig = loadMutationConfig();
  let trackedMutations = selectedMutations(mutationConfig);
  let view = loadView();
  view.ignorePreserved = mutationConfig.ignorePreserved;
  let focus = loadFocus();
  let shortcut = localStorage.getItem(SHORTCUT_KEY) || '';
  page.__gardenCompanionOverviewShortcutChanged = nextShortcut => { shortcut = nextShortcut; };
  let position: { left: number; top: number } | null = null;
  let configPosition: { left: number; top: number } | null = null;
  try { position = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null'); } catch {}
  let configMode: 'species' | 'mutations' | 'focus' | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let lastSignature = '';
  const previousMissing = new Map<string, number>();

  function keyCombo(event: KeyboardEvent): string {
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
    return parts.join('+');
  }

  function stopCompletionAlarm(): void {
    page.__gardenCompanionStopAlarm?.('overview');
  }

  function notifyCompletedMutation(name: string): void {
    if (!view.alarm) return;
    page.__gardenCompanionShowAlarm?.({
      owner: 'overview',
      label: 'GARDEN ALARM | MUTATION GRANTER',
      title: `${displayName(name)} target complete`,
      detail: 'All selected crops have this mutation',
    });
  }

  function checkCompletions(stats: OverviewStats): void {
    for (const row of stats.granterEtas) {
      const previous = previousMissing.get(row.mutation);
      if (previous !== undefined && previous > 0 && row.missing === 0) notifyCompletedMutation(row.mutation);
      previousMissing.set(row.mutation, row.missing);
    }
  }

  function runtime(): OverviewRuntimeState & { slotIndex?: number | null } {
    return (page.__gardenCompanionState ?? {}) as OverviewRuntimeState & { slotIndex?: number | null };
  }

  const applyPlantFocus = installPlantFocus(page, runtime, () => filter, () => focus, () => view.ignorePreserved);

  function knownSpecies(): string[] {
    const catalog = getCatalog();
    if (catalog) return Object.keys(catalog).sort();
    const tiles = runtime().slot?.data?.garden?.tileObjects ?? {};
    return [...new Set(Object.values(tiles).flatMap(tile => [tile.species, ...(tile.slots || []).map(slot => slot.species)]).filter((value): value is string => Boolean(value)))].sort();
  }

  function structureSignature(stats: OverviewStats): string {
    return JSON.stringify({
      plants: stats.plants, crops: stats.crops, mature: stats.mature, value: stats.value, unmutated: stats.unmutated, notMaxSize: stats.notMaxSize,
      mutations: [...stats.mutations], species: stats.species.map(row => [row.species, row.plants, row.crops, row.mature, row.value]),
      etas: stats.granterEtas.map(row => [row.mutation, row.pets, row.missing, Math.round(row.meanSeconds), Math.round(row.totalSeconds)]),
      filter: filter ? [...filter] : null, tracked: [...trackedMutations], mutationConfig, view, configMode,
    });
  }

  function updateCountdowns(panel: HTMLElement, stats: OverviewStats): void {
    const next = panel.querySelector<HTMLElement>('[data-live=next]');
    const all = panel.querySelector<HTMLElement>('[data-live=all]');
    if (next) next.textContent = durationUntil(stats.nextMatureAt);
    if (all) all.textContent = durationUntil(stats.allMatureAt);
  }

  function configHtml(species: string[]): string {
    if (configMode === 'species') {
      const selected = filter ?? new Set(species);
      const counts = new Map<string, number>();
      for (const tile of Object.values(runtime().slot?.data?.garden?.tileObjects ?? {})) if (tile.objectType === 'plant' && tile.species) counts.set(tile.species, (counts.get(tile.species) ?? 0) + 1);
      const section = (label: string, names: string[]) => names.length ? `<div class="go-pill-section"><b>${label} (${names.length})</b><div>${names.map(name => `<button class="go-pill ${selected.has(name) ? 'on' : ''}" data-species-toggle="${escapeHtml(name)}" data-filter-text="${escapeHtml(displayName(name).toLowerCase())}">${selected.has(name) ? '<i>&#10003;</i>' : ''}<span>${escapeHtml(displayName(name))}</span>${counts.has(name) ? `<small>&middot;${counts.get(name)}</small>` : ''}</button>`).join('')}</div></div>` : '';
      const tracked = species.filter(name => selected.has(name));
      const owned = species.filter(name => !selected.has(name) && counts.has(name));
      const rest = species.filter(name => !selected.has(name) && !counts.has(name));
      return `<section class="go-section"><div class="go-section-title"><span>Tracked plants</span><span>${selected.size}/${species.length}</span></div><input class="go-search" data-species-search placeholder="Search plants"><div class="go-tools"><button data-all>All</button><button data-none>None</button><button data-owned>Track owned</button></div><div class="go-pill-list">${section('Tracked', tracked)}${section('In your garden', owned)}${section('All plants', rest)}</div></section>`;
    }
    if (configMode === 'mutations') {
      const group = (label: string, pairs: Array<[keyof MutationConfig, string]>) => `<div class="go-pill-section"><b>${label}</b><div>${pairs.map(([key, name]) => `<button class="go-pill ${mutationConfig[key] ? 'on' : ''}" data-mutation-key="${key}">${mutationConfig[key] ? '<i>&#10003;</i>' : ''}<span>${name}</span></button>`).join('')}</div></div>`;
      return `<section class="go-section"><div class="go-section-title"><span>Mutation tracking</span><span>${trackedMutations.size} selected</span></div><div class="go-pill-list">${group('Color', [['rainbow', 'Rainbow'], ['gold', 'Gold']])}${group('Weather', [['frozen', 'Frozen'], ['thunderstruck', 'Thunderstruck'], ['thundercharged', 'Thundercharged'], ['wet', 'Wet'], ['chilled', 'Chilled']])}${group('Time', [['amberlit', 'Amberlit'], ['dawnlit', 'Dawnlit'], ['dawncharged', 'Dawnbound'], ['ambercharged', 'Amberbound']])}${group('Other', [['none', 'None']])}${group('Combine bars', [['combineRainbow', 'Rainbow + Gold'], ['combineAmberDawn', 'Amberlit + Dawnlit'], ['combineDawnAmbercharged', 'Dawnbound + Amberbound'], ['combineFrozenThunderstruck', 'Frozen + Thunderstruck']])}${group('Estimate scope', [['granterAllGarden', 'Whole garden'], ['ignorePreserved', 'Ignore preserved']])}</div></section>`;
    }
    if (configMode === 'focus') {
      const scopes = [['tracked', 'Tracked plants'], ['all', 'All plants'], ...species.map(name => [name, displayName(name)])];
      const foundMutations = new Set(DEFAULT_TARGETS);
      for (const tile of Object.values(runtime().slot?.data?.garden?.tileObjects ?? {})) for (const slot of tile.slots ?? []) for (const mutation of slot.mutations ?? []) foundMutations.add(mutation);
      for (const mutation of focus.mutations) foundMutations.add(mutation);
      return `<section class="go-section"><div class="go-section-title"><span>Plant focus</span><span>Fade non-matching crops</span></div><label class="go-config-row"><span>Enabled</span><input type="checkbox" data-focus-enabled ${focus.enabled ? 'checked' : ''}></label><label class="go-config-row"><span>Show</span><select data-focus-scope>${scopes.map(([value, label]) => `<option value="${escapeHtml(value)}" ${focus.scope === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label><label class="go-config-row"><span>Mutation rule</span><select data-focus-rule>${[['all', 'All selected'], ['any', 'Any selected'], ['none', 'None selected']].map(([value, label]) => `<option value="${value}" ${focus.mutationRule === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><div class="go-pill-section"><b>Mutations (${focus.mutations.length}) <button data-focus-clear>Clear</button></b><div>${[...foundMutations].map(name => `<button class="go-pill ${focus.mutations.includes(name) ? 'on' : ''}" data-focus-mutation="${escapeHtml(name)}">${focus.mutations.includes(name) ? '<i>&#10003;</i>' : ''}<span>${escapeHtml(displayName(name))}</span></button>`).join('')}</div></div><label class="go-config-row"><span>Invert match</span><input type="checkbox" data-focus-invert ${focus.invert ? 'checked' : ''}></label><label class="go-config-row"><span>Faded opacity <b data-opacity-value>${Math.round(focus.opacity * 100)}%</b></span><input type="range" min="5" max="60" step="5" value="${Math.round(focus.opacity * 100)}" data-focus-opacity></label></section>`;
    }
    return '';
  }

  function normalHtml(stats: OverviewStats): string {
    const mutationColors: Record<string, string> = { Rainbow: 'linear-gradient(90deg,#ff3b30,#ffcc00,#34c759,#5ac8fa,#af52de)', Gold: '#ffd700', Frozen: '#7ec8e3', Thunderstruck: '#ffd700', Thundercharged: '#fbbf24', Wet: '#4fc3f7', Chilled: '#81d4fa', Dawnlit: '#c084e8', Dawncharged: '#a855f7', Ambershine: '#ff8c00', Ambercharged: '#c45e00' };
    const rows: Array<[string, string, number]> = [];
    if (mutationConfig.combineRainbow && mutationConfig.rainbow && mutationConfig.gold) rows.push(['Rainbow / Gold', 'Rainbow', stats.targetProgress.RainbowGold ?? 0]);
    else { if (mutationConfig.rainbow) rows.push(['Rainbow', 'Rainbow', stats.targetProgress.Rainbow ?? 0]); if (mutationConfig.gold) rows.push(['Gold', 'Gold', stats.targetProgress.Gold ?? 0]); }
    if (mutationConfig.combineFrozenThunderstruck && mutationConfig.frozen && mutationConfig.thunderstruck) rows.push(['Frozen / Thunder', 'Frozen', stats.targetProgress.FrozenThunderstruck ?? 0]);
    else {
      if (mutationConfig.frozen) rows.push(['Frozen', 'Frozen', stats.targetProgress.Frozen ?? 0]);
      if (mutationConfig.thunderstruck) rows.push(['Thunderstruck', 'Thunderstruck', stats.targetProgress.Thunderstruck ?? 0]);
      if (mutationConfig.thundercharged) rows.push(['Thundercharged', 'Thundercharged', stats.targetProgress.Thundercharged ?? 0]);
    }
    if (mutationConfig.wet) rows.push(['Wet', 'Wet', stats.targetProgress.Wet ?? 0]);
    if (mutationConfig.chilled) rows.push(['Chilled', 'Chilled', stats.targetProgress.Chilled ?? 0]);
    if (mutationConfig.combineAmberDawn && mutationConfig.amberlit && mutationConfig.dawnlit) rows.push(['Amberlit / Dawnlit', 'Ambershine', stats.targetProgress.AmberDawn ?? 0]);
    else { if (mutationConfig.amberlit) rows.push(['Amberlit', 'Ambershine', stats.targetProgress.Ambershine ?? 0]); if (mutationConfig.dawnlit) rows.push(['Dawnlit', 'Dawnlit', stats.targetProgress.Dawnlit ?? 0]); }
    if (mutationConfig.combineDawnAmbercharged && mutationConfig.dawncharged && mutationConfig.ambercharged) rows.push(['Dawnbound / Amberbound', 'Ambercharged', stats.targetProgress.DawnAmbercharged ?? 0]);
    else { if (mutationConfig.dawncharged) rows.push(['Dawnbound', 'Dawncharged', stats.targetProgress.Dawncharged ?? 0]); if (mutationConfig.ambercharged) rows.push(['Amberbound', 'Ambercharged', stats.targetProgress.Ambercharged ?? 0]); }
    if (mutationConfig.none) rows.push(['None', 'Dawnlit', stats.unmutated]);
    const mutationRows = rows.filter(([, , count]) => count > 0).map(([label, colorKey, count]) => {
      const percent = stats.crops ? Math.min(100, count / stats.crops * 100) : 0;
      const color = mutationColors[colorKey] || '#4fc3f7';
      return `<div class="go-progress"><div><span><i style="background:${color}"></i>${escapeHtml(label)}</span><b style="color:${color}">${count}<small style="color:#444;font-weight:normal">/${stats.crops}</small></b></div><i><u style="width:${percent.toFixed(2)}%;background:${color}"></u></i></div>`;
    }).join('');
    function etaDuration(seconds: number): string {
      const minutes = Math.round(seconds / 60);
      const days = Math.floor(minutes / 1440);
      const hours = Math.floor(minutes % 1440 / 60);
      const remainder = minutes % 60;
      return days ? `${days}d ${hours}h ${remainder}m` : hours ? `${hours}h ${remainder}m` : minutes < 1 ? '<1m' : `${minutes}m`;
    }
    function averageDuration(seconds: number): string {
      const rounded = Math.round(seconds);
      const hours = Math.floor(rounded / 3600);
      const minutes = Math.floor(rounded % 3600 / 60);
      const remainder = rounded % 60;
      return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
    }
    const etaLabels: Record<string, [string, string]> = {
      Rainbow: ['&#127752; Rainbow', 'Rainbow'], Gold: ['&#129716; Gold', 'Gold'], Frozen: ['&#10052;&#65039; Frozen', 'Frozen'], Thunderstruck: ['&#9889; Thunderstruck', 'Thunderstruck'], Wet: ['&#128167; Wet', 'Wet'], Chilled: ['&#10053;&#65039; Chilled', 'Chilled'], Ambershine: ['&#10024; Amberlit', 'Ambershine'], Dawnlit: ['&#127749; Dawnlit', 'Dawnlit'], 'Max Size': ['&#127793; Max Size', 'Dawncharged'], 'Bee Size': ['&#128029; Bee Size', 'Dawncharged'],
    };
    const etaRows = stats.granterEtas.map(row => {
      const [label, colorKey] = etaLabels[row.mutation] ?? [escapeHtml(displayName(row.mutation)), row.mutation];
      const color = mutationColors[colorKey] || '#a78bfa';
      if (row.missing === 0) return `<div class="go-eta-done"><span><i></i>${label}</span><b>&#10003; done</b></div>`;
      const summary = `<small>avg ${averageDuration(row.meanSeconds)} &middot; ~${etaDuration(row.totalSeconds)} total</small>`;
      if (row.countOnly) return `<div class="go-eta-detail"><div><span><i style="background:${color}"></i>${label}</span><b style="color:${color}">${row.missing} <em>remaining</em></b></div>${summary}</div>`;
      const have = Math.max(0, (row.total ?? 0) - row.missing);
      const percent = row.total ? have / row.total * 100 : 0;
      return `<div class="go-eta-detail"><div><span><i style="background:${color}"></i>${label}</span><b style="color:${color}">${have}<em>/${row.total}</em></b></div><u><i style="width:${percent.toFixed(1)}%;background:${color}"></i></u>${summary}</div>`;
    }).join('');
    const plantCount = (plants: number, crops: number) => plants > 0 && plants !== crops ? `${plants} <small>(${crops})</small>` : `${crops}`;
    const plantRows = stats.species.map(row => `<div class="go-plant-row"><span>${escapeHtml(row.species)}</span><b>${plantCount(row.plants, row.crops)}</b></div>`).join('');
    const totalPlants = plantCount(stats.plants, stats.crops);
    const growing = Math.max(0, stats.crops - stats.mature);
    const growth = growing === 0 && stats.notMaxSize === 0
      ? '<div style="font-size:12px;color:#34d399;font-weight:bold;padding:2px 0">&#10004; All mature &amp; max size</div>'
      : growing === 0
        ? `<div style="font-size:12px;color:#ffd700;padding:2px 0">All mature - <b>${stats.notMaxSize}</b> not max size</div>`
      : `<div class="go-summary"><div class="go-metric go-growing"><small>Growing</small><b>${growing.toLocaleString()}</b></div>${stats.mature === 0 ? `<div class="go-metric"><small>First ready</small><b data-live="next">${durationUntil(stats.nextMatureAt)}</b></div>` : ''}<div class="go-metric go-size"><small>Not max size</small><b>${stats.notMaxSize.toLocaleString()}</b></div><div class="go-metric"><small>All ready</small><b data-live="all">${durationUntil(stats.allMatureAt)}</b></div></div>`;
    const bonus = Math.round((stats.friendBonus - 1) * 100);
    return `<section class="go-section go-growth"><div class="go-section-title"><span>Growth</span></div>${growth}</section>${etaRows ? `<section class="go-section go-estimates"><div class="go-section-head"><div class="go-section-title"><span>Mutation Estimates</span></div><button data-alarm data-active="${view.alarm}" title="${view.alarm ? 'Disable' : 'Enable'} completion alarm">${view.alarm ? '&#128276;' : '&#128277;'}</button></div>${etaRows}</section>` : ''}<section class="go-section"><div class="go-section-title go-collapsible" data-collapse="mutations"><span>Mutations</span><span>${view.mutationsOpen ? '&#9662;' : '&#9656;'}</span></div><div data-section="mutations" ${view.mutationsOpen ? '' : 'hidden'}>${mutationRows || '<p class="go-muted">No selected mutations are present.</p>'}</div></section><section class="go-section"><div class="go-section-title go-collapsible" data-collapse="plants"><span>Plants</span><span>${view.plantsOpen ? '&#9662;' : '&#9656;'}</span></div><div class="go-plants" data-section="plants" ${view.plantsOpen ? '' : 'hidden'}><div class="go-plant-row"><span>Total</span><b>${totalPlants}</b></div>${plantRows || '<p class="go-muted">No tracked plants found.</p>'}</div></section><div class="go-footer"><span>Est. value ${bonus ? `<small>+${bonus}% bonus</small>` : ''}</span><b>${compactNumber(stats.value)}</b></div>`;
  }

  function installDrag(card: HTMLElement, header: HTMLElement, save: ((left: number, top: number) => void) | null = null): void {
    header.onpointerdown = event => {
      if ((event.target as HTMLElement).closest('button')) return;
      const bounds = card.getBoundingClientRect();
      const offsetX = event.clientX - bounds.left;
      const offsetY = event.clientY - bounds.top;
      card.style.position = 'fixed';
      card.style.left = `${bounds.left}px`;
      card.style.top = `${bounds.top}px`;
      const move = (next: PointerEvent) => {
        card.style.left = `${Math.max(4, Math.min(innerWidth - card.offsetWidth - 4, next.clientX - offsetX))}px`;
        card.style.top = `${Math.max(4, Math.min(innerHeight - card.offsetHeight - 4, next.clientY - offsetY))}px`;
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        const left = parseFloat(card.style.left);
        const top = parseFloat(card.style.top);
        if (save && Number.isFinite(left) && Number.isFinite(top)) save(left, top);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish, { once: true });
    };
  }

  function bindSearch(input: HTMLInputElement | null): void {
    if (!input) return;
    input.oninput = () => {
      const query = input.value.trim().toLowerCase();
      input.parentElement?.querySelectorAll<HTMLElement>('[data-filter-text]').forEach(row => { row.hidden = Boolean(query && !row.dataset.filterText?.includes(query)); });
    };
  }

  function render(force = false): void {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || (panel.hidden && !view.alarm)) return;
    const stats = calculateStats(runtime(), getCatalog(), filter, trackedMutations, view.ignorePreserved, mutationConfig);
    checkCompletions(stats);
    if (panel.hidden) return;
    if (!force && panel.contains(document.activeElement)) { updateCountdowns(panel, stats); return; }
    const signature = structureSignature(stats);
    if (!force && signature === lastSignature) { updateCountdowns(panel, stats); return; }
    lastSignature = signature;
    const body = panel.querySelector<HTMLElement>('.go-body');
    const scrollTop = body?.scrollTop ?? 0;
    const species = knownSpecies();
    const placement = position ? `position:fixed;left:${Math.max(0, Math.min(innerWidth - 300, position.left))}px;top:${Math.max(0, Math.min(innerHeight - 100, position.top))}px;` : '';
    const configPlacement = configPosition ? `style="position:fixed;left:${Math.max(4, Math.min(innerWidth - 304, configPosition.left))}px;top:${Math.max(4, Math.min(innerHeight - 104, configPosition.top))}px"` : '';
    const configTitle = configMode === 'species' ? 'Tracked Plants' : configMode === 'mutations' ? 'Mutation Config' : 'Plant Focus';
    const configPanel = configMode ? `<div class="go-config-card" ${configPlacement}><header><h2>${escapeHtml(configTitle)}</h2><button data-config-close aria-label="Close">&#10005;</button></header><div class="go-config-body">${configHtml(species)}</div></div>` : '';
    panel.innerHTML = `<div class="go-stage"><div class="go-card" style="${placement}transform:scale(${view.zoom});transform-origin:top left"><header><h2>&#x1F33F; Garden Overview</h2><div class="go-actions"><button data-species-config title="Configure tracked plants">&#x1F33F;</button><button data-focus-config data-active="${focus.enabled}" title="Configure plant focus">&#9680;</button><button data-mutation-config title="Configure tracked mutations">&#128295;</button><button data-zoom title="Cycle zoom">${view.zoom}x</button><button data-close aria-label="Close">&#10005;</button></div></header><div class="go-body">${normalHtml(stats)}</div></div>${configPanel}</div>`;
    const nextBody = panel.querySelector<HTMLElement>('.go-body');
    if (nextBody) nextBody.scrollTop = scrollTop;
    panel.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
    panel.querySelector<HTMLButtonElement>('[data-config-close]')?.addEventListener('click', () => { configMode = null; render(true); });
    panel.querySelector<HTMLButtonElement>('[data-species-config]')!.onclick = () => { configMode = configMode === 'species' ? null : 'species'; render(true); };
    panel.querySelector<HTMLButtonElement>('[data-focus-config]')!.onclick = () => { configMode = configMode === 'focus' ? null : 'focus'; render(true); };
    panel.querySelector<HTMLButtonElement>('[data-mutation-config]')!.onclick = () => { configMode = configMode === 'mutations' ? null : 'mutations'; render(true); };
    const alarmButton = panel.querySelector<HTMLButtonElement>('[data-alarm]');
    if (alarmButton) alarmButton.onclick = () => {
      view.alarm = !view.alarm;
      if (view.alarm) {
        page.__gardenCompanionArmAlarm?.();
        ensureRefreshTimer();
      } else stopCompletionAlarm();
      saveView(view);
      render(true);
    };
    panel.querySelector<HTMLButtonElement>('[data-zoom]')!.onclick = () => { const values = [1, 1.25, 1.5]; view.zoom = values[(values.indexOf(view.zoom) + 1) % values.length]; saveView(view); render(true); };
    panel.querySelector<HTMLButtonElement>('[data-all]')?.addEventListener('click', () => { filter = null; localStorage.removeItem(FILTER_KEY); render(true); });
    panel.querySelector<HTMLButtonElement>('[data-none]')?.addEventListener('click', () => { filter = new Set(); saveFilter(filter); render(true); });
    panel.querySelector<HTMLButtonElement>('[data-owned]')?.addEventListener('click', () => {
      filter = new Set(filter ?? []);
      for (const tile of Object.values(runtime().slot?.data?.garden?.tileObjects ?? {})) if (tile.objectType === 'plant' && tile.species) filter.add(tile.species);
      saveFilter(filter); render(true);
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-species-toggle]').forEach(button => button.onclick = () => {
      const name = button.dataset.speciesToggle ?? '';
      filter = new Set(filter ?? species);
      filter.has(name) ? filter.delete(name) : filter.add(name);
      saveFilter(filter); render(true);
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-mutation-key]').forEach(button => button.onclick = () => {
      const key = button.dataset.mutationKey as keyof MutationConfig;
      mutationConfig[key] = !mutationConfig[key];
      mutationConfig.ignorePreserved = Boolean(mutationConfig.ignorePreserved);
      view.ignorePreserved = mutationConfig.ignorePreserved;
      trackedMutations = selectedMutations(mutationConfig);
      saveMutationConfig(mutationConfig); saveView(view); render(true);
    });
    const saveFocusControls = () => { saveFocus(focus); applyPlantFocus(); lastSignature = ''; };
    const focusEnabled = panel.querySelector<HTMLInputElement>('[data-focus-enabled]');
    if (focusEnabled) focusEnabled.onchange = () => { focus.enabled = focusEnabled.checked; saveFocusControls(); focusEnabled.blur(); };
    const focusScope = panel.querySelector<HTMLSelectElement>('[data-focus-scope]');
    if (focusScope) focusScope.onchange = () => { focus.scope = focusScope.value; saveFocusControls(); };
    const focusRule = panel.querySelector<HTMLSelectElement>('[data-focus-rule]');
    if (focusRule) focusRule.onchange = () => { focus.mutationRule = focusRule.value as FocusConfig['mutationRule']; saveFocusControls(); };
    panel.querySelectorAll<HTMLButtonElement>('[data-focus-mutation]').forEach(button => button.onclick = () => { const selected = new Set(focus.mutations); const mutation = button.dataset.focusMutation ?? ''; selected.has(mutation) ? selected.delete(mutation) : selected.add(mutation); focus.mutations = [...selected]; saveFocusControls(); render(true); });
    panel.querySelector<HTMLButtonElement>('[data-focus-clear]')?.addEventListener('click', () => { focus.mutations = []; saveFocusControls(); render(true); });
    const focusInvert = panel.querySelector<HTMLInputElement>('[data-focus-invert]');
    if (focusInvert) focusInvert.onchange = () => { focus.invert = focusInvert.checked; saveFocusControls(); focusInvert.blur(); };
    const focusOpacity = panel.querySelector<HTMLInputElement>('[data-focus-opacity]');
    if (focusOpacity) focusOpacity.oninput = () => { focus.opacity = Number(focusOpacity.value) / 100; const label = panel.querySelector<HTMLElement>('[data-opacity-value]'); if (label) label.textContent = `${focusOpacity.value}%`; saveFocusControls(); };
    panel.querySelectorAll<HTMLElement>('[data-collapse]').forEach(toggle => toggle.onclick = () => {
      const key = toggle.dataset.collapse;
      if (key === 'mutations') view.mutationsOpen = !view.mutationsOpen;
      if (key === 'plants') view.plantsOpen = !view.plantsOpen;
      saveView(view); render(true);
    });
    bindSearch(panel.querySelector('[data-species-search]'));
    installDrag(panel.querySelector('.go-card')!, panel.querySelector('.go-card > header')!, (left, top) => {
      position = { left, top };
      localStorage.setItem(POSITION_KEY, JSON.stringify(position));
    });
    const configCard = panel.querySelector<HTMLElement>('.go-config-card');
    const configHeader = configCard?.querySelector<HTMLElement>('header');
    if (configCard && configHeader) installDrag(configCard, configHeader, (left, top) => { configPosition = { left, top }; });
  }

  function open(): void {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    panel.hidden = false;
    lastSignature = '';
    render(true);
    ensureRefreshTimer();
  }

  function close(): void {
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.hidden = true;
    if (!view.alarm && refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; }
  }

  function ensureRefreshTimer(): void {
    if (!refreshTimer) refreshTimer = setInterval(() => render(false), 1000);
  }

  function toggle(): void {
    const panel = document.getElementById(PANEL_ID);
    if (panel?.hidden) open();
    else close();
  }

  function mount(): void {
    injectStyles();
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.innerHTML = '&#x1F33F;';
    button.title = 'Garden Overview';
    button.onclick = toggle;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.hidden = true;
    document.body.append(button, panel);
    if (view.alarm) ensureRefreshTimer();
    window.addEventListener('keydown', event => {
      if (!shortcut || event.repeat || ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement as HTMLElement | null)?.tagName || '')) return;
      if (keyCombo(event) !== shortcut) return;
      event.preventDefault(); event.stopImmediatePropagation(); toggle();
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
