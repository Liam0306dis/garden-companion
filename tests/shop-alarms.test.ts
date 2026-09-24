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
