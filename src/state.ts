import type { GameState, PlantSlot, PlayerSlot, RoomState } from './types.js';
import { LOG_KEY, LOG_PER_ABILITY } from './constants.js';
import { loadLocal, saveLocalOrFail } from './utils.js';

export interface AbilityLogRow {
  at: number;
  ability: string;
  pet: string;
  data: Record<string, unknown>;
}

export interface CompanionState {
  room: RoomState | null;
  game: GameState | null;
  slot: PlayerSlot | null;
  slotIndex: number | null;
  /** Our own slot index, straight from the game's myUserSlotIdxAtom. */
  userSlotIndex: number | null;
  /** The game's playerIdAtom, which starts empty and is seeded from the Welcome frame. */
  atomPlayerId: string | null;
  playerId: string | null;
  currentCrop: PlantSlot[] | null;
  currentEgg: PlantSlot | null;
  dirtTileIndex: string | number | null;
  selectedSlotId: string | number | null;
  selectedItemId: string | null;
  preservationMode: boolean;
  currentAction: string | null;
  lastShopSignature: string;
  initializedShops: boolean;
  activityCursor: number;
  abilityLog: AbilityLogRow[];
}

/** Kept per exact ability so a chatty ability cannot crowd a rare one out of the history. */
export function trimAbilityLogs(logs: AbilityLogRow[], perAbility = LOG_PER_ABILITY): AbilityLogRow[] {
  const retained = new Map<string, number>();
  return logs.filter(log => {
    const count = retained.get(log.ability) ?? 0;
    if (count >= perAbility) return false;
    retained.set(log.ability, count + 1);
    return true;
  });
}

/**
 * Live view of the room, our slot, and everything derived from them. Fields are replaced as the
 * game reports new state, so the object itself is stable and safe to import anywhere.
 */
export const state: CompanionState = {
  room: null,
  game: null,
  slot: null,
  slotIndex: null,
  userSlotIndex: null,
  atomPlayerId: null,
  playerId: null,
  currentCrop: null,
  currentEgg: null,
  dirtTileIndex: null,
  selectedSlotId: null,
  selectedItemId: null,
  preservationMode: false,
  currentAction: null,
  lastShopSignature: '',
  initializedShops: false,
  activityCursor: Number(localStorage.getItem('gardenCompanion.activityCursor') || 0),
  abilityLog: trimAbilityLogs(loadLocal<AbilityLogRow[]>(LOG_KEY, [])),
};

/**
 * Each row carries the ability's raw payload, so a long history can outgrow the storage quota.
 * Halve the retained history until it fits rather than silently giving up on persistence.
 */
export function saveAbilityLog(): void {
  if (saveLocalOrFail(LOG_KEY, state.abilityLog)) return;
  for (let perAbility = LOG_PER_ABILITY >> 1; perAbility >= 25; perAbility >>= 1) {
    state.abilityLog = trimAbilityLogs(state.abilityLog, perAbility);
    if (saveLocalOrFail(LOG_KEY, state.abilityLog)) return;
  }
}
