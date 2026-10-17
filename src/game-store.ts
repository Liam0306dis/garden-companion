import type { JotaiAtom } from './types.js';
import { page } from './page.js';

/**
 * The game's jotai store. Since build 1604 the game publishes it as window.__jotaiStore before it
 * renders, and its developers asked mods to use it rather than patch atoms: in particular, not to
 * patch an atom's read to get at the store. It is not an official API, so everything here checks it
 * is there and still has the shape expected, and callers keep their older route as a fallback.
 */
export interface GameStore {
  get(atom: JotaiAtom): unknown;
  set(atom: JotaiAtom, value: unknown): unknown;
  sub(atom: JotaiAtom, listener: () => void): () => void;
}

export function gameStore(): GameStore | null {
  const store = (page as unknown as { __jotaiStore?: Partial<GameStore> }).__jotaiStore;
  return typeof store?.get === 'function' && typeof store.set === 'function' && typeof store.sub === 'function'
    ? store as GameStore
    : null;
}

/**
 * Follow an atom's value through the store: `onValue` hears it now and on every change. Returns false
 * when the build has no store, so the caller can fall back to its older hook. A throw in `onValue` is
 * kept out of the store's notification loop.
 */
export function watchAtom(atom: JotaiAtom, onValue: (value: unknown) => void, label = 'atom'): boolean {
  const store = gameStore();
  if (!store) return false;
  const emit = () => {
    try { onValue(store.get(atom)); } catch (error) { console.warn(`[Garden Companion] Watching ${label} failed:`, error); }
  };
  try {
    store.sub(atom, emit);
  } catch {
    return false;
  }
  emit();
  return true;
}
