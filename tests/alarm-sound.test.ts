import { gmStore } from './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { armAlarmAudio, setAlarmSilenced, showAlarmBanner, stopAlarm } from '../src/alarms.js';
import { config } from '../src/config.js';
import { page } from '../src/page.js';

/** Just enough of an AudioContext to count decodes and see a clip start and stop. */
let decodes = 0;
let decodeFails = true;
const started: Array<{ stopped: boolean }> = [];
class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  resume() { return Promise.resolve(); }
  decodeAudioData() {
    decodes++;
    return decodeFails ? Promise.reject(new Error('bad')) : Promise.resolve({ duration: 5 } as AudioBuffer);
  }
  createGain() { return { gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
  createOscillator() { return { type: '', detune: { value: 0 }, frequency: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
  createBufferSource() {
    const node = { buffer: null, playbackRate: { value: 1 }, onended: null, stopped: false, connect() {}, start() { started.push(node); }, stop() { node.stopped = true; } };
    return node;
  }
}
(page as unknown as { AudioContext: unknown }).AudioContext = FakeAudioContext;
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

test('a custom sound that will not decode is tried once, not on every tick or click', { timeout: 5000 }, async () => {
  config.alarmSound = { preset: 'custom', volume: 60, pitch: 0 };
  gmStore.set('gardenCompanion.alarmSound.v1', { name: 'broken.mp3', data: 'AAAA' });
  armAlarmAudio();
  await settle();
  armAlarmAudio();
  armAlarmAudio();
  await settle();
  assert.equal(decodes, 1, 'decoded on the first arm, then given up on');
});

test('muting the last sounding alarm cuts a custom clip off at once', { timeout: 5000 }, async () => {
  decodeFails = false;
  // A fresh file clears the given-up state, the same way uploading one does.
  const { clearCustomAlarmSound } = await import('../src/alarms.js');
  clearCustomAlarmSound();
  gmStore.set('gardenCompanion.alarmSound.v1', { name: 'ok.mp3', data: 'AAAA' });
  armAlarmAudio();
  await settle();
  // The banner's tone timer keeps the process alive, so it is stopped even when an assertion fails.
  try {
    showAlarmBanner({ owner: 'x', label: 'X', title: 'Clip' });
    assert.equal(started.length, 1, 'the decoded clip plays straight away, no Classic beep first');
    assert.equal(started[0].stopped, false);
    setAlarmSilenced('x', true);
    assert.equal(started[0].stopped, true);
  } finally {
    stopAlarm();
  }
});
