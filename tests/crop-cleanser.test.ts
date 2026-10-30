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
  const count = () => document.querySelector('#gc-crop-cleanser > header [data-cleanser-count]')!.textContent;
  assert.equal(count(), '3 owned');
  row().click();
  await flushMicrotasks();
  assert.deepEqual(socket.commands(), [{ type: 'CropCleanser', tileObjectIdx: 12, growSlotIdx: 0 }]);
  assert.equal(row().textContent, 'Cleansed');
  assert.equal(count(), '2 owned');
  assert.equal(row().disabled, true);
  row().click();
  await flushMicrotasks();
  assert.equal(socket.commands().length, 1);
  setGarden({ 12: carrot([]) }, 2);
  await settle();
});

function setGarden(tileObjects: Record<number, unknown>, loose = 3, shack = 0, extraItems: unknown[] = []): void {
  state.slot = { data: {
    inventory: {
      items: [...extraItems, ...(loose ? [{ itemType: 'Tool', toolId: 'CropCleanser', quantity: loose }] : [])],
      storages: shack ? [{ decorId: 'ToolShack', items: [{ itemType: 'Tool', toolId: 'CropCleanser', quantity: shack }] }] : [],
    },
    garden: { tileObjects },
  } } as unknown as PlayerSlot;
}

/** Long enough for the helper's 100ms polls to see a state change. */
function settle(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 150));
}

function carrot(mutations: string[], preserved = false): unknown {
  return { objectType: 'plant', species: 'Carrot', maturedAt: 1, slots: [{ slotId: 0, species: 'Carrot', mutations, startTime: 1, preserved }] };
}

function choice(id: string): HTMLButtonElement {
  return document.querySelector<HTMLButtonElement>(`[data-cleanser-mutation="${id}"]`)!;
}

/** Opens the helper fresh and leaves exactly these mutations selected. */
function openWithSelection(ids: string[]): void {
  initCropCleanserHelper();
  if (document.getElementById('gc-crop-cleanser')?.hidden === false) page.__gardenCompanionToggleCropCleanser!();
  page.__gardenCompanionToggleCropCleanser!();
  document.querySelectorAll<HTMLButtonElement>('[data-cleanser-mutation]').forEach(button => {
    const id = button.dataset.cleanserMutation!;
    if (button.classList.contains('on') !== ids.includes(id)) choice(id).click();
  });
}

function listedRows(): string[] {
  return [...document.querySelectorAll<HTMLButtonElement>('[data-cleanse-row]')].map(button => button.dataset.cleanseRow!).sort();
}

test('crops carrying any selected mutation are listed, and deselecting drops them', () => {
  setGarden({ 1: carrot(['Frozen']), 2: carrot(['Thunderstruck', 'Wet']), 3: carrot(['Wet']), 4: carrot(['Dawnlit'], true), 5: carrot([]) });
  openWithSelection(['Frozen', 'Thunderstruck', 'Dawnlit']);
  assert.ok(choice('Frozen').classList.contains('on'));
  assert.ok(choice('Thunderstruck').classList.contains('on'));
  assert.deepEqual(listedRows(), ['1:0', '2:0']);
  choice('Frozen').click();
  assert.equal(choice('Frozen').classList.contains('on'), false);
  assert.deepEqual(listedRows(), ['2:0']);
});

test('the empty message names every selected mutation', () => {
  setGarden({});
  openWithSelection(['Wet', 'Frozen']);
  assert.match(document.querySelector('.gc-cleanser-empty')!.textContent!, /Wet or Frozen/);
  openWithSelection([]);
  assert.match(document.querySelector('.gc-cleanser-empty')!.textContent!, /at least one mutation/);
});

test('changing the selection cannot re-enable a crop cleansed moments ago', async () => {
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  setGarden({ 7: carrot(['Wet', 'Frozen']) });
  openWithSelection(['Wet']);
  const row = () => document.querySelector<HTMLButtonElement>('[data-cleanse-row="7:0"]')!;
  row().click();
  await flushMicrotasks();
  assert.equal(socket.commands().length, 1);
  choice('Frozen').click();
  assert.equal(row().textContent, 'Cleansed');
  assert.equal(row().disabled, true);
  // The same slot coming back with different mutations is a new target, not the one cleansed.
  setGarden({ 7: carrot(['Frozen']) }, 2);
  choice('Wet').click();
  assert.equal(row().textContent, 'Cleanse');
  assert.equal(row().disabled, false);
  await settle();
});

test('a crop regaining the same mutations can be cleansed again once the first has settled', async () => {
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  setGarden({ 8: carrot(['Wet']) });
  openWithSelection(['Wet']);
  const row = () => document.querySelector<HTMLButtonElement>('[data-cleanse-row="8:0"]')!;
  row().click();
  await flushMicrotasks();
  setGarden({ 8: carrot([]) }, 2);
  await settle();
  assert.equal(row().textContent, 'Cleansed', 'the list is not rebuilt until the selection changes');
  setGarden({ 8: carrot(['Wet']) }, 2);
  choice('Frozen').click();
  assert.equal(row().textContent, 'Cleanse');
  assert.equal(row().disabled, false);
});

