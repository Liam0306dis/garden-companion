import type { CompanionPage } from './types.js';

/**
 * The game's own window. Userscript managers run us in a sandbox where `window` is a wrapper, so
 * anything that has to see the game's globals (or be seen by them) goes through here.
 */
export const page = (typeof unsafeWindow !== 'undefined' ? unsafeWindow : window) as unknown as CompanionPage;
