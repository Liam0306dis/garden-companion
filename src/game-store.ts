import type { FullState, JotaiAtom } from './types.js';
import { page } from './page.js';
import { findAtom } from './atom-cache.js';

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

const atomLookups = new Map<string, { atom: JotaiAtom | null; missedAt: number }>();

/**
 * An atom by debugLabel, kept once found. A miss is only looked for again every few seconds, since
 * finding one walks the whole atom registry and callers ask on every room frame.
 */
export function cachedAtom(label: string): JotaiAtom | null {
  const known = atomLookups.get(label);
  if (known?.atom) return known.atom;
  if (known && Date.now() - known.missedAt < 5000) return null;
  const atom = findAtom(label);
  atomLookups.set(label, { atom, missedAt: Date.now() });
  return atom;
}

/**
 * Whether a room state from roomPublicationAtom or stateAtom is a real one. Both start out holding
 * an empty placeholder with no room id until the first state arrives from the server; the publish
 * time can't tell them apart, since builds before 1684 don't put one on the atom.
 */
export function isRealRoomState(fullState: FullState | null | undefined): fullState is FullState {
  return !!fullState?.child && !!fullState.data?.roomId;
}