test('reopening during a Tool Shack fetch keeps the row locked through the send', async () => {
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  setGarden({ 9: carrot(['Wet']) }, 0, 2);
  openWithSelection(['Wet']);
  const row = () => document.querySelector<HTMLButtonElement>('[data-cleanse-row="9:0"]')!;
  row().click();
  await flushMicrotasks();
  assert.equal(socket.commands().length, 1, 'only the fetch so far');
  assert.equal(row().disabled, true);
  page.__gardenCompanionToggleCropCleanser!();
  page.__gardenCompanionToggleCropCleanser!();
  assert.equal(row().disabled, true, 'still locked after reopening');
  setGarden({ 9: carrot(['Wet']) }, 1, 1);
  await settle();
  assert.deepEqual(socket.commands()[1], { type: 'CropCleanser', tileObjectIdx: 9, growSlotIdx: 0 });
  assert.equal(row().textContent, 'Cleansed');
  assert.equal(row().disabled, true);
  setGarden({ 9: carrot([]) }, 0, 1);
  await settle();
});

test('a fetch that cannot happen hands the row back', async () => {
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  const full = Array.from({ length: 100 }, () => ({ itemType: 'Produce' }));
  setGarden({ 10: carrot(['Wet']) }, 0, 1, full);
  openWithSelection(['Wet']);
  const row = () => document.querySelector<HTMLButtonElement>('[data-cleanse-row="10:0"]')!;
  row().click();
  await flushMicrotasks();
  assert.equal(socket.commands().length, 0);
  assert.equal(row().textContent, 'Cleanse');
  assert.equal(row().disabled, false);
});

test('a second quick press waits for the first to echo before fetching its cleanser', async () => {
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  setGarden({ 20: carrot(['Wet']), 21: carrot(['Wet']) }, 1, 1);
  openWithSelection(['Wet']);
  document.querySelector<HTMLButtonElement>('[data-cleanse-row="20:0"]')!.click();
  document.querySelector<HTMLButtonElement>('[data-cleanse-row="21:0"]')!.click();
  await flushMicrotasks();
  assert.deepEqual(socket.commands(), [{ type: 'CropCleanser', tileObjectIdx: 20, growSlotIdx: 0 }]);
  setGarden({ 20: carrot([]), 21: carrot(['Wet']) }, 0, 1);
  await settle();
  assert.equal(socket.commands()[1]?.type, 'MoveItem');
  assert.equal(socket.commands().length, 2);
  setGarden({ 20: carrot([]), 21: carrot(['Wet']) }, 1, 0);
  await settle();
  assert.deepEqual(socket.commands()[2], { type: 'CropCleanser', tileObjectIdx: 21, growSlotIdx: 0 });
  setGarden({ 20: carrot([]), 21: carrot([]) }, 0, 0);
  await settle();
});

test('a crop preserved while its press waits is not cleansed', async () => {
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  setGarden({ 30: carrot(['Wet']) }, 0, 1);
  openWithSelection(['Wet']);
  const row = () => document.querySelector<HTMLButtonElement>('[data-cleanse-row="30:0"]')!;
  row().click();
  await flushMicrotasks();
  setGarden({ 30: carrot(['Wet'], true) }, 1, 0);
  await settle();
  assert.equal(socket.commands().filter(command => command.type === 'CropCleanser').length, 0);
  assert.equal(row().textContent, 'Changed');
  assert.equal(row().disabled, true);
});

test('a Changed row stays locked through a redraw', () => {
  setGarden({ 31: carrot(['Wet']) });
  openWithSelection(['Wet']);
  const row = () => document.querySelector<HTMLButtonElement>('[data-cleanse-row="31:0"]')!;
  setGarden({ 31: carrot(['Wet', 'Frozen']) });
  row().click();
  assert.equal(row().textContent, 'Changed');
  page.__gardenCompanionPetSpritesReady!();
  assert.equal(row().textContent, 'Changed');
  assert.equal(row().disabled, true);
});

test('presses queued during a fetch cannot promise more cleansers than are owned', async () => {
  const socket = new FakeSocket();
  noteGameSocket(socket as unknown as WebSocket);
  const garden = { 40: carrot(['Wet']), 41: carrot(['Wet']), 42: carrot(['Wet']) };
  setGarden(garden, 0, 2);
  openWithSelection(['Wet']);
  const row = (tile: number) => document.querySelector<HTMLButtonElement>(`[data-cleanse-row="${tile}:0"]`)!;
  row(40).click();
  row(41).click();
  assert.equal(row(42).disabled, true);
  assert.equal(row(42).textContent, 'Cleanse');
  await flushMicrotasks();
  setGarden(garden, 1, 1);
  await settle();
  setGarden(garden, 0, 1);
  await settle();
  setGarden(garden, 1, 0);
  await settle();
  assert.deepEqual(socket.commands().filter(command => command.type === 'CropCleanser').map(command => command.tileObjectIdx), [40, 41]);
  setGarden(garden, 0, 0);
  await settle();
});
