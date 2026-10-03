import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dustMultiplier } from '../src/features/calculators.js';

// Taken from the game's own sell-dust function: rarity x hatch rarity within the pet's own egg x colour.
test('a Phoenix is priced as a Divine hatch rarer than 5%', () => {
  assert.equal(dustMultiplier('Phoenix', [], 'AmberEgg'), 100 * 50 * 10);
  assert.equal(dustMultiplier('Phoenix', ['Rainbow'], 'AmberEgg'), 100 * 50 * 10 * 50);
});

test('the hatch tier reads the egg the pet came from', () => {
  assert.equal(dustMultiplier('Bee', [], 'CommonEgg'), 100 * 1 * 5);
  assert.equal(dustMultiplier('RedFox', [], 'AmberEgg'), 100 * 50 * 2);
  assert.equal(dustMultiplier('Horse', ['Gold'], 'HorseEgg'), 100 * 10 * 2 * 25);
  assert.equal(dustMultiplier('Phoenix'), 100 * 50 * 10);
});
