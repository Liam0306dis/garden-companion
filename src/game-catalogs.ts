import { EGG_CATALOG, MUTATION_CATALOG, PET_CATALOG, PLANT_CATALOG } from './constants.js';
import { page } from './page.js';

/**
 * Catalogs are baked in at build time, which means a species the game adds after a release is
 * invisible until the script is rebuilt. The game hands its own catalogs to `Object.keys` while it
 * starts up, so this watches that call, recognises them by shape, and fills in anything the baked
 * data is missing.
 *
 * Only unknown species are added. Known ones keep their baked entries, because the build derives
 * fields the live objects do not expose directly (slot counts, component species, capacity that
 * rare variants inherit from the plant sharing their seed).
 */

type Row = Record<string, unknown>;

function isObject(value: unknown): value is Row {
  return Boolean(value) && typeof value === 'object';
}

/** A catalog is recognised by well-known members plus a field probe, both of which survive minification. */
function looksLike(keys: string[], sample: unknown, members: string[], probe: (row: Row) => boolean): boolean {
  if (members.filter(member => keys.includes(member)).length < Math.min(3, members.length)) return false;
  if (!isObject(sample)) return false;
  try { return probe(sample); } catch { return false; }
}

function plantProbe(row: Row): boolean {
  return isObject(row.crop) && typeof (row.crop as Row).baseSellPrice === 'number';
}

function petProbe(row: Row): boolean {
  return 'coinsToFullyReplenishHunger' in row && Array.isArray(row.diet);
}

function eggProbe(row: Row): boolean {
  return isObject(row.faunaSpawnWeights);
}

function mutationProbe(row: Row): boolean {
  return typeof row.coinMultiplier === 'number' && typeof row.group === 'string';
}

function firstMember(keys: string[], members: string[]): string {
  return members.find(member => keys.includes(member)) || '';
}

/** Copies entries the baked catalog does not have. Existing entries are never overwritten. */
function addMissing<T>(baked: Record<string, T>, live: Row, convert: (row: Row) => T | null): string[] {
  const added: string[] = [];
  for (const [id, row] of Object.entries(live)) {
    if (baked[id] || !isObject(row)) continue;
    let entry: T | null = null;
    try { entry = convert(row); } catch { entry = null; }
    if (!entry) continue;
    baked[id] = entry;
    added.push(id);
  }
  return added;
}

function rarityOf(value: unknown): string {
  return typeof value === 'string' && value ? value : 'Common';
}

function absorb(candidate: Row, keys: string[]): void {
  if (looksLike(keys, candidate[firstMember(keys, PLANT_MEMBERS)], PLANT_MEMBERS, plantProbe)) {
    const added = addMissing(PLANT_CATALOG, candidate, row => {
      const crop = row.crop as Row;
      const plant = isObject(row.plant) ? row.plant as Row : {};
      const seed = isObject(row.seed) ? row.seed as Row : {};
      const offsets = Array.isArray(plant.slotOffsets) ? plant.slotOffsets.length : 0;
      return {
        crop: { name: String(crop.name || ''), baseSellPrice: Number(crop.baseSellPrice) || 0, baseWeight: Number(crop.baseWeight) || 0, maxScale: Number(crop.maxScale) || 1 },
        plantLabel: String(plant.name || ''),
        slots: Math.max(1, Number(plant.slotCapacity) || offsets || 1),
        regrows: String(plant.harvestType || '').toLowerCase().includes('multiple'),
        rarity: rarityOf(seed.rarity),
      } as (typeof PLANT_CATALOG)[string];
    });
    report('plants', added);
    return;
  }
  if (looksLike(keys, candidate[firstMember(keys, PET_MEMBERS)], PET_MEMBERS, petProbe)) {
    report('pets', addMissing(PET_CATALOG, candidate, row => ({
      name: String(row.name || ''),
      maxHunger: Number(row.coinsToFullyReplenishHunger) || 0,
      maxScale: Number(row.maxScale) || 1,
      hoursToMature: Number(row.hoursToMature) || 0,
      diet: (row.diet as unknown[]).filter(item => typeof item === 'string') as string[],
      rarity: rarityOf(row.rarity),
    })));
    return;
  }
  if (looksLike(keys, candidate[firstMember(keys, EGG_MEMBERS)], EGG_MEMBERS, eggProbe)) {
    report('eggs', addMissing(EGG_CATALOG, candidate, row => ({
      name: String(row.name || ''),
      spawnWeights: { ...(row.faunaSpawnWeights as Record<string, number>) },
      // How many pulls guarantee each species. Taken from the running game as well as the build so
      // an egg added since our last capture still shows the right threshold rather than the old
      // assumption that every egg guarantees its rarest at forty.
      pityThresholds: { ...(row.speciesPityThresholdPulls as Record<string, number>) },
    })));
    return;
  }
  if (looksLike(keys, candidate[firstMember(keys, MUTATION_MEMBERS)], MUTATION_MEMBERS, mutationProbe)) {
    report('mutations', addMissing(MUTATION_CATALOG, candidate, row => ({
      name: String(row.name || ''),
      group: String(row.group || ''),
      coinMultiplier: Number(row.coinMultiplier) || 1,
      sprite: String(row.sprite || row.name || ''),
    })));
  }
}

