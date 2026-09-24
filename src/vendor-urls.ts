/**
 * Third-party scripts the sprite loader may fetch. The userscript hands the page a fetch that runs
 * outside the page's content policy, so it only ever serves the URLs listed here: anything else a
 * page script asked it for would be the userscript manager's privileges lent to the page.
 */
export const RIVE_RUNTIME_URL = 'https://unpkg.com/@rive-app/canvas-single@2.38.5/rive.js';

export const VENDOR_URLS: ReadonlySet<string> = new Set([RIVE_RUNTIME_URL]);
