import { page } from './page.js';

/**
 * The QuinoaCommand envelope carries a commandSequence, and the server rejects the whole message as
 * `invalid_message` without one - which is how buying, preserving, potting and harvesting stopped
 * working while everything sent through the game's other sender carried on fine.
 *
 * The game seeds its counter from the Welcome frame and takes one number per command:
 *
 *     var K = 1;  function seed(e) { K = e + 1 }   // seed(welcome.executedCommandSequence)
 *     function next() { let n = K; return K++, n }
 *
 * We seed from the same frame, which also means a reconnect needs no special handling: every
 * Welcome re-seeds. What we cannot do is keep a second counter beside the game's, because it never
 * learns we consumed a number and its next command reuses ours. So the counter is applied to every
 * command on its way out, the game's included - one counter, one chooser, no collisions. A command
 * that gets blocked before it is stamped simply takes no number, which is what keeps the run
 * contiguous; the server rejects a gap with `invalid_sequence` and never recovers from one.
 */
let sequence = -1;

/** Welcome reports what the server has executed; the next command is that plus one. */
export function seedCommandSequence(executedCommandSequence: unknown): void {
  const executed = Number(executedCommandSequence);
  if (Number.isFinite(executed)) sequence = executed + 1;
}

/**
 * Stamps an outgoing frame with the next sequence. Frames that are not commands, and anything sent
 * before Welcome has seeded us, are handed back untouched.
 */
export function renumberOutgoingCommand(data: unknown): unknown {
  if (sequence < 0 || typeof data !== 'string' || !data.includes('QuinoaCommand')) return data;
  try {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame?.type !== 'QuinoaCommand') return data;
    frame.commandSequence = sequence++;
    return JSON.stringify(frame);
  } catch { return data; }
}

type CommandListener = (command: Record<string, unknown>) => void;

const commandListeners = new Set<CommandListener>();

/**
 * Watch commands on their way out, whoever sent them.
 *
 * Since build 1029 a command carries the id of the thing it is about to create, so the frame itself
 * is the earliest and most exact notice that something is coming - earlier than any state it will
 * later turn up in, which matters when the game acts on its own prediction before the server has
 * answered.
 */
export function onOutgoingCommand(listener: CommandListener): void {
  commandListeners.add(listener);
}

export function noteOutgoingCommand(data: unknown): void {
  if (!commandListeners.size || typeof data !== 'string' || !data.includes('QuinoaCommand')) return;
  try {
    const frame = JSON.parse(data) as Record<string, unknown>;
    const command = frame?.type === 'QuinoaCommand' ? frame.command : frame;
    if (!command || typeof command !== 'object') return;
    for (const listener of commandListeners) {
      try { listener(command as Record<string, unknown>); } catch { /* one watcher must not stop the rest */ }
    }
  } catch { /* not a frame we can read */ }
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
