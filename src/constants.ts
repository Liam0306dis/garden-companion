import { humanize, NAME_OVERRIDES, NUMBER_LOCALE } from './utils.js';

/** Storage keys, remote endpoints, and the game catalogs baked in at build time. */

export const STORE_KEY = 'gardenCompanion.config.v1';
export const LOG_KEY = 'gardenCompanion.abilityLog.v1';
export const LUNAR_POSITION_KEY = 'gardenCompanion.lunarPosition.v1';
export const LUNAR_MINIMISED_KEY = 'gardenCompanion.lunarMinimised.v1';
export const OVERVIEW_SHORTCUT_KEY = 'gardenCompanion.overviewShortcut.v1';
export const UPDATE_URL = 'https://raw.githubusercontent.com/Liam0306dis/garden-companion/main/dist/garden-companion.user.js';

// History is kept per exact ability rather than overall so a chatty ability cannot crowd out a rare one.
// A hundred each still covers every ability many times over, and keeps the tab quick to filter: the
// search and the redraw both walk the whole history, not just the rows on screen.
export const LOG_PER_ABILITY = 100;
export const LOG_VISIBLE_ROWS = 400;

export const ABILITY_CATALOG = __ABILITY_CATALOG__;
export const ABILITY_DETAILS = __ABILITY_DETAILS__;
export const PET_CATALOG = __PET_CATALOG__;
export const EGG_CATALOG = __EGG_CATALOG__;
export const PLANT_CATALOG = __PLANT_CATALOG__;
export const MUTATION_CATALOG = __MUTATION_CATALOG__;
export const DECOR_CATALOG = __DECOR_CATALOG__;
export const ABILITY_COLOURS = __ABILITY_COLOURS__;
export const ABILITY_COLOUR_FALLBACK = '#969696';

export const ABILITY_GROUPS = [
  ['Coin Finder', ['CoinFinderI', 'CoinFinderII', 'CoinFinderIII', 'CoinFinderIV', 'SnowyCoinFinder', 'DawnCoinFinder', 'ThunderCoinFinder']],
  ['Plant Growth Boost', ['PlantGrowthBoost', 'PlantGrowthBoostII', 'PlantGrowthBoostIII', 'SnowyPlantGrowthBoost', 'DawnPlantGrowthBoost', 'AmberPlantGrowthBoost', 'ThunderPlantGrowthBoost']],
  ['Crop Size Boost', ['ProduceScaleBoost', 'ProduceScaleBoostII', 'ProduceScaleBoostIII', 'SnowyCropSizeBoost']],
  ['Egg Growth Boost', ['EggGrowthBoost', 'EggGrowthBoostII_NEW', 'EggGrowthBoostII', 'SnowyEggGrowthBoost', 'ThunderEggGrowthBoost', 'AmberEggGrowthBoost']],
  ['XP Boost', ['PetXpBoost', 'PetXpBoostII', 'PetXpBoostIII', 'SnowyPetXpBoost', 'DawnXpBoost', 'ThunderXpBoost', 'AmberXpBoost']],
  ['Hunger Restore', ['HungerRestore', 'HungerRestoreII', 'HungerRestoreIII', 'SnowyHungerRestore']],
  ['Hatch XP Boost', ['PetAgeBoost', 'PetAgeBoostII', 'PetAgeBoostIII']],
  ['Max Strength Boost', ['PetHatchSizeBoost', 'PetHatchSizeBoostII', 'PetHatchSizeBoostIII']],
  ['Pet Refund', ['PetRefund', 'PetRefundII']],
  ['Seed Finder', ['SeedFinderI', 'SeedFinderII', 'SeedFinderIII', 'SeedFinderIV']],
  ['Sell Boost', ['SellBoostI', 'SellBoostII', 'SellBoostIII', 'SellBoostIV']],
  ['Mutation Granter', ['RainDance', 'SnowGranter', 'FrostGranter', 'DawnlitGranter', 'AmberlitGranter', 'GoldGranter', 'RainbowGranter', 'ThunderstruckGranter']],
] as const;

