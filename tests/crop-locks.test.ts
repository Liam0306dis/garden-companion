import { FakeSocket } from './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { closeCropLocks, openCropLocks } from '../src/features/crop-locks.js';
import { noteGameSocket } from '../src/game-connection.js';
import { state } from '../src/state.js';
import type { PlayerSlot } from '../src/types.js';

const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
const label = (kind: string) => document.querySelector(`[data-lock-run="${kind}"] [data-lock-label]`)!.textContent;
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/**
 * Waits until `done` holds rather than for a fixed time: the sends are paced by timers, and on a busy
 * machine (the whole suite running at once) a fixed wait can end a step or two early.
 */
async function waitFor(done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!done() && Date.now() < until) await wait(20);
}
const press = (kind: string) => document.querySelector(`[data-lock-run="${kind}"]`)!
  .dispatchEvent(new PointerEvent('pointerdown', { button: 0, bubbles: true }));

test('crop locks lists every crop by plant and needs a press and hold to send', async () => {
  state.slot = { data: { garden: { tileObjects: {
    3: { objectType: 'plant', species: 'Carrot', slots: [{ slotId: 0, species: 'Carrot', mutations: [] }] },
    9: { objectType: 'plant', species: 'Carrot', slots: [{ slotId: 0, species: 'Carrot', mutations: [], locked: true }] },
    12: { objectType: 'plant', species: 'Tomato', slots: [{ slotId: 0, species: 'Tomato' }, { slotId: 1, species: 'Tomato' }] },
    20: { objectType: 'decor', decorId: 'Bench' },
  } } } } as unknown as PlayerSlot;
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  openCropLocks();
  assert.equal(document.querySelectorAll('[data-lock-row]').length, 4, 'one row per grow slot, decor ignored');
  assert.equal(document.querySelectorAll('[data-lock-group]').length, 2);

  click('[data-lock-all]');
  assert.equal(label('lock'), 'Lock 3');
  assert.equal(label('unlock'), 'Unlock 1');

  click('[data-lock-run="unlock"]');
  await wait(20);
  assert.equal(socket.sent.length, 0, 'a plain click sends nothing');

  press('unlock');
  // Done once the hold has sent and the run has finished (the button no longer shows progress).
  await waitFor(() => socket.sent.length > 0 && !label('unlock')!.startsWith('Unlocking'));
  const sent = socket.sent.map(data => JSON.parse(data).command);
  assert.deepEqual(sent, [{ type: 'SetGrowSlotLock', slot: 9, growSlotId: 0, locked: false }]);
  assert.equal(label('lock'), 'Lock 3', 'the other ticks are kept');

  click('[data-lock-filter="locked"]');
  assert.equal(document.querySelectorAll('[data-lock-row]').length, 1);
  closeCropLocks();
  assert.equal(document.getElementById('gc-crop-locks'), null);
  socket.close();
});

test('one press locks at most 15 crops', async () => {
  const tiles: Record<number, unknown> = {};
  for (let tile = 0; tile < 20; tile++) tiles[tile] = { objectType: 'plant', species: 'Carrot', slots: [{ slotId: 0, species: 'Carrot' }] };
  state.slot = { data: { garden: { tileObjects: tiles } } } as unknown as PlayerSlot;
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  openCropLocks();
  click('[data-lock-all]');
  assert.equal(label('lock'), 'Lock 15');
  press('lock');
  // Done once the run has finished and the button shows what is left.
  await waitFor(() => socket.sent.length >= 15 && !label('lock')!.startsWith('Locking'));
  assert.equal(socket.sent.length, 15);
  assert.equal(label('lock'), 'Lock 5', 'the rest wait for the next press');
  closeCropLocks();
  socket.close();
});
