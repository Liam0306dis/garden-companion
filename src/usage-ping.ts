import { onStorageAccountChange, storageAccount } from './storage.js';
import { scriptVersion } from './utils.js';

const PING_URL = 'https://stats.liammg.workers.dev/ping';
const LAST_PING_KEY = 'gc-stats-last-ping';

/**
 * Sends one ping a day per player so the number of people playing with the script can be counted.
 * It is keyed by the player's game id, so one player on several devices or browsers counts once.
 * Only that id and the script version are sent.
 *
 * The id is not known until the room connects, so the ping waits for it, and goes again if a different
 * account signs in on the same browser. The day is only marked as sent once the server accepts it,
 * so a failed ping is retried on the next load.
 */
function ping(): void {
  try {
    const id = storageAccount();
    if (!id) return;
    const mark = `${new Date().toISOString().slice(0, 10)}|${id}`;
    if (GM_getValue<string>(LAST_PING_KEY, '') === mark) return;
    GM_xmlhttpRequest({
      method: 'POST',
      url: PING_URL,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ id, version: scriptVersion() }),
      timeout: 15_000,
      onload: response => { if (response.status === 200) GM_setValue(LAST_PING_KEY, mark); },
    });
  } catch { /* counting users must never break the script */ }
}

export function initUsagePing(): void {
  onStorageAccountChange(ping);
  ping();
}
