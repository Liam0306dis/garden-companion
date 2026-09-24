import './setup.js';
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { retryUntil } from '../src/retry.js';
import { notifyStateChange, onStateChange, state, trimAbilityLogs } from '../src/state.js';
import { createTicker } from '../src/ticker.js';
import { nextWeather, forecastStatus } from '../src/weather-forecast.js';
import { comboFromEvent } from '../src/key-combo.js';

test('state notifications are deferred and coalesced per reason', async () => {
  const seen: string[] = [];
  onStateChange(reason => seen.push(reason));
  notifyStateChange('patch');
  notifyStateChange('patch');
  notifyStateChange('currentAction');
  assert.deepEqual(seen, [], 'nothing runs inside the caller');
  await Promise.resolve();
  assert.deepEqual(seen, ['patch', 'currentAction']);
});

test('a ticker runs only between start and stop', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  let runs = 0;
  const ticker = createTicker(() => { runs++; }, 100);
  ticker.sync(true);
  ticker.sync(true);
  assert.equal(runs, 1, 'starting runs once straight away, and only once');
  mock.timers.tick(300);
  assert.equal(runs, 4);
  ticker.sync(false);
  mock.timers.tick(1000);
  assert.equal(runs, 4);
  assert.equal(ticker.running(), false);
  mock.timers.reset();
});

test('retrying never gives up, it only slows down', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  // The mock clock does not run a timer scheduled during the same tick, so time is stepped.
  const advance = (ms: number) => { for (let elapsed = 0; elapsed < ms; elapsed += 500) mock.timers.tick(500); };
  let attempts = 0;
  let ready = false;
  retryUntil(() => { attempts++; return ready; }, 'a test hook');
  advance(120_000);
  const fastAttempts = attempts;
  assert.ok(fastAttempts >= 200, `${fastAttempts} attempts in the first two minutes`);
  advance(600_000);
  assert.ok(attempts > fastAttempts, 'still trying after ten minutes');
  assert.ok(attempts - fastAttempts <= 121, 'and slower than at the start');
  ready = true;
  advance(5_000);
  const settled = attempts;
  advance(60_000);
  assert.equal(attempts, settled, 'stops once it succeeds');
  mock.timers.reset();
});

test('the ability history keeps a set number per ability', () => {
  const rows = [...Array.from({ length: 5 }, (_, at) => ({ at, ability: 'A', pet: 'p', data: {} })), { at: 9, ability: 'B', pet: 'p', data: {} }];
  assert.deepEqual(trimAbilityLogs(rows, 2).map(row => row.ability), ['A', 'A', 'B']);
});

test('the next weather is the soonest one yet to start, lunar events included', () => {
  state.game = null;
  assert.equal(forecastStatus(), 'pending');
  const now = Date.now();
  state.game = { weatherForecast: [
    { weatherId: 'Rain', startsAtMs: now - 1000, endsAtMs: now + 1000 },
    { weatherId: null, groupId: 'Lunar', startsAtMs: now + 60_000, endsAtMs: now + 120_000 },
    { weatherId: 'Frost', startsAtMs: now + 30_000, endsAtMs: now + 90_000 },
  ] } as never;
  assert.deepEqual(nextWeather(), { weatherId: 'Frost', startsAtMs: now + 30_000, endsAtMs: now + 90_000, lunar: false });
  state.game = { weatherForecast: [{ weatherId: null, groupId: 'Lunar', startsAtMs: now + 60_000 }] } as never;
  assert.equal(nextWeather()?.lunar, true);
  state.game = {} as never;
  assert.equal(forecastStatus(), 'unavailable');
  state.game = null;
});

test('key combos carry every modifier, Meta included', () => {
  const combo = (init: KeyboardEventInit) => comboFromEvent(new KeyboardEvent('keydown', init));
  assert.equal(combo({ key: 'k' }), 'K');
  assert.equal(combo({ key: 'k', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+K');
  assert.equal(combo({ key: 'k', metaKey: true }), 'Meta+K');
  assert.equal(combo({ key: 'F2', altKey: true }), 'Alt+F2');
});
