
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
 * Stamps every outgoing command, the game's own included, overwriting the number it chose.
 *
 * Overwriting looks wrong and is the whole point. The game's counter cannot see the numbers we take,
 * so leaving its own frames alone means two counters both handing out numbers - which shows up as
 * one command carrying a number the other counter still thinks is free. Taking the choice away from
 * it entirely leaves one chooser, and the run stays contiguous.
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

/** The socket the game is using, kept so our commands can leave by the same door as everything else. */
let activeSocket: WebSocket | null = null;

export function noteGameSocket(socket: WebSocket): void {
  activeSocket = socket;
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

/**
 * Sent down the socket rather than through the game's connection, and with no sequence of its own.
 *
 * Both halves of that matter. sendMessage does not pass the socket send we wrap, so a command sent
 * that way left with no sequence at all and the server refused it; numbering it here instead fixed
 * that but set a second counter running beside the game's, and the two started picking the same
 * numbers. Going out through the socket puts our commands past the single stamp, which is the only
 * arrangement where two senders never collide.
 */
/**
 * Sends one of the commands the game still sends bare, outside the envelope.
 *
 * No sequence: the server only numbers what arrives wrapped, and the stamp above passes anything
 * that is not a QuinoaCommand straight through - so this stays in order behind the wrapped commands
 * without drawing a number that would leave a gap in their run.
 */
export function sendBareCommand(command: Record<string, unknown>): void {
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) throw new Error('The game connection is not ready.');
  activeSocket.send(JSON.stringify({ scopePath: ['Room', 'Quinoa'], ...command }));
}

export function sendQuinoaCommand(command: Record<string, unknown>): string {
  const requestId = crypto.randomUUID();
  const frame = { scopePath: ['Room', 'Quinoa'], type: 'QuinoaCommand', requestId, command };
  if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) throw new Error('The game connection is not ready.');
  activeSocket.send(JSON.stringify(frame));
  return requestId;
}
