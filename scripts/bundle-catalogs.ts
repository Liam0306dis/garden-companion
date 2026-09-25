import { basename } from 'node:path';
import { readSnapshot, type Snapshot } from './bundle-snapshot.js';

/** The game catalogs the build bakes into the script, scraped from a captured bundle. */

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface BundleCatalogs {
  /** Which capture the catalogs came from. Reported on every build: a shape change in the newest
   * bundle drops silently through to an older one, and the numbers alone look perfectly healthy. */
  source: string;
  abilities: string[];
  abilityDetails: Record<string, { name: string; trigger: string; baseProbability?: number; baseParameters?: Record<string, number> }>;
  pets: Record<string, { name: string; maxHunger: number; maxScale: number; hoursToMature: number; diet: string[]; rarity: string ; abilities: string[] }>;
  plants: Record<string, { crop: { name: string; baseSellPrice: number; baseWeight: number; maxScale?: number; maxSizeMultiplier?: number; baseTileScale?: number; sprite: string }; plantLabel?: string; plantSprite?: string; slotOffset?: { x: number; y: number }; slots: number; regrows: boolean; rarity: string; slotSpecies?: string[]; component?: boolean }>;
  eggs: Record<string, { name: string; spawnWeights: Record<string, number>; pityThresholds: Record<string, number> }>;
  abilityColours: Record<string, string>;
  mutations: Record<string, { name: string; group: string; coinMultiplier: number; sprite: string }>;
  decor: Record<string, { name: string; rarity: string; rotates: boolean; sprite: string; mountable?: boolean }>;
  /** Tools the game caps at a number held in the inventory (maxInventoryQuantity), by tool id. */
  toolLimits: Record<string, number>;
}

/**
 * Reads the catalogs out of the newest snapshot whose shape still matches, falling back through
 * older ones. The game moves its catalogs between chunks between releases, so every script is
 * searched with the main bundle first rather than assuming a filename.
 */
