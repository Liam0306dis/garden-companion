import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Pet } from '../src/types.js';
import { stopAlarm } from '../src/alarms.js';
import { config } from '../src/config.js';
import { processPetAbilityCooldowns } from '../src/features/active-pets.js';
import { state } from '../src/state.js';

const title = () => document.getElementById('gc-alarm')?.querySelector('strong')?.textContent;

function team(cooldown: number): void {
  const pet: Pet = { id: 'ostrich-1', petSpecies: 'Ostrich', name: 'Ozzy', hunger: 100, abilities: ['DawnCapture'], abilityCooldowns: { DawnCapture: cooldown } };
  state.slot = { data: { petSlots: [pet] } } as unknown as typeof state.slot;
}

test('an activated ability alarms on coming off cooldown, not on first sight', () => {
  config.petAbilityAlarm = true;
  team(0);
  processPetAbilityCooldowns();
  assert.equal(title(), undefined, 'already ready when first seen');
  team(120_000);
  processPetAbilityCooldowns();
  team(0);
  processPetAbilityCooldowns();
  assert.equal(title(), "Ozzy's Dawn Capture is ready");
  team(300_000);
  processPetAbilityCooldowns();
  assert.equal(title(), undefined, 'using it again clears the banner');
  stopAlarm();
});

test('the alarm stays quiet while switched off', () => {
  config.petAbilityAlarm = false;
  team(5_000);
  processPetAbilityCooldowns();
  team(0);
  processPetAbilityCooldowns();
  assert.equal(title(), undefined);
});
