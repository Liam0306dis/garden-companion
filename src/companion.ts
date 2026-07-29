import type {
  CompanionAlarmOptions,
  CompanionConfig,
  CompanionPage,
  FullState,
  GameState,
  JotaiAtom,
  Pet,
  PlantSlot,
  PlayerSlot,
  RoomState,
  ShopItem,
} from './types.js';

interface AbilityLogRow {
  at: number;
  ability: string;
  pet: string;
  data: Record<string, unknown>;
}

interface CompanionState {
  room: RoomState | null;
  game: GameState | null;
  slot: PlayerSlot | null;
  slotIndex: number | null;
  playerId: string | null;
  currentCrop: PlantSlot[] | null;
  currentEgg: PlantSlot | null;
  dirtTileIndex: string | number | null;
  selectedSlotId: string | number | null;
  currentAction: string | null;
  lastShopSignature: string;
  initializedShops: boolean;
  activityCursor: number;
  abilityLog: AbilityLogRow[];
}

export function initCompanion(): void {
  'use strict';

  const page = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage;
  const STORE_KEY = 'gardenCompanion.config.v1';
  const LOG_KEY = 'gardenCompanion.abilityLog.v1';
  const OVERVIEW_SHORTCUT_KEY = 'gardenCompanion.overviewShortcut.v1';
  const UPDATE_URL = 'https://raw.githubusercontent.com/Liam0306dis/garden-companion/main/dist/garden-companion.user.js';
  const ABILITY_CATALOG = __ABILITY_CATALOG__;
  const ABILITY_DETAILS = __ABILITY_DETAILS__;
  const PET_CATALOG = __PET_CATALOG__;
  const ABILITY_GROUPS = [
    ['Coin Finder', ['CoinFinderI', 'CoinFinderII', 'CoinFinderIII', 'SnowyCoinFinder', 'DawnCoinFinder', 'ThunderCoinFinder']],
    ['Plant Growth Boost', ['PlantGrowthBoost', 'PlantGrowthBoostII', 'PlantGrowthBoostIII', 'SnowyPlantGrowthBoost', 'DawnPlantGrowthBoost', 'AmberPlantGrowthBoost', 'ThunderPlantGrowthBoost']],
    ['Crop Size Boost', ['ProduceScaleBoost', 'ProduceScaleBoostII', 'ProduceScaleBoostIII', 'SnowyCropSizeBoost']],
    ['Egg Growth Boost', ['EggGrowthBoost', 'EggGrowthBoostII_NEW', 'EggGrowthBoostII', 'SnowyEggGrowthBoost', 'ThunderEggGrowthBoost']],
    ['XP Boost', ['PetXpBoost', 'PetXpBoostII', 'PetXpBoostIII', 'SnowyPetXpBoost', 'DawnXpBoost', 'ThunderXpBoost']],
    ['Hunger Restore', ['HungerRestore', 'HungerRestoreII', 'HungerRestoreIII', 'SnowyHungerRestore']],
    ['Hatch XP Boost', ['PetAgeBoost', 'PetAgeBoostII', 'PetAgeBoostIII']],
    ['Max Strength Boost', ['PetHatchSizeBoost', 'PetHatchSizeBoostII', 'PetHatchSizeBoostIII']],
    ['Pet Refund', ['PetRefund', 'PetRefundII']],
    ['Seed Finder', ['SeedFinderI', 'SeedFinderII', 'SeedFinderIII', 'SeedFinderIV']],
    ['Sell Boost', ['SellBoostI', 'SellBoostII', 'SellBoostIII', 'SellBoostIV']],
    ['Mutation Granter', ['RainDance', 'SnowGranter', 'FrostGranter', 'DawnlitGranter', 'AmberlitGranter', 'GoldGranter', 'RainbowGranter', 'ThunderstruckGranter']],
  ] as const;
  const UNGROUPED_TRACKED_ABILITIES = ['ProduceEater', 'ProduceRefund', 'DoubleHarvest', 'DoubleHatch'];
  const EXCLUDED_TRACKED_ABILITIES = new Set([
    'HungerBoost', 'HungerBoostII', 'HungerBoostIII', 'SnowyHungerBoost',
    'PetMutationBoost', 'PetMutationBoostII', 'PetMutationBoostIII',
    'ProduceMutationBoost', 'ProduceMutationBoostII', 'ProduceMutationBoostIII', 'SnowyCropMutationBoost', 'DawnBoost', 'AmberMoonBoost', 'ThunderBoost',
    'MoonKisser', 'DawnKisser', 'Thunderbloom', 'Copycat', 'DawnCapture', 'Thundercharger', 'DawnbinderBoost',
  ]);
  const TRACKED_ABILITY_CATALOG = ABILITY_CATALOG.filter(ability => !EXCLUDED_TRACKED_ABILITIES.has(ability));
  const ABILITY_SET = new Set(TRACKED_ABILITY_CATALOG);
  const ABILITY_GROUP_BY_ID = new Map<string, string>();
  for (const [label, abilities] of ABILITY_GROUPS) for (const ability of abilities) ABILITY_GROUP_BY_ID.set(ability, label);
  const ABILITY_FILTER_OPTIONS: Array<{ key: string; label: string; abilities: readonly string[] }> = [
    ...ABILITY_GROUPS.map(([label, abilities]) => ({ key: label, label, abilities })),
    ...UNGROUPED_TRACKED_ABILITIES.map(ability => ({ key: ability, label: ABILITY_DETAILS[ability]?.name || humanize(ability), abilities: [ability] })),
  ];
  const EXCLUDED_TOOL_ALERTS = new Set(['Shovel', 'FeedingTrough', 'DecorShed', 'PetHutch', 'SeedSilo']);
  const STACKED_PASSIVE_GROUPS = [
    { key: 'HungerBoost', label: 'Hunger Boost', parameter: 'hungerRefundPercentage', abilities: ['HungerBoost', 'HungerBoostII', 'HungerBoostIII', 'SnowyHungerBoost'] },
    { key: 'WeatherMutationBoost', label: 'Weather Mutation Boost', parameter: 'mutationChanceIncreasePercentage', abilities: ['ProduceMutationBoost', 'ProduceMutationBoostII', 'ProduceMutationBoostIII', 'SnowyCropMutationBoost', 'DawnBoost', 'AmberMoonBoost', 'ThunderBoost'] },
    { key: 'PetMutationBoost', label: 'Pet Mutation Boost', parameter: 'mutationChanceIncreasePercentage', abilities: ['PetMutationBoost', 'PetMutationBoostII', 'PetMutationBoostIII'] },
    { key: 'DawnbinderBoost', label: 'Dawnbinder Boost', parameter: 'plantAbilityChanceBoostPercentage', abilities: ['DawnbinderBoost'] },
  ] as const;
  const STACKED_PASSIVE_BY_ABILITY = new Map(STACKED_PASSIVE_GROUPS.flatMap(group => group.abilities.map(ability => [ability, group] as const)));
  const PASSIVE_REQUIRED_WEATHER = new Map<string, string>([
    ['SnowyHungerBoost', 'Frost'], ['SnowyCropMutationBoost', 'Frost'], ['DawnBoost', 'Dawn'],
    ['AmberMoonBoost', 'AmberMoon'], ['ThunderBoost', 'Thunderstorm'],
  ]);
  const ALWAYS_ENABLED = new Set(['overview', 'petTeams', 'abilities', 'rooms', 'shopAlarms', 'interfaceShortcuts', 'abilitySilencer', 'lunarTimer']);
  const DEFAULTS: CompanionConfig = {
    overview: true,
    dragMove: true,
    petTeams: true,
    abilities: true,
    rooms: true,
    shopAlarms: true,
    turtleTimer: true,
    instantHarvest: false,
    interfaceShortcuts: true,
    backgroundMode: true,
    autoRefreshGameUpdates: true,
    lunarTimer: true,
    abilitySilencer: true,
    silencedAbilities: [],
    trackedAbilities: [...ABILITY_CATALOG],
    shopAlerts: {},
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

  let config = readConfig();
  const savedSilencedAbilities = Array.isArray(config.silencedAbilities) ? config.silencedAbilities : [];
  config.silencedAbilities = savedSilencedAbilities.filter(ability => !EXCLUDED_TRACKED_ABILITIES.has(ability));
  const savedShopAlerts = config.shopAlerts && typeof config.shopAlerts === 'object' ? config.shopAlerts : {};
  config.shopAlerts = Object.fromEntries(Object.entries(savedShopAlerts).filter(([key]) => {
    const [shop, itemId] = key.split(':');
    return shop !== 'tool' || !EXCLUDED_TOOL_ALERTS.has(itemId);
  }));
  function saveConfig() {
    try { GM_setValue(STORE_KEY, config); }
    catch { localStorage.setItem(STORE_KEY, JSON.stringify(config)); }
  }
  function refreshVisibleKeybindInputs(): void {
    document.querySelectorAll<HTMLInputElement>('#gc-panel [data-team-key]').forEach(field => {
      field.value = config.teamKeybinds[field.dataset.teamKey!] || '';
    });
    document.querySelectorAll<HTMLInputElement>('#gc-panel [data-interface-key]').forEach(field => {
      field.value = config.interfaceKeybinds[field.dataset.interfaceKey!] || '';
    });
    document.querySelectorAll<HTMLInputElement>('#gc-panel [data-overview-key]').forEach(field => {
      field.value = localStorage.getItem(OVERVIEW_SHORTCUT_KEY) || '';
    });
  }
  function claimKeybind(owner: string, combo: string): void {
    const [kind, id = ''] = owner.split(':', 2);
    if (kind === 'team') delete config.teamKeybinds[id];
    if (kind === 'interface') delete config.interfaceKeybinds[id];
    let overviewShortcutChanged: string | null = null;
    if (owner === 'overview') {
      localStorage.removeItem(OVERVIEW_SHORTCUT_KEY);
      overviewShortcutChanged = '';
    }

    if (combo) {
      for (const key of Object.keys(config.interfaceKeybinds)) {
        if (config.interfaceKeybinds[key] === combo) delete config.interfaceKeybinds[key];
      }
      for (const key of Object.keys(config.teamKeybinds)) {
        if (config.teamKeybinds[key] === combo) delete config.teamKeybinds[key];
      }
      if (owner !== 'overview' && localStorage.getItem(OVERVIEW_SHORTCUT_KEY) === combo) {
        localStorage.removeItem(OVERVIEW_SHORTCUT_KEY);
        overviewShortcutChanged = '';
      }
      if (kind === 'team') config.teamKeybinds[id] = combo;
      if (kind === 'interface') config.interfaceKeybinds[id] = combo;
      if (owner === 'overview') {
        localStorage.setItem(OVERVIEW_SHORTCUT_KEY, combo);
        overviewShortcutChanged = combo;
      }
    }

    saveConfig();
    refreshVisibleKeybindInputs();
    if (overviewShortcutChanged !== null) page.__gardenCompanionOverviewShortcutChanged?.(overviewShortcutChanged);
  }
  page.__gardenCompanionClaimKeybind = claimKeybind;
  if (config.silencedAbilities.length !== savedSilencedAbilities.length || Object.keys(config.shopAlerts).length !== Object.keys(savedShopAlerts).length) saveConfig();

  function feature(name: string): boolean { return ALWAYS_ENABLED.has(name) || config[name] !== false; }
  (window as unknown as CompanionPage).__gardenCompanionFeature = feature;
  page.__gardenCompanionFeature = feature;
  page.__gardenCompanionConfig = () => config;

  let gameUpdateDetected = false;
  function handleGameUpdateDetected(source: string): void {
    if (gameUpdateDetected) return;
    gameUpdateDetected = true;
    console.info(`[Garden Companion] Game update detected from ${source}.`);
    if (!feature('autoRefreshGameUpdates')) {
      toast('Game update available. Reload the page when ready.', 'error');
      return;
    }
    toast('Game update detected. Refreshing in 5 seconds.', 'success');
    setTimeout(() => page.location.reload(), 5_000);
  }

  function handleGameSocketClose(event: CloseEvent): void {
    if (event.code === 4710 || event.reason.toLowerCase() === 'version expired') handleGameUpdateDetected('WebSocket');
  }

  function installGameUpdateSocketDetector(): void {
    const OriginalWebSocket = page.WebSocket as typeof WebSocket;
    const GardenCompanionWebSocket = function(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
      const socket = new OriginalWebSocket(...args);
      socket.addEventListener('close', handleGameSocketClose);
      return socket;
    } as unknown as typeof WebSocket;
    Object.setPrototypeOf(GardenCompanionWebSocket, OriginalWebSocket);
    GardenCompanionWebSocket.prototype = OriginalWebSocket.prototype;
    page.WebSocket = GardenCompanionWebSocket;
  }

  installGameUpdateSocketDetector();

  function installBackgroundMode(): void {
    if (!feature('backgroundMode')) return;
    try {
      const documentPrototype = Object.getPrototypeOf(page.document);
      Object.defineProperty(documentPrototype, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(documentPrototype, 'visibilityState', { configurable: true, get: () => 'visible' });
      page.document.hasFocus = () => true;
    } catch (error) {
      console.warn('[Garden Companion] Could not install background visibility mode.', error);
    }
    const keepVisible = (event: Event) => event.stopImmediatePropagation();
    page.document.addEventListener('visibilitychange', keepVisible, true);
    page.addEventListener('blur', keepVisible, true);
    page.addEventListener('focus', keepVisible, true);

    let audioContext: AudioContext | null = null;
    const startSilentAudio = () => {
      if (!feature('backgroundMode')) return;
      if (audioContext) {
        if (audioContext.state !== 'running') void audioContext.resume();
        return;
      }
      try {
        const AudioConstructor = page.AudioContext as typeof AudioContext || (page as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioConstructor) return;
        audioContext = new AudioConstructor({ latencyHint: 'interactive' });
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.frequency.value = 1;
        gain.gain.value = 0.00001;
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start();
      } catch (error) {
        console.warn('[Garden Companion] Could not start background audio context.', error);
      }
    };
    page.addEventListener('pointerdown', startSilentAudio, true);
    page.addEventListener('keydown', startSilentAudio, true);
  }

  installBackgroundMode();

  const state: CompanionState = {
    room: null,
    game: null,
    slot: null,
    slotIndex: null,
    playerId: null,
    currentCrop: null,
    currentEgg: null,
    dirtTileIndex: null,
    selectedSlotId: null,
    currentAction: null,
    lastShopSignature: '',
    initializedShops: false,
    activityCursor: Number(localStorage.getItem('gardenCompanion.activityCursor') || 0),
    abilityLog: trimAbilityLogs(loadLocal<AbilityLogRow[]>(LOG_KEY, [])),
  };

  const SHOP_NAMES = { seed: 'Seed', egg: 'Egg', decor: 'Decor', tool: 'Tool', dawn: 'Dawn', snow: 'Snow', thunder: 'Thunder' };
  const SHOP_TABS = [['seed', 'Seeds'], ['dawn', 'Dawn'], ['thunder', 'Thunder'], ['snow', 'Snow'], ['egg', 'Eggs'], ['tool', 'Tools'], ['decor', 'Decor']];
  const SEASONAL_SHOP_ITEMS: Record<string, string[]> = {
    dawn: ['Daisy', 'Lavender', 'Saffron', 'Eggplant', 'Ube', 'Dawnbreaker', 'DawnCelestial', 'DawnEgg'],
    thunder: ['Cattail', 'Cardoon', 'PricklyPear', 'Milkcap', 'ThunderCelestial', 'ThunderEgg', 'SmallGravestone', 'MediumGravestone', 'LargeGravestone', 'Cauldron', 'WindchimeMoon', 'WindchimeStar', 'WindSpinner', 'WindTurner'],
    snow: ['Snowdrop', 'PineTree', 'Leek', 'Squash', 'Poinsettia', 'SnowEgg', 'ChilledPotion', 'FrozenPotion', 'ColoredStringLights', 'WoodCaribou', 'StoneCaribou', 'MarbleCaribou'],
  };
  const ITEM_KEYS = ['species', 'eggId', 'toolId', 'decorId'];

  const GRANTER_CHANCES: Record<string, number> = {
    RainbowGranter: .72, GoldGranter: .72, AmberlitGranter: 2, DawnlitGranter: 4, FrostGranter: 6,
    ThunderstruckGranter: 5, SnowGranter: 8, RainGranter: 10, RainDance: 10, ProduceScaleBoost: .3, ProduceScaleBoostI: .3, ProduceScaleBoostII: .4,
  };
  const PROC_RULES: Record<string, { chance: number; tick: boolean; effect: (strength: number) => string }> = {
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
    PetAgeBoost: { chance: 50, tick: false, effect: strength => `Bonus XP: +${Math.floor(8000 * strength / 100).toLocaleString()}` },
    PetAgeBoostII: { chance: 60, tick: false, effect: strength => `Bonus XP: +${Math.floor(12000 * strength / 100).toLocaleString()}` },
    PetAgeBoostIII: { chance: 70, tick: false, effect: strength => `Bonus XP: +${Math.floor(16000 * strength / 100).toLocaleString()}` },
    SeedFinderI: { chance: 40, tick: true, effect: () => 'Finds Common or Uncommon seeds' },
    SeedFinderII: { chance: 20, tick: true, effect: () => 'Finds Rare or Legendary seeds' },
    SeedFinderIII: { chance: 10, tick: true, effect: () => 'Finds Mythical seeds' },
    SeedFinderIV: { chance: .01, tick: true, effect: () => 'Finds an event seed' },
    HungerRestore: { chance: 12, tick: true, effect: strength => `Restores ${(30 * strength / 100).toFixed(1)}% hunger` },
    HungerRestoreII: { chance: 14, tick: true, effect: strength => `Restores ${(35 * strength / 100).toFixed(1)}% hunger` },
    HungerRestoreIII: { chance: 16, tick: true, effect: strength => `Restores ${(40 * strength / 100).toFixed(1)}% hunger` },
    SnowyHungerRestore: { chance: 20, tick: true, effect: strength => `Restores ${(38 * strength / 100).toFixed(1)}% hunger` },
  };
  function loadLocal<T>(key: string, fallback: T): T {
    try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
    catch { return fallback; }
  }

  function saveLocal(key: string, value: unknown): void {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  }

  function trimAbilityLogs(logs: AbilityLogRow[]): AbilityLogRow[] {
    const retained = new Map<string, number>();
    return logs.filter(log => {
      const count = retained.get(log.ability) ?? 0;
      if (count >= 100) return false;
      retained.set(log.ability, count + 1);
      return true;
    });
  }

  function escapeHtml(value: unknown): string {
    return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
  }

  function humanize(value: unknown): string {
    return String(value || '').replace(/_NEW$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Za-z])([IVX]+)$/g, '$1 $2');
  }

  function formatDuration(ms: number): string {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }

  function send(command: Record<string, unknown>): void {
    const connection = page.MagicCircle_RoomConnection;
    if (!connection || typeof connection.sendMessage !== 'function') throw new Error('The game connection is not ready.');
    connection.sendMessage({ scopePath: ['Room', 'Quinoa'], ...command });
  }

  function sendQuinoaCommand(command: Record<string, unknown>): string {
    const requestId = crypto.randomUUID();
    send({ type: 'QuinoaCommand', requestId, command });
    return requestId;
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(message: string, tone = ''): void {
    let element = document.getElementById('gc-toast');
    if (!element) {
      element = document.createElement('div');
      element.id = 'gc-toast';
      document.documentElement.appendChild(element);
    }
    element.textContent = message;
    element.dataset.tone = tone;
    element.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('is-visible'), 2600);
  }

  function readPlayerId(): string | null {
    try {
      let value = new URL(page.MagicCircle_RoomConnection?.currentWebSocket?.url || '').searchParams.get('playerId');
      if (value?.startsWith('"')) value = JSON.parse(value);
      return value || null;
    } catch { return null; }
  }

  function pickSlot(game: GameState | null, room: RoomState | null, playerId: string | null): { slot: PlayerSlot | null; index: number | null } {
    const slots = Array.isArray(game?.userSlots) ? game.userSlots : [];
    let slot = slots.find(item => item?.playerId === playerId || item?.data?.playerId === playerId);
    if (!slot) {
      const databaseId = room?.players?.find(item => item?.id === playerId)?.databaseUserId;
      slot = slots.find(item => item?.data?.databaseUserId === databaseId || item?.data?.userId === databaseId);
    }
    return { slot: slot || null, index: slot ? slots.indexOf(slot) : null };
  }

  function subscribeToState(attempt = 0) {
    const connection = page.MagicCircle_RoomConnection;
    if (typeof connection?.subscribeToPatches !== 'function') {
      if (attempt < 180) setTimeout(() => subscribeToState(attempt + 1), 500);
      return;
    }
    connection.subscribeToPatches((_patches: unknown[], fullState: FullState) => {
      state.room = fullState?.data || null;
      state.game = fullState?.child?.data || null;
      state.playerId = fullState?.selfPlayerId || state.room?.selfPlayerId || state.playerId || readPlayerId();
      const picked = pickSlot(state.game, state.room, state.playerId);
      state.slot = picked.slot;
      state.slotIndex = picked.index;
      page.__gardenCompanionState = state;
      refreshCompletedTeamSave();
      refreshCompletedTeamDelete();
      processActivities();
      processShops();
      refreshOpenPanel();
    });
  }

  function atomMap(): Map<unknown, JotaiAtom> | null {
    const cache = page.jotaiAtomCache;
    if (cache instanceof Map) return cache;
    return cache?.cache ?? null;
  }

  type GameInterface = 'weatherStation' | 'seedShop' | 'eggShop' | 'toolShop';
  const GAME_INTERFACES: ReadonlyArray<{ id: GameInterface; label: string }> = [
    { id: 'weatherStation', label: 'Weather station' },
    { id: 'seedShop', label: 'Seed shop' },
    { id: 'eggShop', label: 'Egg shop' },
    { id: 'toolShop', label: 'Tool shop' },
  ];
  let activeModalAtom: JotaiAtom | null = null;
  let gameAtomSet: ((atom: JotaiAtom, value: unknown) => unknown) | null = null;
  const wrappedAtomWrites = new Map<JotaiAtom, JotaiAtom['write']>();

  function restoreAtomWriteCaptures(): void {
    for (const [atom, original] of wrappedAtomWrites) if (atom.write) atom.write = original;
    wrappedAtomWrites.clear();
  }

  function inspectGameAtom(key: unknown, atom: JotaiAtom): JotaiAtom {
    const atomKey = String(key);
    if (atomKey.endsWith('/activeModalAtom')) activeModalAtom = atom;
    if ((atomKey.endsWith('/quinoaEngineAtom') || atom.debugLabel === 'quinoaEngineAtom') && typeof atom.write === 'function' && !atom.__gardenCompanionEngineCapture) {
      const originalEngineWrite = atom.write;
      atom.write = function(get, set, ...args) {
        const result = originalEngineWrite.call(this, get, set, ...args);
        captureQuinoaEngine(args[0]);
        return result;
      };
      atom.__gardenCompanionEngineCapture = true;
    }
    if (gameAtomSet || typeof atom?.write !== 'function' || wrappedAtomWrites.has(atom)) return atom;
    const original = atom.write;
    atom.write = function(get, set, ...args) {
      gameAtomSet = (target, value) => set(target, value);
      restoreAtomWriteCaptures();
      return original.call(this, get, set, ...args);
    };
    wrappedAtomWrites.set(atom, original);
    return atom;
  }

  function installGameModalAccess(): void {
    const existing = page.jotaiAtomCache;
    if (!existing) {
      const cache = new Map<unknown, JotaiAtom>();
      page.jotaiAtomCache = {
        cache,
        get(key, initial) {
          const atom = cache.get(key) ?? initial;
          if (!cache.has(key)) cache.set(key, atom);
          return inspectGameAtom(key, atom);
        },
      };
      return;
    }
    const cache = existing instanceof Map ? existing : existing.cache;
    cache?.forEach((atom, key) => inspectGameAtom(key, atom));
    if (!(existing instanceof Map) && typeof existing.get === 'function' && !existing.__gardenCompanionWrapped) {
      const originalGet = existing.get;
      existing.get = function(key, initial) { return inspectGameAtom(key, originalGet.call(this, key, initial)); };
      existing.__gardenCompanionWrapped = true;
    }
  }

  function openGameInterface(target: GameInterface): void {
    if (!activeModalAtom || !gameAtomSet) {
      toast('The game interface is still loading.', 'error');
      return;
    }
    gameAtomSet(activeModalAtom, target);
  }

  function hookAtom(match, key, attempt = 0) {
    const map = atomMap();
    if (!map || typeof map.values !== 'function') {
      if (attempt < 180) setTimeout(() => hookAtom(match, key, attempt + 1), 500);
      return;
    }
    for (const atom of map.values()) {
      const label = String(atom?.debugLabel || '');
      if (!label.endsWith(match) || typeof atom.read !== 'function') continue;
      const flag = `__gardenCompanion:${key}`;
      if (atom[flag]) return;
      const original = atom.read;
      atom.read = function(get, ...args) {
        const value = original.call(this, get, ...args);
        (state as unknown as Record<string, unknown>)[key] = value;
        if (key === 'selectedSlotId') state.selectedSlotId = value as string | number | null;
        return value;
      };
      atom[flag] = true;
      return;
    }
    if (attempt < 180) setTimeout(() => hookAtom(match, key, attempt + 1), 500);
  }

  function installAtomHooks() {
    hookAtom('myCurrentGrowSlotsAtom', 'currentCrop');
    hookAtom('myCurrentEggAtom', 'currentEgg');
    hookAtom('myOwnCurrentDirtTileIndexAtom', 'dirtTileIndex');
    hookAtom('mySelectedSlotIdAtom', 'selectedSlotId');
    hookAtom('data/action/actionAtom.ts/actionAtom', 'currentAction');
  }

  function processActivities() {
    if (!feature('abilities')) return;
    const entries = state.slot?.data?.activityLogs;
    if (!Array.isArray(entries)) return;
    const fresh = entries.filter(entry => Number(entry?.timestamp) > state.activityCursor).sort((a, b) => a.timestamp - b.timestamp);
    if (!fresh.length) return;
    for (const entry of fresh) {
      if (!ABILITY_SET.has(entry.action)) continue;
      const pet = (entry.parameters?.pet || entry.parameters?.sourcePet || {}) as Record<string, unknown>;
      state.abilityLog.unshift({
        at: Number(entry.timestamp),
        ability: entry.action,
        pet: String(pet.name || pet.petSpecies || 'Pet'),
        data: snapshotPayload(entry.parameters || {}),
      });
    }
    state.abilityLog = trimAbilityLogs(state.abilityLog);
    state.activityCursor = Math.max(state.activityCursor, ...fresh.map(entry => Number(entry.timestamp) || 0));
    localStorage.setItem('gardenCompanion.activityCursor', String(state.activityCursor));
    saveLocal(LOG_KEY, state.abilityLog);
  }

  function itemId(item) {
    for (const key of ITEM_KEYS) if (item?.[key]) return String(item[key]);
    return '';
  }

  function itemType(item, shop) {
    if (item?.itemType) return item.itemType;
    return { seed: 'Seed', egg: 'Egg', decor: 'Decor', tool: 'Tool' }[shop] || (item?.eggId ? 'Egg' : item?.decorId ? 'Decor' : item?.toolId ? 'Tool' : 'Seed');
  }

  function itemPayload(item, shop) {
    const payload = { itemType: itemType(item, shop) };
    for (const key of ITEM_KEYS) if (item?.[key]) payload[key] = item[key];
    return payload;
  }

  function purchasedCount(shop, id) {
    const purchases = state.slot?.data?.shopPurchases?.[shop]?.purchases || {};
    return Number(purchases[id] || 0);
  }

  function availableShopItems() {
    const output = [];
    for (const [shop, data] of Object.entries(state.game?.shops || {})) {
      for (const item of Array.isArray(data?.inventory) ? data.inventory : []) {
        const id = itemId(item);
        const remaining = Math.max(0, Number(item.initialStock || 0) - purchasedCount(shop, id));
        if (id && remaining > 0 && !(shop === 'tool' && EXCLUDED_TOOL_ALERTS.has(id))) output.push({ shop, id, item, remaining });
      }
    }
    return output;
  }

  function processShops() {
    if (!feature('shopAlarms')) return;
    const available = availableShopItems();
    const signature = available.map(row => `${row.shop}:${row.id}:${row.remaining}`).sort().join('|');
    if (signature === state.lastShopSignature) return;
    const old = new Set(state.lastShopSignature.split('|').map(value => value.split(':').slice(0, 2).join(':')));
    state.lastShopSignature = signature;
    for (const row of available) {
      const key = `${row.shop}:${row.id}`;
      if (config.shopAlerts[key] && (!state.initializedShops || !old.has(key))) showShopAlarm(row);
    }
    state.initializedShops = true;
  }

  let alarm: { timer: ReturnType<typeof setInterval> | null; options: CompanionAlarmOptions } | null = null;
  const alarmQueue: CompanionAlarmOptions[] = [];
  let alarmAudioContext: AudioContext | null = null;
  let alarmPhase = 0;

  function armAlarmAudio(): AudioContext | null {
    try {
      if (!alarmAudioContext) {
        const AudioConstructor = page.AudioContext as typeof AudioContext || (page as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioConstructor) return null;
        alarmAudioContext = new AudioConstructor({ latencyHint: 'interactive' });
      }
      if (alarmAudioContext.state !== 'running') void alarmAudioContext.resume().catch(() => undefined);
      return alarmAudioContext;
    } catch {
      return null;
    }
  }

  function playAlarmTone(): void {
    const context = armAlarmAudio();
    if (!context) return;
    const play = () => {
      if (context.state === 'running') alarmTone(context);
    };
    if (context.state === 'running') play();
    else void context.resume().then(play).catch(() => undefined);
  }

  page.addEventListener('pointerdown', () => { if (feature('shopAlarms')) armAlarmAudio(); }, true);
  page.addEventListener('keydown', () => { if (feature('shopAlarms')) armAlarmAudio(); }, true);

  function clearActiveAlarm(): void {
    if (alarm?.timer) clearInterval(alarm.timer);
    document.getElementById('gc-alarm')?.remove();
    alarm = null;
  }

  function updateAlarmQueueCount(): void {
    const count = document.querySelector<HTMLElement>('#gc-alarm [data-alarm-queue]');
    if (!count) return;
    count.hidden = alarmQueue.length === 0;
    count.textContent = alarmQueue.length === 1 ? '1 more alarm queued' : `${alarmQueue.length} more alarms queued`;
  }

  function dismissCurrentAlarm(): void {
    clearActiveAlarm();
    const next = alarmQueue.shift();
    if (next) renderAlarmBanner(next);
  }

  function stopAlarm(owner?: string): void {
    if (!owner) {
      alarmQueue.length = 0;
      clearActiveAlarm();
      return;
    }
    for (let index = alarmQueue.length - 1; index >= 0; index--) {
      if (alarmQueue[index].owner === owner) alarmQueue.splice(index, 1);
    }
    if (alarm?.options.owner === owner) {
      clearActiveAlarm();
      const next = alarmQueue.shift();
      if (next) renderAlarmBanner(next);
    } else updateAlarmQueueCount();
  }
  page.__gardenCompanionArmAlarm = armAlarmAudio;
  page.__gardenCompanionStopAlarm = stopAlarm;

  function alarmTone(context) {
    const now = context.currentTime;
    const frequency = [880, 660, 880, 660, 0][alarmPhase++ % 5];
    if (!frequency) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.connect(gain); gain.connect(context.destination);
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(.25, now);
    gain.gain.exponentialRampToValueAtTime(.001, now + .38);
    oscillator.start(now); oscillator.stop(now + .4);
  }

  function renderAlarmBanner(options: CompanionAlarmOptions): void {
    const banner = document.createElement('div');
    banner.id = 'gc-alarm';
    const detail = options.detail ? `<span>${escapeHtml(options.detail)}</span>` : '';
    const action = options.actionLabel ? `<button data-buy>${escapeHtml(options.actionLabel)}</button>` : '';
    banner.innerHTML = `<i class="gc-alarm-icon">!</i><div><small>${escapeHtml(options.label)}</small><strong>${escapeHtml(options.title)}</strong>${detail}<em data-alarm-queue hidden></em></div>${action}<button data-stop>Stop alarm</button>`;
    document.body.appendChild(banner);
    banner.querySelector<HTMLButtonElement>('[data-stop]')!.onclick = dismissCurrentAlarm;
    const actionButton = banner.querySelector<HTMLButtonElement>('[data-buy]');
    if (actionButton && options.onAction) actionButton.onclick = event => { void options.onAction?.(event.currentTarget as HTMLButtonElement); };
    alarmPhase = 0;
    playAlarmTone();
    alarm = { timer: setInterval(playAlarmTone, 420), options };
    updateAlarmQueueCount();
  }

  function showAlarmBanner(options: CompanionAlarmOptions): void {
    if (alarm) {
      alarmQueue.push(options);
      updateAlarmQueueCount();
      return;
    }
    renderAlarmBanner(options);
  }
  page.__gardenCompanionShowAlarm = showAlarmBanner;

  function showShopAlarm(row) {
    showAlarmBanner({
      label: `SHOP ALARM | ${SHOP_NAMES[row.shop] || humanize(row.shop)}`,
      title: `${humanize(row.id)} is available`,
      detail: `${row.remaining} remaining`,
      actionLabel: 'Buy all',
      onAction: async button => {
        button.disabled = true;
        button.textContent = 'Buying...';
        const live = availableShopItems().find(item => item.shop === row.shop && item.id === row.id);
        if (!live) { toast('This item is no longer available.', 'error'); dismissCurrentAlarm(); return; }
        for (let index = 0; index < live.remaining; index++) {
          sendQuinoaCommand({ type: 'PurchaseShopItem', shop: live.shop, item: itemPayload(live.item, live.shop) });
          if (index + 1 < live.remaining) await new Promise(resolve => setTimeout(resolve, 180));
        }
        toast(`Requested ${live.remaining} ${humanize(live.id)}.`, 'success');
        dismissCurrentAlarm();
      },
    });
  }

  function showSelectedShopAlarm(key: string): void {
    const row = availableShopItems().find(item => `${item.shop}:${item.id}` === key);
    if (row) showShopAlarm(row);
  }

  function allPets() {
    const data = state.slot?.data || {};
    const active = (data.petSlots || []).map(pet => ({ ...pet, location: 'Active' }));
    const inventory = (data.inventory?.items || []).filter(item => item.itemType === 'Pet').map(pet => ({ ...pet, location: 'Inventory' }));
    const stored = (data.inventory?.storages || []).flatMap(storage => (storage.items || []).filter(item => item.itemType === 'Pet').map(pet => ({ ...pet, location: humanize(storage.decorId || 'Storage') })));
    const seen = new Set();
    return [...active, ...inventory, ...stored].filter(pet => pet.id && !seen.has(pet.id) && seen.add(pet.id));
  }

  function teams() { return state.slot?.data?.petTeams || []; }

  const mutatedPetSprites = new Map<string, string>();
  const pendingPetSprites = new Set<string>();

  function renderMutatedPetSprite(key: string, source: string, mutation: string): void {
    if (mutatedPetSprites.has(key) || pendingPetSprites.has(key)) return;
    pendingPetSprites.add(key);
    const image = new Image();
    image.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext('2d');
        if (!context) return;
        context.drawImage(image, 0, 0);
        if (mutation === 'gold') {
          context.globalCompositeOperation = 'source-atop';
          context.globalAlpha = .7;
          context.fillStyle = 'rgb(235,200,0)';
          context.fillRect(0, 0, canvas.width, canvas.height);
        } else {
          const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
          let minimum = canvas.width + canvas.height;
          let maximum = 0;
          for (let y = 0; y < canvas.height; y += 2) for (let x = 0; x < canvas.width; x += 2) {
            if (pixels[(y * canvas.width + x) * 4 + 3] < 8) continue;
            minimum = Math.min(minimum, x + y);
            maximum = Math.max(maximum, x + y);
          }
          if (maximum <= minimum) { minimum = 0; maximum = canvas.width + canvas.height; }
          const gradient = context.createLinearGradient(minimum / 2, minimum / 2, maximum / 2, maximum / 2);
          ['#ff1744', '#ff9100', '#ffea00', '#00e676', '#2979ff', '#d500f9'].forEach((color, index, colors) => gradient.addColorStop(index / (colors.length - 1), color));
          context.globalCompositeOperation = 'color';
          context.globalAlpha = 1;
          context.fillStyle = gradient;
          context.fillRect(0, 0, canvas.width, canvas.height);
        }
        context.globalAlpha = 1;
        context.globalCompositeOperation = 'destination-in';
        context.drawImage(image, 0, 0);
        const result = canvas.toDataURL('image/png');
        mutatedPetSprites.set(key, result);
        document.querySelectorAll<HTMLImageElement>('img[data-pet-mutation-key]').forEach(element => {
          if (element.dataset.petMutationKey === key) element.src = result;
        });
      } finally {
        pendingPetSprites.delete(key);
      }
    };
    image.onerror = () => pendingPetSprites.delete(key);
    image.src = source;
  }

  function petSprite(pet: Pet): string {
    const source = page.__gardenCompanionPetSprites?.[pet.petSpecies];
    const mutations = pet.mutations || [];
    const overlay = mutations.includes('Rainbow') ? 'rainbow' : mutations.includes('Gold') ? 'gold' : '';
    const mutationKey = source && overlay ? `${pet.petSpecies}:${overlay}` : '';
    if (source && overlay) renderMutatedPetSprite(mutationKey, source, overlay);
    const displayedSource = mutationKey ? mutatedPetSprites.get(mutationKey) || source : source;
    return `<span class="gc-pet-sprite">${displayedSource ? `<img src="${escapeHtml(displayedSource)}" alt="${escapeHtml(pet.petSpecies)}"${mutationKey ? ` data-pet-mutation-key="${escapeHtml(mutationKey)}"` : ''}>` : `<i>${escapeHtml((PET_CATALOG[pet.petSpecies]?.name || pet.petSpecies || '?').slice(0, 1))}</i>`}</span>`;
  }

  function hungerDisplay(pet: Pet): string {
    const maximum = Number(PET_CATALOG[pet.petSpecies]?.maxHunger || 0);
    const value = Math.max(0, Number(pet.hunger || 0));
    const percent = maximum > 0 ? Math.min(100, value / maximum * 100) : value > 0 ? 100 : 0;
    const tone = percent < 20 ? 'low' : percent < 50 ? 'medium' : 'good';
    return `<div class="gc-hunger" title="${value.toLocaleString()} / ${maximum.toLocaleString()}"><div><span>Hunger</span><b>${Math.round(percent)}%</b></div><i><u data-tone="${tone}" style="width:${percent.toFixed(2)}%"></u></i></div>`;
  }

  function petMetrics(pet: Pet): { strength: number; maxStrength: number; xpPerLevel: number; xpToMax: number } | null {
    const info = PET_CATALOG[pet.petSpecies];
    if (!info?.maxScale || info.maxScale <= 1 || !info.hoursToMature || !pet.targetScale) return null;
    const xpPerLevel = Math.floor(3600 * info.hoursToMature / 30);
    const maxStrength = Math.floor(((pet.targetScale - 1) / (info.maxScale - 1)) * 20 + 80);
    if (maxStrength < 80 || maxStrength > 100) return null;
    const levelProgress = Math.min(30, Math.floor(Number(pet.xp ?? 0) / xpPerLevel));
    const strength = maxStrength - 30 + levelProgress;
    const xpIntoLevel = Number(pet.xp ?? 0) % xpPerLevel;
    const xpToMax = strength >= maxStrength ? 0 : xpPerLevel - xpIntoLevel + xpPerLevel * (maxStrength - strength - 1);
    return { strength, maxStrength, xpPerLevel, xpToMax };
  }

  const XP_ABILITY_REGISTRY: Record<string, { baseChance: number; baseXp: number }> = {
    PetXpBoost: { baseChance: 30, baseXp: 300 },
    PetXpBoostI: { baseChance: 30, baseXp: 300 },
    PetXpBoostII: { baseChance: 35, baseXp: 400 },
  };

  function abilityXpPerHour(strength: number, baseChance: number, baseXp: number): number {
    const multiplier = Math.max(.25, strength / 100);
    const chancePerSecond = Math.min(.95 / 60, baseChance / 60 / 100 * multiplier);
    return 3600 * chancePerSecond * baseXp * multiplier;
  }

  function teamXpPerHour(pets: Pet[]): number {
    let total = 3600;
    for (const pet of pets) {
      if (pet.hunger <= 0) continue;
      const strength = petMetrics(pet)?.strength ?? 100;
      for (const ability of pet.abilities ?? []) {
        const xpAbility = XP_ABILITY_REGISTRY[ability];
        if (xpAbility) total += abilityXpPerHour(strength, xpAbility.baseChance, xpAbility.baseXp);
      }
    }
    return total;
  }

  function formatEstimate(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return 'Ready';
    const minutes = Math.ceil(seconds / 60);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor(minutes % 1440 / 60);
    const remainder = minutes % 60;
    return days ? `${days}d ${hours}h` : hours ? `${hours}h ${remainder}m` : `${minutes}m`;
  }

  const GRANTER_MUTATIONS: Record<string, string> = {
    RainDance: 'Wet', SnowGranter: 'Chilled', FrostGranter: 'Frozen', DawnlitGranter: 'Dawnlit',
    AmberlitGranter: 'Ambershine', GoldGranter: 'Gold', RainbowGranter: 'Rainbow', ThunderstruckGranter: 'Thunderstruck',
  };

  function abilityEffectText(ability: string, strength: number, trigger: string | undefined, parameters: Record<string, number> | undefined): string {
    const proc = PROC_RULES[ability];
    if (proc) return proc.effect(strength);
    if (GRANTER_MUTATIONS[ability]) return `Applies the ${GRANTER_MUTATIONS[ability]} mutation`;
    const values = parameters ?? {};
    const scaled = (key: string) => Number(values[key] || 0) * strength / 100;
    const percent = (value: number) => Number(value.toFixed(2)).toLocaleString();
    if (values.hungerRefundPercentage != null) return `Reduces hunger depletion by ${percent(scaled('hungerRefundPercentage'))}%`;
    if (values.hungerRestorePercentage != null) return `Restores ${percent(scaled('hungerRestorePercentage'))}% hunger per proc`;
    if (values.mutationChanceIncreasePercentage != null) return `Mutation chance increase: +${percent(scaled('mutationChanceIncreasePercentage'))}%`;
    if (values.scaleIncreasePercentage != null) return `Crop size increase: +${percent(scaled('scaleIncreasePercentage'))}% per proc`;
    if (values.cropSellPriceIncreasePercentage != null) return `Sell bonus: +${percent(scaled('cropSellPriceIncreasePercentage'))}% coins`;
    if (values.plantGrowthReductionMinutes != null) return `Growth reduction: ${scaled('plantGrowthReductionMinutes').toFixed(1)}m per proc`;
    if (values.eggGrowthTimeReductionMinutes != null) return `Hatch reduction: ${scaled('eggGrowthTimeReductionMinutes').toFixed(1)}m per proc`;
    if (values.baseMaxCoinsFindable != null) return `Coins found: 1 - ${Math.floor(scaled('baseMaxCoinsFindable')).toLocaleString()} per proc`;
    if (values.bonusXp != null) return `Bonus XP: +${Math.floor(scaled('bonusXp')).toLocaleString()} per proc`;
    if (values.maxStrengthIncreasePercentage != null) return `Max STR boost: +${percent(scaled('maxStrengthIncreasePercentage'))}%`;
    if (values.plantAbilityChanceBoostPercentage != null) return `Active pet ability chance: +${percent(scaled('plantAbilityChanceBoostPercentage'))}%`;
    if (values.mutationChancePerMinute != null) return `Mutation chance: ${percent(scaled('mutationChancePerMinute'))}% per minute`;
    if (values.cooldownSeconds != null) {
      const cooldown = values.cooldownSeconds / Math.max(strength / 100, .01);
      const range = values.tileRadius != null ? ` | Range: ${values.tileRadius} tile${values.tileRadius === 1 ? '' : 's'}` : '';
      return `Cooldown: ${formatDuration(cooldown * 1000)}${range}`;
    }
    return humanize(trigger || 'Effect details unavailable');
  }

  function combinedAbilityRows(pets: Pet[]): string {
    const groups = new Map<string, Array<{ ability: string; pet: Pet }>>();
    for (const pet of pets) {
      if (pet.hunger <= 0) continue;
      for (const ability of pet.abilities ?? []) {
        const key = STACKED_PASSIVE_BY_ABILITY.get(ability)?.key ?? ability;
        const group = groups.get(key) ?? [];
        group.push({ ability, pet });
        groups.set(key, group);
      }
    }
    return [...groups].map(([, entries]) => {
      const ability = entries[0].ability;
      const owners = entries.map(entry => entry.pet);
      const strengths = owners.map(pet => petMetrics(pet)?.strength ?? 100);
      const averageStrength = strengths.reduce((sum, value) => sum + value, 0) / strengths.length;
      const details = ABILITY_DETAILS[ability];
      const passiveGroup = STACKED_PASSIVE_BY_ABILITY.get(ability);
      const proc = PROC_RULES[ability];
      const baseChance = passiveGroup ? undefined : details?.baseProbability ?? proc?.chance ?? GRANTER_CHANCES[ability];
      let chance = '';
      if (baseChance != null) {
        const tick = details?.trigger ? details.trigger === 'continuous' : proc?.tick !== false;
        if (tick) {
          const tickRate = 1 - strengths.reduce((remaining, strength) => remaining * Math.pow(1 - baseChance * strength / 10000, 1 / 60), 1);
          const perMinute = (1 - Math.pow(1 - tickRate, 60)) * 100;
          const mean = tickRate > 0 ? 1 / tickRate : null;
          chance = `<div class="gc-ability-rate"><b>${Math.floor(perMinute * 100) / 100}%/min</b>${mean ? `<small>avg ~${formatEstimate(mean)}</small><small>95% within ${formatEstimate(Math.log(20) * mean)}</small>` : ''}</div>`;
        } else {
          const combined = (1 - strengths.reduce((remaining, strength) => remaining * (1 - baseChance * strength / 10000), 1)) * 100;
          chance = `<div class="gc-ability-rate"><b>${combined.toFixed(1)}%</b><small>per trigger</small></div>`;
        }
      }
      let effect: string;
      if (passiveGroup) {
        const total = entries.reduce((sum, entry) => {
          const requiredWeather = PASSIVE_REQUIRED_WEATHER.get(entry.ability);
          if (entry.pet.hunger <= 0 || requiredWeather && state.game?.weather !== requiredWeather) return sum;
          const strength = petMetrics(entry.pet)?.strength ?? 100;
          const base = Number(ABILITY_DETAILS[entry.ability]?.baseParameters?.[passiveGroup.parameter] || 0);
          return sum + base * strength / 100;
        }, 0);
        const amount = Number(total.toFixed(2)).toLocaleString();
        if (passiveGroup.key === 'HungerBoost') effect = `Reduces hunger depletion by ${amount}% combined`;
        else if (passiveGroup.key === 'WeatherMutationBoost') effect = `Weather mutation chance increase: +${amount}% combined`;
        else if (passiveGroup.key === 'PetMutationBoost') effect = `Egg mutation chance increase: +${amount}% combined`;
        else effect = `Active pet ability chance: +${amount}% combined`;
      } else effect = abilityEffectText(ability, averageStrength, details?.trigger, details?.baseParameters);
      const names = owners.map(pet => pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies)).join(', ');
      const label = passiveGroup?.label ?? ABILITY_DETAILS[ability]?.name ?? humanize(ability);
      return `<article class="gc-card gc-ability-summary"><div><h3>${escapeHtml(label)}</h3><p>${escapeHtml(names)}</p><small>${escapeHtml(effect)}</small></div>${chance}</article>`;
    }).join('');
  }

  function snapshotPayload(data: Record<string, unknown>): Record<string, unknown> {
    try { return JSON.parse(JSON.stringify(data)) as Record<string, unknown>; }
    catch { return {}; }
  }

  function payloadRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  }

  function payloadItemName(value: unknown): string {
    if (typeof value === 'string') return humanize(value);
    const item = payloadRecord(value);
    return item ? humanize(item.name || item.species || item.petSpecies || item.eggId || item.id || 'Unknown') : String(value ?? 'Unknown');
  }

  function payloadItemList(value: unknown): string {
    if (!Array.isArray(value)) return payloadItemName(value);
    const counts = new Map<string, number>();
    for (const item of value) {
      const name = payloadItemName(item);
      counts.set(name, (counts.get(name) ?? 0) + Number(payloadRecord(item)?.quantity || 1));
    }
    return [...counts].map(([name, quantity]) => quantity > 1 ? `${name} x${quantity}` : name).join(', ');
  }

  function procOutcome(ability: string, data: Record<string, unknown>): string {
    const growSlot = payloadRecord(data.growSlot);
    if (ability.includes('SeedFinder') && data.speciesId) return payloadItemName(data.speciesId);
    if (growSlot?.species) return payloadItemName(growSlot.species);
    if (data.harvestedCrop) return payloadItemName(data.harvestedCrop);
    if (data.extraPet) return payloadItemName(data.extraPet);
    if (data.targetPet) return payloadItemName(data.targetPet);
    if (data.cropsRefunded) return payloadItemList(data.cropsRefunded);
    if (data.petsAffected) return payloadItemList(data.petsAffected);
    if (data.eggsAffected) return payloadItemList(data.eggsAffected);
    if (data.growSlotsAffected) return payloadItemList(data.growSlotsAffected);
    if (data.eggId) return payloadItemName(data.eggId);
    if (data.coinsFound != null) return `${Number(data.coinsFound).toLocaleString()} coins`;
    if (data.bonusCoins != null) return `+${Number(data.bonusCoins).toLocaleString()} coins`;
    if (data.bonusXp != null) return `+${Number(data.bonusXp).toLocaleString()} XP`;
    if (data.secondsReduced != null) return `${Number(data.secondsReduced).toLocaleString()}s reduced`;
    if (data.numPlantsAffected != null) return `${Number(data.numPlantsAffected).toLocaleString()} plants`;
    if (data.hungerRestoreAmount != null) return `${Number(data.hungerRestoreAmount).toLocaleString()} hunger`;
    if (data.sellPrice != null) return `${Number(data.sellPrice).toLocaleString()} coins`;
    if (data.strengthIncrease != null) return `+${Number(data.strengthIncrease).toLocaleString()} STR`;
    if (data.scaleIncreasePercentage != null) return `+${Number(data.scaleIncreasePercentage).toLocaleString()}% size`;
    if (data.mutation || data.targetMutation) return payloadItemName(data.mutation || data.targetMutation);
    const fallback = Object.entries(data).find(([key, value]) => !['pet', 'sourcePet'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value));
    return fallback ? `${humanize(fallback[0])}: ${String(fallback[1])}` : 'Proc recorded';
  }

  function comboFromEvent(event) {
    const parts = [];
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');
    parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
    return parts.join('+');
  }

  function isTyping() {
    const element = document.activeElement;
    return Boolean(element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || (element as HTMLElement).isContentEditable));
  }

  window.addEventListener('keydown', event => {
    if (isTyping() || event.repeat) return;
    const combo = comboFromEvent(event);
    if (config.interfaceKeybinds.companionPanel === combo) {
      event.preventDefault(); event.stopPropagation();
      togglePanel();
      return;
    }
    const gameInterface = feature('interfaceShortcuts')
      ? GAME_INTERFACES.find(item => config.interfaceKeybinds[item.id] === combo)
      : undefined;
    if (gameInterface) {
      event.preventDefault(); event.stopPropagation();
      openGameInterface(gameInterface.id);
      return;
    }
    if (!feature('petTeams')) return;
    const team = teams().find(item => config.teamKeybinds[item.id] === combo);
    if (!team) return;
    event.preventDefault(); event.stopPropagation();
    send({ type: 'ApplyPetTeam', teamId: team.id });
    toast(`Switching to ${team.name}.`, 'success');
  }, true);

  function saveTeam(name, petIds, teamId = null) {
    if (!name.trim() || petIds.length < 1 || petIds.length > 3) throw new Error('Choose a name and one to three pets.');
    send({ type: 'SavePetTeam', teamId, name: name.trim(), petIds });
  }

  function installInstantHarvest() {
    window.addEventListener('keydown', event => {
      if (!feature('instantHarvest') || event.code !== 'Space' || event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || isTyping()) return;
      if (state.currentAction && state.currentAction !== 'none' && !['harvest', 'rainbowHarvest', 'goldHarvest'].includes(state.currentAction)) return;
      const tile = state.slot?.data?.garden?.tileObjects?.[String(state.dirtTileIndex)];
      if (!tile?.slots?.length) return;
      const now = Date.now();
      const qualifies = slot => Number(slot?.endTime) <= now && (slot?.mutations || []).some(value => value === 'Gold' || value === 'Rainbow');
      let index = tile.slots.findIndex(slot => String(slot.slotId) === String(state.selectedSlotId));
      if (index >= 0 && !qualifies(tile.slots[index])) return;
      if (index < 0) index = tile.slots.findIndex(qualifies);
      if (index < 0) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const slot = tile.slots[index];
      send({ type: 'HarvestCrop', slot: state.dirtTileIndex, slotsIndex: slot.slotId ?? index });
      toast('Harvest requested.', 'success');
    }, true);
  }

  installPixiCapture();
  function installPixiCapture() {
    const store = page.__GARDEN_COMPANION_PIXI__ ||= { app: null, renderer: null };
    for (const name of ['__PIXI_APP_INIT__', '__PIXI_RENDERER_INIT__']) {
      const previous = page[name];
      page[name] = function(value, ...args) {
        if (name.includes('APP') && value) { store.app = value; store.renderer = value.renderer || store.renderer; }
        else if (value) store.renderer = value;
        if (typeof previous === 'function') return previous.call(this, value, ...args);
      };
    }
  }

  function findPixiCard() {
    const capture = page.__GARDEN_COMPANION_PIXI__;
    const app = capture?.app as { stage?: Record<string, any>; renderer?: Record<string, any> } | undefined;
    const renderer = capture?.renderer as Record<string, any> | undefined || app?.renderer;
    const stage = app?.stage || renderer?.lastObjectRendered;
    const canvas = document.querySelector('.QuinoaCanvas canvas') || renderer?.canvas || renderer?.view;
    if (!stage || !renderer || !(canvas instanceof HTMLCanvasElement)) return null;
    const stack = [stage];
    const seen = new WeakSet();
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      const visible = node.visible !== false && node.renderable !== false && node.worldVisible !== false &&
        !(typeof node.alpha === 'number' && node.alpha <= .001) && !(typeof node.worldAlpha === 'number' && node.worldAlpha <= .001);
      if (!visible) continue;
      if (node.label === 'GardenInfoCardSystem' && typeof node.getBounds === 'function') {
        try {
          const bounds = node.getBounds();
          const card = typeof node.getChildByLabel === 'function' ? node.getChildByLabel('GardenInfoObjectCard', true) : null;
          const cardBounds = typeof card?.getBounds === 'function' ? card.getBounds() : null;
          const position = typeof node.getGlobalPosition === 'function' ? node.getGlobalPosition() : null;
          const rect = canvas.getBoundingClientRect();
          const screen = renderer.screen || { width: canvas.width, height: canvas.height };
          if (![bounds.x, bounds.y, bounds.width, bounds.height, rect.width, rect.height, screen.width, screen.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || rect.width <= 0 || rect.height <= 0) continue;
          const centerX = Number.isFinite(position?.x) ? position.x : bounds.x + bounds.width / 2;
          const cardTop = Number.isFinite(cardBounds?.y) ? cardBounds.y : bounds.y;
          return { centerX: rect.left + centerX * rect.width / screen.width, top: rect.top + cardTop * rect.height / screen.height };
        } catch { return null; }
      }
      if (Array.isArray(node.children)) stack.push(...node.children);
    }
    return null;
  }

  const COLOR_MULT = { Gold: 25, Rainbow: 50 };
  const WEATHER_MULT = { Wet: 2, Chilled: 2, Frozen: 6, Thunderstruck: 5, Thundercharged: 7 };
  const TIME_MULT = { Dawnlit: 4, Dawnbound: 7, Dawncharged: 7, Ambershine: 6, Amberbound: 10, Ambercharged: 10 };
  const COMBO_MULT = { 'Wet+Dawnlit': 5, 'Chilled+Dawnlit': 5, 'Wet+Ambershine': 7, 'Chilled+Ambershine': 7, 'Frozen+Dawnlit': 9, 'Frozen+Dawnbound': 12, 'Frozen+Dawncharged': 12, 'Frozen+Ambershine': 11, 'Frozen+Amberbound': 15, 'Frozen+Ambercharged': 15, 'Thunderstruck+Dawnlit': 8, 'Thunderstruck+Dawnbound': 11, 'Thunderstruck+Dawncharged': 11, 'Thunderstruck+Ambershine': 10, 'Thunderstruck+Amberbound': 14, 'Thunderstruck+Ambercharged': 14, 'Thundercharged+Dawnlit': 10, 'Thundercharged+Dawnbound': 13, 'Thundercharged+Dawncharged': 13, 'Thundercharged+Ambershine': 12, 'Thundercharged+Amberbound': 16, 'Thundercharged+Ambercharged': 16 };

  function mutationMultiplier(mutations) {
    const color = Math.max(1, ...mutations.map(value => COLOR_MULT[value] || 1));
    const weather = mutations.sort((a, b) => (WEATHER_MULT[b] || 0) - (WEATHER_MULT[a] || 0)).find(value => WEATHER_MULT[value]);
    const time = mutations.sort((a, b) => (TIME_MULT[b] || 0) - (TIME_MULT[a] || 0)).find(value => TIME_MULT[value]);
    return color * (COMBO_MULT[`${weather}+${time}`] || Math.max(WEATHER_MULT[weather] || 1, TIME_MULT[time] || 1));
  }

  function petStrength(pet, xpPerLevel = 12000, maxScale = 2.5) {
    const xp = Math.min(30, Math.floor(Number(pet.xp || 0) / xpPerLevel));
    const max = Math.floor(((Number(pet.targetScale || 1) - 1) / (maxScale - 1)) * 20 + 80);
    return Math.max(0, Math.min(100, max - 30 + xp));
  }

  function turtleRate(pets) {
    return pets.filter(pet => pet.hunger > 0 && pet.petSpecies === 'Turtle' && (pet.abilities || []).includes('PlantGrowthBoostII')).reduce((sum, pet) => {
      const strength = petStrength(pet);
      return sum + (strength / 100 * 5) * 60 * (1 - Math.pow(1 - 0.27 * strength / 100, 1 / 60));
    }, 0);
  }

  const EGG_ABILITIES = { EggGrowthBoost: [7, .21], EggGrowthBoostI: [9, .24], EggGrowthBoostII_NEW: [9, .24], EggGrowthBoostII: [11, .27] };
  const EGG_PETS = { Chicken: [2880, 2], Turkey: [8640, 2.5], Turtle: [12000, 2.5] };
  function eggRate(pets) {
    let total = 0;
    for (const pet of pets) {
      const info = EGG_PETS[pet.petSpecies];
      if (!info || pet.hunger <= 0) continue;
      const strength = petStrength(pet, info[0], info[1]);
      for (const ability of pet.abilities || []) {
        const rule = EGG_ABILITIES[ability];
        if (rule) total += (strength / 100 * rule[0]) * 60 * (1 - Math.pow(1 - rule[1] * strength / 100, 1 / 60));
      }
    }
    return total;
  }

  function turtleLines() {
    const pets = state.slot?.data?.petSlots || [];
    const crops = Array.isArray(state.currentCrop) ? state.currentCrop : [];
    const crop = crops.find(slot => String(slot?.slotId) === String(state.selectedSlotId)) || crops[0] || null;
    const egg = state.currentEgg || (crop?.species?.endsWith('Egg') ? crop : null);
    if (egg) {
      const end = Number(egg.maturedAt || egg.endTime || 0);
      const rate = eggRate(pets);
      return end > Date.now() && rate > 0 ? [`Growth estimate: ${formatDuration((end - Date.now()) / (rate + 1))}`] : [];
    }
    if (!crop) return [];
    const lines = [];
    const base = Number(page.__gardenCompanionPlantPrice?.(crop.species) || 0);
    if (base) lines.push(`Value: ${Math.round(base * Number(crop.targetScale || 1) * mutationMultiplier([...(crop.mutations || [])]) * (1 + Math.min(5, Math.max(0, (state.room?.players?.length || 1) - 1)) * .1)).toLocaleString()}`);
    const end = Number(crop.endTime || 0), rate = turtleRate(pets);
    if (end > Date.now() && rate > 0) lines.push(`Growth estimate: ${formatDuration((end - Date.now()) / (rate + 1))}`);
    return lines;
  }

  interface GardenCardState {
    card?: { attributes?: Array<Record<string, unknown>>; [key: string]: unknown } | null;
    [key: string]: unknown;
  }

  interface NativeGardenCardHook {
    view: Record<string, any>;
    originalSetState: (state: GardenCardState) => unknown;
    sourceState: GardenCardState | null;
    signature: string;
  }

  let nativeGardenCardHook: NativeGardenCardHook | null = null;

  function cleanGardenCardState(nextState: GardenCardState): GardenCardState {
    if (!nextState.card || !Array.isArray(nextState.card.attributes)) return nextState;
    let changed = false;
    const attributes = nextState.card.attributes.flatMap(attribute => {
      if (attribute.gardenCompanionEstimate !== true) return [attribute];
      changed = true;
      if (!('gardenCompanionOriginalText' in attribute)) return [];
      const restored: Record<string, unknown> = { ...attribute, text: attribute.gardenCompanionOriginalText };
      delete restored.gardenCompanionEstimate;
      delete restored.gardenCompanionOriginalText;
      return [restored];
    });
    return !changed ? nextState : {
      ...nextState,
      card: { ...nextState.card, attributes },
    };
  }

  function nativeEstimateSignature(): string {
    return feature('turtleTimer') ? turtleLines().join('\n') : '';
  }

  function decorateGardenCardState(nextState: GardenCardState, signature = nativeEstimateSignature()): GardenCardState {
    const clean = cleanGardenCardState(nextState);
    if (!clean.card || !signature) return clean;
    const lines = signature.split('\n');
    const attributes = [...(clean.card.attributes || [])];
    const estimateAttributes = lines.map((text, index) => ({
      key: 'time',
      text,
      color: index === 0 && text.startsWith('Value:') ? 0xffd84d : 0xa9efff,
      gardenCompanionEstimate: true,
    }));
    return {
      ...clean,
      card: { ...clean.card, attributes: [...attributes, ...estimateAttributes] },
    };
  }

  function nativeEstimateChip(node: Record<string, any>): Record<string, any> | null {
    let chip = node;
    while (chip.parent && !['GardenInfoAttributeRow', 'GardenInfoWrappedAttributeBand'].includes(chip.parent.label)) chip = chip.parent;
    return chip.parent ? chip : null;
  }

  function shiftNativeRowToCardCenter(card: Record<string, any>, row: Record<string, any>, chip: Record<string, any>): void {
    const peers = (row.children || []).filter((candidate: Record<string, any>) => Math.abs(Number(candidate.y) - Number(chip.y)) < .5);
    if (!peers.length) return;
    const bounds = peers.map((peer: Record<string, any>) => peer.getBounds?.()).filter(Boolean);
    if (!bounds.length) return;
    const left = Math.min(...bounds.map((item: Record<string, number>) => item.x));
    const right = Math.max(...bounds.map((item: Record<string, number>) => item.x + item.width));
    const cardBounds = card.getBounds();
    const offset = cardBounds.x + cardBounds.width / 2 - (left + right) / 2;
    const worldScale = Math.abs(Number(row.worldTransform?.a)) || 1;
    if (Number.isFinite(offset) && Math.abs(offset) > .25) for (const peer of peers) peer.x += offset / worldScale;
  }

  function layoutNativeEstimates(view: Record<string, any>, signature: string): boolean {
    if (!signature) return false;
    const card = view.container?.getChildByLabel?.('GardenInfoObjectCard', true);
    if (!card || typeof card.getBounds !== 'function') return false;
    const estimateLines = new Set(signature.split('\n'));
    const estimateChips: Record<string, any>[] = [];
    const stack = [...(card.children || [])];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      const text = typeof node.text === 'string' ? node.text : typeof node._text === 'string' ? node._text : '';
      if (estimateLines.has(text)) {
        const chip = nativeEstimateChip(node);
        if (chip && !estimateChips.includes(chip)) estimateChips.push(chip);
      }
      if (Array.isArray(node.children)) stack.push(...node.children);
    }
    if (!estimateChips.length) return false;
    if (!signature.startsWith('Value:')) return false;
    for (const chip of estimateChips) shiftNativeRowToCardCenter(card, chip.parent, chip);
    return false;
  }

  function captureQuinoaEngine(value: unknown): void {
    const engine = value as { getSystem?: (name: string) => Record<string, any> | undefined } | null;
    if (!engine || typeof engine.getSystem !== 'function') {
      nativeGardenCardHook = null;
      return;
    }
    const view = engine.getSystem('gardenInfoCard')?.view;
    if (!view || typeof view.setState !== 'function' || nativeGardenCardHook?.view === view || view.__gardenCompanionEstimateHook) return;
    const originalSetState = view.setState;
    const originalLayout = view.layout;
    const hook: NativeGardenCardHook = { view, originalSetState, sourceState: null, signature: '' };
    view.setState = function(nextState: GardenCardState) {
      hook.sourceState = cleanGardenCardState(nextState);
      hook.signature = nativeEstimateSignature();
      return originalSetState.call(this, decorateGardenCardState(hook.sourceState, hook.signature));
    };
    if (typeof originalLayout === 'function') view.layout = function(...args: unknown[]) {
      const result = originalLayout.apply(this, args);
      layoutNativeEstimates(this, hook.signature);
      return result;
    };
    view.__gardenCompanionEstimateHook = true;
    nativeGardenCardHook = hook;
    if (view.state) view.setState(view.state);
    document.getElementById('gc-turtle')?.remove();
  }

  function refreshNativeGardenCard(): boolean {
    const hook = nativeGardenCardHook;
    if (!hook || hook.view.container?.destroyed) {
      if (hook) nativeGardenCardHook = null;
      return false;
    }
    const signature = nativeEstimateSignature();
    if (hook.sourceState && signature !== hook.signature) {
      hook.signature = signature;
      hook.originalSetState.call(hook.view, decorateGardenCardState(hook.sourceState, signature));
    }
    document.getElementById('gc-turtle')?.remove();
    return true;
  }

  function renderTurtleOverlay() {
    if (refreshNativeGardenCard()) return;
    let overlay = document.getElementById('gc-turtle');
    const bounds = feature('turtleTimer') ? findPixiCard() : null;
    const lines = bounds ? turtleLines() : [];
    if (!lines.length) { overlay?.remove(); return; }
    if (!overlay) { overlay = document.createElement('div'); overlay.id = 'gc-turtle'; document.body.appendChild(overlay); }
    overlay.replaceChildren(...lines.map(text => Object.assign(document.createElement('div'), { textContent: text })));
    overlay.style.left = `${Math.round(bounds.centerX)}px`;
    overlay.style.top = `${Math.round(bounds.top - 5)}px`;
  }

  function nextLunarAt(now = Date.now()) {
    const date = new Date(now);
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    const slots = [0, 48, 96, 144, 192, 240];
    for (const day of [0, 1]) for (const slot of slots) {
      const at = midnight + day * 86400000 + slot * 300000;
      if (at > now) return at;
    }
    return midnight + 86400000;
  }

  function updateLunarTimer() {
    const root = document.getElementById('gc-lunar');
    if (!root) return;
    root.hidden = !feature('lunarTimer');
    root.querySelector('strong').textContent = formatDuration(nextLunarAt() - Date.now());
  }

  type SocketStatus = 'connecting' | 'connected' | 'disconnected';
  let socketStatus: SocketStatus = 'connecting';
  let watchedSocket: WebSocket | null = null;

  function renderSocketStatus(): void {
    const indicator = document.getElementById('gc-ws-health');
    if (!indicator) return;
    indicator.dataset.status = socketStatus;
    const label = indicator.querySelector('b');
    if (label) label.textContent = socketStatus === 'connected' ? 'Connected' : socketStatus === 'connecting' ? 'Connecting' : 'Disconnected';
  }

  function watchSocketHealth(): void {
    const socket = page.MagicCircle_RoomConnection?.currentWebSocket ?? null;
    if (socket !== watchedSocket) {
      watchedSocket = socket;
      if (socket) {
        const setCurrentSocketStatus = (status: SocketStatus) => {
          if (watchedSocket !== socket) return;
          socketStatus = status;
          renderSocketStatus();
        };
        socket.addEventListener('open', () => setCurrentSocketStatus('connected'));
        socket.addEventListener('close', event => {
          setCurrentSocketStatus('disconnected');
          handleGameSocketClose(event);
        });
        socket.addEventListener('error', () => setCurrentSocketStatus('disconnected'));
      }
    }
    socketStatus = !socket ? 'connecting'
      : socket.readyState === WebSocket.OPEN ? 'connected'
      : socket.readyState === WebSocket.CONNECTING ? 'connecting'
      : 'disconnected';
    renderSocketStatus();
  }

  type UpdateStatus = 'checking' | 'current' | 'available' | 'failed';
  let updateStatus: UpdateStatus = 'checking';
  let availableVersion = '';

  function versionParts(version: string): number[] {
    return version.split('.').map(part => Number.parseInt(part, 10) || 0);
  }

  function isNewerVersion(candidate: string, current: string): boolean {
    const next = versionParts(candidate);
    const installed = versionParts(current);
    const length = Math.max(next.length, installed.length);
    for (let index = 0; index < length; index++) {
      const difference = (next[index] ?? 0) - (installed[index] ?? 0);
      if (difference !== 0) return difference > 0;
    }
    return false;
  }

  function renderUpdateStatus(): void {
    const button = document.getElementById('gc-update-health') as HTMLButtonElement | null;
    if (!button) return;
    button.dataset.status = updateStatus;
    button.textContent = updateStatus === 'checking' ? 'Checking update'
      : updateStatus === 'available' ? `Update ${availableVersion}`
      : updateStatus === 'failed' ? 'Check update'
      : 'Up to date';
    button.title = updateStatus === 'available'
      ? `Install Garden Companion ${availableVersion}`
      : updateStatus === 'failed' ? 'Update check failed. Click to retry.' : 'Click to check for updates.';
  }

  function currentScriptVersion(): string {
    try { return GM_info.script.version || '0.0.0'; } catch { return '0.0.0'; }
  }

  function checkForUpdate(): void {
    updateStatus = 'checking';
    renderUpdateStatus();
    GM_xmlhttpRequest({
      method: 'GET',
      url: `${UPDATE_URL}?check=${Date.now()}`,
      headers: { 'Cache-Control': 'no-cache' },
      onload: response => {
        const match = response.responseText.match(/^\/\/\s*@version\s+([^\s]+)\s*$/m);
        availableVersion = match?.[1] ?? '';
        updateStatus = response.status >= 200 && response.status < 300 && availableVersion
          ? isNewerVersion(availableVersion, currentScriptVersion()) ? 'available' : 'current'
          : 'failed';
        renderUpdateStatus();
      },
      onerror: () => { updateStatus = 'failed'; renderUpdateStatus(); },
    });
  }

  function handleUpdateClick(): void {
    if (updateStatus === 'available') {
      window.open(UPDATE_URL, '_blank', 'noopener,noreferrer');
      return;
    }
    checkForUpdate();
  }

  function checkForGameUpdateDialog(): boolean {
    const dialogs = document.querySelectorAll<HTMLElement>('[role="alertdialog"], section.chakra-modal__content');
    for (const dialog of dialogs) {
      if (!dialog.textContent?.toLowerCase().includes('game update available')) continue;
      handleGameUpdateDetected('update dialog');
      return true;
    }
    return false;
  }

  function watchForGameUpdateDialog(): void {
    const observer = new MutationObserver(() => { if (!gameUpdateDetected) checkForGameUpdateDialog(); });
    observer.observe(document.body, { childList: true, subtree: true });
    checkForGameUpdateDialog();
    setInterval(checkForGameUpdateDialog, 5_000);
  }

  let activeTab = 'abilities';
  let abilityFilterInteracting = false;
  let abilityFilterMenuOpen = false;
  let editingTeamId: string | null = null;
  let teamSearchQuery = '';
  let pendingTeamSave: { teamId: string | null; name: string; petIds: string[] } | null = null;
  let confirmDeleteTeamId: string | null = null;
  let pendingTeamDeleteId: string | null = null;
  let shopAlarmTab = 'seed';
  let panelRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let cancelKeybindCapture: (() => void) | null = null;

  function cancelPanelRefresh(): void {
    if (!panelRefreshTimer) return;
    clearTimeout(panelRefreshTimer);
    panelRefreshTimer = null;
  }

  function selectPanelTab(tab: string | undefined): void {
    if (!tab || tab === activeTab) return;
    cancelPanelRefresh();
    activeTab = tab;
    if (activeTab !== 'abilityLog') { abilityFilterMenuOpen = false; abilityFilterInteracting = false; }
    renderPanel();
  }

  function beginKeybindCapture(input: HTMLInputElement, owner: string, prompt: string): void {
    cancelKeybindCapture?.();
    input.value = prompt;
    const capture = (event: KeyboardEvent) => {
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
      claimKeybind(owner, event.key === 'Escape' ? '' : comboFromEvent(event));
      input.blur();
    };
    const cancel = () => {
      window.removeEventListener('keydown', capture, true);
      input.removeEventListener('blur', cancel);
      if (cancelKeybindCapture === cancel) cancelKeybindCapture = null;
    };
    cancelKeybindCapture = cancel;
    window.addEventListener('keydown', capture, true);
    input.addEventListener('blur', cancel, { once: true });
  }

  function openPanel(tab = activeTab) {
    activeTab = tab;
    let panel = document.getElementById('gc-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'gc-panel';
      document.body.appendChild(panel);
    }
    panel.hidden = false;
    renderPanel();
  }

  function closePanel() {
    cancelKeybindCapture?.();
    const panel = document.getElementById('gc-panel');
    if (panel) panel.hidden = true;
    abilityFilterMenuOpen = false;
    abilityFilterInteracting = false;
  }
  function togglePanel(): void {
    const panel = document.getElementById('gc-panel');
    if (panel && !panel.hidden) closePanel();
    else openPanel();
  }
  function refreshCompletedTeamSave(): void {
    if (!pendingTeamSave) return;
    const expected = pendingTeamSave;
    const saved = teams().find(team => {
      if (expected.teamId ? team.id !== expected.teamId : team.name !== expected.name) return false;
      const members = team.members.map(member => member.petId).sort();
      return members.length === expected.petIds.length && members.every((petId, index) => petId === expected.petIds[index]);
    });
    if (!saved) return;
    pendingTeamSave = null;
    const panel = document.getElementById('gc-panel');
    if (panel && !panel.hidden && activeTab === 'teams') renderPanel();
  }
  function refreshCompletedTeamDelete(): void {
    if (!pendingTeamDeleteId || teams().some(team => team.id === pendingTeamDeleteId)) return;
    const deletedTeamId = pendingTeamDeleteId;
    pendingTeamDeleteId = null;
    const panel = document.getElementById('gc-panel');
    if (!panel || panel.hidden || activeTab !== 'teams') return;
    const cards = [...panel.querySelectorAll<HTMLElement>('[data-team-card]')];
    const deletedCard = cards.find(card => card.dataset.teamCard === deletedTeamId);
    if (deletedCard && cards.length > 1) deletedCard.remove();
    else renderPanelPreservingScroll();
  }
  function refreshOpenPanel() {
    const panel = document.getElementById('gc-panel');
    if (!panel || panel.hidden || !['abilities', 'abilityLog'].includes(activeTab) || abilityFilterInteracting || panel.contains(document.activeElement)) return;
    const abilityLog = activeTab === 'abilityLog' ? panel.querySelector<HTMLElement>('.gc-log') : null;
    if (abilityLog && (abilityLog.matches(':hover') || abilityLog.scrollTop > 0)) return;
    if (panelRefreshTimer) return;
    panelRefreshTimer = setTimeout(() => {
      panelRefreshTimer = null;
      const main = panel.querySelector('main');
      const scrollTop = main?.scrollTop ?? 0;
      renderPanel();
      const nextMain = panel.querySelector('main');
      if (nextMain) nextMain.scrollTop = scrollTop;
    }, 1000);
  }

  const TABS = [['abilities', 'Active Pets'], ['abilityLog', 'Pet Abilities'], ['teams', 'Pet Teams'], ['shops', 'Shop Alarms'], ['silence', 'Silence'], ['rooms', 'Rooms'], ['features', 'Features']];

  function renderPanel() {
    cancelKeybindCapture?.();
    const panel = document.getElementById('gc-panel');
    if (!panel) return;
    panel.innerHTML = `<div class="gc-shell"><header><div><small>GARDEN COMPANION</small><h2>${escapeHtml(TABS.find(tab => tab[0] === activeTab)?.[1] || '')}</h2></div><button data-close aria-label="Close">x</button></header><div class="gc-layout"><nav>${TABS.map(([id, label]) => `<button data-tab="${id}" class="${id === activeTab ? 'active' : ''}">${label}</button>`).join('')}</nav><main class="${activeTab === 'abilityLog' ? 'gc-ability-log-tab' : ''}">${renderTab()}</main></div></div>`;
    panel.querySelector<HTMLButtonElement>('[data-close]')!.onclick = closePanel;
    panel.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
      button.onpointerdown = event => {
        if (event.button !== 0) return;
        event.preventDefault();
        selectPanelTab(button.dataset.tab);
      };
      button.onclick = () => selectPanelTab(button.dataset.tab);
    });
    bindTabEvents(panel.querySelector('main'));
  }

  function renderPanelPreservingScroll(): void {
    const panel = document.getElementById('gc-panel');
    const scrollTop = panel?.querySelector('main')?.scrollTop ?? 0;
    renderPanel();
    const main = panel?.querySelector<HTMLElement>('main');
    if (main) main.scrollTop = scrollTop;
  }

  function renderTab() {
    if (activeTab === 'features') return renderFeatures();
    if (activeTab === 'teams') return renderTeams();
    if (activeTab === 'abilities') return renderAbilities();
    if (activeTab === 'abilityLog') return renderAbilityLog();
    if (activeTab === 'rooms') return renderRooms();
    if (activeTab === 'shops') return renderShops();
    if (activeTab === 'silence') return renderSilence();
    return '';
  }

  function renderFeatures() {
    const rows = [
      ['dragMove', 'Plant drag move', 'Hold, drag and release a plant - consumes planter pots'],
      ['turtleTimer', 'Crop and egg estimates', 'Values and pet-adjusted timing'],
      ['instantHarvest', 'Instant harvest key', 'Spacebar harvest for mature Gold or Rainbow crops'],
      ['backgroundMode', 'Run in background', 'Keep the game active when its tab is not visible'],
      ['autoRefreshGameUpdates', 'Refresh for game updates', 'Reload five seconds after the game reports an expired version'],
    ];
    const shortcutRow = (label: string, attribute: string, value: string) => `<label class="gc-shortcut-row"><b>${label}</b><input readonly ${attribute} value="${escapeHtml(value)}" placeholder="Click, then press keys"></label>`;
    const shortcuts = [
      shortcutRow('Garden Companion', 'data-interface-key="companionPanel"', config.interfaceKeybinds.companionPanel || ''),
      shortcutRow('Garden Overview', 'data-overview-key', localStorage.getItem(OVERVIEW_SHORTCUT_KEY) || ''),
      ...GAME_INTERFACES.map(item => shortcutRow(item.label, `data-interface-key="${item.id}"`, config.interfaceKeybinds[item.id] || '')),
    ].join('');
    return `<p class="gc-note">Optional tools can be changed here. Plant drag, estimates, and harvest settings apply immediately. Background mode applies after a reload.</p><div class="gc-list">${rows.map(([key, title, text]) => `<label class="gc-toggle"><span><b>${title}</b><small>${text}</small></span><input type="checkbox" data-feature="${key}" ${feature(key) ? 'checked' : ''}><i></i></label>`).join('')}</div><section class="gc-card gc-shortcuts"><h3>Interface shortcuts</h3><p>Open interfaces from anywhere in a loaded room. Press Escape while recording to clear a keybind.</p><div class="gc-shortcut-grid">${shortcuts}</div></section>`;
  }

  function renderTeams() {
    const pets = allPets();
    const editing = teams().find(team => team.id === editingTeamId) ?? null;
    const selectedIds = new Set(editing?.members.map(member => member.petId) ?? []);
    const formActions = editing ? '<div class="gc-row"><button data-cancel-team>Cancel</button><button class="gc-primary" data-save-team>Save changes</button></div>' : '<button class="gc-primary" data-save-team>Save team</button>';
    const petRows = pets.map(pet => {
      const abilityText = (pet.abilities || []).flatMap(ability => [ability, ABILITY_DETAILS[ability]?.name || humanize(ability)]).join(' ');
      const filterText = `${pet.name || ''} ${pet.petSpecies} ${PET_CATALOG[pet.petSpecies]?.name || ''} ${abilityText}`.toLowerCase();
      return `<label data-filter-text="${escapeHtml(filterText)}"><input type="checkbox" data-pet-id="${escapeHtml(pet.id)}" ${selectedIds.has(pet.id) ? 'checked' : ''}>${petSprite(pet)}<span><b>${escapeHtml(pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies))}</b><small>${escapeHtml(humanize(pet.petSpecies))} | ${escapeHtml(pet.location)}</small><span class="gc-team-abilities">${(pet.abilities || []).map(ability => escapeHtml(ABILITY_DETAILS[ability]?.name || humanize(ability))).join(' | ') || 'No abilities'}</span></span></label>`;
    }).join('');
    return `<section class="gc-card"><h3>${editing ? 'Edit team' : 'Create team'}</h3><input data-team-name placeholder="Team name" maxlength="32" value="${escapeHtml(editing?.name || '')}"><input class="gc-search" data-team-search placeholder="Filter by pet name, species, or ability" value="${escapeHtml(teamSearchQuery)}"><div class="gc-pet-grid gc-filter-list">${petRows || '<p>No pet data yet.</p>'}</div>${formActions}</section><section class="gc-stack">${teams().map(team => `<article class="gc-card" data-team-card="${escapeHtml(team.id)}"><div class="gc-row"><div><h3>${escapeHtml(team.name)}</h3><p>${team.members.map(member => escapeHtml(member.name || humanize(member.petSpecies))).join(', ')}</p></div><div class="gc-row"><button data-edit-team="${escapeHtml(team.id)}">Edit</button><button data-apply-team="${escapeHtml(team.id)}">Activate</button></div></div><div class="gc-row"><label class="gc-key"><span>Keybind</span><input readonly data-team-key="${escapeHtml(team.id)}" value="${escapeHtml(config.teamKeybinds[team.id] || '')}" placeholder="Click, then press keys"><small>Press Esc to cancel or clear</small></label>${confirmDeleteTeamId === team.id ? `<span class="gc-team-delete-confirm"><b>Delete this team?</b><button data-cancel-delete-team>Cancel</button><button class="gc-danger" data-confirm-delete-team="${escapeHtml(team.id)}">Delete team</button></span>` : `<button class="gc-danger" data-delete-team="${escapeHtml(team.id)}">Delete</button>`}</div></article>`).join('') || '<p class="gc-empty">No saved teams yet.</p>'}</section>`;
  }

  function renderAbilities() {
    const active = state.slot?.data?.petSlots || [];
    const xpRate = teamXpPerHour(active);
    const activeCards = active.map(pet => {
      const metrics = petMetrics(pet);
      const maxText = metrics ? metrics.xpToMax > 0 ? `${formatEstimate(metrics.xpToMax / xpRate * 3600)} until max STR` : 'Max STR reached' : 'Strength estimate unavailable';
      return `<article class="gc-card gc-pet-card"><div class="gc-pet-head">${petSprite(pet)}<div><h3>${escapeHtml(pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies))}</h3><p>${escapeHtml(humanize(pet.petSpecies))}</p></div>${hungerDisplay(pet)}</div><div class="gc-pet-strength"><span>${metrics ? `STR <b>${metrics.strength}</b> / ${metrics.maxStrength}` : 'STR unavailable'}</span><strong>${escapeHtml(maxText)}</strong></div></article>`;
    }).join('');
    const abilityRows = combinedAbilityRows(active);
    return `<section class="gc-card gc-team-summary"><b>${active.length} active pet${active.length === 1 ? '' : 's'}</b><span>${Math.round(xpRate).toLocaleString()} XP/hour per pet</span></section><section class="gc-active-pets">${activeCards || '<p class="gc-empty">Waiting for active pet data.</p>'}</section><div class="gc-section-label">Combined abilities</div><section class="gc-stack">${abilityRows || '<p class="gc-empty">No active pet abilities found.</p>'}</section>`;
  }

  function renderAbilityLog() {
    const saved = new Set(config.trackedAbilities || []);
    const hasGroupedKeys = ABILITY_GROUPS.some(([label]) => saved.has(label));
    const selectedFilters = new Set(ABILITY_FILTER_OPTIONS.filter(option =>
      saved.has(option.key) || !hasGroupedKeys && option.abilities.some(ability => saved.has(ability)),
    ).map(option => option.key));
    const isVisibleAbility = (ability: string) => ABILITY_SET.has(ability) && ABILITY_FILTER_OPTIONS.some(option => selectedFilters.has(option.key) && option.abilities.includes(ability));
    const filterSummary = selectedFilters.size === ABILITY_FILTER_OPTIONS.length ? 'All abilities' : selectedFilters.size === 0 ? 'No abilities' : selectedFilters.size === 1 ? ABILITY_FILTER_OPTIONS.find(option => selectedFilters.has(option.key))?.label : `${selectedFilters.size} selections`;
    const filterOptions = ABILITY_FILTER_OPTIONS.map(option => `<button data-ability-option="${escapeHtml(option.key)}" data-active="${selectedFilters.has(option.key)}"><span>${escapeHtml(option.label)}</span><i>${selectedFilters.has(option.key) ? '&#10003;' : ''}</i></button>`).join('');
    const recent = state.abilityLog.filter(log => isVisibleAbility(log.ability)).slice(0, 100);
    return `<section class="gc-card gc-ability-filter"><span>Ability filter</span><details data-ability-filter ${abilityFilterMenuOpen ? 'open' : ''}><summary>${escapeHtml(filterSummary || 'No abilities')}</summary><div class="gc-ability-picker"><header><button data-ability-all>All</button><button data-ability-none>None</button></header>${filterOptions}</div></details><small>Choose any combination. Proc history stores up to 100 entries per exact ability.</small></section><section class="gc-card gc-ability-log-card"><div class="gc-row"><h3>Recent tracked procs</h3><button data-clear-log>Clear</button></div><div class="gc-log">${recent.map(log => `<div><time>${new Date(log.at).toLocaleTimeString()}</time><b>${escapeHtml(log.pet)}</b><span class="gc-proc-result">${escapeHtml(ABILITY_DETAILS[log.ability]?.name || humanize(log.ability))}<i>&rarr; ${escapeHtml(procOutcome(log.ability, log.data))}</i></span></div>`).join('') || '<p>No ability procs recorded yet.</p>'}</div></section>`;
  }

  let roomRows = null, roomError = '', roomLoading = false;
  function renderRooms() {
    if (!roomRows && !roomLoading && !roomError) fetchRooms();
    const body = roomLoading ? '<p class="gc-empty">Loading rooms...</p>' : roomError ? `<p class="gc-empty">${escapeHtml(roomError)}</p>` : (roomRows || []).map(room => `<article class="gc-card gc-room"><div><h3>${escapeHtml(room.id)}</h3><p>${room.user_slots?.map(slot => escapeHtml(slot.name)).filter(Boolean).join(', ') || 'No visible players'}</p></div><span class="gc-pill">${Number(room.players_count || 0)}/6</span><button data-join-room="${escapeHtml(room.id)}">Join</button></article>`).join('') || '<p class="gc-empty">No joinable rooms found.</p>';
    return `<div class="gc-row"><p class="gc-note">Public rooms with one or two open slots.</p><button data-refresh-rooms>Refresh</button></div><section class="gc-stack">${body}</section>`;
  }

  function requestJson(url) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({ method: 'GET', url, onload: response => { try { response.status >= 200 && response.status < 300 ? resolve(JSON.parse(response.responseText)) : reject(new Error(`Request failed (${response.status})`)); } catch (error) { reject(error); } }, onerror: () => reject(new Error('Network request failed')) }));
  }

  async function fetchRooms() {
    roomLoading = true; roomError = ''; refreshOpenPanel();
    try {
      const rows = await requestJson('https://ariesmod-api.ariedam.fr/rooms?limit=200');
      roomRows = Array.isArray(rows) ? rows
        .filter(room => !room.is_private && [4, 5].includes(Number(room.players_count)))
        .sort((left, right) => Number(right.players_count) - Number(left.players_count)) : [];
    } catch (error) { roomError = error.message; roomRows = []; }
    roomLoading = false;
    const panel = document.getElementById('gc-panel');
    if (panel && !panel.hidden && activeTab === 'rooms') renderPanel();
  }

  function renderShops() {
    const shops = state.game?.shops || {};
    const liveItems = new Map<string, ShopItem>();
    for (const item of shops[shopAlarmTab]?.inventory || []) {
      const id = itemId(item);
      if (id) liveItems.set(id, item);
    }
    const itemIds = [...new Set([...(SEASONAL_SHOP_ITEMS[shopAlarmTab] || []), ...liveItems.keys()])].filter(id => shopAlarmTab !== 'tool' || !EXCLUDED_TOOL_ALERTS.has(id));
    const available = new Set(availableShopItems().filter(row => row.shop === shopAlarmTab).map(row => row.id));
    const rows = itemIds.map(id => {
      const key = `${shopAlarmTab}:${id}`;
      const sprite = page.__gardenCompanionShopSprites?.[id];
      return `<label class="gc-check" data-filter-text="${escapeHtml(humanize(id).toLowerCase())}"><input type="checkbox" data-shop-alert="${escapeHtml(key)}" ${config.shopAlerts[key] ? 'checked' : ''}><span class="gc-shop-sprite">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}</span><span><b>${escapeHtml(humanize(id))}</b><small>${available.has(id) ? 'Available now' : `${SHOP_NAMES[shopAlarmTab] || humanize(shopAlarmTab)} shop`}</small></span></label>`;
    });
    const tabs = SHOP_TABS.map(([id, label]) => `<button data-shop-tab="${id}" class="${shopAlarmTab === id ? 'active' : ''}">${label}</button>`).join('');
    return `<p class="gc-note">An alarm appears when a selected item becomes available. Buy all only runs after you click it.</p><div class="gc-shop-tabs">${tabs}</div><input class="gc-search" data-shop-search placeholder="Search ${escapeHtml(SHOP_NAMES[shopAlarmTab] || humanize(shopAlarmTab))} shop"><div class="gc-check-grid gc-filter-list">${rows.join('') || '<p class="gc-empty">Waiting for shop data.</p>'}</div>`;
  }

  function renderSilence() {
    const selected = new Set(config.silencedAbilities || []);
    return `<p class="gc-note">Selected abilities keep their rewards but hide the game popup and sound. Pet history is still recorded.</p><div class="gc-row"><button data-silence-finders>Select finders</button><button data-silence-clear>Clear all</button></div><input class="gc-search" data-silence-search placeholder="Search abilities"><div class="gc-check-grid gc-filter-list">${TRACKED_ABILITY_CATALOG.map(ability => `<label class="gc-check" data-filter-text="${escapeHtml(`${ABILITY_DETAILS[ability]?.name || humanize(ability)} ${ability}`.toLowerCase())}"><input type="checkbox" data-silence="${escapeHtml(ability)}" ${selected.has(ability) ? 'checked' : ''}><span><b>${escapeHtml(ABILITY_DETAILS[ability]?.name || humanize(ability))}</b><small>${escapeHtml(ability)}</small></span></label>`).join('')}</div>`;
  }

  function bindListSearch(input: HTMLInputElement | null, onQuery?: (query: string) => void): void {
    if (!input) return;
    const list = input.parentElement?.querySelector('.gc-filter-list');
    const apply = () => {
      const query = input.value.trim().toLowerCase();
      onQuery?.(query);
      list?.querySelectorAll<HTMLElement>('[data-filter-text]').forEach(row => { row.hidden = Boolean(query && !row.dataset.filterText?.includes(query)); });
    };
    input.oninput = apply;
    apply();
  }

  function bindTabEvents(main) {
    main.querySelectorAll('[data-feature]').forEach(input => input.onchange = () => { config[input.dataset.feature] = input.checked; saveConfig(); updateLunarTimer(); });
    main.querySelector('[data-save-team]')?.addEventListener('click', () => {
      try {
        const name = (main.querySelector('[data-team-name]') as HTMLInputElement).value.trim();
        const petIds = ([...main.querySelectorAll('[data-pet-id]:checked')] as HTMLInputElement[]).map(input => input.dataset.petId!).sort();
        const teamId = editingTeamId;
        saveTeam(name, petIds, teamId);
        pendingTeamSave = { teamId, name, petIds };
        toast(teamId ? 'Team update requested.' : 'Team save requested.', 'success');
        editingTeamId = null;
        renderPanel();
      }
      catch (error) { toast(error.message, 'error'); }
    });
    main.querySelector('[data-cancel-team]')?.addEventListener('click', () => { editingTeamId = null; renderPanel(); });
    main.querySelectorAll('[data-edit-team]').forEach(button => button.onclick = () => { editingTeamId = button.dataset.editTeam; renderPanel(); });
    main.querySelectorAll('[data-apply-team]').forEach(button => button.onclick = () => { send({ type: 'ApplyPetTeam', teamId: button.dataset.applyTeam }); toast('Team activation requested.', 'success'); });
    main.querySelectorAll('[data-delete-team]').forEach(button => button.onclick = () => { confirmDeleteTeamId = button.dataset.deleteTeam; renderPanelPreservingScroll(); });
    main.querySelector('[data-cancel-delete-team]')?.addEventListener('click', () => { confirmDeleteTeamId = null; renderPanelPreservingScroll(); });
    main.querySelector('[data-confirm-delete-team]')?.addEventListener('click', event => {
      const button = event.currentTarget as HTMLButtonElement;
      const teamId = button.dataset.confirmDeleteTeam;
      if (!teamId) return;
      button.disabled = true;
      button.textContent = 'Deleting...';
      pendingTeamDeleteId = teamId;
      confirmDeleteTeamId = null;
      send({ type: 'DeletePetTeam', teamId });
      toast('Team deletion requested.', 'success');
    });
    (main.querySelectorAll('[data-team-key]') as NodeListOf<HTMLInputElement>).forEach(input => {
      input.onclick = () => beginKeybindCapture(input, `team:${input.dataset.teamKey}`, 'Press keys... Esc cancels');
    });
    (main.querySelectorAll('[data-interface-key]') as NodeListOf<HTMLInputElement>).forEach(input => {
      input.onclick = () => beginKeybindCapture(input, `interface:${input.dataset.interfaceKey}`, 'Press keys...');
    });
    (main.querySelectorAll('[data-overview-key]') as NodeListOf<HTMLInputElement>).forEach(input => {
      input.onclick = () => beginKeybindCapture(input, 'overview', 'Press keys...');
    });
    main.querySelector('[data-clear-log]')?.addEventListener('click', () => { state.abilityLog = []; saveLocal(LOG_KEY, []); renderPanel(); });
    main.querySelector('[data-refresh-rooms]')?.addEventListener('click', () => { roomRows = null; roomError = ''; fetchRooms(); });
    main.querySelectorAll('[data-join-room]').forEach(button => button.onclick = () => { if (/^[a-zA-Z0-9_-]{1,64}$/.test(button.dataset.joinRoom)) location.href = `/r/${button.dataset.joinRoom}`; });
    main.querySelectorAll('[data-shop-alert]').forEach(element => element.onchange = () => {
      const input = element as HTMLInputElement;
      const key = input.dataset.shopAlert!;
      config.shopAlerts[key] = input.checked;
      saveConfig();
      if (input.checked) {
        armAlarmAudio();
        showSelectedShopAlarm(key);
      }
    });
    main.querySelectorAll('[data-shop-tab]').forEach(button => button.onclick = () => { shopAlarmTab = button.dataset.shopTab || shopAlarmTab; renderPanel(); });
    main.querySelectorAll('[data-silence]').forEach(input => input.onchange = () => { const set = new Set(config.silencedAbilities || []); input.checked ? set.add(input.dataset.silence) : set.delete(input.dataset.silence); config.silencedAbilities = [...set].sort(); saveConfig(); });
    main.querySelector('[data-silence-clear]')?.addEventListener('click', () => { config.silencedAbilities = []; saveConfig(); renderPanel(); });
    main.querySelector('[data-silence-finders]')?.addEventListener('click', () => { config.silencedAbilities = TRACKED_ABILITY_CATALOG.filter(ability => ability.includes('Finder')); saveConfig(); renderPanel(); });
    const abilityFilter = main.querySelector('[data-ability-filter]') as HTMLDetailsElement | null;
    if (abilityFilter) {
      abilityFilter.ontoggle = () => { abilityFilterMenuOpen = abilityFilter.open; abilityFilterInteracting = abilityFilter.open; };
      abilityFilter.addEventListener('focusout', () => setTimeout(() => {
        if (!abilityFilter.contains(document.activeElement)) {
          abilityFilter.open = false;
          abilityFilterMenuOpen = false;
          abilityFilterInteracting = false;
        }
      }));
      main.querySelectorAll('[data-ability-option]').forEach(button => button.onclick = event => {
        event.preventDefault();
        const selected = new Set(config.trackedAbilities || []);
        const currentKeys = new Set(ABILITY_FILTER_OPTIONS.filter(option => selected.has(option.key) || option.abilities.some(ability => selected.has(ability))).map(option => option.key));
        const key = button.dataset.abilityOption;
        currentKeys.has(key) ? currentKeys.delete(key) : currentKeys.add(key);
        config.trackedAbilities = [...currentKeys];
        saveConfig(); abilityFilterMenuOpen = true; abilityFilterInteracting = true; renderPanel();
      });
      main.querySelector('[data-ability-all]')?.addEventListener('click', event => { event.preventDefault(); config.trackedAbilities = ABILITY_FILTER_OPTIONS.map(option => option.key); saveConfig(); abilityFilterMenuOpen = true; abilityFilterInteracting = true; renderPanel(); });
      main.querySelector('[data-ability-none]')?.addEventListener('click', event => { event.preventDefault(); config.trackedAbilities = []; saveConfig(); abilityFilterMenuOpen = true; abilityFilterInteracting = true; renderPanel(); });
    }
    bindListSearch(main.querySelector('[data-shop-search]'));
    bindListSearch(main.querySelector('[data-silence-search]'));
    bindListSearch(main.querySelector('[data-team-search]'), query => { teamSearchQuery = query; });
  }

  function mount() {
    const style = document.createElement('style');
    style.textContent = __GARDEN_COMPANION_CSS__;
    document.head.appendChild(style);
    const lunar = document.createElement('div');
    lunar.id = 'gc-lunar';
    lunar.innerHTML = '<div class="gc-lunar-head"><div class="gc-lunar-title"><i class="gc-lunar-mark"></i><span>Next lunar event</span></div><button data-options aria-label="Open Garden Companion options" title="Open Garden Companion"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/><path d="M19.1 13.5c.1-.5.1-1 0-1.5l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.3-.8L15 4.8h-4l-.4 2.5c-.5.2-.9.5-1.3.8l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 1.5l-2 1.5 2 3.4 2.4-1c.4.3.8.6 1.3.8l.4 2.5h4l.4-2.5c.5-.2.9-.5 1.3-.8l2.4 1 2-3.4-2-1.5Z"/></svg></button></div><div class="gc-lunar-countdown"><strong>--</strong></div><div class="gc-health"><span id="gc-ws-health" data-status="connecting"><i></i><b>Connecting</b></span><button id="gc-update-health" data-status="checking">Checking update</button></div>';
    lunar.querySelector<HTMLButtonElement>('[data-options]')!.onclick = togglePanel;
    lunar.querySelector<HTMLButtonElement>('#gc-update-health')!.onclick = handleUpdateClick;
    document.body.appendChild(lunar);
    page.__gardenCompanionPetSpritesReady = () => {
      const panel = document.getElementById('gc-panel');
      if (panel && !panel.hidden && ['teams', 'abilities', 'shops'].includes(activeTab)) renderPanel();
    };
    updateLunarTimer();
    watchSocketHealth();
    checkForUpdate();
    setInterval(updateLunarTimer, 1000);
    setInterval(watchSocketHealth, 1000);
    setInterval(checkForUpdate, 30 * 60 * 1000);
    watchForGameUpdateDialog();
    renderTurtleOverlay();
    setInterval(renderTurtleOverlay, 250);
  }

  installGameModalAccess();
  subscribeToState();
  installAtomHooks();
  installInstantHarvest();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
