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
  petFood: true,
  instantHarvest: false,
  interfaceShortcuts: true,
  backgroundMode: true,
  autoRefreshGameUpdates: true,
  lunarTimer: true,
  abilitySilencer: true,
  silencedAbilities: [],
  trackedAbilities: [...ABILITY_CATALOG],
  shopAlerts: {},
  petFoodChoices: {},
  teamKeybinds: {},
  interfaceKeybinds: {},
};

function readConfig(): CompanionConfig {
  try {
    const saved = GM_getValue(STORE_KEY, {});
    return { ...DEFAULTS, ...(saved && typeof saved === 'object' ? saved : {}) } as CompanionConfig;
  } catch {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') } as CompanionConfig; }
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
  config.petFoodChoices = Object.fromEntries(Object.entries(savedFoodChoices).filter(([species, crop]) => PET_CATALOG[species]?.diet?.includes(crop)));
  if (config.silencedAbilities.length !== savedSilencedAbilities.length || Object.keys(config.shopAlerts).length !== Object.keys(savedShopAlerts).length) saveConfig();
}
