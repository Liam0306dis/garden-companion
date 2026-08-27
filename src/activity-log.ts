import { feature } from './config.js';
import { recordAbilityActivities } from './features/ability-log.js';
import { recordEggHatches } from './features/egg-luck.js';
import { state } from './state.js';
import type { ActivityLogEntry } from './types.js';
import { loadLocal, saveLocal } from './utils.js';

/**
 * One pass over the game's activity log, shared by everything that reads it.
 *
 * The log holds only the last handful of entries, so anything wanted from it has to be copied out
 * as it appears. Not counting an entry twice is what the bookkeeping below is for, and it belongs
 * here rather than to any one reader: were each to keep its own, an entry would be at a different
 * place in each, and turning a feature off would strand its position where a later frame replays
 * everything that happened in between.
 */

const SEEN_KEY = 'gardenCompanion.activitySeen';

/**
 * Entries already counted, by content.
 *
 * A high-water timestamp was not enough. It admitted only entries newer than the newest one already
 * seen, so an entry that reached us after one stamped later than it was dropped for good - and
 * nothing offers it again. Hatch several eggs quickly and their completions land close enough
 * together to arrive out of order, which silently lost hatches: a lost one that happened to be the
 * rare species left its bad luck counter climbing through a reset that had really happened, on past
 * the threshold the game guarantees it by.
 *
 * Identity settles it where a timestamp cannot. The log itself only holds about 25 entries, so a
 * window a little wider than that covers everything it can still be offering.
 */
const SEEN_LIMIT = 64;
/** How far behind the newest entry seen we will still accept one, so an old backlog cannot replay. */
const LATE_GRACE_MS = 10 * 60_000;

const savedSeen = loadLocal<unknown>(SEEN_KEY, []);
let seen = Array.isArray(savedSeen) ? savedSeen.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * An entry's identity, hashed. The text it is taken from carries the whole payload - a hatched pet
 * alone runs to about 280 bytes - and the window is written back on every batch, so keeping the
 * text would put 20KB through a synchronous store for something only ever compared for equality.
 */
function signature(entry: ActivityLogEntry): string {
  let text: string;
  try { text = `${entry.action}|${entry.timestamp}|${JSON.stringify(entry.parameters ?? {})}`; }
  catch { text = `${entry.action}|${entry.timestamp}`; }
  let hash = 5381;
  for (let index = 0; index < text.length; index++) hash = (hash * 33 ^ text.charCodeAt(index)) >>> 0;
  // The timestamp stays in front of the hash: it costs nothing and no two entries of one moment
  // can then collide, which is exactly where the duplicates being guarded against arise.
  return `${entry.timestamp}:${hash.toString(36)}`;
}

export function processActivityLog(): void {
  const entries = state.slot?.data?.activityLogs;
  if (!Array.isArray(entries)) return;
  const cursor = state.activityCursor;
  const known = new Set(seen);
  const fresh = entries
    .filter(entry => {
      const at = Number(entry?.timestamp);
      if (!Number.isFinite(at) || at < cursor - LATE_GRACE_MS) return false;
      const id = signature(entry);
      if (known.has(id)) return false;
      // Added as it passes, so a batch holding the same entry twice is treated the way two frames
      // holding it would be - counted once.
      known.add(id);
      return true;
    })
    .sort((left, right) => Number(left.timestamp) - Number(right.timestamp));
  if (!fresh.length) return;
  if (feature('abilities')) recordAbilityActivities(fresh);
  recordEggHatches(fresh);

  seen = [...seen, ...fresh.map(signature)].slice(-SEEN_LIMIT);
  // Still tracked, but only to bound how far back the window ever reaches - never to decide on its
  // own whether an entry is new, which is what dropped them.
  state.activityCursor = Math.max(cursor, ...fresh.map(entry => Number(entry.timestamp) || 0));
  localStorage.setItem('gardenCompanion.activityCursor', String(state.activityCursor));
  saveLocal(SEEN_KEY, seen);
}
