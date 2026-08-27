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
 * Never smaller than the log itself, and generous beyond it.
 *
 * A fixed 64 was wrong: only an entry the log is still offering can be counted twice, so the window
 * has to cover the whole log - and the log runs longer than 64 once selling pets fills it. Entries
 * fell out of the window while still present, and were counted again on the next pass, inflating
 * every tally and re-applying resets that had already been applied.
 *
 * The floor sits close to the log rather than far above it. The window is written back on every
 * batch that carries anything new, so every signature kept is bytes through a synchronous store on
 * a hot path. Four times the log is already margin enough: an entry has to be pushed out of the log
 * itself long before that many newer signatures can accumulate behind it.
 */
function seenLimit(logLength: number): number {
  return Math.max(96, logLength * 4);
}

/**
 * Entries already counted, by identity.
 *
 * A high-water timestamp was not enough. It admitted only entries newer than the newest one already
 * seen, so an entry that reached us after one stamped later than it was dropped for good - and
 * nothing offers it again. Hatch several eggs quickly and their completions land close enough
 * together to arrive out of order, which silently lost hatches: a lost one that happened to be the
 * rare species left its bad luck counter climbing through a reset that had really happened, on past
 * the threshold the game guarantees it by.
 */
const savedSeen = loadLocal<unknown>(SEEN_KEY, []);
let seen = Array.isArray(savedSeen) ? savedSeen.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * An entry's identity, from the few fields that name the thing it happened to.
 *
 * Serialising the whole payload was the obvious way to do this and the wrong one. The state arrives
 * as patches, so an entry's object is rebuilt rather than held: its keys can come back in a
 * different order, and a field inside it can be refreshed in place. Either rewrites the text
 * without the entry having changed, and an identity that moves is no identity at all - the entry
 * reads as new on the very next pass and is counted again.
 *
 * An id does not move. Entries that carry none fall back to the action and its timestamp, which can
 * only collide between two of the same action in one millisecond - and none of those feed a tally
 * that has to be exact.
 */
function signature(entry: ActivityLogEntry): string {
  const parameters = (entry.parameters ?? {}) as Record<string, { id?: unknown } | unknown>;
  const idOf = (value: unknown): string => {
    const held = (value && typeof value === 'object' ? (value as { id?: unknown }).id : value);
    return typeof held === 'string' || typeof held === 'number' ? String(held) : '';
  };
  const ids = [parameters.pet, parameters.extraPet, parameters.sourcePet, parameters.eggId, parameters.itemId]
    .map(idOf).filter(Boolean).join('/');
  return `${entry.action}|${entry.timestamp}|${ids}`;
}

export function processActivityLog(): void {
  const entries = state.slot?.data?.activityLogs;
  if (!Array.isArray(entries)) return;
  const known = new Set(seen);
  const fresh = entries
    .filter(entry => {
      if (!Number.isFinite(Number(entry?.timestamp))) return false;
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

  // Everything the log is currently offering is remembered, not just what was counted from it. What
  // has already left the log cannot come back, so the old entries carried alongside are only there
  // to survive a moment where the log arrives short - a reconnect handing over a partial one would
  // otherwise empty the window and replay the lot.
  //
  // Emptied of holes first. The walk above steps around a missing entry, but this reads every one
  // the log offers, and taking a signature from nothing throws - out of here, and so out of every
  // reader that runs after this one on the same frame.
  seen = [...new Set([...seen, ...entries.filter(Boolean).map(signature)])].slice(-seenLimit(entries.length));
  saveLocal(SEEN_KEY, seen);
}
