import { OVERVIEW_SHORTCUT_KEY } from './constants.js';

/**
 * A keypress as the text a keybind is stored as: modifiers in a fixed order, then the key. Meta is
 * included so Cmd+K is not read as a bare K; combos saved before it was added never contain it, so
 * they keep matching exactly as they did.
 */
export function comboFromEvent(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Meta');
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return parts.join('+');
}

/**
 * The Garden Overview shortcut lives in its own storage key, older than the shared config, and the
 * overview reads it at start-up. Storage can be refused outright (a locked-down or private window),
 * so every access is guarded rather than left to throw out of a key handler.
 */
export function overviewShortcut(): string {
  try { return localStorage.getItem(OVERVIEW_SHORTCUT_KEY) || ''; } catch { return ''; }
}

export function setOverviewShortcut(combo: string): void {
  try {
    if (combo) localStorage.setItem(OVERVIEW_SHORTCUT_KEY, combo);
    else localStorage.removeItem(OVERVIEW_SHORTCUT_KEY);
  } catch { /* the shortcut lasts for this session only */ }
}
