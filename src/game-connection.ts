import { page } from './page.js';

/**
 * The QuinoaCommand envelope carries a commandSequence, and the server rejects the whole message as
 * `invalid_message` without one - which is how buying, preserving, potting and harvesting stopped
 * working while everything sent through the game's other sender carried on fine.
 *
 * The game's counter is private to one of its modules, so we cannot read it, and running a second
 * counter alongside it does not work: the game never learns that we consumed a number, so its next
 * command reuses one of ours and the server drops one of the pair. That is intermittent breakage of
 * the player's own actions, which is worse than the bug being fixed.
 *
 * So instead of numbering only our own commands, every outgoing command is renumbered from one
 * counter as it leaves. Two senders can then never choose the same number, because there is only
 * one chooser. The game matches replies by requestId rather than sequence, so renumbering is
 * invisible to it.
 */
let sequence = -1;
let executedSeen = -1;

/**
 * The server requires the sequence to be contiguous, not merely increasing: a number it never
 * received makes every later command `invalid_sequence`. Crop protection creates exactly that hole
 * - the game's counter advances for a harvest we then swallow - so the numbering cannot be left to
 * the game. Renumbering every command as it leaves closes the hole, because a blocked command
 * simply never takes a number and the next one continues the run unbroken.
 */
export function noteFrameSequence(data: unknown): void {
  if (typeof data !== 'string' || !data.includes('executedCommandSequence')) return;
  try {
    const frame = JSON.parse(data) as { executedCommandSequence?: unknown };
    const executed = Number(frame?.executedCommandSequence);
    if (Number.isFinite(executed) && executed > executedSeen) executedSeen = executed;
  } catch {}
}

/** A reconnect restarts the game's counter, so ours has to be seeded again rather than carried. */
export function resetCommandSequence(): void {
  sequence = -1;
  executedSeen = -1;
}

/**
 * Stamps an outgoing frame with the next sequence. Everything that leaves goes through here - the
 * game's commands as well as ours - which is what keeps the run single and unbroken. The first
 * command keeps whatever number the game chose, so the run starts where the server expects; after
 * that the count is ours and the game's own number is deliberately ignored.
 */
export function renumberOutgoingCommand(data: unknown): unknown {
  if (typeof data !== 'string' || !data.includes('QuinoaCommand')) return data;
  try {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame?.type !== 'QuinoaCommand') return data;
    if (sequence < 0) {
      // Continue from what the server has actually received, never from what the game believes it
      // has sent: after a blocked command those two disagree, and the server's view is the one that
      // decides. Its own claim is only a fallback for before any frame has been seen.
      const claimed = Number(frame.commandSequence);
      sequence = executedSeen >= 0 ? executedSeen : (Number.isFinite(claimed) ? claimed - 1 : -1);
    }
    sequence += 1;
    frame.commandSequence = sequence;
    return JSON.stringify(frame);
  } catch { return data; }
}

/** Sends a message on the game's own room connection, so the server sees it as the player acting. */
export function send(command: Record<string, unknown>): void {
  const connection = page.MagicCircle_RoomConnection;
  if (!connection || typeof connection.sendMessage !== 'function') throw new Error('The game connection is not ready.');
  connection.sendMessage({ scopePath: ['Room', 'Quinoa'], ...command });
}

/**
 * The sequence is left off deliberately: it is stamped on the way out, so that one counter covers
 * our commands and the game's alike.
 */
export function sendQuinoaCommand(command: Record<string, unknown>): string {
  const requestId = crypto.randomUUID();
  send({ type: 'QuinoaCommand', requestId, command });
  return requestId;
}
