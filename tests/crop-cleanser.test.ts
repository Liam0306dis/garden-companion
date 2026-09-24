import { FakeSocket, flushMicrotasks } from './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { initCropCleanserHelper } from '../src/features/crop-cleanser-helper.js';
import { noteGameSocket } from '../src/game-connection.js';
import { page } from '../src/page.js';
import { state } from '../src/state.js';
import type { PlayerSlot } from '../src/types.js';

test('a cleansed row stays disabled, so a second press cannot spend another cleanser', async () => {
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  state.slot = { data: {
    inventory: { items: [{ itemType: 'Tool', toolId: 'CropCleanser', quantity: 3 }], storages: [] },
    garden: { tileObjects: { 12: { objectType: 'plant', species: 'Carrot', maturedAt: 1, slots: [{ slotId: 0, species: 'Carrot', mutations: ['Wet'], startTime: 1 }] } } },
  } } as unknown as PlayerSlot;
  initCropCleanserHelper();
  page.__gardenCompanionToggleCropCleanser!();
  document.querySelector<HTMLButtonElement>('[data-cleanser-mutation="Wet"]')!.click();
  const row = () => document.querySelector<HTMLButtonElement>('[data-cleanse-row="12:0"]')!;
  assert.equal(row().disabled, false);
  row().click();
  await flushMicrotasks();
  assert.deepEqual(socket.commands(), [{ type: 'CropCleanser', tileObjectIdx: 12, growSlotIdx: 0 }]);
  assert.equal(row().textContent, 'Cleansed');
  assert.equal(row().disabled, true);
  row().click();
  await flushMicrotasks();
  assert.equal(socket.commands().length, 1);
});
