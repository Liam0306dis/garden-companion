import { FakeSocket } from './setup.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { config } from '../src/config.js';
import { noteRoomSocketClosed, noteRoomSocketOpened } from '../src/connection-state.js';
import { noteGameSocket } from '../src/game-connection.js';
import { processShops, toggleShopAlert } from '../src/features/shop-alarms.js';
import { stopAlarm } from '../src/alarms.js';
import { state } from '../src/state.js';
import type { GameState, PlayerSlot } from '../src/types.js';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const socket = new FakeSocket();
noteGameSocket(socket as unknown as WebSocket);
noteRoomSocketOpened();

const alarmTitle = () => document.querySelector('#gc-alarm strong')?.textContent ?? null;

function world(stock: Record<string, number>, purchases: Record<string, number> = {}, secondsUntilRestock = 300): void {
  state.playerId = 'me';
  state.slot = { data: { inventory: { items: [] }, shopPurchases: { seed: { purchases } } } } as unknown as PlayerSlot;
  state.game = {
    shops: { seed: { secondsUntilRestock, inventory: Object.entries(stock).map(([species, initialStock]) => ({ species, initialStock })) } },
  } as unknown as GameState;
}

test('a half-loaded world is never baselined', () => {
  config.shopAlerts = { 'seed:Carrot': true };
  state.playerId = null;
  state.slot = null;
  state.game = { shops: { seed: { inventory: [{ species: 'Carrot', initialStock: 5 }] } } } as unknown as GameState;
  processShops();
  mock.timers.tick(1000);
  assert.equal(state.initializedShops, false);
  assert.equal(alarmTitle(), null);
});

test('the first settled snapshot alarms for watched stock', () => {
  world({ Carrot: 5, Beet: 3 });
  processShops();
  mock.timers.tick(500);
  assert.equal(state.initializedShops, true);
  assert.equal(alarmTitle(), 'Carrot is available');
  stopAlarm();
});

test('stock that stays in place does not alarm again, a restock does', () => {
  world({ Carrot: 5, Beet: 3 }, {}, 200);
  processShops();
  assert.equal(alarmTitle(), null);
  world({ Carrot: 5, Beet: 3 }, {}, 290);
  processShops();
  assert.equal(alarmTitle(), 'Carrot is available', 'the restock clock jumping back up is a restock');
});

test('selling out stops the alarm', () => {
  world({ Carrot: 5, Beet: 3 }, { Carrot: 5 }, 280);
  processShops();
  assert.equal(alarmTitle(), null);
});

test('a reconnect re-adopts the shelf silently', () => {
  noteRoomSocketClosed();
  noteRoomSocketOpened();
  world({ Carrot: 5, Beet: 3 }, {}, 9000);
  processShops();
  mock.timers.tick(2500);
  assert.equal(alarmTitle(), null, 'stock already there before the drop is not news');
  world({ Carrot: 5, Beet: 3 }, {}, 8990);
  processShops();
  assert.equal(alarmTitle(), null);
});

test('turning an alert on while in stock fires straight away, and Buy all buys every remaining one', async () => {
  world({ Beet: 3 }, { Beet: 1 }, 8980);
  toggleShopAlert('seed:Beet', true);
  assert.equal(alarmTitle(), 'Beet is available');
  socket.sent.length = 0;
  document.querySelector<HTMLButtonElement>('#gc-alarm [data-buy]')!.click();
  // The purchases leave 180ms apart; each tick lets the loop's await resume.
  for (let index = 0; index < 5; index++) { await Promise.resolve(); mock.timers.tick(200); await Promise.resolve(); }
  const purchases = socket.commands().filter(command => command.type === 'PurchaseShopItem');
  assert.equal(purchases.length, 2);
  assert.deepEqual(purchases[0], { type: 'PurchaseShopItem', shop: 'seed', item: { itemType: 'Seed', species: 'Beet' } });
  assert.equal(alarmTitle(), null, 'the alarm stops once the purchases are sent');
});

