import { FakeSocket } from './setup.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { config } from '../src/config.js';
import { processAutoStore } from '../src/features/auto-store.js';
import { noteGameSocket } from '../src/game-connection.js';
import { holdTool } from '../src/pets.js';
import { state } from '../src/state.js';
import type { PlayerSlot } from '../src/types.js';

mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
const socket = new FakeSocket();
noteGameSocket(socket as unknown as WebSocket);

function inventory(items: Array<Record<string, unknown>>, storages: Array<Record<string, unknown>>): void {
  state.slot = { data: { inventory: { items, storages } } } as unknown as PlayerSlot;
}
const stores = () => socket.commands().filter(command => command.type === 'PutItemInStorage');
function run(): void {
  processAutoStore();
  mock.timers.tick(1000);
  for (let index = 0; index < 10; index++) mock.timers.tick(200);
}

test('off by default, so nothing moves', () => {
  inventory([{ itemType: 'Seed', species: 'Carrot', quantity: 3 }], [{ decorId: 'SeedSilo', items: [{ itemType: 'Seed', species: 'Carrot' }] }]);
  run();
  assert.equal(stores().length, 0);
});

test('only tops up a stack the storage already holds, one move at a time', () => {
  config.autoStoreSeeds = true;
  inventory(
    [{ itemType: 'Seed', species: 'Carrot', quantity: 3 }, { itemType: 'Seed', species: 'Beet', quantity: 1 }, { itemType: 'Seed', species: 'Apple', quantity: 1 }],
    [{ decorId: 'SeedSilo', items: [{ itemType: 'Seed', species: 'Carrot' }, { itemType: 'Seed', species: 'Apple' }] }],
  );
  processAutoStore();
  mock.timers.tick(1000);
  assert.equal(stores().length, 1, 'the first move leaves alone');
  mock.timers.tick(200);
  assert.deepEqual(stores().map(command => command.itemId).sort(), ['Apple', 'Carrot']);
});

test('an unchanged inventory is not sent again', () => {
  socket.sent.length = 0;
  run();
  mock.timers.tick(6000);
  run();
  assert.equal(stores().length, 0);
});

test('a tool in use, or a running crystal, stays out', () => {
  socket.sent.length = 0;
  config.autoStoreTools = true;
  const release = holdTool('PlanterPot');
  inventory(
    [{ itemType: 'Tool', toolId: 'PlanterPot', quantity: 2 }, { itemType: 'Tool', toolId: 'StrengthShard', quantity: 1, remainingActiveSeconds: 30 }, { itemType: 'Tool', toolId: 'WateringCan', quantity: 1 }],
    [{ decorId: 'ToolShack', items: [{ itemType: 'Tool', toolId: 'PlanterPot' }, { itemType: 'Tool', toolId: 'StrengthShard' }, { itemType: 'Tool', toolId: 'WateringCan' }] }],
  );
  run();
  assert.deepEqual(stores().map(command => command.itemId), ['WateringCan']);
  release();
  config.autoStoreTools = false;
  config.autoStoreSeeds = false;
});

test('a pause holds a kind back until every pause on it is released', async () => {
  const { pauseAutoStore } = await import('../src/features/auto-store.js');
  socket.sent.length = 0;
  config.autoStoreSeeds = true;
  const first = pauseAutoStore('Seed');
  const second = pauseAutoStore('Seed', 'Tool');
  inventory([{ itemType: 'Seed', species: 'Pear', quantity: 1 }], [{ decorId: 'SeedSilo', items: [{ itemType: 'Seed', species: 'Pear' }] }]);
  run();
  first();
  first();
  run();
  assert.equal(stores().length, 0, 'still paused while the second pause holds');
  second();
  inventory([{ itemType: 'Seed', species: 'Pear', quantity: 2 }], [{ decorId: 'SeedSilo', items: [{ itemType: 'Seed', species: 'Pear' }] }]);
  run();
  assert.deepEqual(stores().map(command => command.itemId), ['Pear']);
  assert.equal(config.autoStoreSeeds, true, 'the saved setting is never touched');
  config.autoStoreSeeds = false;
});
