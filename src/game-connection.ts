import { page } from './page.js';

/** Sends a message on the game's own room connection, so the server sees it as the player acting. */
export function send(command: Record<string, unknown>): void {
  const connection = page.MagicCircle_RoomConnection;
  if (!connection || typeof connection.sendMessage !== 'function') throw new Error('The game connection is not ready.');
  connection.sendMessage({ scopePath: ['Room', 'Quinoa'], ...command });
}

export function sendQuinoaCommand(command: Record<string, unknown>): string {
  const requestId = crypto.randomUUID();
  send({ type: 'QuinoaCommand', requestId, command });
  return requestId;
}
