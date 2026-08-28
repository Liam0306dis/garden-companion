import type { CompanionConfig } from './types.js';
import { ABILITY_CATALOG, EXCLUDED_TOOL_ALERTS, EXCLUDED_TRACKED_ABILITIES, PET_CATALOG, STORE_KEY } from './constants.js';

/** Features that cannot be turned off, so their toggles never appear in the panel. */
export const ALWAYS_ENABLED = new Set(['overview', 'petTeams', 'abilities', 'rooms', 'shopAlarms', 'interfaceShortcuts', 'abilitySilencer', 'lunarTimer']);

export const DEFAULTS: CompanionConfig = {
  overview: true,
  dragMove: true,
  keepPlanterPotSelected: false,
  petTeams: true,
  abilities: true,
  rooms: true,
  shopAlarms: true,
  turtleTimer: true,
  cropValues: true,
  petFood: true,
  petHungerAlarm: false,
  instantHarvest: false,
  petSwapToss: false,
  autoStoreSeeds: false,
  autoStoreDecor: false,
  cropProtection: false,
  protectMaxSize: false,
  protectedMutations: [],
  protectedSpecies: {},
  interfaceShortcuts: true,
  backgroundMode: true,
  autoRefreshGameUpdates: true,
  lunarTimer: true,
  abilitySilencer: true,
  silencedAbilities: [],
  trackedAbilities: [...ABILITY_CATALOG],
  shopAlerts: {},
  weatherAlerts: {},
  petFoodChoices: {},
  teamKeybinds: {},
  interfaceKeybinds: {},
};

/**
 * Carries a setting forward when one switch becomes two.
 *
 * Crop value and growth time used to share turtleTimer, so turning it off meant "keep the card
 * quiet". Splitting them let the new switch take its own default and put the value back on a card
 * someone had deliberately cleared, undoing a choice they had already made. Only an untouched new
 * switch is answered for; once it has been set either way it speaks for itself.
 */
function migrate(saved: Record<string, unknown>): Record<string, unknown> {
  if (saved.turtleTimer === false && saved.cropValues === undefined) return { ...saved, cropValues: false };
  return saved;
}

function readConfig(): CompanionConfig {
  try {
    const saved = GM_getValue(STORE_KEY, {});
    return { ...DEFAULTS, ...migrate((saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>) } as CompanionConfig;
  } catch {
    try { return { ...DEFAULTS, ...migrate(JSON.parse(localStorage.getItem(STORE_KEY) || '{}')) } as CompanionConfig; }
    catch { return { ...DEFAULTS }; }
  }
}

export const config = readConfig();

export function saveConfig(): void {
  try { GM_setValue(STORE_KEY, config); }
  catch { localStorage.setItem(STORE_KEY, JSON.stringify(config)); }
}

export function feature(name: string): boolean {
  return ALWAYS_ENABLED.has(name) || config[name] !== false;
}

/**
 * Saved settings outlive the game: abilities stop being tracked, tools stop being sellable, and pet
 * diets change. Drop anything that no longer applies once, at load, so the rest of the panel can
 * trust what it reads.
 */
export function pruneStaleConfig(): void {
  const savedSilencedAbilities = Array.isArray(config.silencedAbilities) ? config.silencedAbilities : [];
  config.silencedAbilities = savedSilencedAbilities.filter(ability => !EXCLUDED_TRACKED_ABILITIES.has(ability));
  const savedShopAlerts = config.shopAlerts && typeof config.shopAlerts === 'object' ? config.shopAlerts : {};
  config.shopAlerts = Object.fromEntries(Object.entries(savedShopAlerts).filter(([key]) => {
    const [shop, itemId] = key.split(':');
    return shop !== 'tool' || !EXCLUDED_TOOL_ALERTS.has(itemId);
  }));
  const savedFoodChoices = config.petFoodChoices && typeof config.petFoodChoices === 'object' ? config.petFoodChoices : {};
  // A pet the baked catalog has never heard of is passed over rather than dropped: this runs before
  // the game's own catalog is captured, so judging a species newer than our last build would clear
  // a choice the player had made on every load.
  //
  // The Hunger Potion is not a crop and belongs to no diet, so measuring it against one dropped it
  // from every pet on every load - the choice saved, and was gone by the time the panel next drew.
  // Named here rather than imported: the constant lives with the pet food panel, which reads this
  // module, and reaching back for it would close the loop.
  config.petFoodChoices = Object.fromEntries(Object.entries(savedFoodChoices)
    .filter(([species, crop]) => crop === 'ReplenishPotion'
      || !PET_CATALOG[species] || PET_CATALOG[species].diet?.includes(crop)));
  const savedProtectedSpecies = config.protectedSpecies && typeof config.protectedSpecies === 'object' ? config.protectedSpecies : {};
  // Only the protected ones are worth keeping: an unticked species reads the same as an absent one.
  // Membership of the catalog is deliberately not checked - this runs before the game's own catalog
  // has been captured, so a species newer than our last build would be unticked on every load, and
  // a species the game has dropped can never match a crop anyway.
  config.protectedSpecies = Object.fromEntries(Object.entries(savedProtectedSpecies).filter(([, on]) => on === true));
  if (config.silencedAbilities.length !== savedSilencedAbilities.length
    || Object.keys(config.shopAlerts).length !== Object.keys(savedShopAlerts).length
    || Object.keys(config.protectedSpecies).length !== Object.keys(savedProtectedSpecies).length) saveConfig();
}
