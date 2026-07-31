export interface Pet {
  id: string;
  name?: string;
  petSpecies: string;
  hunger: number;
  xp?: number;
  targetScale?: number;
  abilities?: string[];
  mutations?: string[];
  itemType?: string;
}

export interface ProduceItem {
  id: string;
  species: string;
  itemType?: string;
  scale?: number;
  mutations?: string[];
}

export interface PetTeamMember {
  petId: string;
  petSpecies: string;
  name?: string | null;
}

export type PetTeamEmblem =
  | { type: 'number'; number: number }
  | { type: 'pet'; petSpecies: string }
  | { type: 'icon'; icon: string };

export interface PetTeam {
  id: string;
  name: string;
  members: PetTeamMember[];
  emblem?: PetTeamEmblem | null;
}

export interface PlantSlot {
  slotId?: string | number;
  species?: string;
  endTime?: number;
  maturedAt?: number;
  mutations?: string[];
  targetScale?: number;
  preserved?: boolean;
}

export interface GardenTile {
  objectType?: string;
  species?: string;
  slots?: PlantSlot[];
}

export interface ShopItem {
  itemType?: string;
  species?: string;
  eggId?: string;
  toolId?: string;
  decorId?: string;
  initialStock?: number;
}

export interface ShopData {
  inventory?: ShopItem[];
  secondsUntilRestock?: number;
}

export interface ActivityLogEntry {
  action: string;
  timestamp: number;
  parameters?: Record<string, unknown>;
}

export interface InventoryStorage {
  decorId?: string;
  items?: Pet[];
}

export interface PlayerData {
  playerId?: string;
  databaseUserId?: string;
  userId?: string;
  petSlots?: Pet[];
  petTeams?: PetTeam[];
  activityLogs?: ActivityLogEntry[];
  shopPurchases?: Record<string, { purchases?: Record<string, number> }>;
  inventory?: { items?: Pet[]; storages?: InventoryStorage[] };
  garden?: { tileObjects?: Record<string, GardenTile> };
}

export interface PlayerSlot {
  playerId?: string;
  data?: PlayerData;
}

export interface RoomPlayer {
  id?: string;
  databaseUserId?: string;
  name?: string;
}

export interface RoomState {
  selfPlayerId?: string;
  players?: RoomPlayer[];
}

export interface GameState {
  selfPlayerId?: string;
  userSlots?: PlayerSlot[];
  shops?: Record<string, ShopData>;
  weather?: string;
}

export interface FullState {
  selfPlayerId?: string;
  data?: RoomState;
  child?: { data?: GameState };
}

export interface RoomConnection {
  currentWebSocket?: WebSocket;
  sendMessage(command: Record<string, unknown>): void;
  subscribeToPatches(callback: (patches: unknown[], state: FullState) => void): void | (() => void);
}

export interface CompanionPage extends Window {
  MagicCircle_RoomConnection?: RoomConnection;
  jotaiAtomCache?: { cache?: Map<unknown, JotaiAtom>; get?: (key: unknown, initial: JotaiAtom) => JotaiAtom; __gardenCompanionWrapped?: boolean } | Map<unknown, JotaiAtom>;
  __gardenCompanionFeature?: (name: string) => boolean;
  __gardenCompanionConfig?: () => CompanionConfig;
  __gardenCompanionPlantPrice?: (species?: string) => number | undefined;
  __gardenCompanionPetSprites?: Record<string, string>;
  __gardenCompanionShopSprites?: Record<string, string>;
  __gardenCompanionProduceSprites?: Record<string, string>;
  __gardenCompanionEmblemSprites?: Record<string, string>;
  __gardenCompanionPetSpritesReady?: () => void;
  __gardenCompanionClaimKeybind?: (owner: string, combo: string) => void;
  __gardenCompanionOverviewShortcutChanged?: (shortcut: string) => void;
  __gardenCompanionArmAlarm?: () => AudioContext | null;
  __gardenCompanionStopAlarm?: (owner?: string) => void;
  __gardenCompanionShowAlarm?: (options: CompanionAlarmOptions) => void;
  __gardenCompanionState?: unknown;
  __GARDEN_COMPANION_PIXI__?: { app: unknown; renderer: unknown };
  [key: string]: unknown;
}

export interface CompanionAlarmOptions {
  owner?: string;
  label: string;
  title: string;
  detail?: string;
  actionLabel?: string;
  onAction?: (button: HTMLButtonElement) => void | Promise<void>;
}

export interface JotaiAtom {
  debugLabel?: string;
  read?: (get: unknown, ...args: unknown[]) => unknown;
  write?: (get: unknown, set: (atom: JotaiAtom, value: unknown) => unknown, ...args: unknown[]) => unknown;
  [key: string]: unknown;
}

export interface CompanionConfig {
  overview: boolean;
  dragMove: boolean;
  petTeams: boolean;
  abilities: boolean;
  rooms: boolean;
  shopAlarms: boolean;
  turtleTimer: boolean;
  petFood: boolean;
  instantHarvest: boolean;
  interfaceShortcuts: boolean;
  backgroundMode: boolean;
  autoRefreshGameUpdates: boolean;
  lunarTimer: boolean;
  abilitySilencer: boolean;
  silencedAbilities: string[];
  trackedAbilities: string[];
  shopAlerts: Record<string, boolean>;
  petFoodChoices: Record<string, string>;
  teamKeybinds: Record<string, string>;
  interfaceKeybinds: Record<string, string>;
  [key: string]: boolean | string[] | Record<string, boolean> | Record<string, string>;
}
