import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showAlarmBanner, stopAlarm, updateAlarmDetail } from '../src/alarms.js';

const banner = () => document.getElementById('gc-alarm');

const titles = () => [...document.querySelectorAll('#gc-alarm .gc-alarm-card strong')].map(element => element.textContent);
const queueLine = () => [...document.querySelectorAll<HTMLElement>('#gc-alarm [data-alarm-queue]')].find(element => element.style.display !== 'none')!;

test('alarms list one below the other, queue past the limit, and stop by owner', () => {
  for (const name of ['a', 'b', 'c', 'd', 'e', 'f']) showAlarmBanner({ owner: name, label: name.toUpperCase(), title: name });
  assert.deepEqual(titles(), ['a', 'b', 'c', 'd']);
  assert.match(queueLine().textContent!, /2 more alarms queued/);
  stopAlarm('e');
  assert.match(queueLine().textContent!, /1 more alarm queued/);
  stopAlarm('a');
  assert.deepEqual(titles(), ['b', 'c', 'd', 'f'], 'the rest move up and the queue fills the gap');
  updateAlarmDetail('c', '3 remaining');
  stopAlarm();
  assert.equal(banner(), null);
});

test('Stop dismisses only its own card', () => {
  showAlarmBanner({ owner: 'x', label: 'X', title: 'One' });
  showAlarmBanner({ owner: 'y', label: 'Y', title: 'Two' });
  banner()!.querySelector<HTMLButtonElement>('[data-stop]')!.click();
  assert.deepEqual(titles(), ['Two']);
  stopAlarm();
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
