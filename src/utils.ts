/** Small formatting and storage helpers shared across the panel and its features. */

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]);
}

export function humanize(value: unknown): string {
  return String(value || '').replace(/_NEW$/, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Za-z])([IVX]+)$/g, '$1 $2');
}

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
