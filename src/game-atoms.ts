import type { JotaiAtom } from './types.js';
import { page } from './page.js';
import { notifyStateChange, state } from './state.js';
import { toast } from './toast.js';
import { onCurrentRoomState, type RoomStateInstance } from './game-room-state.js';
import { atomMap, findAtom } from './atom-cache.js';
import { retryUntil } from './retry.js';
import { gameStore, watchAtom } from './game-store.js';

/**
 * Reading and driving the game through its own jotai atoms: mirroring the values the panel needs
 * into our state, and opening the game's shops and weather station the way its own buttons do.
 */
export type GameInterface = 'weatherStation' | 'seedShop' | 'eggShop' | 'toolShop'
  | 'petHutch' | 'decorShed' | 'toolShack' | 'seedSilo' | 'feedingTrough' | 'dailyQuests'
  // Weather shops, only openable while their weather runs. Kept out of GAME_INTERFACES because one
  // keybind opens whichever is running (see WEATHER_SHOP_KEY), rather than one row each.
  | 'snowShop' | 'thunderShop' | 'dawnShop' | 'amberShop' | 'rainShop';

export const GAME_INTERFACES: ReadonlyArray<{ id: GameInterface; label: string }> = [
  { id: 'weatherStation', label: 'Weather station' },
  { id: 'seedShop', label: 'Seed shop' },
  { id: 'eggShop', label: 'Egg shop' },
  { id: 'toolShop', label: 'Tool shop' },
  { id: 'petHutch', label: 'Pet hutch' },
  { id: 'decorShed', label: 'Decor shed' },
  { id: 'toolShack', label: 'Tool shack' },
  { id: 'seedSilo', label: 'Seed silo' },
  { id: 'feedingTrough', label: 'Feeding trough' },
  // The quest booth's window, added in build 1448. The game opens it with this modal id.
  { id: 'dailyQuests', label: 'Daily quests' },
];
// The modal the game shows is read from activeModalAtom, but that is a read-only derived atom
// (`atom(get => get(activeModalStateAtom))`); writing it throws "write is not a function". The
// writable source is activeModalStateAtom, which the game's own open sets to the interface id.
let activeModalStateAtom: JotaiAtom | null = null;
let cinematicAtom: JotaiAtom | null = null;
let gameAtomSet: ((atom: JotaiAtom, value: unknown) => unknown) | null = null;

/**
 * The store's setter. Since build 1604 the game publishes its jotai store as window.__jotaiStore
 * before it renders, which is there from the start and needs no patching; older builds (or one that
 * drops it, since the game calls it unofficial) fall back to the setter captured from an atom write.
 */
function atomSetter(): ((atom: JotaiAtom, value: unknown) => unknown) | null {
  const store = gameStore();
  if (store) return (atom, value) => store.set(atom, value);
  return gameAtomSet;
}
const wrappedAtomWrites = new Map<JotaiAtom, { original: JotaiAtom['write']; capture: JotaiAtom['write'] }>();

export function restoreAtomWriteCaptures(): void {
  for (const [atom, { original, capture }] of wrappedAtomWrites) {
    if (atom.write === capture) atom.write = original;
  }
  wrappedAtomWrites.clear();
}

export function inspectGameAtom(key: unknown, atom: JotaiAtom): JotaiAtom {
  // The game's own getter answers with whatever it was handed, so a caller asking for a key it has
  // not registered gets nothing back. Reading a label off that threw, and the throw came straight
  // out of the getter we wrapped - taking down whichever of the game's modules was mid-initialise.
  if (!atom) return atom;
  const atomKey = String(key);
  if (atomKey.endsWith('/activeModalStateAtom')) activeModalStateAtom = atom;
  // Bundle 1206 removed the standalone isCinematicModeAtom; cinematic mode is now the
  // `isCinematicMode` field atom on currentRoomAtom's state instance, captured in
  // installGameRoomStateHooks below rather than here.
  // The engine is captured from the system registry in plant-drag-move.ts (bundle 1141 removed the
  // engine atom this used to hook), so nothing to do here for it.
  if (atomSetter() || typeof atom?.write !== 'function' || wrappedAtomWrites.has(atom)) return atom;
  const original = atom.write;
  const capture: NonNullable<JotaiAtom['write']> = function(this: JotaiAtom, get, set, ...args) {
    gameAtomSet = (target, value) => set(target, value);
    restoreAtomWriteCaptures();
    return original.call(this, get, set, ...args);
  };
  atom.write = capture;
  wrappedAtomWrites.set(atom, { original, capture });
  return atom;
}

/**
 * Bundle 1361 added an atomMutationDiagnostics module that assigns a fresh jotaiAtomCache
 * unconditionally at boot. A cache we installed at document-start, or a wrapped getter on it, was
 * thrown away along with every atom it would have seen, so the modal atom and the store setter were
 * never captured and every interface keybind reported the game as still loading. The live registry
 * is polled instead until both have been found, whichever cache the game ends up holding.
 */
