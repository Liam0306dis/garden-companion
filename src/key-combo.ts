import { OVERVIEW_SHORTCUT_KEY } from './constants.js';
import { sharedValue } from './storage.js';

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
 * overview reads it at start-up. It was always stored as the bare combo rather than JSON, which the
 * move out of localStorage has to read it as.
 */
const shortcutStore = sharedValue<string>(OVERVIEW_SHORTCUT_KEY, '', { raw: true });

export function overviewShortcut(): string {
  return shortcutStore.load() || '';
}

export function setOverviewShortcut(combo: string): void {
  shortcutStore.save(combo);
}