export const UNGROUPED_TRACKED_ABILITIES = ['ProduceEater', 'ProduceRefund', 'DoubleHarvest', 'DoubleHatch', 'DoubleHatchII', 'DustBoost', 'Rebirth'];

export const EXCLUDED_TRACKED_ABILITIES = new Set([
  'HungerBoost', 'HungerBoostII', 'HungerBoostIII', 'SnowyHungerBoost',
  'PetMutationBoost', 'PetMutationBoostII', 'PetMutationBoostIII',
  'ProduceMutationBoost', 'ProduceMutationBoostII', 'ProduceMutationBoostIII', 'SnowyCropMutationBoost', 'DawnBoost', 'AmberMoonBoost', 'ThunderBoost',
  'MoonKisser', 'DawnKisser', 'Thunderbloom', 'Copycat', 'DawnCapture', 'AmberCapture', 'Thundercharger', 'DawnbinderBoost',
]);

export const TRACKED_ABILITY_CATALOG = ABILITY_CATALOG.filter(ability => !EXCLUDED_TRACKED_ABILITIES.has(ability));
export const ABILITY_SET = new Set(TRACKED_ABILITY_CATALOG);

export const ABILITY_GROUP_BY_ID = new Map<string, string>();
for (const [label, abilities] of ABILITY_GROUPS) for (const ability of abilities) ABILITY_GROUP_BY_ID.set(ability, label);

export const ABILITY_FILTER_OPTIONS: Array<{ key: string; label: string; abilities: readonly string[] }> = [
  ...ABILITY_GROUPS.map(([label, abilities]) => ({ key: label, label, abilities })),
  // Only the ones this build's catalog actually has. An ability can be listed here before the game
  // ships it - the tables are written from a preview bundle - and an option filtering for something
  // no pet can have yet is an option that always comes back empty.
  ...UNGROUPED_TRACKED_ABILITIES.filter(ability => ABILITY_SET.has(ability))
    .map(ability => ({ key: ability, label: ABILITY_DETAILS[ability]?.name || humanize(ability), abilities: [ability] })),
];

export const RARITY_ORDER = ['Common', 'Uncommon', 'Rare', 'Legendary', 'Mythic', 'Divine', 'Celestial'];

export function rarityRank(rarity: string | undefined): number {
  const rank = RARITY_ORDER.indexOf(rarity || 'Common');
  return rank < 0 ? RARITY_ORDER.length : rank;
}

export const EXCLUDED_TOOL_ALERTS = new Set(['Shovel', 'FeedingTrough', 'DecorShed', 'PetHutch', 'SeedSilo', 'ToolShack']);

export const STACKED_PASSIVE_GROUPS = [
  { key: 'HungerBoost', label: 'Hunger Boost', parameter: 'hungerRefundPercentage', abilities: ['HungerBoost', 'HungerBoostII', 'HungerBoostIII', 'SnowyHungerBoost'] },
  { key: 'WeatherMutationBoost', label: 'Weather Mutation Boost', parameter: 'mutationChanceIncreasePercentage', abilities: ['ProduceMutationBoost', 'ProduceMutationBoostII', 'ProduceMutationBoostIII', 'SnowyCropMutationBoost', 'DawnBoost', 'AmberMoonBoost', 'ThunderBoost'] },
  { key: 'PetMutationBoost', label: 'Pet Mutation Boost', parameter: 'mutationChanceIncreasePercentage', abilities: ['PetMutationBoost', 'PetMutationBoostII', 'PetMutationBoostIII'] },
  { key: 'DawnbinderBoost', label: 'Dawnbinder Boost', parameter: 'plantAbilityChanceBoostPercentage', abilities: ['DawnbinderBoost'] },
] as const;

export const STACKED_PASSIVE_BY_ABILITY = new Map(STACKED_PASSIVE_GROUPS.flatMap(group => group.abilities.map(ability => [ability, group] as const)));

