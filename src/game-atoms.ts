import type { JotaiAtom } from './types.js';
import { page } from './page.js';
import { setQuinoaEngine } from './quinoa-engine.js';
import { state } from './state.js';
import { toast } from './toast.js';

/**
 * Reading and driving the game through its own jotai atoms: mirroring the values the panel needs
 * into our state, and opening the game's shops and weather station the way its own buttons do.
 */
export type GameInterface = 'weatherStation' | 'seedShop' | 'eggShop' | 'toolShop';

function atomMap(): Map<unknown, JotaiAtom> | null {
  const cache = page.jotaiAtomCache;
  if (cache instanceof Map) return cache;
  return cache?.cache ?? null;
}

export const GAME_INTERFACES: ReadonlyArray<{ id: GameInterface; label: string }> = [
  { id: 'weatherStation', label: 'Weather station' },
  { id: 'seedShop', label: 'Seed shop' },
  { id: 'eggShop', label: 'Egg shop' },
  { id: 'toolShop', label: 'Tool shop' },
];
let activeModalAtom: JotaiAtom | null = null;
let cinematicAtom: JotaiAtom | null = null;
let gameAtomSet: ((atom: JotaiAtom, value: unknown) => unknown) | null = null;
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
  if (atomKey.endsWith('/activeModalAtom')) activeModalAtom = atom;
  if (atomKey.endsWith('/isCinematicModeAtom')) {
    cinematicAtom = atom;
    watchCinematicValue(atom);
  }
  if ((atomKey.endsWith('/quinoaEngineAtom') || atom.debugLabel === 'quinoaEngineAtom') && typeof atom.write === 'function' && !atom.__gardenCompanionEngineCapture) {
    const originalEngineWrite = atom.write;
    atom.write = function(get, set, ...args) {
      const result = originalEngineWrite.call(this, get, set, ...args);
      setQuinoaEngine(args[0]);
      return result;
    };
    atom.__gardenCompanionEngineCapture = true;
  }
  if (gameAtomSet || typeof atom?.write !== 'function' || wrappedAtomWrites.has(atom)) return atom;
  const original = atom.write;
  const capture = function(this: JotaiAtom, get, set, ...args) {
    gameAtomSet = (target, value) => set(target, value);
    restoreAtomWriteCaptures();
    return original.call(this, get, set, ...args);
  };
  atom.write = capture;
  wrappedAtomWrites.set(atom, { original, capture });
  return atom;
}

export function installGameModalAccess(): void {
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

export function openGameInterface(target: GameInterface): void {
  if (!activeModalAtom || !gameAtomSet) {
    toast('The game interface is still loading.', 'error');
    return;
  }
  gameAtomSet(activeModalAtom, target);
}

const cinematicOwners = new Set<string>();
let cinematicValue = false;

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
  if (!cinematicAtom || !gameAtomSet) return false;
  try {
    if (enabled) {
      if (!cinematicOwners.size) cinematicBeforeClaim = cinematicValue;
      cinematicOwners.add(owner);
    } else cinematicOwners.delete(owner);
    applyingOwnCinematic = true;
    try { gameAtomSet(cinematicAtom, cinematicOwners.size > 0 || cinematicBeforeClaim); }
    finally { applyingOwnCinematic = false; }
    return true;
  } catch { return false; }
};

/**
 * Atoms are found by debugLabel, which the game sets to a bare name. A plain endsWith would let one
 * label swallow another - lastCurrencyTransactionAtom ends with actionAtom - and which of the two
 * won would come down to Map order, so a match is either exact or a whole path segment.
 */
function labelMatches(label: string, match: string): boolean {
  return label === match || label.endsWith(`/${match}`);
}

function hookAtom(match, key, attempt = 0) {
  const map = atomMap();
  if (!map || typeof map.values !== 'function') {
    if (attempt < 180) setTimeout(() => hookAtom(match, key, attempt + 1), 500);
    return;
  }
  for (const atom of map.values()) {
    const label = String(atom?.debugLabel || '');
    if (!labelMatches(label, match) || typeof atom.read !== 'function') continue;
    const flag = `__gardenCompanion:${key}`;
    if (atom[flag]) return;
    const original = atom.read;
    atom.read = function(get, ...args) {
      const value = original.call(this, get, ...args);
      (state as unknown as Record<string, unknown>)[key] = value;
      if (key === 'selectedSlotId') state.selectedSlotId = value as string | number | null;
      return value;
    };
    // A derived atom is read whenever anything depends on it, but a primitive one holds its value
    // and the store need never call read at all - mySelectedSlotIdAtom is `atom(0)`, so cycling
    // slots only ever showed up as a write. Reading it back after the write keeps both kinds live.
    if (typeof atom.write === 'function') {
      const originalWrite = atom.write;
      atom.write = function(get, set, ...args) {
        const result = originalWrite.call(this, get, set, ...args);
        try {
          const value = (get as (target: JotaiAtom) => unknown)(atom);
          (state as unknown as Record<string, unknown>)[key] = value;
          if (key === 'selectedSlotId') state.selectedSlotId = value as string | number | null;
        } catch {}
        return result;
      };
    }
    atom[flag] = true;
    return;
  }
  if (attempt < 180) setTimeout(() => hookAtom(match, key, attempt + 1), 500);
}

export function installAtomHooks() {
  hookAtom('myCurrentGrowSlotsAtom', 'currentCrop');
  hookAtom('myCurrentEggAtom', 'currentEgg');
  hookAtom('myOwnCurrentDirtTileIndexAtom', 'dirtTileIndex');
  hookAtom('mySelectedSlotIdAtom', 'selectedSlotId');
  hookAtom('mySelectedItemIdAtom', 'selectedItemId');
  hookAtom('isInPreservationModeAtom', 'preservationMode');
  // Which slot in userSlots is ours. Nothing in the room state says so any more, and the socket url
  // no longer carries a playerId, so the game's own answer is the only reliable one.
  hookAtom('myUserSlotIdxAtom', 'userSlotIndex');
  // Kept apart from state.playerId: this atom starts as an empty string, and writing that
  // straight in would wipe the id the Welcome frame already gave us.
  hookAtom('playerIdAtom', 'atomPlayerId');
  hookAtom('actionAtom', 'currentAction');
}
