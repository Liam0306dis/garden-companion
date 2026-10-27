import { scriptVersion } from './utils.js';

const PING_URL = 'https://stats.liammg.workers.dev/ping';
const ID_KEY = 'gc-stats-id';
const LAST_PING_KEY = 'gc-stats-last-ping';

/**
 * Sends one anonymous ping a day so the number of active users can be counted. The only thing sent
 * is a random id made on first run (nothing tied to the player or their game account) and the script
 * version. The day is only marked as sent once the server accepts it, so a failed ping is retried on
 * the next load.
 */
export function initUsagePing(): void {
  try {
    let id = GM_getValue<string>(ID_KEY, '');
    if (!id) { id = crypto.randomUUID(); GM_setValue(ID_KEY, id); }
    const today = new Date().toISOString().slice(0, 10);
    if (GM_getValue<string>(LAST_PING_KEY, '') === today) return;
    GM_xmlhttpRequest({
      method: 'POST',
      url: PING_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ id, version: scriptVersion() }),
      timeout: 15_000,
      onload: response => { if (response.status === 200) GM_setValue(LAST_PING_KEY, today); },
    });
  } catch { /* counting users must never break the script */ }
}
