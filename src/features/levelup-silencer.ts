import type { CompanionPage, JotaiAtom } from '../types.js';

function atomMap(page: CompanionPage): Map<unknown, JotaiAtom> | null {
  const cache = page.jotaiAtomCache;
  if (cache instanceof Map) return cache;
  return cache?.cache ?? null;
}

/**
 * Silences the pet "Level up!" / "Fully grown!" popup by removing it from the toast atom the game
 * renders from. Unlike ability popups (a pet's lastActionEvent, which the ability silencer strips),
 * level-ups are toasts pushed onto quinoaToastsAtom by a React effect that diffs each pet's
 * strength, so they need their own hook. The level-up toast is the only one in the game that is
 * both stackable and the "success" variant, which makes it safe to match without depending on its
 * (localised) title text. The pet's own sound effect is fired separately by that same effect and is
 * not affected here.
 */
export function initLevelUpSilencer(attempt = 0): void {
  const page = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage;
  const map = atomMap(page);
  if (!map) {
    if (attempt < 240) setTimeout(() => initLevelUpSilencer(attempt + 1), 500);
    return;
  }

  const atom = [...map.values()].find(candidate => String(candidate.debugLabel ?? '').endsWith('quinoaToastsAtom'));
  if (!atom?.write) {
    if (attempt < 240) setTimeout(() => initLevelUpSilencer(attempt + 1), 500);
    return;
  }
  if (atom.__gardenCompanionLevelUpSilencer) return;

  // quinoaToastsAtom is a primitive atom: jotai stores its value on write and hands it straight
  // back without re-running read, so wrapping read (the way the ability silencer does for the
  // derived pet-slot atom) never fires here - the hook has to be on write.
  //
  // The original write is left to run exactly as before rather than swapping out its setter: the
  // game reaches into a write's own `set` to capture a store setter (see game-atoms.ts), so feeding
  // it a wrapped setter is not safe. Instead, once the write has completed, the current toast list
  // is read back and the level-up toast removed with an ordinary self-set - the same thing the
  // game's own toast dismissal does. Everything is guarded so a failure here can never take the
  // real write (or whatever effect triggered it) down with it.
  const isLevelUpToast = (entry: unknown): boolean => {
    const toast = entry as Record<string, unknown> | null;
    return Boolean(toast && typeof toast === 'object' && toast.isStackable === true && toast.variant === 'success');
  };
  const originalWrite = atom.write;
  atom.write = function(get: unknown, set: (target: JotaiAtom, value: unknown, ...rest: unknown[]) => unknown, ...args: unknown[]): unknown {
    const result = originalWrite.call(this, get, set, ...args);
    try {
      if (page.__gardenCompanionConfig?.()?.silenceLevelUps) {
        const current = (get as (target: JotaiAtom) => unknown)(atom);
        if (Array.isArray(current) && current.some(isLevelUpToast)) {
          set(atom, current.filter(entry => !isLevelUpToast(entry)));
        }
      }
    } catch {}
    return result;
  };
  atom.__gardenCompanionLevelUpSilencer = true;
}
