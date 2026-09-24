import { FakeSocket } from './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gameConnectionReady, getSequencerDiagnostics, noteGameSocket, noteOutgoingCommand, noteServerFrame, onOutgoingCommand,
  parseOutgoingFrame, renumberOutgoingCommand, seedCommandSequence, sendBareCommand, sendQuinoaCommand,
} from '../src/game-connection.js';

const command = (type: string) => ({ scopePath: ['Room', 'Quinoa'], type: 'QuinoaCommand', requestId: 'r', command: { type } });

test('nothing is renumbered before the Welcome frame seeds the counter', () => {
  const frame = command('HarvestCrop') as Record<string, unknown>;
  assert.equal(renumberOutgoingCommand(frame), false);
  assert.equal(frame.commandSequence, undefined);
});

test('the counter is seeded from Welcome and every wrapped command takes the next number', () => {
  seedCommandSequence(41);
  const first = command('HarvestCrop') as Record<string, unknown>;
  const second = command('FeedPet') as Record<string, unknown>;
  assert.equal(renumberOutgoingCommand(first), true);
  assert.equal(renumberOutgoingCommand(second), true);
  assert.equal(first.commandSequence, 42);
  assert.equal(second.commandSequence, 43);
});

test('bare frames are never numbered', () => {
  const bare = { scopePath: ['Room', 'Quinoa'], type: 'PlayerPosition', position: { x: 1, y: 1 } };
  assert.equal(renumberOutgoingCommand(bare), false);
  assert.equal('commandSequence' in bare, false);
});

test('a frontier that ran ahead (another mod sending) is jumped to before stamping', () => {
  // A small frame carrying the frontier, as the room publication would.
  noteServerFrame(JSON.stringify({ type: 'PartialState', executedCommandSequence: 100 }));
  const frame = command('Preserve') as Record<string, unknown>;
  renumberOutgoingCommand(frame);
  assert.equal(frame.commandSequence, 101);
  assert.ok(getSequencerDiagnostics().forwardJumps as number >= 1);
});

test('an invalid_sequence rejection resyncs to the frontier', () => {
  for (let index = 0; index < 5; index++) renumberOutgoingCommand(command('FeedPet'));
  noteServerFrame(JSON.stringify({ type: 'QuinoaCommandResult', ok: false, code: 'invalid_sequence', requestId: 'x' }));
  const frame = command('FeedPet') as Record<string, unknown>;
  renumberOutgoingCommand(frame);
  assert.equal(frame.commandSequence, 101);
  assert.equal(getSequencerDiagnostics().heals, 1);
});

test('only frames that can be commands are parsed', () => {
  assert.equal(parseOutgoingFrame(JSON.stringify({ type: 'PlayerPosition', position: {} })), null);
  assert.equal(parseOutgoingFrame('not json QuinoaCommand'), null);
  assert.equal(parseOutgoingFrame(new ArrayBuffer(2)), null);
  assert.deepEqual(parseOutgoingFrame(JSON.stringify(command('HarvestCrop')))?.command, { type: 'HarvestCrop' });
});

test('outgoing command listeners see the unwrapped command', () => {
  const seen: string[] = [];
  onOutgoingCommand(item => seen.push(String(item.type)));
  noteOutgoingCommand(command('PotPlant'));
  noteOutgoingCommand({ scopePath: ['Room', 'Quinoa'], type: 'PlantGardenPlant' });
  assert.deepEqual(seen, ['PotPlant', 'PlantGardenPlant']);
});

test('commands go out on the room socket, and refuse to send without one', () => {
  assert.equal(gameConnectionReady(), false);
  assert.throws(() => sendQuinoaCommand({ type: 'FeedPet' }), /not ready/);
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  assert.equal(gameConnectionReady(), true);
  const requestId = sendQuinoaCommand({ type: 'FeedPet', petItemId: 'p', cropItemId: 'c' });
  sendBareCommand({ type: 'PlayerPosition', position: { x: 2, y: 3 } });
  const [wrapped, bare] = socket.sent.map(data => JSON.parse(data));
  assert.deepEqual(wrapped, { scopePath: ['Room', 'Quinoa'], type: 'QuinoaCommand', requestId, command: { type: 'FeedPet', petItemId: 'p', cropItemId: 'c' } });
  assert.deepEqual(bare, { scopePath: ['Room', 'Quinoa'], type: 'PlayerPosition', position: { x: 2, y: 3 } });
  socket.close();
  assert.equal(gameConnectionReady(), false);
});
