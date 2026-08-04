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
  const atomKey = String(key);
  if (atomKey.endsWith('/activeModalAtom')) activeModalAtom = atom;
  if (atomKey.endsWith('/isCinematicModeAtom')) cinematicAtom = atom;
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

page.__gardenCompanionSetCinematic = (enabled: boolean) => {
  if (!cinematicAtom || !gameAtomSet) return false;
  try {
    gameAtomSet(cinematicAtom, enabled);
    return true;
  } catch { return false; }
};

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

export function installAtomHooks() {
  hookAtom('myCurrentGrowSlotsAtom', 'currentCrop');
  hookAtom('myCurrentEggAtom', 'currentEgg');
  hookAtom('myOwnCurrentDirtTileIndexAtom', 'dirtTileIndex');
  hookAtom('mySelectedSlotIdAtom', 'selectedSlotId');
  hookAtom('data/action/actionAtom.ts/actionAtom', 'currentAction');
}