export function installGameModalAccess(): void {
  retryUntil(() => {
    atomMap()?.forEach((atom, key) => inspectGameAtom(key, atom));
    return Boolean(activeModalStateAtom && atomSetter());
  }, 'the interface shortcuts');
}

export function openGameInterface(target: GameInterface): void {
  const set = atomSetter();
  if (!activeModalStateAtom || !set) {
    toast('The game interface is still loading.', 'error');
    return;
  }
  // Bundle 1333 made the state `{ modal, openId }`, and the game's own open bumps openId each time
  // (its cards use it to tell a fresh open from a re-render). Writing the bare id left `.modal`
  // undefined, so nothing opened. The updater mirrors the game's open, and still accepts the old
  // bare-string shape should a bundle ever go back to it.
  set(activeModalStateAtom, (previous: unknown) => {
    if (typeof previous === 'string' || previous === null) return target;
    const openId = Number((previous as { openId?: unknown } | undefined)?.openId) || 0;
    return { modal: target, openId: openId + 1 };
  });
}

const cinematicOwners = new Set<string>();
let cinematicValue = false;
/** Set while the player has cinematic mode on from our button; see the write guard below. */
let cinematicPinned = false;
let holdingCameraAtom: JotaiAtom | null = null;

/** Whether the Camera is in hand, the one time the game's own Hide UI can switch cinematic off. */
function holdingCamera(): boolean {
  holdingCameraAtom ??= findAtom('isHoldingCameraAtom');
  const store = gameStore();
  if (!holdingCameraAtom || !store) return false;
  try { return Boolean(store.get(holdingCameraAtom)); } catch { return false; }
}

/**
 * The atom has no getter, so its value is followed by watching what gets written to it. Ours and
 * the player's writes look identical here; they are told apart by whether any of our features is
 * currently holding a claim, which is what `cinematicOwners` records.
 *
 * The value is read back through the write's own getter rather than inferred from the argument.
 * The game toggles with an updater, and replaying that against our own copy is only right while
 * the copy already is, so a single drift would never correct itself.
 */
function watchCinematicValue(atom: JotaiAtom): void {
  if (typeof atom.write !== 'function' || atom.__gardenCompanionCinematicWatch) return;
  const originalWrite = atom.write;
  atom.write = function(get, set, ...args) {
    // Since build 1634 the camera system switches cinematic mode off on every frame the Camera is
    // not in hand, which made our button (and every scene that hides the HUD with it) flip straight
    // back. While we hold it on, a write turning it off that is not ours is dropped - except the
    // player pressing Hide UI with the Camera in hand, which only our button's pin gives way to.
    if (!applyingOwnCinematic && (cinematicPinned || cinematicOwners.size)) {
      const next = args[0];
      const resolved = typeof next === 'function' ? (next as (value: boolean) => unknown)(cinematicValue) : next;
      if (!resolved) {
        if (cinematicOwners.size || !holdingCamera()) return undefined;
        cinematicPinned = false;
      }
    }
    const result = originalWrite.call(this, get, set, ...args);
    const previous = cinematicValue;
    try {
      cinematicValue = Boolean((get as (target: JotaiAtom) => unknown)(atom));
    } catch {
      const next = args[0];
      cinematicValue = typeof next === 'function' ? Boolean((next as (value: boolean) => unknown)(previous)) : Boolean(next);
    }
    // A write we did not make while we hold a claim is the player toggling it, so that becomes the
    // state to restore when the last claim is released.
    if (!applyingOwnCinematic && cinematicOwners.size) cinematicBeforeClaim = cinematicValue;
    if (cinematicValue !== previous) for (const listener of cinematicListeners) listener();
    return result;
  };
  atom.__gardenCompanionCinematicWatch = true;
}

/**
 * Flips cinematic mode the way the game's own button used to, as the player's choice rather than a
 * claim, so a scene opened later still hands it back when it closes. Returns the new state, or null
 * while the atom has not been captured yet.
 */
page.__gardenCompanionToggleCinematic = () => {
  const set = atomSetter();
  if (!cinematicAtom || !set) return null;
  const next = !cinematicValue;
  // Written as our own so the guard lets it through; pinned so the camera system cannot undo it.
  applyingOwnCinematic = true;
  try {
    cinematicPinned = next;
    set(cinematicAtom, next);
  } catch {
    cinematicPinned = false;
    return null;
  } finally { applyingOwnCinematic = false; }
  return cinematicValue;
};

/** Whether one of our own scenes is holding cinematic mode on right now. */
page.__gardenCompanionCinematicClaimed = () => cinematicOwners.size > 0;

