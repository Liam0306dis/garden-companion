/** Small formatting and storage helpers shared across the panel and its features. */

/**
 * The installed script version, straight from the userscript manager. Everything that reports a
 * version reads it from here, so the panel header, the update check and the shared state cannot
 * disagree about which build is running.
 */
export function scriptVersion(): string {
  try { return GM_info.script.version || '0.0.0'; } catch { return '0.0.0'; }
}

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

/**
 * Ids whose split-on-capitals name is not what the thing is actually called. Kept here because
 * every display path funnels through humanize, so an override applies everywhere at once.
 *
 * Plant names now come from the catalog first, so these are the fallback for before it loads, plus
 * the two the game words for its own card: it calls them Dawnbinder Bulb and Moonbinder Bulb, which
 * is a mouthful in a list of plants.
 */
export const NAME_OVERRIDES: Record<string, string> = {
  ThunderCelestialShroomPlant: 'Stormcap',
  ThunderCelestial: 'Thunderpeel',
  MoonCelestial: 'Moonbinder',
  DawnCelestial: 'Dawnbinder',
  ReplenishPotion: 'Hunger Potion',
};

export function humanize(value: unknown): string {
  const id = String(value || '');
  return NAME_OVERRIDES[id]
    ?? id.replace(/_NEW$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Za-z])([IVX]+)$/g, '$1 $2');
}

/**
 * Number grouping is pinned rather than left to the browser: a player on an Indian locale sees
 * 13,200,193 written 1,32,00,193, which reads as a corrupted value next to every screenshot and
 * wiki page. Every number the companion prints goes through here.
 */
export const NUMBER_LOCALE = 'en-US';

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

export function loadLocal<T>(key: string, fallback: T): T {
  try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; }
  catch { return fallback; }
}

export function saveLocal(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

/** Reports whether the write landed, so callers can shed data and retry when the quota is full. */
export function saveLocalOrFail(key: string, value: unknown): boolean {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; }
  catch { return false; }
}