export async function catalogsFromSnapshots(dirs: string[]): Promise<BundleCatalogs> {
  for (const dir of dirs) {
    const snapshot = await readSnapshot(dir);
    const directory = basename(dir);
    const files = [...snapshot.files.keys()].sort((left, right) => Number(right.startsWith('main-')) - Number(left.startsWith('main-')));
    for (const file of files) {
      const bundle = snapshot.files.get(file)!;
      if (!bundle.includes('innateAbilityWeights')) continue;
      const matches = [...bundle.matchAll(/([A-Za-z][A-Za-z0-9_]+):\{name:`([^`]+)`,trigger:`([^`]+)`(?:,baseProbability:([0-9.e+-]+))?(?:,baseParameters:\{([^}]*)\})?/g)];
      if (matches.length > 0) {
        const abilityDetails = Object.fromEntries(matches.map(match => {
          const baseParameters = Object.fromEntries(
            [...(match[5] || '').matchAll(/([A-Za-z][A-Za-z0-9_]*):([0-9.e+-]+)/g)]
              .map(parameter => [parameter[1], Number(parameter[2])]),
          );
          return [match[1], {
            name: match[2],
            trigger: match[3],
            ...(match[4] ? { baseProbability: Number(match[4]) } : {}),
            ...(Object.keys(baseParameters).length ? { baseParameters } : {}),
          }];
        }));
        // The leading sprite field comes and goes between releases and nothing here reads it, so a
        // pet entry is matched with or without it.
        const petMatches = [...bundle.matchAll(/([A-Za-z][A-Za-z0-9_]+):\{(?:sprite:[A-Za-z_$]+\.Pet\.([A-Za-z][A-Za-z0-9_]+),)?name:`([^`]+)`,coinsToFullyReplenishHunger:([0-9.e+-]+),innateAbilityWeights:\{[^}]*\},maxScale:([0-9.e+-]+),.*?hoursToMature:([0-9.e+-]+),rarity:[A-Za-z_$]+\.([A-Za-z]+).{0,300}?diet:\[([^\]]*)\]/g)];
        if (!petMatches.length) continue;
        // Which abilities each species can roll at hatch. Captured separately rather than by adding
        // a group to the pet pattern above, which would renumber every field that follows it.
        const petAbilityWeights = new Map([...bundle.matchAll(
          /([A-Za-z][A-Za-z0-9_]+):\{(?:sprite:[A-Za-z_$]+\.Pet\.[A-Za-z][A-Za-z0-9_]+,)?name:`[^`]+`,coinsToFullyReplenishHunger:[0-9.e+-]+,innateAbilityWeights:\{([^}]*)\}/g)]
          .map(match => [match[1], [...match[2].matchAll(/([A-Za-z][A-Za-z0-9_]*):/g)].map(entry => entry[1])]));
        // Build 1291 put a `name` field ahead of `seed`, so it is matched optionally.
        // The size update replaced a crop's `maxScale` with `maxSizeMultiplier`, optionally preceded
        // by `baseTileScale`. Some crops (Clover, Milkcap, the seasonals) carry maxSizeMultiplier with
        // no baseTileScale, so that field is optional or those crops drop out of the catalog entirely.
        // The tail matches either form: match[8] is the old maxScale, match[9] the optional
        // baseTileScale, match[10] the new maxSizeMultiplier.
        const plantMatches = [...bundle.matchAll(/([A-Za-z][A-Za-z0-9_]+):\{(?:name:`[^`]*`,)?seed:\{(.*?)\},plant:\{(.*?)\},crop:\{sprite:[A-Za-z_$]+\.[A-Za-z]+\.([A-Za-z][A-Za-z0-9_]*),name:`([^`]+)`,baseSellPrice:([0-9.e+-]+),baseWeight:([0-9.e+-]+).*?(?:maxScale:([0-9.e+-]+)|(?:baseTileScale:([0-9.e+-]+),)?maxSizeMultiplier:([0-9.e+-]+))/g)];
        if (!plantMatches.length) continue;
        // The pity block follows the weights closely, and is captured with a tight bound rather
        // than a lazy run so a missing one cannot reach forward into the next egg's. Optional: an
        // egg without one must still be caught, or the whole bundle would fall to the fallback.
        const eggMatches = [...bundle.matchAll(/([A-Za-z][A-Za-z0-9_]+):\{sprite:[A-Za-z_$]+\.Pet\.[A-Za-z0-9_]+,name:`([^`]+)`,.*?faunaSpawnWeights:\{([^}]*)\}(?:.{0,120}?speciesPityThresholdPulls:\{([^}]*)\})?/g)];
        if (!eggMatches.length) continue;
        const pets = Object.fromEntries(petMatches.map(match => [match[1], {
          name: match[3],
          maxHunger: Number(match[4]),
          maxScale: Number(match[5]),
          hoursToMature: Number(match[6]),
          rarity: match[7],
          diet: [...match[8].matchAll(/`([^`]+)`/g)].map(entry => entry[1]),
          abilities: petAbilityWeights.get(match[1]) ?? [],
        }]));
        const plantRows = plantMatches.map(match => {
          const plantBlock = match[3];
          // Patch plants (clover, snowdrop, daisies, cattail) hold slotCapacity plants on one tile.
          const capacity = Number(plantBlock.match(/slotCapacity:([0-9]+)/)?.[1] || 0);
          return {
            species: match[1],
            seedSprite: match[2].match(/sprite:[A-Za-z_$]+\.Seed\.([A-Za-z0-9_]+)/)?.[1] || '',
            capacity,
            // A slot can override its species (Thunderspire grows stormcaps in four of its slots).
            slotSpecies: [...plantBlock.matchAll(/\{x:[^{}]*?\}/g)]
              .map(offset => offset[0].match(/speciesOverride:`([A-Za-z0-9_]+)`/)?.[1] || ''),
            entry: {
              // The crop's own display name, which is often not its species id: DawnCelestial is
              // a Dawnbinder Bulb and ThunderCelestialShroomPlant is a Stormcap.
              crop: {
                name: match[5], baseSellPrice: Number(match[6]), baseWeight: Number(match[7]), sprite: match[4],
                ...(match[8] ? { maxScale: Number(match[8]) } : {}),
                ...(match[9] ? { baseTileScale: Number(match[9]) } : {}),
                ...(match[10] ? { maxSizeMultiplier: Number(match[10]) } : {}),
              },
              // What the game calls the plant rather than its crop, which is the only name a patch
              // has: a daisy patch grows daisies and purple daisies, and neither crop names the tile.
              plantLabel: plantBlock.match(/name:`([^`]+)`/)?.[1] || '',
              // The growing plant is a different atlas frame from its harvested crop, and some
              // callers want the plant: a Starweaver crop looks nothing like a Starweaver.
              plantSprite: plantBlock.match(/sprite:[A-Za-z_$]+\.Plant\.([A-Za-z0-9_]+)/)?.[1] || '',
              // Where the game hangs the first crop on the plant, as a fraction of a 256 tile from
              // its centre. Anything drawing a plant with its fruit needs the real mount point.
              slotOffset: (() => {
                const first = plantBlock.match(/slotOffsets:\[\{x:(-?[0-9.e+-]+),y:(-?[0-9.e+-]+)/);
                return first ? { x: Number(first[1]), y: Number(first[2]) } : undefined;
              })(),
              slots: Math.max(1, capacity || (plantBlock.match(/\{x:/g) || []).length),
              regrows: /harvestType:[A-Za-z_$]+\.Multiple/.test(plantBlock),
              rarity: match[2].match(/rarity:[A-Za-z_$]+\.([A-Za-z]+)/)?.[1] || 'Common',
            } as BundleCatalogs['plants'][string],
          };
        });
        // Rare patch variants (four-leaf clover, purple daisy) grow inside their parent patch and
        // carry no capacity of their own, so they inherit it from the plant sharing their seed.
        const capacityBySeed = new Map(plantRows.filter(row => row.capacity).map(row => [row.seedSprite, row.capacity]));
        for (const row of plantRows) {
          if (!row.capacity && row.seedSprite && capacityBySeed.has(row.seedSprite)) {
            row.entry.slots = capacityBySeed.get(row.seedSprite)!;
          }
        }
        // Species that only exist inside another plant's slots are not separately plantable.
        const componentSpecies = new Set(plantRows.flatMap(row => row.slotSpecies.filter(Boolean)));
        for (const row of plantRows) {
          if (row.slotSpecies.some(Boolean)) row.entry.slotSpecies = row.slotSpecies;
          if (componentSpecies.has(row.species)) row.entry.component = true;
        }
        const plants = Object.fromEntries(plantRows.map(row => [row.species, row.entry]));
        // How many pulls without a species before the game guarantees it. Usually one species per
        // egg, but the Amber Egg has two at different thresholds - so this is read rather than
        // inferred from the spawn weights, which would name the rarer one and the wrong number.
        // Thresholds are written as a shared minified constant (`var L=40`) as often as a literal,
        // so an identifier is resolved against the bundle rather than dropped.
        const pityValue = (raw: string): number => {
          const literal = Number(raw);
          if (Number.isFinite(literal)) return literal;
          const declared = bundle.match(new RegExp(`(?:^|[^A-Za-z0-9_$.])${escapeRegExp(raw)}=([0-9]+)(?![0-9.])`));
          return declared ? Number(declared[1]) : 0;
        };
        const eggs = Object.fromEntries(eggMatches.map(match => [match[1], {
          name: match[2],
          spawnWeights: Object.fromEntries([...match[3].matchAll(/([A-Za-z][A-Za-z0-9_]*):([0-9.e+-]+)/g)].map(entry => [entry[1], Number(entry[2])])),
          pityThresholds: Object.fromEntries([...(match[4] || '').matchAll(/([A-Za-z][A-Za-z0-9_]*):([A-Za-z0-9_$.]+)/g)]
            .map(entry => [entry[1], pityValue(entry[2])])
            .filter(([, threshold]) => Number(threshold) > 0)),
        }]));
        // Mutations carry a display name that differs from their id (Dawncharged shows as Dawnbound)
        // and a group; only one mutation from each group can be on a crop at a time.
        const mutations = Object.fromEntries([...bundle.matchAll(
          /([A-Za-z][A-Za-z0-9_]*):\{name:`([^`]+)`,baseChance:[0-9.e+-]+,coinMultiplier:([0-9.]+),group:`([A-Za-z]+)`(?:,sprite:[A-Za-z_$]+\.Mutation\.([A-Za-z0-9_]+))?/g)]
          .map(match => [match[1], { name: match[2], group: match[4], coinMultiplier: Number(match[3]), sprite: match[5] || match[1] }]));
        if (Object.keys(mutations).length < 8) continue;
        // Build 1019 renamed decor's sprite field to art, which matched nothing and quietly sent the
        // whole bundle to the fallback below - so both spellings are accepted. The same build gave
        // animated decor a Rive artboard in place of an atlas reference, so the field is captured
        // whole and the id picked out of whichever shape arrived.
        // canDisplayCrop marks decor that can show a harvested crop on top (pedestals, stools).
        const decor = Object.fromEntries([...bundle.matchAll(
          /([A-Za-z][A-Za-z0-9_]*):\{(?:sprite|art):([A-Za-z_$]+\.Decor\.[A-Za-z0-9_]+|\{artboardName:`[A-Za-z0-9_]+`\}),((?:rotationVariants:\{.*?\},)?)name:`([^`]+)`([^{}]*?)rarity:[A-Za-z_$]+\.([A-Za-z]+)([^{}]*)/g)]
          .map(match => [match[1], {
            name: match[4],
            rarity: match[6],
            rotates: Boolean(match[3]),
            sprite: decorSpriteId(match[2]),
            ...(/canDisplayCrop:!0/.test(match[5] + match[7]) ? { mountable: true } : {}),
          }]));
        if (Object.keys(decor).length < 10) continue;
        const abilityColours = abilityColoursFromSnapshot(snapshot);
        // Only tools carry a cap - the game's own max-quantity check returns nothing for any other
        // item type. Matched within one catalog entry, so a cap is never pinned on its neighbour.
        const toolLimits = Object.fromEntries([...bundle.matchAll(
          /([A-Za-z][A-Za-z0-9_]*):\{sprite:[A-Za-z_$]+\.Item\.[A-Za-z0-9_]+,[^{}]*?maxInventoryQuantity:(\d+)/g)]
          .map(match => [match[1], Number(match[2])]));
        return { source: directory, abilities: Object.keys(abilityDetails).sort(), abilityDetails, pets, plants, eggs, abilityColours, mutations, decor, toolLimits };
      }
    }
  }
  throw new Error('No ability catalog was found in the captured game bundles. Run `npm run check-bundle` to capture a fresh one.');
}


function formatPercent(offset: number): string {
  return `${Number((offset * 100).toFixed(2))}%`;
}

/**
 * The game builds its gradient line the same way CSS does - clockwise from "to top", through the
 * centre, length |w sin0| + |h cos0| - so an angle carries straight over. It first mirrors any angle
 * whose sine and cosine share a sign, which is what collapses the rainbow granter's declared 45
 * degrees onto the same top-left to bottom-right diagonal as everything else.
 */
function gradientAngle(angleDegrees: number): number {
  const radians = angleDegrees * Math.PI / 180;
  return Math.sin(radians) * Math.cos(radians) > 1e-6 ? 180 - angleDegrees : angleDegrees;
}

/**
 * The art id from either shape a decor entry uses: an atlas reference like `NS.Decor.SmallRock`, or
 * the Rive artboard that animated decor carries instead. Both name the same sprite in the end.
 */
function decorSpriteId(descriptor: string): string {
  return descriptor.match(/artboardName:`([A-Za-z0-9_]+)`/)?.[1] ?? descriptor.split('.').pop() ?? '';
}

/**
 * The game colours each ability chip through a switch in its store chunk. Read it from the captured
 * bundle so our chips match the game exactly.
 */
function abilityColoursFromSnapshot(snapshot: Snapshot): Record<string, string> {
  for (const chunk of snapshot.files.values()) {
    const colours: Record<string, string> = {};
    // The gradient abilities (the Rainbow and Gold granters) hold their stops in a hoisted constant
    // that the switch returns by name, so those are collected first and resolved below.
    const gradients: Record<string, string> = {};
    for (const match of chunk.matchAll(/([A-Za-z_$][A-Za-z0-9_$]*)=\{solid:`#[0-9A-Fa-f]{6}`,gradient:\{angleDegrees:([0-9.]+),colorStops:\[([^\]]*)\]\}\}/g)) {
      const stops = [...match[3].matchAll(/color:`(#[0-9A-Fa-f]{6})`,offset:([0-9.]+)(?:\/([0-9.]+))?/g)]
        .map(stop => `${stop[1]} ${formatPercent(Number(stop[2]) / (stop[3] ? Number(stop[3]) : 1))}`);
      if (stops.length) gradients[match[1]] = `linear-gradient(${gradientAngle(Number(match[2]))}deg, ${stops.join(', ')})`;
    }
    // A colour is either an object with a hex `solid`, one of those gradient constants, or - on
    // older bundles - a bare string carrying the stops with no angle or offsets of its own.
    for (const match of chunk.matchAll(/((?:case`[A-Za-z0-9_]+`:)+)return\s*(?:\{solid:`(#[0-9A-Fa-f]{6})`\}|`(#[0-9A-Fa-f]{6}|linear-gradient\([^`]+\))`|([A-Za-z_$][A-Za-z0-9_$]*))/g)) {
      const literal = match[2] ?? match[3];
      const stops = literal
        ? literal.startsWith('linear-gradient')
          ? `linear-gradient(135deg, ${(literal.match(/#[0-9A-Fa-f]{6}/g) || []).join(', ')})`
          : literal
        : gradients[match[4]];
      if (!stops) continue;
      for (const name of match[1].matchAll(/case`([A-Za-z0-9_]+)`/g)) colours[name[1]] = stops;
    }
    if (Object.keys(colours).length >= 40) return colours;
  }
  // Loudly, because the switch has changed shape before and shipping colourless chips looks like a
  // styling bug rather than a build that quietly found nothing.
  throw new Error('No ability colours were found in the captured game bundles.');
}