/**
 * Lets go of the button's pin and turns cinematic mode off with it, for when the button goes away
 * (switched off in Tools) and would otherwise leave no way back out.
 */
page.__gardenCompanionReleaseCinematicPin = () => {
  if (!cinematicPinned) return;
  cinematicPinned = false;
  const set = atomSetter();
  if (!cinematicAtom || !set) return;
  applyingOwnCinematic = true;
  try { set(cinematicAtom, cinematicOwners.size > 0 || cinematicBeforeClaim); } catch {} finally { applyingOwnCinematic = false; }
};

/**
 * True only while the player has put the game into cinematic mode themselves. Our own scenes claim
 * cinematic too, and their panels are the point of being there, so those must not count.
 */
page.__gardenCompanionCinematicFromGame = () => cinematicValue && cinematicOwners.size === 0;

/**
 * More than one thing steps aside for cinematic mode, so this is a subscription rather than a
 * single slot a later feature could quietly take over. New listeners are called once on arrival, so
 * they do not have to wait for the next toggle to match the current state.
 */
const cinematicListeners = new Set<() => void>();
page.__gardenCompanionOnCinematicChange = (listener: () => void) => {
  cinematicListeners.add(listener);
  listener();
};

/**
 * Whether the player already had cinematic mode on when our first scene claimed it. Releasing the
 * last claim restores that rather than writing a flat false, so closing a scene cannot switch off
 * a cinematic mode the player turned on themselves.
 */
let cinematicBeforeClaim = false;
/** Set while we are the one writing, so the watcher can tell our own writes from the player's. */
let applyingOwnCinematic = false;

page.__gardenCompanionSetCinematic = (enabled: boolean, owner = 'default') => {
  const set = atomSetter();
  if (!cinematicAtom || !set) return false;
  try {
    if (enabled) {
      if (!cinematicOwners.size) cinematicBeforeClaim = cinematicValue;
      cinematicOwners.add(owner);
    } else cinematicOwners.delete(owner);
    applyingOwnCinematic = true;
    try { set(cinematicAtom, cinematicOwners.size > 0 || cinematicBeforeClaim || cinematicPinned); }
    finally { applyingOwnCinematic = false; }
    // Told even when the value stays the same: who holds it changed, which the cinematic button
    // shows (it steps aside while one of our scenes has it).
    for (const listener of cinematicListeners) listener();
    return true;
  } catch { return false; }
};

/**
 * Bundle 1141 folded myCurrentGrowSlotsAtom and myCurrentEggAtom into the raw current garden
 * object. Keep the old mirrored fields populated so crop estimates and the interaction helpers
 * remain independent of that internal atom refactor.
 */
function mirrorAtomValue(key: string, value: unknown): void {
  // Derived atoms are read far more often than they change, so only a new value is news.
  const changed = (state as unknown as Record<string, unknown>)[key] !== value;
  (state as unknown as Record<string, unknown>)[key] = value;
  if (key === 'currentGardenObject') {
    const object = value as { objectType?: unknown; slots?: unknown } | null;
    state.currentCrop = object?.objectType === 'plant' && Array.isArray(object.slots)
      ? object.slots as typeof state.currentCrop
      : null;
    state.currentEgg = object?.objectType === 'egg' ? object as typeof state.currentEgg : null;
  }
  if (key === 'selectedSlotId') state.selectedSlotId = value as string | number | null;
  // Bundle 1159 removed isInPreservationModeAtom. The primary action is 'preserve'
  // exactly while a potted plant is held at the preservation station, and actionAtom
  // (mirrored here) is read continuously by the on-screen action prompt, so derive
  // the flag preserve-all reads from it. (currentBuildingAtom would look cleaner but
  // is only subscribed during the tutorial, so its read hook almost never fires.)
  if (key === 'currentAction') state.preservationMode = value === 'preserve';
  if (changed) notifyStateChange(key);
}

/** Mirror a labelled atom's value into our state under `key`, once the game has created it. */
function hookAtom(match: string, key: string): void {
  retryUntil(() => {
    const atom = findAtom(match);
    if (typeof atom?.read !== 'function') return false;
    mirrorFieldAtom(atom, key);
    return true;
  }, `the ${key} mirror`);
}

/**
 * Mirror an atom's value into our state under `key`, wrapping both read and write. A derived atom is
 * read whenever anything depends on it, but a primitive one (mySelectedSlotIdAtom is `atom(0)`,
 * isCinematicMode is `atom(false)`) holds its value and the store need never call read, so the write
 * side reads it back to keep the mirror live either way.
 */
