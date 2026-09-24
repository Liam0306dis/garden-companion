import { installPlantFocus, loadFocus, loadFocusPresets, presetConfigOf, PRESET_LIMIT, PRESET_NAME_LIMIT, saveFocus, saveFocusPresets, type FocusConfig } from './overview-focus.js';
import { BUTTON_ID, injectOverviewStyles, PANEL_ID } from './overview-styles.js';
import { escapeHtml } from '../utils.js';
import { page } from '../page.js';
import { comboFromEvent, overviewShortcut } from '../key-combo.js';
import { catalogMutationMultiplier } from '../mutation-value.js';
import type { PlantSlot, PlayerSlot, RoomState } from '../types.js';
import { ABILITY_DETAILS, MUTATION_CATALOG, PATCH_FAMILY_OF, patchName, PLANT_CATALOG, plantName } from '../constants.js';
import { currentWeather } from './weather-timer.js';

/** Plant Growth Boost abilities and the weather each seasonal tier needs to be active. */
const PLANT_GROWTH_ABILITIES = new Set(['PlantGrowthBoost', 'PlantGrowthBoostII', 'PlantGrowthBoostIII', 'SnowyPlantGrowthBoost', 'DawnPlantGrowthBoost', 'AmberPlantGrowthBoost', 'ThunderPlantGrowthBoost']);
const PLANT_GROWTH_WEATHER: Record<string, string> = { SnowyPlantGrowthBoost: 'Frost', DawnPlantGrowthBoost: 'Dawn', AmberPlantGrowthBoost: 'AmberMoon', ThunderPlantGrowthBoost: 'Thunderstorm' };
import { crystalStrengthBonus, mutationSprite, onSpritesReady, petMetrics, produceSprite } from '../pets.js';
import { maxSizeMultiplier, slotIsMaxSize, slotScale } from '../crop-size.js';
import { toast } from '../toast.js';
import { NAME_OVERRIDES, NUMBER_LOCALE } from '../utils.js';

interface PlantCatalogEntry {
  crop?: { baseSellPrice?: number; maxScale?: number; maxSizeMultiplier?: number };
}

export interface OverviewRuntimeState {
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
  /** One-time sell total: base x size x mutation x friend, summed over every crop. */
  value: number;
  /** value scaled by expected DoubleHarvest / ProduceRefund yield from active fed pets. */
  projectedValue: number;
  doubleHarvestMult: number;
  cropRefundMult: number;
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
  /** Seconds of growth progressed per real second from active Plant Growth Boost pets. */
  growthRate: number;
}

const FILTER_KEY = 'gardenCompanion.overviewSpecies.v1';
const MUTATION_KEY = 'gardenCompanion.overviewMutations.v2';
const VIEW_KEY = 'gardenCompanion.overviewView.v1';
const OPEN_FAMILIES_KEY = 'gardenCompanion.overviewOpenFamilies.v1';

/** Which patch rows are expanded to show the species inside them. Remembered between sessions. */
const openFamilies = new Set<string>((() => {
  try { return JSON.parse(localStorage.getItem(OPEN_FAMILIES_KEY) || '[]') as string[]; }
  catch { return []; }
})());

function saveOpenFamilies(): void {
  try { localStorage.setItem(OPEN_FAMILIES_KEY, JSON.stringify([...openFamilies])); } catch {}
}
const ALARM_TARGETS_KEY = 'gardenCompanion.overviewAlarmTargets.v1';
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
const ALARM_TARGETS = [...new Set(Object.values(GRANTERS).map(rule => rule.mutation)), 'Max Size'];

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

function loadAlarmTargets(defaults: Set<string>): Set<string> {
  try {
    const stored = localStorage.getItem(ALARM_TARGETS_KEY);
    if (stored === null) return new Set([...defaults].filter(target => ALARM_TARGETS.includes(target)));
    const parsed = JSON.parse(stored) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((target): target is string => typeof target === 'string' && ALARM_TARGETS.includes(target)) : []);
  } catch { return new Set([...defaults].filter(target => ALARM_TARGETS.includes(target))); }
}

function saveAlarmTargets(targets: Set<string>): void {
  try { localStorage.setItem(ALARM_TARGETS_KEY, JSON.stringify([...targets])); } catch {}
}

// A crop only ever carries one mutation from each catalog group. The focus picker reuses that to stop people asking for combinations no
// crop can satisfy. Labels match the value calculator so the two pickers read the same.
const ZOOM_LEVELS = [1, 1.25, 1.5];
const MUTATION_GROUP_ORDER = ['Growth', 'Hydro', 'Lunar'];
const MUTATION_GROUP_LABELS: Record<string, string> = { Growth: 'Colour', Hydro: 'Weather', Lunar: 'Lunar' };
function mutationGroupOf(mutation: string): string | null {
  return MUTATION_CATALOG[mutation]?.group ?? null;
}
/** The catalog name is what the game itself calls the mutation, so tooltips match the crop card. */
function mutationLabel(mutation: string): string {
  return MUTATION_CATALOG[mutation]?.name || displayName(mutation);
}

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

function loadView(): { ignorePreserved: boolean; mutationsOpen: boolean; plantsOpen: boolean; zoom: number; alarm: boolean } {
  try { return { ignorePreserved: true, mutationsOpen: true, plantsOpen: true, zoom: 1, alarm: false, ...JSON.parse(localStorage.getItem(VIEW_KEY) || '{}') }; }
  catch { return { ignorePreserved: true, mutationsOpen: true, plantsOpen: true, zoom: 1, alarm: false }; }
}

function saveView(view: { ignorePreserved: boolean; mutationsOpen: boolean; plantsOpen: boolean; zoom: number; alarm: boolean }): void {
  try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch {}
}

/**
 * Crops defer to the shared name, which knows the game calls DawnCelestial a Dawnbinder and drops
 * the trailing Fruit off a Starweaver. Anything else here is a mutation or an alarm target, which
 * only ever needs its id split on capitals.
 */
