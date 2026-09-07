import { page } from './page.js';

/**
 * The QuinoaCommand envelope carries a commandSequence, and the server accepts an envelope only when
 * its number is exactly the frontier - the last sequence the server executed - plus one. A stale or
 * duplicate number is dropped without a result; a gap comes back as `invalid_sequence`. (A missing
 * number is rejected outright as `invalid_message`, which is how buying, preserving, potting and
 * harvesting once stopped working while the game's own sender carried on fine.)
 *
 * The game seeds a module-private counter from the Welcome frame and takes one number per command:
 *
 *     var K = 1;  function seed(e) { K = e + 1 }   // seed(welcome.executedCommandSequence)
 *     function next() { let n = K; return K++, n }
 *
 * We seed the same way, and while we are the only script sending on this socket, stamping every
 * outgoing command from our own counter keeps the run contiguous: the game's counter cannot see the
 * numbers we take, so we take the choice away from it entirely - one chooser, no collisions.
 *
 * What a single blind counter cannot survive is a SECOND script doing the same thing on the same
 * socket. AriesMod, QPM and others all wrap the send path and renumber from their own counters; two
 * blind counters drift apart the instant either one drops or injects a command the other cannot see,
 * and a single gap looks like a frozen connection (the symptom users hit with two mods loaded). So
 * we stop trusting our counter on its own and anchor it to the server's frontier - the
 * `executedCommandSequence` the room connection publishes. Before stamping we jump forward if the
 * server has already run past our next number (another script advanced the stream); when the server
 * rejects a command as `invalid_sequence` we resync down to the frontier. Either way the next number
 * we hand out is frontier+1 again, the one the server will accept, so a desync costs at most the one
 * command that tripped it instead of every command after it.
 *
 * A command that gets blocked before it is stamped still takes no number, which keeps our own run
 * contiguous in the common (single-script) case.
 */
let sequence = -1;
let frontier = -1;

/**
 * Counters for the sequencer, exposed on the page (see getSequencerDiagnostics) so a desync can be
 * inspected live. The two `frontierFrom*` tallies answer the practical question of which source is
 * actually feeding us the frontier - in particular whether the room-connection property still
 * exists on this build or whether we are running on the frame scan alone.
 */
const diagnostics = {
  welcomeSeeds: 0,
  frontierFromProperty: 0,
  frontierFromFrame: 0,
  propertyPresent: false as boolean,
  propertyProbed: false as boolean,
  forwardJumps: 0,
  heals: 0,
  lastForwardJump: null as { from: number; to: number } | null,
  lastHeal: null as { from: number; to: number } | null,
};

/** A snapshot for the console: page.__gardenCompanionSequencer(). */
export function getSequencerDiagnostics(): Record<string, unknown> {
  return { sequence, frontier, ...diagnostics, lastForwardJump: diagnostics.lastForwardJump, lastHeal: diagnostics.lastHeal };
}

/** Welcome reports what the server has executed; the next command is that plus one. */
export function seedCommandSequence(executedCommandSequence: unknown): void {
  const executed = Number(executedCommandSequence);
  if (!Number.isFinite(executed)) return;
  sequence = executed + 1;
  frontier = executed;
  diagnostics.welcomeSeeds += 1;
  console.info('[Garden Companion] Command sequencer seeded from Welcome.', { executed, sequence, frontier });
}

/**
 * Advance our idea of the server's frontier when we see a higher one. The frontier only ever climbs
 * within a session (a reconnect re-seeds it through Welcome), so a plain max is all it takes.
 */
function noteFrontier(value: unknown, source: 'property' | 'frame'): void {
  const executed = Number(value);
  if (!Number.isFinite(executed)) return;
  if (source === 'property') diagnostics.frontierFromProperty += 1;
  else diagnostics.frontierFromFrame += 1;
  if (executed > frontier) frontier = executed;
}

/**
 * The server's confirmed command frontier, read straight off the room connection - the same
 * `lastDistributedRoomPublication.executedCommandSequence` the game seeds its own counter from. It is
 * a plain property, so reading it needs no frame parsing and stays cheap enough to consult on every
 * command. Absent (an older or renamed field) leaves whatever the frame scan and Welcome have set.
 *
 * The first time a room connection exists we log whether the property is there at all, so a build
 * where it has been renamed shows up plainly instead of silently falling back to the frame scan.
 */
function readServerFrontier(): void {
  const connection = (page as unknown as {
    MagicCircle_RoomConnection?: { lastDistributedRoomPublication?: { executedCommandSequence?: unknown } };
  }).MagicCircle_RoomConnection;
  if (!connection) return;
  const publication = connection.lastDistributedRoomPublication;
  const raw = publication?.executedCommandSequence;
  if (!diagnostics.propertyProbed) {
    diagnostics.propertyProbed = true;
    diagnostics.propertyPresent = typeof raw === 'number' && Number.isFinite(raw);
    console.info('[Garden Companion] Command frontier property probe.', {
      hasRoomConnection: true,
      hasLastDistributedRoomPublication: !!publication,
      executedCommandSequence: raw,
      present: diagnostics.propertyPresent,
    });
  }
  noteFrontier(raw, 'property');
}

