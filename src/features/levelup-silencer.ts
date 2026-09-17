import type { CompanionPage, JotaiAtom } from '../types.js';
import { onCurrentRoomState } from '../game-room-state.js';

/**
 * Silences the pet "Level up!" / "Fully grown!" popup by removing it from the toast list the game
 * renders from. Unlike ability popups (a pet's lastActionEvent, which the ability silencer strips),
 * level-ups are toasts pushed onto the room toast list by a React effect that diffs each pet's
 * strength, so they need their own hook. The level-up toast is the only one in the game that is both
 * stackable and the "success" variant, which makes it safe to match without depending on its
 * (localised) title text. The pet's own sound effect is fired separately by that same effect and is
 * not affected here.
 *
 * Bundle 1206 folded the old standalone quinoaToastsAtom into `currentRoomAtom`'s state instance as a
 * `toasts` field atom (game-room-state.ts hands it over); the hook itself is unchanged - it is still
 * on the toast list atom's write.
 */
const isLevelUpToast = (entry: unknown): boolean => {
  const toast = entry as Record<string, unknown> | null;
  return Boolean(toast && typeof toast === 'object' && toast.isStackable === true && toast.variant === 'success');
};

function hookToastsAtom(atom: JotaiAtom): void {
  if (!atom || typeof atom.write !== 'function' || atom.__gardenCompanionLevelUpSilencer) return;
  const page = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage;

  // The toasts atom is a primitive atom: jotai stores its value on write and hands it straight back
  // without re-running read, so wrapping read never fires here - the hook has to be on write.
  //
  // The original write is left to run exactly as before rather than swapping out its setter: the
  // game reaches into a write's own `set` to capture a store setter (see game-atoms.ts), so feeding
  // it a wrapped setter is not safe. Instead, once the write has completed, the current toast list is
  // read back and the level-up toast removed with an ordinary self-set - the same thing the game's
  // own toast dismissal does. Everything is guarded so a failure here can never take the real write
  // (or whatever effect triggered it) down with it.
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

export function initLevelUpSilencer(): void {
  onCurrentRoomState(state => {
    if (state.toasts) hookToastsAtom(state.toasts);
  });
}