export const PASSIVE_REQUIRED_WEATHER = new Map<string, string>([
  ['SnowyHungerBoost', 'Frost'], ['SnowyHungerRestore', 'Frost'], ['SnowyCropMutationBoost', 'Frost'], ['DawnBoost', 'Dawn'],
  ['AmberMoonBoost', 'AmberMoon'], ['ThunderBoost', 'Thunderstorm'],
  ['AmberXpBoost', 'AmberMoon'], ['AmberEggGrowthBoost', 'AmberMoon'],
]);

export const SHOP_NAMES = { seed: 'Seed', egg: 'Egg', decor: 'Decor', tool: 'Tool', dawn: 'Dawn', snow: 'Snow', thunder: 'Thunder', rain: 'Rain', amber: 'Amber' };
export const SHOP_TABS = [['seed', 'Seeds'], ['amber', 'Amber'], ['dawn', 'Dawn'], ['thunder', 'Thunder'], ['snow', 'Snow'], ['rain', 'Rain'], ['egg', 'Eggs'], ['tool', 'Tools'], ['decor', 'Decor']];

export const SEASONAL_SHOP_ITEMS: Record<string, string[]> = {
  dawn: ['Daisy', 'Lavender', 'Saffron', 'Eggplant', 'Ube', 'Dawnbreaker', 'DawnCelestial', 'DawnEgg'],
  thunder: ['Cattail', 'Cardoon', 'PricklyPear', 'Milkcap', 'ThunderCelestial', 'ThunderEgg', 'ThunderWardShard', 'SmallGravestone', 'MediumGravestone', 'LargeGravestone', 'Cauldron', 'WindchimeMoon', 'WindchimeStar', 'WindSpinner', 'WindTurner'],
  snow: ['Snowdrop', 'PineTree', 'Leek', 'Squash', 'Poinsettia', 'SnowEgg', 'ChilledPotion', 'FrozenPotion', 'SnowWardShard', 'ColoredStringLights', 'WoodCaribou', 'StoneCaribou', 'MarbleCaribou'],
  // Not live yet. Taken from a preview build's shop payload, and listed for the same reason the
  // others are: an alarm can only be armed from a tab, and a shop that has never opened has no live
  // stock to build one from - so without these the first restock is the earliest you could ask to
  // be told about it, which is exactly the one worth knowing about.
  rain: ['Clover', 'Delphinium', 'Mushroom', 'VioletCort', 'RainWardShard', 'WoodFrog', 'StoneBirdbath', 'MarbleFountain'],
  amber: ['Persimmon', 'Habanero', 'Marigold', 'Emberbloom', 'MoonCelestial', 'AmberEgg', 'HungerShard', 'XPShard', 'StrengthShard', 'StoneMoonGate', 'StoneTorch', 'StoneFirepit'],
};

export const ITEM_KEYS = ['species', 'eggId', 'toolId', 'decorId'];

export const GRANTER_CHANCES: Record<string, number> = {
  RainbowGranter: .72, GoldGranter: .72, AmberlitGranter: 2, DawnlitGranter: 4, FrostGranter: 6,
  ThunderstruckGranter: 5, SnowGranter: 8, RainGranter: 10, RainDance: 10, ProduceScaleBoost: .3, ProduceScaleBoostI: .3, ProduceScaleBoostII: .4,
};

