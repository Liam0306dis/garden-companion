import type { JotaiAtom } from './types.js';
import { findAtom } from './atom-cache.js';
import { retryUntil } from './retry.js';

/**
 * Bundle 1206 dissolved a batch of standalone jotai atoms - mySelectedItemIdAtom,
 * myLastExplicitlySelectedItemIdAtom, isCinematicModeAtom and quinoaToastsAtom - into fields of one
 * central state object. That object is the value of `currentRoomAtom` (a plain `atom(new Rr())`),
 * and each field is itself a writable atom created by the game's atom factory:
 *
 *     class Rr {
 *       isCinematicMode = atom(false);
 *       toasts          = atom([]);
 *       selection = { itemId: atom(null), lastExplicitItemId: atom(null), rotation: atom(0), ... };
 *       ...
 *     }
 *
 * The focus atoms the game reads through (`k(e => e.toasts)` etc.) have no debugLabel and cannot be
 * found in the cache, but `currentRoomAtom` still carries one, so it is the one handle back to all of
 * those field atoms. Wrapping a field atom's read/write behaves exactly as wrapping the old
 * standalone atom did - the game reaches the same atom object through its focus.
 *
 * The instance is seeded from the atom's `.init` (its initial value, set once at module load) and
 * refreshed by watching writes to `currentRoomAtom`, so a room reset that swaps in a fresh Rr hands
 * listeners the new field atoms rather than leaving them wrapping dead ones.
 */

/** The shape of the fields we reach for. Everything is optional: a future build may move them again. */
export interface RoomSelectionAtoms {
  itemId?: JotaiAtom;
  lastExplicitItemId?: JotaiAtom;
}
export interface RoomStateInstance {
  isCinematicMode?: JotaiAtom;
  toasts?: JotaiAtom;
  selection?: RoomSelectionAtoms;
  [key: string]: unknown;
}

type RoomStateListener = (state: RoomStateInstance) => void;

const listeners = new Set<RoomStateListener>();
let roomAtom: JotaiAtom | null = null;
let instance: RoomStateInstance | null = null;
let installing = false;

function isRoomState(value: unknown): value is RoomStateInstance {
  // The marker is the field atoms themselves: a bare object with a `selection` holding atom-like
  // members. Kept loose so a field rename elsewhere does not disqualify the whole instance.
  return Boolean(value) && typeof value === 'object';
}

function captureInstance(next: unknown): void {
  if (!isRoomState(next) || next === instance) return;
  instance = next;
  for (const listener of listeners) {
    try { listener(next); } catch { /* one feature must not stop the rest */ }
  }
}

/** One attempt at hooking currentRoomAtom. True once an instance is in hand. */
function install(): boolean {
  const atom = findAtom('currentRoomAtom');
  if (!atom) return false;
  roomAtom = atom;
  // The initial value of `atom(new Rr())`; the live instance until a room reset swaps it.
  if (atom.init !== undefined) captureInstance(atom.init);
  // A reset writes a fresh instance through the atom, so read it back after each write. Guarded so a
  // failure here can never take the real write down with it.
  if (!atom.__gardenCompanionRoomWatch && typeof atom.write === 'function') {
    const originalWrite = atom.write;
    atom.write = function(get, set, ...args) {
      const result = originalWrite.call(this, get, set, ...args);
      try { captureInstance((get as (target: JotaiAtom) => unknown)(atom)); } catch { /* keep the write */ }
      return result;
    };
    atom.__gardenCompanionRoomWatch = true;
  }
  return Boolean(instance);
}

/**
 * Register for the current room state instance. The listener fires once as soon as the instance is
 * known, and again with a fresh instance whenever the room is reset - so a feature re-wraps the new
 * field atoms rather than holding a stale one.
 */
export function onCurrentRoomState(listener: RoomStateListener): void {
  listeners.add(listener);
  if (instance) {
    try { listener(instance); } catch { /* as above */ }
  }
  if (!installing) {
    installing = true;
    retryUntil(install, 'the room state hooks');
  } else if (roomAtom && !instance && roomAtom.init !== undefined) {
    captureInstance(roomAtom.init);
  }
}

/** The live room state instance, or null before the room has loaded. */
export function getCurrentRoomState(): RoomStateInstance | null {
  return instance;
}