function mirrorFieldAtom(atom: JotaiAtom, key: string): void {
  const flag = `__gardenCompanion:${key}`;
  if (!atom || atom[flag]) return;
  // The store (1604+) follows primitive and derived atoms alike, with nothing patched; the read and
  // write wraps below are for builds without it.
  if (watchAtom(atom, value => mirrorAtomValue(key, value), key)) {
    atom[flag] = true;
    return;
  }
  if (typeof atom.read === 'function') {
    const original = atom.read;
    atom.read = function(get, ...args) {
      const value = original.call(this, get, ...args);
      mirrorAtomValue(key, value);
      return value;
    };
  }
  if (typeof atom.write === 'function') {
    const originalWrite = atom.write;
    atom.write = function(get, set, ...args) {
      const result = originalWrite.call(this, get, set, ...args);
      try { mirrorAtomValue(key, (get as (target: JotaiAtom) => unknown)(atom)); } catch {}
      return result;
    };
  }
  atom[flag] = true;
}

/**
 * While one of our scenes holds the farm, the tile under the player is hidden but the game still
 * offers its actions (Insta Grow, Pick Up, View) and Space would carry them out. The action HUD,
 * actionAtom and the bound action all derive from the selected actions, so emptying those (and the
 * info card's subject toggles) stands every one down.
 * Reading the cinematic atom makes the claim a dependency, so the actions update the moment a scene
 * opens or closes rather than on the player's next step.
 */
function suppressActionsDuringScenes(match: string, empty: unknown): void {
  retryUntil(() => {
    const atom = findAtom(match);
    if (typeof atom?.read !== 'function') return false;
    const flag = '__gardenCompanionSceneActions';
    if (atom[flag]) return true;
    const original = atom.read;
    atom.read = function(get, ...args) {
      const value = original.call(this, get, ...args);
      if (cinematicAtom) try { (get as (target: JotaiAtom) => unknown)(cinematicAtom); } catch {}
      return cinematicOwners.size ? empty : value;
    };
    atom[flag] = true;
    return true;
  }, `the ${match} scene guard`);
}

/**
 * A room reset hands over a fresh field atom that starts off. What we track is read back from it,
 * and a pin or a scene that was holding cinematic on puts it straight back on, so the button and the
 * toggle do not go on believing the old atom's value.
 */
function syncCinematicToNewAtom(atom: JotaiAtom): void {
  const previous = cinematicValue;
  const store = gameStore();
  // Without the store to ask, the fresh atom's starting value (off) is the best answer.
  try { cinematicValue = store ? Boolean(store.get(atom)) : false; } catch { cinematicValue = false; }
  const set = atomSetter();
  if ((cinematicPinned || cinematicOwners.size) && !cinematicValue && set) {
    applyingOwnCinematic = true;
    try { set(atom, true); } catch {} finally { applyingOwnCinematic = false; }
  }
  if (cinematicValue !== previous) for (const listener of cinematicListeners) listener();
}

/**
 * Bundle 1206 folded cinematic mode into currentRoomAtom's state instance. The instance is re-handed
 * on a room reset, so cinematic is re-captured against whichever field atom is live.
 */
function installGameRoomStateHooks(): void {
  onCurrentRoomState((roomState: RoomStateInstance) => {
    const cinematic = roomState.isCinematicMode;
    if (cinematic && cinematic !== cinematicAtom) {
      cinematicAtom = cinematic;
      watchCinematicValue(cinematic);
      syncCinematicToNewAtom(cinematic);
    }
  });
}

export function installAtomHooks() {
  // Bundle 1141 replaced the dedicated crop and egg atoms with this common raw tile
  // object; mirrorAtomValue derives currentCrop/currentEgg from it.
  hookAtom('myCurrentGardenObjectAtom', 'currentGardenObject');
  hookAtom('myOwnCurrentDirtTileIndexAtom', 'dirtTileIndex');
  hookAtom('selectedCropSlotIdAtom', 'selectedSlotId');
  // Bundle 1320 made the held item server state (`heldItem` on the predicted player state) and
  // brought mySelectedItemIdAtom back as a labelled read of it.
  hookAtom('mySelectedItemIdAtom', 'selectedItemId');
  // Cinematic mode lives on currentRoomAtom's state instance since bundle 1206.
  installGameRoomStateHooks();
  // Which slot in userSlots is ours. Nothing in the room state says so any more, and the socket url
  // no longer carries a playerId, so the game's own answer is the only reliable one.
  hookAtom('myUserSlotIdxAtom', 'userSlotIndex');
  // Kept apart from state.playerId: this atom starts as an empty string, and writing that
  // straight in would wipe the id the Welcome frame already gave us.
  hookAtom('playerIdAtom', 'atomPlayerId');
  hookAtom('actionAtom', 'currentAction');
  suppressActionsDuringScenes('selectedSubjectActionsAtom', null);
  suppressActionsDuringScenes('selectedActionsAtom', []);
  // The garden info card's VIEW chips, one per other subject on the tile, read their own atom.
  suppressActionsDuringScenes('toggleDataAtom', []);
}