export const PROC_RULES: Record<string, { chance: number; tick: boolean; effect: (strength: number) => string }> = {
  PlantGrowthBoost: { chance: 24, tick: true, effect: strength => `Growth reduction: ${(3 * strength / 100).toFixed(1)}m per proc` },
  PlantGrowthBoostII: { chance: 27, tick: true, effect: strength => `Growth reduction: ${(5 * strength / 100).toFixed(1)}m per proc` },
  PlantGrowthBoostIII: { chance: 30, tick: true, effect: strength => `Growth reduction: ${(7 * strength / 100).toFixed(1)}m per proc` },
  SnowyPlantGrowthBoost: { chance: 40, tick: true, effect: strength => `Growth reduction: ${(6 * strength / 100).toFixed(1)}m per proc` },
  DawnPlantGrowthBoost: { chance: 60, tick: true, effect: strength => `Growth reduction: ${(6 * strength / 100).toFixed(1)}m per proc` },
  AmberPlantGrowthBoost: { chance: 80, tick: true, effect: strength => `Growth reduction: ${(6 * strength / 100).toFixed(1)}m per proc` },
  ThunderPlantGrowthBoost: { chance: 50, tick: true, effect: strength => `Growth reduction: ${(6 * strength / 100).toFixed(1)}m per proc` },
  EggGrowthBoost: { chance: 21, tick: true, effect: strength => `Hatch reduction: ${(7 * strength / 100).toFixed(1)}m per proc` },
  EggGrowthBoostII_NEW: { chance: 24, tick: true, effect: strength => `Hatch reduction: ${(9 * strength / 100).toFixed(1)}m per proc` },
  EggGrowthBoostII: { chance: 27, tick: true, effect: strength => `Hatch reduction: ${(11 * strength / 100).toFixed(1)}m per proc` },
  SnowyEggGrowthBoost: { chance: 35, tick: true, effect: strength => `Hatch reduction: ${(10 * strength / 100).toFixed(1)}m per proc` },
  ThunderEggGrowthBoost: { chance: 50, tick: true, effect: strength => `Hatch reduction: ${(10 * strength / 100).toFixed(1)}m per proc` },
  ProduceEater: { chance: 60, tick: true, effect: strength => `Sell bonus: ${(150 * strength / 100).toFixed(0)}% price` },
  DoubleHarvest: { chance: 5, tick: false, effect: () => 'Effect: double harvest' },
  DoubleHatch: { chance: 3, tick: false, effect: () => 'Effect: extra pet' },
  ProduceRefund: { chance: 20, tick: false, effect: () => 'Effect: crop refund' },
  SellBoostI: { chance: 10, tick: false, effect: strength => `Sell bonus: +${(20 * strength / 100).toFixed(0)}% coins` },
  SellBoostII: { chance: 12, tick: false, effect: strength => `Sell bonus: +${(30 * strength / 100).toFixed(0)}% coins` },
  SellBoostIII: { chance: 14, tick: false, effect: strength => `Sell bonus: +${(40 * strength / 100).toFixed(0)}% coins` },
  SellBoostIV: { chance: 16, tick: false, effect: strength => `Sell bonus: +${(50 * strength / 100).toFixed(0)}% coins` },
  PetRefund: { chance: 5, tick: false, effect: () => 'Effect: egg refund' },
  PetRefundII: { chance: 7, tick: false, effect: () => 'Effect: egg refund' },
  PetHatchSizeBoost: { chance: 12, tick: false, effect: strength => `Max STR boost: +${(2.4 * strength / 100).toFixed(2)}%` },
  PetHatchSizeBoostII: { chance: 14, tick: false, effect: strength => `Max STR boost: +${(3.5 * strength / 100).toFixed(2)}%` },
  PetHatchSizeBoostIII: { chance: 16, tick: false, effect: strength => `Max STR boost: +${(4.6 * strength / 100).toFixed(2)}%` },
  PetAgeBoost: { chance: 50, tick: false, effect: strength => `Bonus XP: +${Math.floor(8000 * strength / 100).toLocaleString(NUMBER_LOCALE)}` },
  PetAgeBoostII: { chance: 60, tick: false, effect: strength => `Bonus XP: +${Math.floor(12000 * strength / 100).toLocaleString(NUMBER_LOCALE)}` },
  PetAgeBoostIII: { chance: 70, tick: false, effect: strength => `Bonus XP: +${Math.floor(16000 * strength / 100).toLocaleString(NUMBER_LOCALE)}` },
  SeedFinderI: { chance: 40, tick: true, effect: () => 'Finds Common or Uncommon seeds' },
  SeedFinderII: { chance: 20, tick: true, effect: () => 'Finds Rare or Legendary seeds' },
  SeedFinderIII: { chance: 10, tick: true, effect: () => 'Finds Mythical seeds' },
  SeedFinderIV: { chance: .01, tick: true, effect: () => 'Finds an event seed' },
  HungerRestore: { chance: 12, tick: true, effect: strength => `Restores ${(30 * strength / 100).toFixed(1)}% hunger` },
  HungerRestoreII: { chance: 14, tick: true, effect: strength => `Restores ${(35 * strength / 100).toFixed(1)}% hunger` },
  HungerRestoreIII: { chance: 16, tick: true, effect: strength => `Restores ${(40 * strength / 100).toFixed(1)}% hunger` },
  SnowyHungerRestore: { chance: 20, tick: true, effect: strength => `Restores ${(38 * strength / 100).toFixed(1)}% hunger` },
};

