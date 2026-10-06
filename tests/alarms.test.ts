import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyAlarmLayout, showAlarmBanner, stopAlarm, updateAlarmDetail } from '../src/alarms.js';
import { config } from '../src/config.js';

const banner = () => document.getElementById('gc-alarm');

const titles = () => [...document.querySelectorAll('#gc-alarm .gc-alarm-card strong')].map(element => element.textContent);
const queueLine = () => [...document.querySelectorAll<HTMLElement>('#gc-alarm [data-alarm-queue]')].find(element => element.style.visibility === 'visible')!;

test('stacked by default: one card shows with the rest queued behind it', () => {
  showAlarmBanner({ owner: 'a', label: 'A', title: 'First' });
  showAlarmBanner({ owner: 'b', label: 'B', title: 'Second' });
  showAlarmBanner({ owner: 'c', label: 'C', title: 'Third' });
  assert.deepEqual(titles(), ['First']);
  assert.match(queueLine().textContent!, /2 more alarms queued/);
  stopAlarm('b');
  assert.match(queueLine().textContent!, /1 more alarm queued/);
  stopAlarm('a');
  assert.deepEqual(titles(), ['Third'], 'stopping the one showing brings the next forward');
  stopAlarm();
  assert.equal(banner(), null);
});

test('the list layout reflows alarms already up when switched on and off', () => {
  for (const name of ['a', 'b', 'c']) showAlarmBanner({ owner: name, label: name, title: name });
  config.alarmList = true;
  applyAlarmLayout();
  assert.deepEqual(titles(), ['a', 'b', 'c']);
  config.alarmList = false;
  applyAlarmLayout();
  assert.deepEqual(titles(), ['a']);
  assert.match(queueLine().textContent!, /2 more alarms queued/);
  stopAlarm();
});

test('alarms list one below the other, queue past the limit, and stop by owner', () => {
  config.alarmList = true;
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) showAlarmBanner({ owner: name, label: name.toUpperCase(), title: name });
  assert.deepEqual(titles(), ['a', 'b', 'c', 'd']);
  assert.match(queueLine().textContent!, /2 more alarms queued/);
  stopAlarm('e');
  assert.match(queueLine().textContent!, /1 more alarm queued/);
  stopAlarm('a');
  assert.deepEqual(titles(), ['b', 'c', 'd', 'f'], 'the rest move up and the queue fills the gap');
  updateAlarmDetail('c', '3 remaining');
  stopAlarm();
  config.alarmList = false;
  assert.equal(banner(), null);
});

test('Stop dismisses only its own card', () => {
  showAlarmBanner({ owner: 'x', label: 'X', title: 'One' });
  showAlarmBanner({ owner: 'y', label: 'Y', title: 'Two' });
  config.alarmList = true;
  applyAlarmLayout();
  assert.deepEqual(titles(), ['One', 'Two']);
  banner()!.querySelector<HTMLButtonElement>('[data-stop]')!.click();
  assert.deepEqual(titles(), ['Two']);
  stopAlarm();
  config.alarmList = false;
});

test('an action that throws puts its button back and leaves the alarm up', async () => {
  showAlarmBanner({
    owner: 'shop:seed:Carrot', label: 'SHOP', title: 'Carrot', actionLabel: 'Buy all',
    onAction: async button => { button.disabled = true; button.textContent = 'Buying...'; throw new Error('The game connection is not ready.'); },
  });
  const button = banner()!.querySelector<HTMLButtonElement>('[data-buy]')!;
  button.click();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'Buy all');
  assert.ok(banner(), 'the alarm is still showing');
  assert.equal(document.getElementById('gc-toast')?.textContent, 'The game connection is not ready.');
  stopAlarm();
});
