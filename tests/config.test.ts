import { gmStore } from './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const STORE_KEY = 'gardenCompanion.config.v1';

// Seeded before the config module loads, since it reads the saved settings once at import.
gmStore.set(STORE_KEY, {
  turtleTimer: false,
  silencedAbilities: ['CoinFinderI', 'HungerBoost'],
  shopAlerts: { 'seed:Carrot': true, 'seed:Beet': false, 'tool:Shovel': true, 'tool:WateringCan': true },
  petFoodChoices: { Worm: 'NotInItsDiet', Snail: 'ReplenishPotion', BrandNewPet: 'Anything' },
  protectedSpecies: { Carrot: true, Beet: false },
});
const { config, DEFAULTS, feature, pruneStaleConfig, saveConfig } = await import('../src/config.js');

test('a saved turtleTimer=false carries forward to the split crop value switch', () => {
  assert.equal(config.turtleTimer, false);
  assert.equal(config.cropValues, false);
});

test('pruning drops what no longer applies and keeps what might', () => {
  pruneStaleConfig();
  assert.deepEqual(config.silencedAbilities, ['CoinFinderI'], 'untracked abilities are dropped');
  assert.deepEqual(Object.keys(config.shopAlerts).sort(), ['seed:Carrot', 'tool:WateringCan'], 'unticked alerts and unsellable tools are dropped');
  assert.deepEqual(config.petFoodChoices, { Snail: 'ReplenishPotion', BrandNewPet: 'Anything' }, 'potions and species newer than the build are kept');
  assert.deepEqual(config.protectedSpecies, { Carrot: true });
  assert.deepEqual((gmStore.get(STORE_KEY) as typeof config).shopAlerts, config.shopAlerts, 'the pruned config is saved');
});

test('the live config never shares its lists with the defaults', () => {
  config.protectedMutations.push('Gold');
  config.teamKeybinds.someTeam = 'K';
  assert.deepEqual(DEFAULTS.protectedMutations, []);
  assert.deepEqual(DEFAULTS.teamKeybinds, {});
});

test('always-on features cannot be switched off', () => {
  config.overview = false;
  config.dragMove = false;
  assert.equal(feature('overview'), true);
  assert.equal(feature('dragMove'), false);
  saveConfig();
  assert.equal((gmStore.get(STORE_KEY) as typeof config).dragMove, false);
});
