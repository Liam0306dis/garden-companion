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
 * as it appears. The cursor is what stops an entry being counted twice across the state frames it
 * survives, and it belongs here rather than to any one reader: were each to keep its own, an entry
 * would be at a different place in each, and turning a feature off would silently strand its cursor
 * where a later frame replays everything that happened in between.
 */

const SEEN_KEY = 'gardenCompanion.activityCursorSeen';

/**
 * Entries already counted that sit exactly on the cursor.
 *
 * A timestamp alone cannot separate them. Two entries can share a millisecond - a Double Hatch
 * produces two of them - and there is no promise they arrive in the same state frame, so a cursor
 * advanced past the first would drop the second on sight and no later frame would offer it again.
 * Admitting ties and remembering which have been counted keeps the second, and holds only the
 * entries of a single millisecond, so it cannot grow.
 */
const savedSeen = loadLocal<unknown>(SEEN_KEY, []);
let seenAtCursor = new Set(Array.isArray(savedSeen) ? savedSeen.filter((entry): entry is string => typeof entry === 'string') : []);

function signature(entry: ActivityLogEntry): string {
  try { return `${entry.action}|${entry.timestamp}|${JSON.stringify(entry.parameters ?? {})}`; }
  catch { return `${entry.action}|${entry.timestamp}`; }
}

export function processActivityLog(): void {
  const entries = state.slot?.data?.activityLogs;
  if (!Array.isArray(entries)) return;
  const cursor = state.activityCursor;
  const fresh = entries
    .filter(entry => {
      const at = Number(entry?.timestamp);
      if (!Number.isFinite(at) || at < cursor) return false;
      return at > cursor || !seenAtCursor.has(signature(entry));
    })
    .sort((left, right) => left.timestamp - right.timestamp);
  if (!fresh.length) return;
  if (feature('abilities')) recordAbilityActivities(fresh);
  recordEggHatches(fresh);

  const advanced = Math.max(cursor, ...fresh.map(entry => Number(entry.timestamp) || 0));
  // Only the entries sitting on the new cursor can be offered again, so only those are remembered.
  // Where the cursor has not moved they join the ones already there; where it has, they replace them.
  const ties = fresh.filter(entry => Number(entry.timestamp) === advanced).map(signature);
  seenAtCursor = advanced === cursor ? new Set([...seenAtCursor, ...ties]) : new Set(ties);
  state.activityCursor = advanced;
  localStorage.setItem('gardenCompanion.activityCursor', String(advanced));
  saveLocal(SEEN_KEY, [...seenAtCursor]);
}
