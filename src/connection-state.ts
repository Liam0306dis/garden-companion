/**
 * A reconnect does not hand the world back in one piece. The socket reopens and the first patches
 * can carry an empty shop list, a garden with no tiles, or a restock clock that has jumped forward
 * by however long the connection was down. Anything that fires on a *change* reads that gap as news
 * and alarms on it, which is how a dropped connection turns into a burst of false alarms.
 *
 * So the interruption is published once, here, and every watcher re-baselines instead of guessing
 * from the state itself.
 */

let roomSocketOpens = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    try { listener(); } catch (error) { console.warn('[Garden Companion] A reconnect listener failed.', error); }
  }
}

/** Called for every room socket that opens. The first is the initial connection, not a reconnect. */
export function noteRoomSocketOpened(): void {
  roomSocketOpens++;
  if (roomSocketOpens > 1) emit();
}

/**
 * Called when a room socket closes. Announced as well as the reopen because a patch can still be
 * delivered between the two, and it must not be diffed against the pre-drop world either.
 */
export function noteRoomSocketClosed(): void {
  if (roomSocketOpens > 0) emit();
}

/**
 * Runs whenever the room connection drops or comes back. Listeners must be cheap and idempotent:
 * a single reconnect fires this twice, once on the close and once on the open.
 */
export function onRoomConnectionInterrupted(listener: () => void): void {
  listeners.add(listener);
}
