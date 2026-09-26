/**
 * The server's clock, as the game itself keeps it. Weather and lunar times are server timestamps,
 * so counting down to them against Date.now() is off by however far this PC's clock has drifted -
 * a few seconds is normal. The game anchors its own clock on the `publishedAtServerMs` every room
 * frame carries: reset on Welcome, and after that only ever moved forward (a frame that arrived late
 * says less about "now" than one that arrived promptly). This mirrors that exactly.
 */

let anchor: { clientMs: number; serverMs: number } | null = null;

export function serverNow(): number {
  const client = Date.now();
  return anchor ? anchor.serverMs + client - anchor.clientMs : client;
}

/**
 * Pulls `publishedAtServerMs` off an incoming frame without parsing it - room frames are large and
 * frequent, so this is an indexOf and a digit walk like the frontier scan in game-connection.ts.
 */
export function noteServerClock(data: unknown): void {
  if (typeof data !== 'string') return;
  const key = '"publishedAtServerMs":';
  const at = data.indexOf(key);
  if (at === -1) return;
  let end = at + key.length;
  while (end < data.length) {
    const code = data.charCodeAt(end);
    if (code < 48 || code > 57) break;
    end += 1;
  }
  const serverMs = Number(data.slice(at + key.length, end));
  if (!Number.isFinite(serverMs) || serverMs <= 0) return;
  const clientMs = Date.now();
  const welcome = data.includes('"selfPlayerId"');
  if (welcome || !anchor || serverMs > anchor.serverMs + clientMs - anchor.clientMs) anchor = { clientMs, serverMs };
}

/** How far the server's clock is ahead of this PC's, for the debug trace. */
export function serverClockOffsetMs(): number | null {
  return anchor ? anchor.serverMs - anchor.clientMs : null;
}