/**
 * Pulls the frontier off any incoming frame that carries one, without parsing it. The room
 * publications are large and frequent, so this reaches for the number with indexOf and a digit walk
 * rather than a regex or JSON.parse over the whole frame. This is the source that does not depend on
 * the room-connection property still being named the same, so healing keeps working even if it is.
 */
function noteFrontierFromFrame(data: string): void {
  const key = '"executedCommandSequence":';
  const at = data.indexOf(key);
  if (at === -1) return;
  let end = at + key.length;
  while (end < data.length) {
    const code = data.charCodeAt(end);
    if (code < 48 || code > 57) break;
    end += 1;
  }
  if (end > at + key.length) noteFrontier(data.slice(at + key.length, end), 'frame');
}

/**
 * Hands out the next wire number, healing forward first: if the server has already executed past our
 * next number, another sender advanced the stream and we must catch up, or the number we choose is
 * one the server has run past and would drop.
 */
function allocateSequence(): number {
  readServerFrontier();
  if (frontier + 1 > sequence) {
    diagnostics.forwardJumps += 1;
    diagnostics.lastForwardJump = { from: sequence, to: frontier + 1 };
    console.info('[Garden Companion] Command sequence jumped forward to the server frontier.', diagnostics.lastForwardJump);
    sequence = frontier + 1;
  }
  return sequence++;
}

/**
 * Resync after the server rejects a command as `invalid_sequence`: our counter and the wire have
 * drifted, almost always because another script on this socket numbered a command we could not see.
 * Dropping back to frontier+1 makes the very next command valid again and lifts the freeze.
 */
function healToFrontier(): void {
  readServerFrontier();
  if (frontier < 0) return;
  diagnostics.heals += 1;
  diagnostics.lastHeal = { from: sequence, to: frontier + 1 };
  console.warn('[Garden Companion] invalid_sequence - resyncing command counter to the server frontier.', {
    ...diagnostics.lastHeal,
    frontierFromProperty: diagnostics.frontierFromProperty,
    frontierFromFrame: diagnostics.frontierFromFrame,
    propertyPresent: diagnostics.propertyPresent,
  });
  sequence = frontier + 1;
}

/**
 * A QuinoaCommandResult is tiny; a room publication is not. Scanning the big frames for substrings
 * they cannot contain is what turned this hook into a per-frame cost heavy enough to be felt as jank,
 * so anything past this length is skipped on an O(1) length check before any scan runs.
 */
const RESULT_FRAME_MAX = 20_000;

/**
 * Watches incoming frames for the invalid_sequence rejection that says our numbering has desynced,
 * and - only on builds where the room-connection frontier property is missing - for the frontier
 * itself. The frontier is normally read straight off that property at allocate/heal time, so on the
 * hot path here the large room publications cost nothing but a length check: the substring scans and
 * JSON.parse run only on the small frames a result can actually be.
 */
export function noteServerFrame(data: unknown): void {
  if (sequence < 0 || typeof data !== 'string') return;
  // Probe the property once a connection exists; after that it is read at allocate/heal time, so the
  // per-frame frontier scan is only needed as a fallback on a build where the property is absent.
  if (!diagnostics.propertyProbed) readServerFrontier();
  if (diagnostics.propertyProbed && !diagnostics.propertyPresent) noteFrontierFromFrame(data);
  if (data.length > RESULT_FRAME_MAX || !data.includes('QuinoaCommandResult') || !data.includes('invalid_sequence')) return;
  try {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame?.type === 'QuinoaCommandResult' && frame.ok === false && frame.code === 'invalid_sequence') healToFrontier();
  } catch { /* not a frame we can read */ }
}

/**
 * Stamps every outgoing command, the game's own included, overwriting the number it chose.
 *
 * Overwriting looks wrong and is the whole point. The game's counter cannot see the numbers we take,
 * so leaving its own frames alone means two counters both handing out numbers - which shows up as
 * one command carrying a number the other counter still thinks is free. Taking the choice away from
 * it entirely leaves one chooser, and the run stays contiguous. The number itself comes from
 * allocateSequence, which keeps it anchored to the server's frontier even when a second mod is
 * renumbering alongside us.
 */
export function renumberOutgoingCommand(data: unknown): unknown {
  if (sequence < 0 || typeof data !== 'string' || !data.includes('QuinoaCommand')) return data;
  try {
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame?.type !== 'QuinoaCommand') return data;
    frame.commandSequence = allocateSequence();
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
