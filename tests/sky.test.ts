import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { page } from '../src/page.js';
import type { SkySettings } from '../src/types.js';
import {
  GAME_NIGHT_COLOURS, mixColour, nightGradeAvailable, nightStrength, patchNightGrade, tunedNightColour, tunedToneCurve,
} from '../src/features/sky.js';

const DEFAULTS: SkySettings = {
  weather: 'live', time: 'live',
  night: 100, nightColour: 100, glow: 100, nightTint: '', sunsetTint: '', sunriseTint: '',
  brightness: 100, contrast: 100, saturation: 100, warmth: 0, hue: 0,
};
const sky = (over: Partial<SkySettings>): SkySettings => ({ ...DEFAULTS, ...over });

// The day cycle starts at sunrise: sunrise 10, day 210, sunset 10, midnight 10 minutes of 240.
const at = (minute: number) => minute / 240;

test('night strength follows the game curve: falls through sunrise, 0 by day, rises through sunset', () => {
  assert.equal(nightStrength(at(0)), 1);
  assert.ok(Math.abs(nightStrength(at(5)) - 0.5) < 1e-9);
  assert.equal(nightStrength(at(10)), 0);
  assert.equal(nightStrength(at(120)), 0);
  assert.ok(Math.abs(nightStrength(at(225)) - 0.5) < 1e-9);
  assert.equal(nightStrength(at(235)), 1);
  assert.ok(Math.abs(nightStrength(1 + at(5)) - 0.5) < 1e-9);
});

test('the colour blend matches the game: per channel, rounded', () => {
  assert.equal(mixColour(0x000000, 0xffffff, 0.5), 0x808080);
  assert.equal(mixColour(0x102030, 0x102030, 0.7), 0x102030);
  assert.equal(mixColour(0xff0000, 0x0000ff, 1), 0x0000ff);
});

test('at the defaults the game values go through untouched', () => {
  assert.equal(tunedToneCurve(0.6, -0.05, DEFAULTS), null);
  assert.equal(tunedNightColour(123, 0.4, at(225), DEFAULTS), null);
});

test('darkness scales the blend away from no change, the same as scaling brightness and contrast', () => {
  // The game's grade at full night: contrast -45 -> gain 0.55, brightness -71 -> lift .5 - .5*.55 - 71/255.
  const gain = 0.55;
  const lift = 0.5 - 0.5 * 0.55 - 71 / 255;
  const [g, l] = tunedToneCurve(gain, lift, sky({ night: 50 }))!;
  // Brightness -35.5 and contrast -22.5, worked out the way the game does.
  assert.ok(Math.abs(g - 0.775) < 1e-9);
  assert.ok(Math.abs(l - (0.5 - 0.5 * 0.775 - 35.5 / 255)) < 1e-9);
  const [none, noLift] = tunedToneCurve(gain, lift, sky({ night: 0 }))!;
  assert.equal(none, 1);
  assert.ok(noLift === 0);
});

test('tint strength scales the opacity and keeps the game colour when no tint is set', () => {
  assert.deepEqual(tunedNightColour(0xabcdef, 0.4, at(225), sky({ nightColour: 50 })), [0xabcdef, 0.2]);
});

test('a tint replaces the colour in the game blend, with the game colours behind any left empty', () => {
  // Midway through sunset: strength 0.5, so the blend is fully the sunset colour.
  assert.deepEqual(tunedNightColour(1, 0.3, at(225), sky({ sunsetTint: '#ff0000' })), [0xff0000, 0.3]);
  // Midnight: no blend, the night tint alone.
  assert.deepEqual(tunedNightColour(1, 0.3, at(235), sky({ nightTint: '#00ff00' })), [0x00ff00, 0.3]);
  // Midway through sunrise with only a night tint: blended halfway... at strength 0.5, fully the game's sunrise colour.
  assert.deepEqual(tunedNightColour(1, 0.3, at(5), sky({ nightTint: '#00ff00' })), [GAME_NIGHT_COLOURS.sunriseColor, 0.3]);
  // No phase known: the game's colour is kept.
  assert.deepEqual(tunedNightColour(7, 0.3, undefined, sky({ nightTint: '#00ff00' })), [7, 0.3]);
});

test('the patched dayNight filter applies the settings, reading the phase the system draws', () => {
  const calls: Array<[string, number, number]> = [];
  const filter = {
    setToneCurve(gain: number, lift: number) { calls.push(['tone', gain, lift]); },
    setColor(color: number, opacity: number) { calls.push(['colour', color, opacity]); },
  };
  const system = {
    name: 'dayNight',
    filter,
    draw(frame: { dayNightPhase01: number }) {
      this.filter.setToneCurve(0.5, -0.1);
      this.filter.setColor(0x123456, 0.4);
      return frame.dayNightPhase01;
    },
  };
  page.__gardenCompanionFarmSystems = { tapToMove: null, tileSystem: null, petSystem: null, worldTapRouter: null, ownUserSlotIdx: null, dayNight: system };
  config.sky = sky({ night: 50, nightColour: 50, nightTint: '#00ff00' });
  assert.equal(nightGradeAvailable(), true);
  assert.equal(patchNightGrade(), true);
  assert.equal(patchNightGrade(), true, 'a second patch is a no-op');
  assert.equal(system.draw({ dayNightPhase01: at(235) }), at(235));
  assert.deepEqual(calls, [['tone', 0.75, -0.05], ['colour', 0x00ff00, 0.2]]);
});