// Minutes a full hunger bar lasts per species. Not present in the game bundle, so these come from
// the standalone calculators and are shared by the food planner and the active-pet hunger estimate.
export const HUNGER_MINUTES: Record<string, number> = {
  Worm: 30, Snail: 60, Bee: 15, Chicken: 60, Bunny: 45, Dragonfly: 15, Pig: 60, Cow: 75, Turkey: 60,
  SnowFox: 45, Stoat: 60, WhiteCaribou: 75, Squirrel: 30, Turtle: 90, Goat: 60, Sheep: 60, Ostrich: 45,
  Pony: 60, Horse: 75, FireHorse: 90, Bat: 30, Platypus: 60, ThunderWolf: 60, Butterfly: 30, Peacock: 60, Capybara: 60,
};

/** The only link in the script that asks anything of anyone, so it lives somewhere obvious. */
export const KOFI_URL = 'https://ko-fi.com/liam0306';

export const MAX_PET_TEAMS = 25;
export const MAX_TEAM_PETS = 3;
export const XP_PER_POTION = 20_000;

/**
 * Species that share one dirt tile. Either member can seed the patch and both can then grow in it,
 * so neither is the host: a purple daisy tile is as real as a daisy one. Thunderspire is the same
 * shape from the other direction, growing thunderpeels and stormcaps on the tile it seeds.
 */
export const PATCH_FAMILIES: ReadonlyArray<readonly string[]> = [
  ['Daisy', 'PurpleDaisy'],
  ['Clover', 'FourLeafClover'],
  ['Snowdrop', 'SnowdropDouble'],
  ['Cattail', 'VariegatedCattail'],
  ['ThunderCelestial', 'ThunderCelestialShroomPlant'],
  // Emberbloom seeds the tile and embercrowns grow in it, which is the clover shape: one seed
  // sprite between them, capacity on the parent, and the child sold nowhere.
  ['Emberbloom', 'Embercrown'],
];

/** Species to the family it shares a tile with, keyed by the family's first member. */
export const PATCH_FAMILY_OF: Record<string, string> = Object.fromEntries(
  PATCH_FAMILIES.flatMap(family => family.map(species => [species, family[0]])));

/**
 * What the game calls a crop, which is regularly not its species id: DawnCelestial is a Dawnbinder,
 * ThunderCelestialShroomPlant is a Stormcap, and OrangeTulip is just a Tulip. Overrides win so the
 * few the game words for its own card ("Dawnbinder Bulb") can be trimmed for a list.
 */
export function plantName(species: string): string {
  const name = NAME_OVERRIDES[species] ?? PLANT_CATALOG[species]?.crop?.name;
  if (!name) return humanize(species);
  // The game tails a few crops with Fruit where the word is the plant, not the crop: a Cacao Fruit
  // is just a cacao. Species whose id already ends in Fruit genuinely are called that, so a dragon
  // fruit keeps its name.
  return species.endsWith('Fruit') ? name : name.replace(/ Fruit$/, '');
}

/** What the game calls the plant. A patch is named for the plant, since its crops disagree. */
export function patchName(species: string): string {
  return PLANT_CATALOG[species]?.plantLabel || plantName(species);
}