test('turning an alert off removes it from the saved config', () => {
  toggleShopAlert('seed:Beet', false);
  assert.equal('seed:Beet' in config.shopAlerts, false);
});

test('a tool already held at its cap does not alarm', () => {
  stopAlarm();
  state.playerId = 'me';
  state.slot = { data: { inventory: { items: [{ itemType: 'Tool', toolId: 'WateringCan', quantity: 99 }] }, shopPurchases: {} } } as unknown as PlayerSlot;
  state.game = { shops: { tool: { secondsUntilRestock: 100, inventory: [{ toolId: 'WateringCan', initialStock: 5 }] } } } as unknown as GameState;
  toggleShopAlert('tool:WateringCan', true);
  assert.equal(alarmTitle(), null, 'at 99 the shop will not sell another');
  (state.slot!.data!.inventory!.items as unknown as Array<{ quantity: number }>)[0].quantity = 98;
  toggleShopAlert('tool:WateringCan', true);
  assert.equal(alarmTitle(), 'Watering Can is available');
  stopAlarm();
  toggleShopAlert('tool:WateringCan', false);
});

test('a capped potion in the Snow shop does not alarm either', () => {
  stopAlarm();
  state.playerId = 'me';
  state.slot = { data: { inventory: { items: [{ itemType: 'Tool', toolId: 'FrozenPotion', quantity: 99 }] }, shopPurchases: {} } } as unknown as PlayerSlot;
  state.game = { shops: { snow: { secondsUntilRestock: 100, inventory: [{ itemType: 'Tool', toolId: 'FrozenPotion', initialStock: 2 }] } } } as unknown as GameState;
  toggleShopAlert('snow:FrozenPotion', true);
  assert.equal(alarmTitle(), null);
  toggleShopAlert('snow:FrozenPotion', false);
});

function toolWorld(held: number, stock = 5): void {
  state.playerId = 'me';
  state.slot = { data: { inventory: { items: [{ itemType: 'Tool', toolId: 'WateringCan', quantity: held }] }, shopPurchases: {} } } as unknown as PlayerSlot;
  state.game = { shops: { tool: { secondsUntilRestock: 100, inventory: [{ toolId: 'WateringCan', initialStock: stock }] } } } as unknown as GameState;
}

test('Buy all only buys up to the cap', async () => {
  stopAlarm();
  toolWorld(97);
  toggleShopAlert('tool:WateringCan', true);
  socket.sent.length = 0;
  document.querySelector<HTMLButtonElement>('#gc-alarm [data-buy]')!.click();
  for (let index = 0; index < 5; index++) { await Promise.resolve(); mock.timers.tick(200); await Promise.resolve(); }
  assert.equal(socket.commands().filter(command => command.type === 'PurchaseShopItem').length, 2);
  toggleShopAlert('tool:WateringCan', false);
});

test('an alarm already up comes down once the item reaches its cap', () => {
  stopAlarm();
  toolWorld(98);
  toggleShopAlert('tool:WateringCan', true);
  assert.equal(alarmTitle(), 'Watering Can is available');
  toolWorld(99);
  processShops();
  assert.equal(alarmTitle(), null);
  toggleShopAlert('tool:WateringCan', false);
});

test('tools in the Tool Shack count toward the cap', () => {
  stopAlarm();
  toolWorld(40);
  (state.slot!.data!.inventory as unknown as { storages: unknown[] }).storages = [{ decorId: 'ToolShack', items: [{ itemType: 'Tool', toolId: 'WateringCan', quantity: 59 }] }];
  toggleShopAlert('tool:WateringCan', true);
  try {
    assert.equal(alarmTitle(), null, '40 held plus 59 in the shack is 99');
  } finally {
    stopAlarm();
    toggleShopAlert('tool:WateringCan', false);
  }
});
