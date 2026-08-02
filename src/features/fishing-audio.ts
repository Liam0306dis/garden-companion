import { armAlarmAudio } from '../alarms.js';
import { loadLocal, saveLocal } from '../utils.js';

/**
 * Sound for the fishing minigame, synthesized rather than loaded: a userscript has nowhere to host
 * audio files and no reliable way to fetch them, so splashes are filtered noise and the reel is a
 * ratchet of short clicks. The alarm context is shared so the page never holds two of them.
 */

const MUTE_KEY = 'gardenCompanion.fishingMuted.v1';
/** A reel is a stream of clicks; this is the fastest they may arrive. */
const CLICK_INTERVAL = 62;

let muted = loadLocal<boolean>(MUTE_KEY, false);
let noiseBuffer: AudioBuffer | null = null;
let noiseContext: AudioContext | null = null;
let lastClickAt = 0;

export function fishingMuted(): boolean { return muted; }

export function setFishingMuted(value: boolean): void {
  muted = value;
  saveLocal(MUTE_KEY, value);
}

function audio(): AudioContext | null {
  if (muted) return null;
  const context = armAlarmAudio();
  return context && context.state !== 'closed' ? context : null;
}

/**
 * Browsers only start an audio context on a gesture, and resuming is asynchronous. Opening the
 * panel is a click, so arming here keeps the first cast from being silent.
 */
export function primeFishingAudio(): void {
  audio();
}

/** One second of white noise, rebuilt only if the context is ever replaced. */
function noise(context: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseContext === context) return noiseBuffer;
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
  noiseContext = context;
  noiseBuffer = buffer;
  return buffer;
}

/** Water: a noise burst swept from bright to dull, which is most of what a splash actually is. */
function splash(context: AudioContext, at: number, strength: number, volume = .2): void {
  const source = context.createBufferSource();
  source.buffer = noise(context);
  source.playbackRate.value = .8 + Math.random() * .4;
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = .7;
  filter.frequency.setValueAtTime(2200 * strength, at);
  filter.frequency.exponentialRampToValueAtTime(280, at + .36 * strength);
  const gain = context.createGain();
  gain.gain.setValueAtTime(.0001, at);
  gain.gain.linearRampToValueAtTime(volume * strength, at + .012);
  gain.gain.exponentialRampToValueAtTime(.0008, at + .44 * strength);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);
  source.start(at, Math.random() * .5);
  source.stop(at + .5 * strength + .06);
}

/** A single droplet: a short sine that falls in pitch as it fades. */
function droplet(context: AudioContext, at: number, frequency: number, volume = .09): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, at);
  oscillator.frequency.exponentialRampToValueAtTime(frequency * .45, at + .09);
  gain.gain.setValueAtTime(.0001, at);
  gain.gain.linearRampToValueAtTime(volume, at + .006);
  gain.gain.exponentialRampToValueAtTime(.0008, at + .13);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + .15);
}

function tone(context: AudioContext, at: number, frequency: number, length: number, volume = .12, type: OscillatorType = 'triangle'): void {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, at);
  gain.gain.setValueAtTime(.0001, at);
  gain.gain.linearRampToValueAtTime(volume, at + .015);
  gain.gain.exponentialRampToValueAtTime(.0008, at + length);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(at);
  oscillator.stop(at + length + .04);
}

function semitone(base: number, steps: number): number {
  return base * Math.pow(2, steps / 12);
}

/** The line going out, then the float landing a moment later. */
export function playCast(): void {
  const context = audio();
  if (!context) return;
  const now = context.currentTime;
  const source = context.createBufferSource();
  source.buffer = noise(context);
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 4;
  filter.frequency.setValueAtTime(700, now);
  filter.frequency.exponentialRampToValueAtTime(2600, now + .16);
  filter.frequency.exponentialRampToValueAtTime(900, now + .32);
  const gain = context.createGain();
  gain.gain.setValueAtTime(.0001, now);
  gain.gain.linearRampToValueAtTime(.13, now + .06);
  gain.gain.exponentialRampToValueAtTime(.0008, now + .34);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);
  source.start(now, Math.random() * .5);
  source.stop(now + .38);
  splash(context, now + .34, .55, .16);
  droplet(context, now + .36, 900);
}

/** The strike: a knock on the water and two quick alert pips. */
export function playBite(): void {
  const context = audio();
  if (!context) return;
  const now = context.currentTime;
  splash(context, now, .7, .19);
  droplet(context, now + .02, 640);
  tone(context, now + .05, 1180, .07, .1, 'square');
  tone(context, now + .16, 1480, .07, .1, 'square');
}

/**
 * One tooth of the reel. Called every frame while the mouse is held, so it rate-limits itself and
 * pitches up while the fish is in the zone - the ratchet tells you how the fight is going.
 */
export function playReelClick(inside: boolean): void {
  const context = audio();
  if (!context) return;
  const stamp = performance.now();
  if (stamp - lastClickAt < CLICK_INTERVAL) return;
  lastClickAt = stamp;
  const now = context.currentTime;
  const source = context.createBufferSource();
  source.buffer = noise(context);
  source.playbackRate.value = inside ? 1.5 : 1;
  const filter = context.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 9;
  filter.frequency.setValueAtTime(inside ? 2100 : 1350, now);
  const gain = context.createGain();
  gain.gain.setValueAtTime(.0001, now);
  gain.gain.linearRampToValueAtTime(inside ? .075 : .055, now + .003);
  gain.gain.exponentialRampToValueAtTime(.0008, now + .035);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(context.destination);
  source.start(now, Math.random() * .5);
  source.stop(now + .05);
}

/** Landing it: a heave of water, then a rising figure that gets longer the rarer the fish. */
export function playCatch(tier: number): void {
  const context = audio();
  if (!context) return;
  const now = context.currentTime;
  splash(context, now, 1.15, .24);
  droplet(context, now + .06, 760);
  droplet(context, now + .14, 1020);
  const steps = [0, 4, 7, 12, 16, 19, 24];
  const notes = Math.min(steps.length, 3 + tier);
  for (let index = 0; index < notes; index++) {
    tone(context, now + .18 + index * .085, semitone(523.25, steps[index]), .3, .1);
  }
}

/** It got away: a heavy swirl and a figure that falls instead. */
export function playEscape(): void {
  const context = audio();
  if (!context) return;
  const now = context.currentTime;
  splash(context, now, .95, .2);
  tone(context, now + .05, 392, .22, .09);
  tone(context, now + .2, 294, .34, .09);
}
