import { page } from './page.js';

/**
 * The sprite loader is over half of this script: a 485KB WebAssembly texture transcoder carried as
 * base64, plus the code that fetches every atlas, transcodes it and renders 26 pets through Rive.
 * Injecting it at document-start makes the browser compile all of that synchronously, then start
 * decoding, while the game is still booting - which is exactly when the page feels slowest.
 *
 * Nothing needs a sprite until the game is up and a panel is opened, so injection waits for the
 * page to finish loading and the main thread to fall quiet. If the player reaches for the UI before
 * that happens, the first pointer press stops the waiting and injects immediately.
 */

/**
 * Set to skip sprite loading entirely on the next load, for measuring what it costs. Kept in
 * storage rather than memory because the loader runs during startup: a switch that only lasts the
 * session could never be turned off before the thing it controls has already run.
 */
const DISABLE_KEY = 'gardenCompanion.disableSprites';

let injected = false;

function spritesDisabled(): boolean {
  try { return localStorage.getItem(DISABLE_KEY) === '1'; } catch { return false; }
}

function inject(): void {
  if (injected || spritesDisabled()) return;
  injected = true;
  const script = document.createElement('script');
  script.textContent = __PET_SPRITE_LOADER__;
  (document.head || document.documentElement).appendChild(script);
  script.remove();
}

/**
 * Genuine idle, with a long stop so a permanently busy page still gets its artwork eventually. A
 * short timeout here is worse than none: it fires in the middle of the load it was meant to avoid.
 */
function whenIdle(run: () => void): void {
  const idle = (page as unknown as { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number }).requestIdleCallback;
  if (typeof idle === 'function') idle.call(page, run, { timeout: 15_000 });
  else setTimeout(run, 5000);
}

export function installPetSpriteLoader(): void {
  // Published so anything that actually needs a sprite can stop waiting and pull the loader in.
  page.__gardenCompanionLoadSprites = inject;
  page.__gardenCompanionDisableSprites = (disabled = true) => {
    try {
      if (disabled) localStorage.setItem(DISABLE_KEY, '1');
      else localStorage.removeItem(DISABLE_KEY);
    } catch {}
    console.log(`[Garden Companion] Sprite loading ${disabled ? 'disabled' : 'enabled'}. Reload the page to apply.`);
    return disabled;
  };
  if (spritesDisabled()) {
    console.warn('[Garden Companion] Sprite loading is disabled; artwork will be missing. Run __gardenCompanionDisableSprites(false) to restore it.');
    return;
  }
  const start = () => whenIdle(inject);
  if (document.readyState === 'complete') start();
  else page.addEventListener('load', start, { once: true });
}
