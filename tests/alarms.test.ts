import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { showAlarmBanner, stopAlarm, updateAlarmDetail } from '../src/alarms.js';

const banner = () => document.getElementById('gc-alarm');
const title = () => banner()?.querySelector('strong')?.textContent;

test('alarms queue behind the one showing, and stop by owner', () => {
  showAlarmBanner({ owner: 'a', label: 'A', title: 'First' });
  showAlarmBanner({ owner: 'b', label: 'B', title: 'Second' });
  showAlarmBanner({ owner: 'c', label: 'C', title: 'Third' });
  assert.equal(title(), 'First');
  assert.match(banner()!.querySelector('[data-alarm-queue]')!.textContent!, /2 more alarms queued/);
  stopAlarm('b');
  assert.match(banner()!.querySelector('[data-alarm-queue]')!.textContent!, /1 more alarm queued/);
  stopAlarm('a');
  assert.equal(title(), 'Third', 'stopping the one showing brings the next forward');
  updateAlarmDetail('c', '3 remaining');
  stopAlarm();
  assert.equal(banner(), null);
});

test('Stop dismisses only the alarm showing', () => {
  showAlarmBanner({ owner: 'x', label: 'X', title: 'One' });
  showAlarmBanner({ owner: 'y', label: 'Y', title: 'Two' });
  banner()!.querySelector<HTMLButtonElement>('[data-stop]')!.click();
  assert.equal(title(), 'Two');
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