function displayName(value: string): string {
  if (PLANT_CATALOG[value]) return plantName(value);
  // A mutation carries its own display name - Ambershine shows as Amberlit - and this is reached
  // with a mutation id from the completion alarm and the alarm-target picker, not just plant ids.
  if (MUTATION_CATALOG[value]) return MUTATION_CATALOG[value].name;
  return NAME_OVERRIDES[value] ?? value.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

interface PlantRow { label: string; species: string; tiles: number; crops: number; child: boolean; family?: string; open?: boolean }

/**
 * Tiles are counted per patch family, crops per species. A purple daisy grows in the same patch as
 * a daisy and either can seed it, so no single species owns the tile; counting the family keeps the
 * tiles column equal to the dirt tiles actually occupied. A family with only one of its species in
 * the garden stays a single row, since there is nothing to disambiguate.
 */
function plantRowList(rows: readonly SpeciesStats[]): PlantRow[] {
  const groups = new Map<string, SpeciesStats[]>();
  for (const row of rows) {
    const key = PATCH_FAMILY_OF[row.species] ?? row.species;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  // Biggest holdings first: the catalog order buried whatever the player actually grows a lot of
  // somewhere down a list of every species in the game.
  const bySize = (left: { crops: number; tiles: number; label: string }, right: { crops: number; tiles: number; label: string }) =>
    right.crops - left.crops || right.tiles - left.tiles || left.label.localeCompare(right.label);
  const list: PlantRow[] = [];
  const families: Array<{ row: PlantRow; children: PlantRow[] }> = [];
  for (const [key, members] of groups) {
    const present = members.filter(member => member.crops > 0 || member.plants > 0);
    const shown = present.length ? present : members;
    const tiles = shown.reduce((sum, member) => sum + member.plants, 0);
    const crops = shown.reduce((sum, member) => sum + member.crops, 0);
    if (shown.length < 2) {
      const species = shown[0]?.species ?? key;
      families.push({ row: { label: displayName(species), species, tiles, crops, child: false }, children: [] });
      continue;
    }
    const open = openFamilies.has(key);
    families.push({
      row: { label: patchName(key), species: shown[0]?.species ?? key, tiles, crops, child: false, family: key, open },
      // A patch member holds no tiles of its own unless it seeded them, so its tile count is left
      // blank rather than printed as a zero that reads like a missing value.
      children: shown
        .map(member => ({ label: displayName(member.species), species: member.species, tiles: member.plants, crops: member.crops, child: true }))
        .sort(bySize),
    });
  }
  families.sort((left, right) => bySize(left.row, right.row));
  for (const family of families) {
    list.push(family.row);
    if (family.row.open) list.push(...family.children);
  }
  return list;
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
  const result: OverviewStats = { plants: 0, crops: 0, mature: 0, value: 0, projectedValue: 0, doubleHarvestMult: 1, cropRefundMult: 1, mutations: new Map(), species: [], nextMatureAt: null, allMatureAt: null, targetProgress: {}, granterEtas: [], unmutated: 0, notMaxSize: 0, allCrops: 0, allTargetProgress: {}, friendBonus: 1, growthRate: 0 };
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
    // A rare variant grows as a slot inside an ordinary patch, so crops are counted against the
    // slot's own species. The plant itself belongs to the tile, and is only counted once.
    const tileTracked = !filter || filter.has(tile.species);
    function speciesRow(name: string): SpeciesStats {
      let row = bySpecies.get(name);
      if (!row) {
        row = { species: name, plants: 0, crops: 0, mature: 0, value: 0, mutations: new Map() };
        bySpecies.set(name, row);
      }
      return row;
    }
    if (tileTracked) {
      result.plants++;
      speciesRow(tile.species).plants++;
    }
    for (const slot of tile.slots as PlantSlot[]) {
      if (ignorePreserved && slot.preserved) continue;
      const slotSpecies = slot.species ?? tile.species;
      if (filter && !filter.has(slotSpecies)) continue;
      const species = speciesRow(slotSpecies);
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
      const crop = catalog?.[slotSpecies]?.crop;
      // Only crops that can actually grow count towards "not max size", matching the old maxScale gate.
      if (maxSizeMultiplier(crop) > 1 && !slotIsMaxSize(crop, slot)) result.notMaxSize++;
      const base = crop?.baseSellPrice ?? 0;
      const value = Math.round(base * slotScale(crop, slot) * catalogMutationMultiplier(slot.mutations ?? []) * friendMultiplier);
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

  /**
   * The shared figure, rather than a second copy of the same arithmetic.
   *
   * This used to repeat petMetrics' formula, which meant a Strength Crystal's ten had to be added in
   * two places and either could be forgotten. petMetrics returns null for a pet whose catalog entry
   * cannot give a strength, which is what the stand-in below is for - and it carries the crystal's
   * bonus itself, so the stand-in has to as well.
   */
  function petStrength(pet: (typeof activePets)[number]): number {
    return petMetrics(pet as unknown as Parameters<typeof petMetrics>[0])?.strength ?? 87 + crystalStrengthBonus();
  }

  /**
   * Expected-yield multipliers layered onto the one-time sell total, matching how our other tooling
   * projects value. Both scan every owned pet (team, inventory and storage) for the top three carrying
   * the ability, since that is the best team the player could field, and scale each by its strength.
   *
   * DoubleHarvest gives a second crop on a proc, so it adds its summed proc chance. ProduceRefund
   * returns a sold produce to the inventory so it can be sold again - and each refund pet rolls
   * independently on the same sale (3 pets can all proc it, returning up to 3 copies), so expected
   * copies per sale add, and since a returned copy can itself be refunded the effect is geometric:
   * 1 / (1 - p).
   */
  const abilityProcSum = (ability: string, perProcAtFullStrength: number): number =>
    availablePets
      .filter(pet => pet.abilities?.includes(ability))
      .map(petStrength)
      .sort((left, right) => right - left)
      .slice(0, 3)
      .reduce((sum, strength) => sum + perProcAtFullStrength * strength / 100, 0);

  const pDouble = abilityProcSum('DoubleHarvest', 0.05);
  const pRefund = abilityProcSum('ProduceRefund', 0.20);
  result.doubleHarvestMult = 1 + pDouble;
  result.cropRefundMult = pRefund < 1 ? 1 / (1 - pRefund) : 1;
  result.projectedValue = Math.round(result.value * result.doubleHarvestMult * result.cropRefundMult);

  // Plant Growth Boost pets shave time off maturing crops, so the ready timers count down faster.
  // Each proc removes plantGrowthReductionMinutes at baseProbability (data-driven per tier); seasonal
  // tiers only count while their weather runs. This is the per-second rate the turtle card timer uses.
  const weatherNow = currentWeather();
  let growthRate = 0;
  for (const pet of activePets) {
    if (!(Number(pet.hunger) > 0)) continue;
    const strength = petStrength(pet);
    for (const ability of pet.abilities ?? []) {
      if (!PLANT_GROWTH_ABILITIES.has(ability)) continue;
      const required = PLANT_GROWTH_WEATHER[ability];
      if (required && required !== weatherNow) continue;
      const minutes = Number(ABILITY_DETAILS[ability]?.baseParameters?.plantGrowthReductionMinutes);
      const chance = Number(ABILITY_DETAILS[ability]?.baseProbability) / 100;
      if (!Number.isFinite(minutes) || !Number.isFinite(chance)) continue;
      growthRate += (strength / 100 * minutes) * 60 * (1 - Math.pow(1 - chance * strength / 100, 1 / 60));
    }
  }
  result.growthRate = growthRate;

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

  /**
   * The worst crop's number of size-boost procs to reach maximum size.
   *
   * The size update reworked this: a crop's size is a flat 50-100 stat and each proc adds a whole
   * `sizeIncrease` to it, capped at 100 for every crop - so strength no longer changes the amount (it
   * only scales the proc rate, handled in addEta) and the species no longer matters. A slot carrying
   * `size` is on the new model; the old multiplicative-to-maxScale path is kept for the live build
   * until it ships.
   */
  function boostsUntilMax(ability: string | string[], baseBoost: number, cap: number, sizeIncrease: number): number {
    const abilities = Array.isArray(ability) ? ability : [ability];
    const strengths = availablePets.filter(pet => pet.abilities?.some(name => abilities.includes(name))).map(petStrength).sort((a, b) => b - a).slice(0, 3);
    const average = strengths.length ? strengths.reduce((sum, value) => sum + value, 0) / strengths.length : 87;
    const multiplier = 1 + baseBoost * average / 100;
    let maximum = 0;
    for (const candidate of eligibleSlots) {
      if (!mutationConfig.granterAllGarden && !candidate.tracked) continue;
      const size = (candidate.slot as { size?: number }).size;
      if (size != null) {
        if (Number(size) < 100) maximum = Math.max(maximum, Math.ceil((100 - Number(size)) / Math.max(1, sizeIncrease)));
        continue;
      }
      const maxScale = catalog?.[candidate.species]?.crop?.maxScale;
      if (!maxScale) continue;
      let scale = Number(candidate.slot.targetScale ?? 1);
      let boosts = 0;
      while (scale < maxScale && boosts <= cap) { scale *= multiplier; boosts++; }
      maximum = Math.max(maximum, boosts);
    }
    return maximum;
  }

  // The per-proc size gain comes from the ability's own baseParameters, not a remembered constant, so
  // a dev tweak to Crop Size Boost I/II flows through without an edit here (I is +4, II is +7 today).
  const sizeIncreaseOf = (ability: string, fallback: number): number => {
    const value = Number(ABILITY_DETAILS[ability]?.baseParameters?.sizeIncrease);
    return Number.isFinite(value) && value > 0 ? value : fallback;
  };
  const maxSizeBoosts = boostsUntilMax(['ProduceScaleBoostII', 'Crop Size Boost II'], .1, 20, sizeIncreaseOf('ProduceScaleBoostII', 7));
  const beeSizeBoosts = boostsUntilMax('ProduceScaleBoost', .06, 200, sizeIncreaseOf('ProduceScaleBoost', 4));
  addEta('Max Size', ['ProduceScaleBoostII', 'Crop Size Boost II'], .4, maxSizeBoosts, null, true);
  addEta('Bee Size', 'ProduceScaleBoost', .3, beeSizeBoosts, null, true);
  return result;
}

// Stroke icons on a 24px grid, matching the companion panel's set.
const svgIcon = (paths: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const GEAR_ICON = svgIcon('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>');
const FOCUS_ICON = svgIcon('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>');
const CLOSE_ICON = svgIcon('<path d="M6 6l12 12M18 6 6 18"/>');
const BELL_ICON = svgIcon('<path d="M18 16H6c1-1.2 1.5-2.5 1.5-5a4.5 4.5 0 0 1 9 0c0 2.5.5 3.8 1.5 5Z"/><path d="M10 19a2 2 0 0 0 4 0"/>');
const BELL_OFF_ICON = svgIcon('<path d="M18 16H6c1-1.2 1.5-2.5 1.5-5a4.5 4.5 0 0 1 9 0c0 2.5.5 3.8 1.5 5Z"/><path d="M10 19a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/>');
const CHEVRON_UP = svgIcon('<path d="m6 15 6-6 6 6"/>');
const CHEVRON_DOWN = svgIcon('<path d="m6 9 6 6 6-6"/>');

function compactNumber(value: number): string {
  if (value >= 1e12) return `${(value / 1e12).toFixed(2)}T`;
  if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
  return Math.round(value).toLocaleString(NUMBER_LOCALE);
}

function durationUntil(timestamp: number | null, growthRate = 0): string {
  if (!timestamp) return 'Ready';
  // Plant Growth Boost pets progress crops faster than real time, so the wait is the remaining time
  // divided by that accelerated rate.
  const seconds = Math.max(0, Math.ceil((timestamp - Date.now()) / 1000 / (1 + Math.max(0, growthRate))));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor(seconds % 3600 / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m ${seconds % 60}s`;
}

export function initGardenOverview(): void {
  // Catalogs are captured once at start-up and shared, so this is simply the live view.
  const getCatalog = () => PLANT_CATALOG;
  let filter = loadFilter();
  let mutationConfig = loadMutationConfig();
  let trackedMutations = selectedMutations(mutationConfig);
  let alarmTargets = loadAlarmTargets(trackedMutations);
  let view = loadView();
  view.ignorePreserved = mutationConfig.ignorePreserved;
  let focus = loadFocus();
  let shortcut = overviewShortcut();
  page.__gardenCompanionOverviewShortcutChanged = nextShortcut => { shortcut = nextShortcut; };
  let position: { left: number; top: number } | null = null;
  let configPosition: { left: number; top: number } | null = null;
  try { position = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null'); } catch {}
  let configMode: 'species' | 'mutations' | 'focus' | 'panel' | 'alarms' | null = null;
  let lastConfigTab: 'species' | 'mutations' | 'focus' | 'panel' = 'species';
  let focusPresets = loadFocusPresets();
  // Cleared by any manual edit, so the dropdown never claims a preset the settings no longer match.
  let selectedPreset = '';
  // What is typed in the name box, kept apart from the selection so that building a setup up out of
  // condition clicks - each of which redraws the card - does not wipe the name half way through.
  let presetDraft = '';
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let activeDrag = false;
  // A focused control inside the panel swallows the keys the game needs to move, so focus is handed
  // straight back after a click. Someone driving the panel from the keyboard still needs to keep it.
  let keyboardDriven = false;
  let lastSignature = '';
  const previousMissing = new Map<string, number>();

  function stopCompletionAlarm(): void {
    page.__gardenCompanionStopAlarm?.('overview');
  }

  function notifyCompletedMutation(name: string): void {
    if (!view.alarm) return;
    page.__gardenCompanionShowAlarm?.({
      owner: 'overview',
      label: name === 'Max Size' ? 'GARDEN ALARM | MAX SIZE' : 'GARDEN ALARM | MUTATION GRANTER',
      title: `${displayName(name)} target complete`,
      detail: name === 'Max Size' ? 'All selected crops have reached maximum size' : 'All selected crops have this mutation',
    });
  }

  function checkCompletions(stats: OverviewStats): void {
    const notified = new Set<string>();
    for (const row of stats.granterEtas) {
      const target = row.mutation === 'Bee Size' ? 'Max Size' : row.mutation;
      if (!alarmTargets.has(target)) {
        previousMissing.delete(row.mutation);
        continue;
      }
      const previous = previousMissing.get(row.mutation);
      if (previous !== undefined && previous > 0 && row.missing === 0 && !notified.has(target)) {
        notified.add(target);
        notifyCompletedMutation(target);
      }
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
      plants: stats.plants, crops: stats.crops, mature: stats.mature, value: stats.value, projectedValue: stats.projectedValue, growthRate: Math.round(stats.growthRate * 1000), unmutated: stats.unmutated, notMaxSize: stats.notMaxSize,
      mutations: [...stats.mutations], species: stats.species.map(row => [row.species, row.plants, row.crops, row.mature, row.value]),
      etas: stats.granterEtas.map(row => [row.mutation, row.pets, row.missing, Math.round(row.meanSeconds), Math.round(row.totalSeconds)]),
      filter: filter ? [...filter] : null, tracked: [...trackedMutations], alarms: [...alarmTargets], mutationConfig, view, configMode,
    });
  }

  function focusConditionNames(): string[] {
    return [...focus.mutations.map(mutationLabel), ...(focus.maxSize ? ['Max size'] : [])];
  }

  /**
   * Kept separate from the rest of the picker so a control that only changes the wording can rewrite
   * this one node instead of forcing a redraw that would take the focused element with it.
   */
  function focusSummaryHtml(): string {
    if (!focus.enabled) return 'Plant focus is <b>off</b> &mdash; nothing in your garden is faded yet.';
    const scopeLabel = focus.scope === 'all' ? 'all plants' : focus.scope === 'tracked' ? 'tracked plants' : displayName(focus.scope);
    const conditionNames = focusConditionNames();
    const rulePhrase = conditionNames.length
      ? ` carrying <b>${focus.mutationRule === 'all' ? 'all' : focus.mutationRule === 'any' ? 'any' : 'none'}</b> of ${escapeHtml(conditionNames.join(', '))}`
      : '';
    const percent = Math.round(focus.opacity * 100);
    return focus.mode === 'hide'
      ? `<b>Faded to <span data-opacity-value>${percent}%</span>:</b> ${escapeHtml(scopeLabel)}${rulePhrase}.`
      : `<b>Highlighted:</b> ${escapeHtml(scopeLabel)}${rulePhrase}.`;
  }

  function updateCountdowns(panel: HTMLElement, stats: OverviewStats): void {
    const next = panel.querySelector<HTMLElement>('[data-live=next]');
    const all = panel.querySelector<HTMLElement>('[data-live=all]');
    if (next) next.textContent = durationUntil(stats.nextMatureAt, stats.growthRate);
    if (all) all.textContent = durationUntil(stats.allMatureAt, stats.growthRate);
  }

  /** One heading, one switch row, one pill: the settings card only speaks in these three shapes. */
  function settingsHead(label: string, trailing = ''): string {
    return `<div class="go-settings-head"><span>${escapeHtml(label)}</span>${trailing}</div>`;
  }

  function switchRow(attribute: string, key: string, label: string, hint: string, on: boolean): string {
    return `<label class="go-config-row"><span>${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span>`
      + `<input class="go-switch" type="checkbox" ${attribute}="${escapeHtml(key)}" ${on ? 'checked' : ''}></label>`;
  }

  function choiceRow(label: string, attribute: string, options: Array<[string, string]>, current: string): string {
    return `<div class="go-config-row"><span>${escapeHtml(label)}</span><div class="go-pill-choice">${
      options.map(([value, text]) => `<button class="go-pill ${current === value ? 'on' : ''}" ${attribute}="${escapeHtml(value)}">${escapeHtml(text)}</button>`).join('')
    }</div></div>`;
  }

  /**
   * Counted per slot, because a rare variant lives on the slot rather than the tile: a four leaf
   * clover sits in a clover patch and a stormcap in a Thunderspire, so a tile-only walk never sees
   * them and both the owned list and Track owned would skip the very plants worth tracking.
   */
  function ownedSpeciesCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const tile of Object.values(runtime().slot?.data?.garden?.tileObjects ?? {})) {
      if (tile.objectType !== 'plant' || !tile.species) continue;
      const slots: PlantSlot[] = Array.isArray(tile.slots) ? tile.slots : [];
      if (!slots.length) { counts.set(tile.species, (counts.get(tile.species) ?? 0) + 1); continue; }
      for (const slot of slots) {
        const name = slot?.species ?? tile.species;
        counts.set(name, (counts.get(name) ?? 0) + 1);
      }
    }
    return counts;
  }

  function configHtml(species: string[]): string {
    if (configMode === 'species') {
      const selected = filter ?? new Set(species);
      const counts = ownedSpeciesCounts();
      // The crop sprite does the recognising, so a wall of sixty names becomes something you scan.
      const plantPill = (name: string) => {
        const label = displayName(name);
        const sprite = produceSprite(name);
        return `<button class="go-pill go-pill-plant ${selected.has(name) ? 'on' : ''}" data-species-toggle="${escapeHtml(name)}" data-filter-text="${escapeHtml(label.toLowerCase())}" title="${escapeHtml(label)}">`
          + `${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '<i class="go-plant-blank"></i>'}<span>${escapeHtml(label)}</span>`
          + `${counts.has(name) ? `<small>${counts.get(name)}</small>` : ''}</button>`;
      };
      const section = (label: string, names: string[]) => names.length
        ? `<div class="go-pill-group">${settingsHead(label, `<em>${names.length}</em>`)}<div class="go-pill-section"><div>${names.map(plantPill).join('')}</div></div></div>`
        : '';
      const tracked = species.filter(name => selected.has(name));
      const owned = species.filter(name => !selected.has(name) && counts.has(name));
      const rest = species.filter(name => !selected.has(name) && !counts.has(name));
      return `<section class="go-section">`
        + `<p class="go-muted">Only tracked plants are counted in the overview and its estimates.</p>`
        + `<input class="go-search" data-species-search placeholder="Search plants">`
        + `<div class="go-tools"><button data-all>All</button><button data-none>None</button><button data-owned>Track owned</button></div>`
        + `<div class="go-pill-list">${section('Tracked', tracked)}${section('In your garden', owned)}${section('Everything else', rest)}</div></section>`;
    }
    if (configMode === 'mutations') {
      // The same icons the focus picker uses, grouped by the same catalog groups, so the two
      // pickers read as one idea rather than two lists of differently worded names.
      const trackPill = (key: keyof MutationConfig, mutation: string) => {
        const label = mutationLabel(mutation);
        const sprite = mutationSprite(mutation);
        const face = sprite ? `<img src="${escapeHtml(sprite)}" alt="${escapeHtml(label)}">` : `<span>${escapeHtml(label)}</span>`;
        return `<button class="go-pill go-pill-icon ${mutationConfig[key] ? 'on' : ''}" title="${escapeHtml(label)}" data-mutation-key="${key}">${face}</button>`;
      };
      const grouped = new Set<keyof typeof MUTATION_IDS>();
      const groups = MUTATION_GROUP_ORDER.map(group => {
        const keys = (Object.keys(MUTATION_IDS) as Array<keyof typeof MUTATION_IDS>).filter(key => mutationGroupOf(MUTATION_IDS[key]) === group);
        keys.forEach(key => grouped.add(key));
        return keys.length ? `<div class="go-pill-section"><b><span>${escapeHtml(MUTATION_GROUP_LABELS[group] ?? group)}</span></b><div>${keys.map(key => trackPill(key, MUTATION_IDS[key])).join('')}</div></div>` : '';
      }).join('');
      // A mutation the catalog no longer groups still gets a pill here. Dropping it would leave it
      // tracked, drawing a bar and an estimate, with nothing left in the UI to switch it off.
      const ungrouped = (Object.keys(MUTATION_IDS) as Array<keyof typeof MUTATION_IDS>).filter(key => !grouped.has(key));
      const otherGroup = `<div class="go-pill-section"><b><span>Other</span></b><div>${ungrouped.map(key => trackPill(key, MUTATION_IDS[key])).join('')}`
        + `<button class="go-pill go-pill-icon ${mutationConfig.none ? 'on' : ''}" title="Unmutated crops" data-mutation-key="none"><span>NONE</span></button></div></div>`;
      const mergeRow = (key: keyof MutationConfig, label: string, hint = '') => switchRow('data-mutation-check', key, label, hint, Boolean(mutationConfig[key]));
      return `<section class="go-section">`
        + `<p class="go-muted">Tracked mutations get a progress bar and a granter estimate.</p>`
        + settingsHead('Tracked mutations', `<em>${trackedMutations.size}</em>`)
        + `${groups}${otherGroup}`
        + settingsHead('Show as one bar')
        + `${mergeRow('combineRainbow', 'Rainbow + Gold')}${mergeRow('combineFrozenThunderstruck', 'Frozen + Thunderstruck')}${mergeRow('combineAmberDawn', 'Amberlit + Dawnlit')}${mergeRow('combineDawnAmbercharged', 'Dawnbound + Amberbound')}`
        + settingsHead('Counting')
        + `${mergeRow('granterAllGarden', 'Whole garden', 'Estimate from every plant, not just tracked ones')}${mergeRow('ignorePreserved', 'Ignore preserved', 'Leave preserved crops out of every count')}`
        + `</section>`;
    }
    if (configMode === 'panel') {
      return `<section class="go-section">`
        + `<p class="go-muted">How the overview itself is drawn. Drag the panel by its header to move it.</p>`
        + settingsHead('Size')
        + choiceRow('Zoom', 'data-zoom-level', ZOOM_LEVELS.map(level => [String(level), `${level}x`]), String(view.zoom))
        + `</section>`;
    }
    if (configMode === 'alarms') {
      const buttons = ALARM_TARGETS.map(target => `<button class="go-pill ${alarmTargets.has(target) ? 'on' : ''}" data-alarm-target="${escapeHtml(target)}"><i>${alarmTargets.has(target) ? '&#10003;' : ''}</i><span>${escapeHtml(displayName(target))}</span></button>`).join('');
      return `<section class="go-section"><div class="go-section-title"><span>Completion alarms</span><span data-alarm-count>${alarmTargets.size}/${ALARM_TARGETS.length} selected</span></div><p class="go-muted">Choose which granter targets may trigger the Garden alarm.</p><div class="go-tools"><button data-alarm-all>All</button><button data-alarm-none>None</button></div><div class="go-pill-section"><div>${buttons}</div></div></section>`;
    }
    if (configMode === 'focus') {
      const scopes = [['tracked', 'Tracked plants'], ['all', 'All plants'], ...species.map(name => [name, displayName(name)])];
      const foundMutations = new Set(DEFAULT_TARGETS);
      for (const tile of Object.values(runtime().slot?.data?.garden?.tileObjects ?? {})) for (const slot of tile.slots ?? []) for (const mutation of slot.mutations ?? []) foundMutations.add(mutation);
      for (const mutation of focus.mutations) foundMutations.add(mutation);
      const conditionNames = focusConditionNames();
      const percent = Math.round(focus.opacity * 100);
      const pillGroup = (label: string, hint: string, body: string) => `<div class="go-pill-section"><b><span>${escapeHtml(label)}</span>${hint ? `<em>${escapeHtml(hint)}</em>` : ''}</b><div>${body}</div></div>`;
      // The icon carries the name, so the pill only falls back to text when the art has not loaded.
      const mutationPill = (name: string) => {
        const sprite = mutationSprite(name);
        const label = mutationLabel(name);
        const face = sprite ? `<img src="${escapeHtml(sprite)}" alt="${escapeHtml(label)}">` : `<span>${escapeHtml(label)}</span>`;
        return `<button class="go-pill go-pill-icon ${focus.mutations.includes(name) ? 'on' : ''}" title="${escapeHtml(label)}" data-focus-mutation="${escapeHtml(name)}">${face}</button>`;
      };
      const grouped = new Set<string>();
      const groupHint = focus.mutationRule === 'all' ? 'pick one' : '';
      const conditionGroups = MUTATION_GROUP_ORDER.map(group => {
        const members = [...foundMutations].filter(name => mutationGroupOf(name) === group);
        members.forEach(name => grouped.add(name));
        return members.length ? pillGroup(MUTATION_GROUP_LABELS[group] ?? group, groupHint, members.map(mutationPill).join('')) : '';
      }).join('');
      const ungrouped = [...foundMutations].filter(name => !grouped.has(name));
      const otherGroup = ungrouped.length ? pillGroup('Other', '', ungrouped.map(mutationPill).join('')) : '';
      // Max size has no sprite of its own, so it borrows the MAX chip used elsewhere in the mod.
      const sizeGroup = pillGroup('Size', '', `<button class="go-pill go-pill-icon ${focus.maxSize ? 'on' : ''}" title="Max size" data-focus-max-size><span>MAX</span></button>`);
      // Split so the card answers two questions in order: which crops match, and what happens to
      // them. The old layout interleaved the two and left people guessing which control did what.
      return `<section class="go-section">`
        + switchRow('data-focus-enabled', 'enabled', 'Plant focus', 'Dim the crops you are not looking for', focus.enabled)
        + settingsHead('Presets', focusPresets.length ? `<em>${focusPresets.length}</em>` : '')
        + `<div class="go-config-row"><span>Load</span><select data-focus-preset ${focusPresets.length ? '' : 'disabled'}>`
        + `<option value="">${focusPresets.length ? 'Choose a preset' : 'No presets saved'}</option>`
        + `${focusPresets.map(preset => `<option value="${escapeHtml(preset.name)}" ${preset.name === selectedPreset ? 'selected' : ''}>${escapeHtml(preset.name)}</option>`).join('')}`
        + `</select></div>`
        + `<div class="go-preset-row"><input class="go-search" data-preset-name maxlength="${PRESET_NAME_LIMIT}" placeholder="Name this setup" value="${escapeHtml(presetDraft)}">`
        + `<button data-preset-save>Save</button>`
        + `${selectedPreset ? `<button data-preset-delete title="Delete ${escapeHtml(selectedPreset)}">&#10005;</button>` : ''}</div>`
        + settingsHead('Which crops match')
        + `<label class="go-config-row"><span>Look at</span><select data-focus-scope>${scopes.map(([value, label]) => `<option value="${escapeHtml(value)}" ${focus.scope === value ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select></label>`
        + choiceRow('Must have', 'data-focus-rule-pill', [['all', 'All'], ['any', 'Any'], ['none', 'None']], focus.mutationRule)
        + settingsHead('Conditions', `${conditionNames.length ? `<button data-focus-clear>Clear</button>` : `<em>none</em>`}`)
        + `${conditionGroups}${otherGroup}${sizeGroup}`
        + settingsHead('What happens to them')
        + choiceRow('Matches are', 'data-focus-mode', [['highlight', 'Highlighted'], ['hide', 'Faded out']], focus.mode)
        + `<label class="go-config-row"><span>${focus.mode === 'hide' ? 'Matches sit at' : 'Everything else sits at'} <b data-opacity-value>${percent}%</b></span><input type="range" min="5" max="60" step="5" value="${percent}" data-focus-opacity></label>`
        // Last in the section so its height changing never shifts the controls above it.
        + `<p class="go-focus-summary"${focus.enabled ? '' : ' data-off'}>${focusSummaryHtml()}</p></section>`;
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
      return `<div class="go-progress"><div><span><i style="background:${color}"></i>${escapeHtml(label)}</span><b style="color:${color}">${count}<small class="go-of">/${stats.crops}</small></b></div><i><u style="width:${percent.toFixed(2)}%;background:${color}"></u></i></div>`;
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
      Rainbow: ['Rainbow', 'Rainbow'], Gold: ['Gold', 'Gold'], Frozen: ['Frozen', 'Frozen'], Thunderstruck: ['Thunderstruck', 'Thunderstruck'], Wet: ['Wet', 'Wet'], Chilled: ['Chilled', 'Chilled'], Ambershine: ['Amberlit', 'Ambershine'], Dawnlit: ['Dawnlit', 'Dawnlit'], 'Max Size': ['Max Size', 'Dawncharged'], 'Bee Size': ['Bee Size', 'Dawncharged'],
    };
    const etaRows = stats.granterEtas.map(row => {
      const [label, colorKey] = etaLabels[row.mutation] ?? [escapeHtml(displayName(row.mutation)), row.mutation];
      const color = mutationColors[colorKey] || '#a78bfa';
      if (row.missing === 0) return `<div class="go-eta-done"><span><i></i>${label}</span><b>Done</b></div>`;
      const summary = `<small>avg ${averageDuration(row.meanSeconds)} &middot; ~${etaDuration(row.totalSeconds)} total</small>`;
      if (row.countOnly) return `<div class="go-eta-detail"><div><span><i style="background:${color}"></i>${label}</span><b>${row.missing} <em>remaining</em></b></div>${summary}</div>`;
      const have = Math.max(0, (row.total ?? 0) - row.missing);
      const percent = row.total ? have / row.total * 100 : 0;
      return `<div class="go-eta-detail"><div><span><i style="background:${color}"></i>${label}</span><b>${have}<em>/${row.total}</em></b></div><u><i style="width:${percent.toFixed(1)}%;background:${color}"></i></u>${summary}</div>`;
    }).join('');
    const count = (value: number) => value.toLocaleString(NUMBER_LOCALE);
    const plantList = plantRowList(stats.species);
    const plantRows = plantList.map(row => {
      const sprite = produceSprite(row.species);
      const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '<i class="go-plant-blank"></i>';
      // Kept as an empty cell on rows that cannot expand, so every icon starts at the same offset.
      const chevron = row.child ? '' : `<u>${row.family ? row.open ? CHEVRON_UP : CHEVRON_DOWN : ''}</u>`;
      const name = `<span>${chevron}${icon}${escapeHtml(row.label)}</span>`;
      const cells = `<b>${row.tiles ? count(row.tiles) : ''}</b><b>${count(row.crops)}</b>`;
      return row.family
        ? `<div class="go-plant-row go-plant-family" data-family="${escapeHtml(row.family)}" title="Show the crops in this patch">${name}${cells}</div>`
        : `<div class="go-plant-row"${row.child ? ' data-child="true"' : ''}>${name}${cells}</div>`;
    }).join('');
    const growing = Math.max(0, stats.crops - stats.mature);
    const growth = growing === 0 && stats.notMaxSize === 0
      ? '<div class="go-status" data-tone="done">All mature &amp; max size</div>'
      : growing === 0
        ? `<div class="go-status">All mature - <b>${stats.notMaxSize}</b> not max size</div>`
      : (() => {
        const metrics = [
          `<div class="go-metric go-growing"><small>Growing</small><b>${growing.toLocaleString(NUMBER_LOCALE)}</b></div>`,
          // Only worth a tile while nothing has matured; once something is ready it says nothing.
          ...(stats.mature === 0 ? [`<div class="go-metric"><small>First ready</small><b data-live="next">${durationUntil(stats.nextMatureAt, stats.growthRate)}</b></div>`] : []),
          `<div class="go-metric go-size"><small>Not max size</small><b>${stats.notMaxSize.toLocaleString(NUMBER_LOCALE)}</b></div>`,
          `<div class="go-metric"><small>All ready</small><b data-live="all">${durationUntil(stats.allMatureAt, stats.growthRate)}</b></div>`,
        ];
        // Three tiles share one row; a fourth would not fit beside them, so it falls back to 2x2.
        return `<div class="go-summary" data-tiles="${metrics.length}">${metrics.join('')}</div>`;
      })();
    const bonus = Math.round((stats.friendBonus - 1) * 100);
    // The chevron is a real control rather than a bare glyph, and the badge saves opening a section
    // just to find out whether it holds anything.
    const collapsible = (key: string, label: string, total: number, open: boolean) =>
      `<div class="go-section-title go-collapsible" data-collapse="${key}" title="${open ? 'Hide' : 'Show'} ${escapeHtml(label.toLowerCase())}"><span>${escapeHtml(label)}<small>${total}</small></span><u class="go-chevron">${open ? CHEVRON_UP : CHEVRON_DOWN}</u></div>`;
    return `<section class="go-section go-growth"><div class="go-section-title"><span>Growth</span></div>${growth}</section>${etaRows ? `<section class="go-section go-estimates"><div class="go-section-head"><div class="go-section-title"><span>Mutation Estimates</span></div><div class="go-section-actions"><button data-alarm-config title="Configure completion alarms">${GEAR_ICON}</button><button data-alarm data-active="${view.alarm}" title="${view.alarm ? 'Disable' : 'Enable'} completion alarm">${view.alarm ? BELL_ICON : BELL_OFF_ICON}</button></div></div>${etaRows}</section>` : ''}<section class="go-section">${collapsible('mutations', 'Mutations', rows.filter(([, , value]) => value > 0).length, view.mutationsOpen)}<div data-section="mutations" ${view.mutationsOpen ? '' : 'hidden'}>${mutationRows || '<p class="go-muted">No selected mutations are present.</p>'}</div></section><section class="go-section">${collapsible('plants', 'Plants', plantList.filter(row => !row.child).length, view.plantsOpen)}<div class="go-plants" data-section="plants" ${view.plantsOpen ? '' : 'hidden'}>${plantRows ? `<div class="go-plant-row go-plant-units"><span></span><b>Tiles</b><b>Crops</b></div>${plantRows}` : '<p class="go-muted">No tracked plants found.</p>'}</div></section><div class="go-footer"><span>Est. value ${bonus ? `<small>+${bonus}% bonus</small>` : ''}</span><b title="Estimated value including expected DoubleHarvest and ProduceRefund yield from your top pets">${compactNumber(stats.projectedValue || stats.value)}</b></div>`;
  }

  function installDrag(card: HTMLElement, header: HTMLElement, save: ((left: number, top: number) => void) | null = null): void {
    header.onpointerdown = event => {
      if ((event.target as HTMLElement).closest('button')) return;
      event.preventDefault();
      activeDrag = true;
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
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        activeDrag = false;
        const left = parseFloat(card.style.left);
        const top = parseFloat(card.style.top);
        if (save && Number.isFinite(left) && Number.isFinite(top)) save(left, top);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish);
      window.addEventListener('pointercancel', finish);
    };
  }

  function bindSearch(input: HTMLInputElement | null): void {
    if (!input) return;
    input.oninput = () => {
      const query = input.value.trim().toLowerCase();
      const scope = input.parentElement;
      scope?.querySelectorAll<HTMLElement>('[data-filter-text]').forEach(row => { row.hidden = Boolean(query && !row.dataset.filterText?.includes(query)); });
      // A group whose every pill is filtered out hides its heading too, rather than leaving a
      // labelled divider with nothing under it.
      scope?.querySelectorAll<HTMLElement>('.go-pill-group').forEach(group => {
        group.hidden = ![...group.querySelectorAll<HTMLElement>('[data-filter-text]')].some(row => !row.hidden);
      });
    };
  }

  function render(force = false): void {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || (panel.hidden && !view.alarm)) return;
    const stats = calculateStats(runtime(), getCatalog(), filter, trackedMutations, view.ignorePreserved, mutationConfig);
    checkCompletions(stats);
    if (panel.hidden) return;
    if (activeDrag) { updateCountdowns(panel, stats); return; }
    if (!force && panel.contains(document.activeElement)) { updateCountdowns(panel, stats); return; }
    const signature = structureSignature(stats);
    if (!force && signature === lastSignature) { updateCountdowns(panel, stats); return; }
    lastSignature = signature;
    const body = panel.querySelector<HTMLElement>('.go-body');
    const scrollTop = body?.scrollTop ?? 0;
    const species = knownSpecies();
    const placement = position ? `position:fixed;left:${Math.max(0, Math.min(innerWidth - 300, position.left))}px;top:${Math.max(0, Math.min(innerHeight - 100, position.top))}px;` : '';
    const configPlacement = configPosition ? `style="position:fixed;left:${Math.max(4, Math.min(innerWidth - 304, configPosition.left))}px;top:${Math.max(4, Math.min(innerHeight - 104, configPosition.top))}px"` : '';
    // Plants, mutations and focus are one card with tabs: they are all "what the overview watches",
    // and three separate header buttons made the player hunt for which one held a given setting.
    const configTabs = configMode === 'alarms' ? '' : `<div class="go-config-tabs">${
      ([['species', 'Plants'], ['mutations', 'Mutations'], ['focus', 'Focus'], ['panel', 'Panel']] as const)
        .map(([tab, label]) => `<button data-config-tab="${tab}" data-active="${configMode === tab}">${label}</button>`).join('')
    }</div>`;
    const configTitle = configMode === 'alarms' ? 'Alarm Config' : 'Overview Settings';
    const configPanel = configMode ? `<div class="go-config-card" ${configPlacement}><header><h2>${escapeHtml(configTitle)}</h2><button data-config-close aria-label="Close" title="Close">${CLOSE_ICON}</button></header><div class="go-config-body">${configTabs}${configHtml(species)}</div></div>` : '';
    panel.innerHTML = `<div class="go-stage"><div class="go-card" style="${placement}transform:scale(${view.zoom});transform-origin:top left"><header><h2>&#x1F33F; Garden Overview</h2><div class="go-actions"><button data-open-config data-active="${configMode !== null && configMode !== 'alarms'}" title="Settings">${GEAR_ICON}</button><button data-focus-toggle data-active="${focus.enabled}" title="${focus.enabled ? 'Turn plant focus off' : 'Turn plant focus on'}">${FOCUS_ICON}</button><button data-close aria-label="Close" title="Close">${CLOSE_ICON}</button></div></header><div class="go-body">${normalHtml(stats)}</div></div>${configPanel}</div>`;
    const nextBody = panel.querySelector<HTMLElement>('.go-body');
    if (nextBody) nextBody.scrollTop = scrollTop;
    panel.querySelector<HTMLButtonElement>('[data-close]')!.onclick = close;
    panel.querySelector<HTMLButtonElement>('[data-config-close]')?.addEventListener('click', () => { configMode = null; render(true); });
    // Reopening lands on the tab last used rather than always resetting to Plants.
    panel.querySelector<HTMLButtonElement>('[data-open-config]')!.onclick = () => { configMode = configMode && configMode !== 'alarms' ? null : lastConfigTab; render(true); };
    panel.querySelectorAll<HTMLButtonElement>('[data-config-tab]').forEach(button => button.onclick = () => {
      configMode = button.dataset.configTab as typeof configMode;
      if (configMode && configMode !== 'alarms') lastConfigTab = configMode;
      render(true);
    });
    panel.querySelector<HTMLButtonElement>('[data-focus-toggle]')!.onclick = () => { focus.enabled = !focus.enabled; saveFocus(focus); applyPlantFocus(); render(true); };
    const alarmConfigButton = panel.querySelector<HTMLButtonElement>('[data-alarm-config]');
    if (alarmConfigButton) alarmConfigButton.onclick = () => { configMode = configMode === 'alarms' ? null : 'alarms'; render(true); };
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
    panel.querySelectorAll<HTMLButtonElement>('[data-zoom-level]').forEach(button => button.onclick = () => {
      view.zoom = Number(button.dataset.zoomLevel);
      saveView(view);
      renderAndRefocus(`[data-zoom-level="${button.dataset.zoomLevel}"]`);
    });
    panel.querySelector<HTMLButtonElement>('[data-all]')?.addEventListener('click', () => { filter = null; localStorage.removeItem(FILTER_KEY); render(true); });
    panel.querySelector<HTMLButtonElement>('[data-none]')?.addEventListener('click', () => { filter = new Set(); saveFilter(filter); render(true); });
    panel.querySelector<HTMLButtonElement>('[data-owned]')?.addEventListener('click', () => {
      filter = new Set(filter ?? []);
      for (const name of ownedSpeciesCounts().keys()) filter.add(name);
      saveFilter(filter); render(true);
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-species-toggle]').forEach(button => button.onclick = () => {
      const name = button.dataset.speciesToggle ?? '';
      filter = new Set(filter ?? species);
      filter.has(name) ? filter.delete(name) : filter.add(name);
      saveFilter(filter); render(true);
    });
    // Only a keyboard interaction keeps hold of a control: a redraw would otherwise leave nothing
    // focused, and after a click the game should have its keys back. Deferred by a tick because a
    // click on the label around a checkbox focuses it again after the change event, which would
    // quietly undo an inline blur.
    const releaseUnlessTyping = (element: HTMLElement) => {
      if (keyboardDriven) return;
      setTimeout(() => { if (!keyboardDriven) element.blur(); }, 0);
    };
    const renderAndRefocus = (selector: string) => {
      render(true);
      if (keyboardDriven) panel.querySelector<HTMLElement>(selector)?.focus();
    };
    const applyMutationKey = (key: keyof MutationConfig, value: boolean) => {
      mutationConfig[key] = value;
      mutationConfig.ignorePreserved = Boolean(mutationConfig.ignorePreserved);
      view.ignorePreserved = mutationConfig.ignorePreserved;
      trackedMutations = selectedMutations(mutationConfig);
      saveMutationConfig(mutationConfig); saveView(view);
    };
    panel.querySelectorAll<HTMLButtonElement>('[data-mutation-key]').forEach(button => button.onclick = () => {
      const key = button.dataset.mutationKey as keyof MutationConfig;
      applyMutationKey(key, !mutationConfig[key]);
      renderAndRefocus(`[data-mutation-key="${key}"]`);
    });
    panel.querySelectorAll<HTMLInputElement>('[data-mutation-check]').forEach(input => input.onchange = () => {
      const key = input.dataset.mutationCheck as keyof MutationConfig;
      applyMutationKey(key, input.checked);
      renderAndRefocus(`[data-mutation-check="${key}"]`);
    });
    const syncAlarmTargetControls = () => {
      panel.querySelectorAll<HTMLButtonElement>('[data-alarm-target]').forEach(button => {
        const selected = alarmTargets.has(button.dataset.alarmTarget ?? '');
        button.classList.toggle('on', selected);
        const check = button.querySelector<HTMLElement>('i');
        if (check) check.innerHTML = selected ? '&#10003;' : '';
      });
      const count = panel.querySelector<HTMLElement>('[data-alarm-count]');
      if (count) count.textContent = `${alarmTargets.size}/${ALARM_TARGETS.length} selected`;
    };
    panel.querySelectorAll<HTMLButtonElement>('[data-alarm-target]').forEach(button => button.onclick = () => {
      const target = button.dataset.alarmTarget ?? '';
      if (alarmTargets.has(target)) {
        alarmTargets.delete(target);
        previousMissing.delete(target);
        if (target === 'Max Size') previousMissing.delete('Bee Size');
      } else alarmTargets.add(target);
      saveAlarmTargets(alarmTargets);
      syncAlarmTargetControls();
    });
    panel.querySelector<HTMLButtonElement>('[data-alarm-all]')?.addEventListener('click', () => {
      alarmTargets = new Set(ALARM_TARGETS);
      saveAlarmTargets(alarmTargets);
      syncAlarmTargetControls();
    });
    panel.querySelector<HTMLButtonElement>('[data-alarm-none]')?.addEventListener('click', () => {
      alarmTargets = new Set();
      previousMissing.clear();
      saveAlarmTargets(alarmTargets);
      syncAlarmTargetControls();
    });
    const saveFocusControls = () => {
      saveFocus(focus);
      applyPlantFocus();
      // Any hand edit means the settings are no longer the preset that was loaded.
      selectedPreset = '';
      const focusButton = panel.querySelector<HTMLButtonElement>('[data-focus-toggle]');
      if (focusButton) focusButton.dataset.active = String(focus.enabled);
    };
    // Under "all of these" a crop can only hold one mutation per group, so keep the newest pick and
    // drop the rest of its group — otherwise the garden goes blank with nothing explaining why.
    const enforceGroupExclusivity = (keep?: string) => {
      if (focus.mutationRule !== 'all') return;
      const claimed = new Map<string, string>();
      if (keep) { const group = mutationGroupOf(keep); if (group) claimed.set(group, keep); }
      focus.mutations = focus.mutations.filter(name => {
        const group = mutationGroupOf(name);
        if (!group) return true;
        if (claimed.has(group)) return claimed.get(group) === name;
        claimed.set(group, name);
        return true;
      });
    };
    // Rewriting just the summary where nothing else on the panel changes, because render() replaces
    // the whole panel and would drop the control the keyboard is on mid-interaction.
    const refreshFocusSummary = () => {
      const node = panel.querySelector<HTMLElement>('.go-focus-summary');
      if (node) {
        node.toggleAttribute('data-off', !focus.enabled);
        node.innerHTML = focusSummaryHtml();
      }
      // These controls are updated in place too: a hand edit drops the loaded preset, and without
      // this the dropdown would keep naming a preset the settings no longer match.
      const select = panel.querySelector<HTMLSelectElement>('[data-focus-preset]');
      if (select) select.value = selectedPreset;
      const remove = panel.querySelector<HTMLElement>('[data-preset-delete]');
      if (remove) remove.hidden = !selectedPreset;
    };
    // Enter and Escape are how someone on the keyboard says they are done with a dropdown.
    const releaseOnCommit = (select: HTMLSelectElement) => {
      select.onkeydown = event => { if (event.key === 'Enter' || event.key === 'Escape') select.blur(); };
    };
    const focusEnabled = panel.querySelector<HTMLInputElement>('[data-focus-enabled]');
    // Whether focus is on is not part of a preset, so toggling it must not drop the loaded one.
    if (focusEnabled) focusEnabled.onchange = () => {
      const loaded = selectedPreset;
      focus.enabled = focusEnabled.checked;
      saveFocusControls();
      selectedPreset = loaded;
      refreshFocusSummary();
      releaseUnlessTyping(focusEnabled);
    };
    panel.querySelectorAll<HTMLButtonElement>('[data-focus-mode]').forEach(button => button.onclick = () => { focus.mode = button.dataset.focusMode as FocusConfig['mode']; saveFocusControls(); renderAndRefocus(`[data-focus-mode="${button.dataset.focusMode}"]`); });
    const focusScope = panel.querySelector<HTMLSelectElement>('[data-focus-scope]');
    if (focusScope) {
      focusScope.onchange = () => { focus.scope = focusScope.value; saveFocusControls(); refreshFocusSummary(); releaseUnlessTyping(focusScope); };
      releaseOnCommit(focusScope);
    }
    const presetSelect = panel.querySelector<HTMLSelectElement>('[data-focus-preset]');
    if (presetSelect) {
      presetSelect.onchange = () => {
        const preset = focusPresets.find(entry => entry.name === presetSelect.value);
        // The placeholder option clears the selection rather than applying anything.
        if (!preset) { selectedPreset = ''; renderAndRefocus('[data-focus-preset]'); return; }
        Object.assign(focus, presetConfigOf({ ...focus, ...preset.config }));
        saveFocusControls();
        // Set after saveFocusControls, which clears it for hand edits. The name box follows, so
        // Save re-saves over the preset you just loaded rather than silently making a second one.
        selectedPreset = preset.name;
        presetDraft = preset.name;
        renderAndRefocus('[data-focus-preset]');
      };
      releaseOnCommit(presetSelect);
    }
    const presetName = panel.querySelector<HTMLInputElement>('[data-preset-name]');
    if (presetName) presetName.oninput = () => { presetDraft = presetName.value; };
    panel.querySelector<HTMLButtonElement>('[data-preset-save]')?.addEventListener('click', () => {
      const name = (presetName?.value ?? '').trim().slice(0, PRESET_NAME_LIMIT);
      if (!name) { presetName?.focus(); return; }
      const config = presetConfigOf(focus);
      const existing = focusPresets.findIndex(entry => entry.name === name);
      // Saving over a name replaces it rather than leaving two entries that look identical.
      if (existing >= 0) focusPresets = focusPresets.map((entry, index) => index === existing ? { name, config } : entry);
      else if (focusPresets.length >= PRESET_LIMIT) { toast(`Only ${PRESET_LIMIT} presets can be saved.`, 'error'); return; }
      else focusPresets = [...focusPresets, { name, config }];
      saveFocusPresets(focusPresets);
      selectedPreset = name;
      presetDraft = name;
      toast(`Saved "${name}".`, 'success');
      render(true);
    });
    panel.querySelector<HTMLButtonElement>('[data-preset-delete]')?.addEventListener('click', () => {
      const removed = selectedPreset;
      // The button can outlive its selection: a hand edit clears it without a redraw.
      if (!removed) return;
      focusPresets = focusPresets.filter(entry => entry.name !== removed);
      saveFocusPresets(focusPresets);
      selectedPreset = '';
      if (presetDraft === removed) presetDraft = '';
      toast(`Deleted "${removed}".`, 'success');
      render(true);
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-focus-rule-pill]').forEach(button => button.onclick = () => {
      const rule = button.dataset.focusRulePill as FocusConfig['mutationRule'];
      focus.mutationRule = rule;
      enforceGroupExclusivity();
      saveFocusControls();
      renderAndRefocus(`[data-focus-rule-pill="${rule}"]`);
    });
    panel.querySelectorAll<HTMLButtonElement>('[data-focus-mutation]').forEach(button => button.onclick = () => {
      const mutation = button.dataset.focusMutation ?? '';
      const selected = new Set(focus.mutations);
      const adding = !selected.has(mutation);
      adding ? selected.add(mutation) : selected.delete(mutation);
      focus.mutations = [...selected];
      enforceGroupExclusivity(adding ? mutation : undefined);
      saveFocusControls();
      renderAndRefocus(`[data-focus-mutation="${mutation}"]`);
    });
    panel.querySelector<HTMLButtonElement>('[data-focus-clear]')?.addEventListener('click', () => { focus.mutations = []; focus.maxSize = false; saveFocusControls(); renderAndRefocus('[data-focus-clear]'); });
    const focusMaxSize = panel.querySelector<HTMLButtonElement>('[data-focus-max-size]');
    if (focusMaxSize) focusMaxSize.onclick = () => { focus.maxSize = !focus.maxSize; saveFocusControls(); renderAndRefocus('[data-focus-max-size]'); };
    const focusOpacity = panel.querySelector<HTMLInputElement>('[data-focus-opacity]');
    if (focusOpacity) {
      focusOpacity.oninput = () => { focus.opacity = Number(focusOpacity.value) / 100; panel.querySelectorAll<HTMLElement>('[data-opacity-value]').forEach(label => { label.textContent = `${focusOpacity.value}%`; }); saveFocusControls(); };
      // Releasing on pointerup rather than change: a drag that lands back on the value it started
      // from fires no change at all, and would otherwise keep hold of the keyboard.
      focusOpacity.onpointerup = () => releaseUnlessTyping(focusOpacity);
      focusOpacity.onchange = () => releaseUnlessTyping(focusOpacity);
    }
    panel.querySelectorAll<HTMLElement>('[data-family]').forEach(row => row.onclick = () => {
      const key = row.dataset.family!;
      if (openFamilies.has(key)) openFamilies.delete(key);
      else openFamilies.add(key);
      saveOpenFamilies();
      render(true);
    });
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
    // Mutation icons for the focus picker live in the deferred atlas stage, which nothing decodes
    // until a panel that needs it asks.
    page.__gardenCompanionLoadSpriteGroup?.('deferred');
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
    injectOverviewStyles();
    // The companion panel offers its own way in, so the toggle is published for it.
    page.__gardenCompanionToggleOverview = toggle;
    const button = document.createElement('button');
    button.id = BUTTON_ID;
    button.innerHTML = '&#x1F33F;';
    button.title = 'Garden Overview';
    button.onclick = toggle;
    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.hidden = true;
    // Bound once on the panel itself, which survives every redraw, so these never stack up.
    panel.addEventListener('keydown', () => { keyboardDriven = true; }, true);
    panel.addEventListener('pointerdown', () => { keyboardDriven = false; }, true);
    document.body.append(button, panel);
    // Cinematic mode is for screenshots, so the launcher steps aside - but only when the player
    // asked for it. Our own scenes claim cinematic too, and this button belongs on screen there.
    page.__gardenCompanionOnCinematicChange?.(() => {
      button.hidden = Boolean(page.__gardenCompanionCinematicFromGame?.());
    });
    if (view.alarm) ensureRefreshTimer();
    // The focus picker draws mutation icons, which are blank until the atlases decode. Redrawing on
    // arrival stops the panel sitting on its text fallback for the rest of the session.
    onSpritesReady(() => { if (configMode === 'focus') render(true); });
    window.addEventListener('keydown', event => {
      if (!shortcut || event.repeat || ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement as HTMLElement | null)?.tagName || '')) return;
      if (comboFromEvent(event) !== shortcut) return;
      event.preventDefault(); event.stopImmediatePropagation(); toggle();
    }, true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
