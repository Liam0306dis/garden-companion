/**
 * Opens a link in a new tab, through the userscript manager where it can.
 *
 * Inside the Discord activity the game runs in nested frames that refuse popups, so `window.open`
 * and `target="_blank"` links quietly do nothing there - which left the Update button unable to
 * open the new version. GM_openInTab opens the tab from the extension itself, outside the frame.
 */
export function openExternal(url: string): void {
  try {
    if (typeof GM_openInTab === 'function') {
      GM_openInTab(url, { active: true, insert: true });
      return;
    }
  } catch { /* fall through to the page's own way */ }
  window.open(url, '_blank', 'noopener,noreferrer');
}