const PLANT_MEMBERS = ['Carrot', 'Cabbage', 'Strawberry', 'Aloe', 'Beet', 'Clover'];
const PET_MEMBERS = ['Worm', 'Snail', 'Bee', 'Chicken', 'Bunny', 'Turkey', 'Goat'];
const EGG_MEMBERS = ['CommonEgg', 'UncommonEgg', 'RareEgg', 'LegendaryEgg'];
const MUTATION_MEMBERS = ['Gold', 'Rainbow', 'Wet', 'Chilled', 'Frozen'];

function report(kind: string, added: string[]): void {
  if (added.length) console.info(`[Garden Companion] Added ${added.length} ${kind} from the running game: ${added.join(', ')}`);
}

let watching = false;
let scanning = false;

/**
 * Watching `Object.keys` means sharing it with anything else that has hooked it, so the previous
 * implementation is always called and always gets to decide the return value. Scanning never
 * throws, and the wrapper stays installed as a pass-through rather than being removed, because
 * restoring it would discard a hook that another script installed after ours.
 */
export function initCatalogCapture(): void {
  // The game runs in the page realm, so its own Object.keys calls go through the page's constructor
  // rather than the sandbox copy this script sees by default.
  const objectConstructor = (page.Object as ObjectConstructor) || Object;
  const target = objectConstructor as unknown as Row;
  if (target.__gardenCompanionCatalogHook) return;
  const previous = objectConstructor.keys;
  const seen = new WeakSet<object>();

  function scan(value: unknown, depth: number): void {
    if (!isObject(value) || seen.has(value)) return;
    seen.add(value);
    let keys: string[];
    try { keys = previous(value); } catch { return; }
    if (!keys.length) return;
    absorb(value, keys);
    if (depth >= 3) return;
    for (const key of keys) {
      let child: unknown;
      try { child = value[key]; } catch { continue; }
      if (isObject(child)) scan(child, depth + 1);
    }
  }

  const hook = function (this: unknown, value: never): string[] {
    // `scanning` stops a getter reached during a scan from re-entering this hook.
    if (watching && !scanning) {
      scanning = true;
      try { scan(value, 0); }
      catch { /* a scan must never break the game's own call */ }
      finally { scanning = false; }
    }
    return previous.call(this, value) as string[];
  };
  target.__gardenCompanionCatalogHook = true;
  watching = true;
  objectConstructor.keys = hook as typeof Object.keys;
  // One owner for the price lookup other features read.
  page.__gardenCompanionPlantPrice = species => PLANT_CATALOG[species ?? '']?.crop?.baseSellPrice;

  // The catalogs are read during start-up, so scanning past that is pure overhead. The wrapper is
  // only removed when it is still the outermost one; otherwise it stays as a cheap pass-through so
  // a hook installed after ours is not discarded.
  setTimeout(() => {
    watching = false;
    if (objectConstructor.keys === hook) objectConstructor.keys = previous;
  }, 30_000);
}
