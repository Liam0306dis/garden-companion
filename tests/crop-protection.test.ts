import './setup.js';
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { config } from '../src/config.js';
import { blockOutgoingHarvest, protectionReason } from '../src/features/crop-protection.js';
import { comboKey, repeatsEarlierCombo } from '../src/harvest-combos.js';
import { state } from '../src/state.js';
import type { PlayerSlot } from '../src/types.js';

const harvest = (tile: number, slotsIndex: number) => ({
  scopePath: ['Room', 'Quinoa'], type: 'QuinoaCommand', requestId: 'req-1',
  command: { type: 'HarvestCrop', slot: tile, slotsIndex, cropItemId: 'x' },
});

function garden(slots: Array<Record<string, unknown>>): void {
  state.slot = { data: { garden: { tileObjects: { 7: { objectType: 'plant', species: 'Carrot', slots } } } } } as unknown as PlayerSlot;
}

test('nothing is blocked while Crop Protection is off', () => {
  config.cropProtection = false;
  config.protectedMutations = ['Gold'];
  garden([{ slotId: 0, species: 'Carrot', mutations: ['Gold'] }]);
  assert.equal(blockOutgoingHarvest(harvest(7, 0)), null);
});

test('a protected mutation blocks the harvest and hands back the request to refuse', () => {
  config.cropProtection = true;
  config.protectedMutations = ['Gold'];
  garden([{ slotId: 0, species: 'Carrot', mutations: ['Gold'] }, { slotId: 1, species: 'Carrot', mutations: [] }]);
  assert.deepEqual(blockOutgoingHarvest(harvest(7, 0)), { tile: '7', slotId: '0', requestId: 'req-1' });
  assert.equal(blockOutgoingHarvest(harvest(7, 1)), null, 'an unprotected crop on the same tile is let through');
});

test('species and max size rules apply, mutations first', () => {
  config.cropProtection = true;
  config.protectedMutations = [];
  config.protectedSpecies = { Carrot: true };
  assert.equal(protectionReason({ slotId: 0, species: 'Carrot', mutations: [] } as never, 'Carrot'), 'Carrot');
  config.protectedSpecies = {};
  config.protectMaxSize = true;
  assert.equal(protectionReason({ slotId: 0, species: 'Carrot', size: 100 } as never, 'Carrot'), 'max size');
  assert.equal(protectionReason({ slotId: 0, species: 'Carrot', size: 99 } as never, 'Carrot'), null);
  config.protectMaxSize = false;
});

test('a repeat is the same size and mutations in any order, and only a later one counts', () => {
  const combos = [{ minSize: 90, mutations: ['Rainbow', 'Frozen'] }, { minSize: 90, mutations: ['Frozen', 'Rainbow'] }, { minSize: 80, mutations: ['Rainbow', 'Frozen'] }];
  assert.equal(comboKey(combos[0]), comboKey(combos[1]));
  assert.equal(repeatsEarlierCombo(combos, 0), false);
  assert.equal(repeatsEarlierCombo(combos, 1), true);
  assert.equal(repeatsEarlierCombo(combos, 2), false, 'a different size is a different combo');
  assert.equal(comboKey(null), comboKey({}), 'a damaged entry reads as a blank');
});

test('a slot with no id is found by its place on the tile', () => {
  config.cropProtection = true;
  config.protectedMutations = ['Gold'];
  garden([{ species: 'Carrot', mutations: [] }, { species: 'Carrot', mutations: ['Gold'] }]);
  assert.ok(blockOutgoingHarvest(harvest(7, 1)));
  assert.equal(blockOutgoingHarvest(harvest(7, 0)), null);
});

test('a harvest before the garden has loaded is held rather than waved through', () => {
  config.cropProtection = true;
  state.slot = null;
  assert.ok(blockOutgoingHarvest(harvest(7, 0)));
});

test('anything that is not a harvest passes', () => {
  config.cropProtection = true;
  assert.equal(blockOutgoingHarvest({ type: 'QuinoaCommand', command: { type: 'FeedPet' } }), null);
});

afterEach(() => {
  config.protectedMutations = [];
  config.protectMaxSize = false;
  config.protectedSpecies = {};
  config.harvestRules = {};
});

const crop = (size: number | undefined, mutations: string[]) => ({ slotId: 0, species: 'Carrot', size, mutations }) as never;

function protect(combos: Array<{ minSize: number; mutations: string[] }>, locks: string[] = [], maxSize = false): void {
  config.cropProtection = true;
  config.protectedMutations = locks;
  config.protectMaxSize = maxSize;
  config.protectedSpecies = { Carrot: true };
  config.harvestRules = { Carrot: { combos } };
}

test('a combo lets a protected species through once it has the size and every mutation', () => {
  protect([{ minSize: 100, mutations: ['Ambercharged', 'Thundercharged'] }, { minSize: 90, mutations: ['Frozen', 'Rainbow'] }]);
  assert.equal(protectionReason(crop(100, ['Ambercharged', 'Thundercharged']), 'Carrot'), null);
  assert.equal(protectionReason(crop(90, ['Frozen', 'Rainbow']), 'Carrot'), null, 'each combo has its own size');
  assert.ok(protectionReason(crop(95, ['Ambercharged', 'Thundercharged']), 'Carrot'), 'too small for that combo');
  assert.ok(protectionReason(crop(100, ['Frozen']), 'Carrot'), 'half a combo');
});

test('a combo with nothing picked lets nothing through', () => {
  protect([{ minSize: 50, mutations: [] }]);
  assert.equal(protectionReason(crop(100, ['Gold']), 'Carrot'), 'Carrot');
});

test('a size only combo works, but does not lift a mutation lock', () => {
  protect([{ minSize: 90, mutations: [] }], ['Rainbow']);
  assert.equal(protectionReason(crop(95, []), 'Carrot'), null);
  assert.equal(protectionReason(crop(95, ['Rainbow']), 'Carrot'), 'Rainbow');
});

test('a combo lifts max size and the mutation locks it names', () => {
  protect([{ minSize: 70, mutations: ['Rainbow', 'Chilled'] }, { minSize: 90, mutations: ['Rainbow', 'Thundercharged'] }], ['Thundercharged', 'Rainbow'], true);
  assert.equal(protectionReason(crop(100, ['Rainbow', 'Thundercharged']), 'Carrot'), null);
  assert.equal(protectionReason(crop(100, ['Rainbow', 'Chilled']), 'Carrot'), null);
  assert.equal(protectionReason(crop(100, ['Rainbow']), 'Carrot'), 'Rainbow', 'no combo met, so the locks stand');
});

test('a mutation this build does not know still has to be on the crop', () => {
  protect([{ minSize: 50, mutations: ['BrandNewMutation', 'Rainbow'] }]);
  assert.ok(protectionReason(crop(60, ['Rainbow']), 'Carrot'));
  assert.equal(protectionReason(crop(60, ['Rainbow', 'BrandNewMutation']), 'Carrot'), null);
});

test('a crop with no size on record reads as the smallest', () => {
  protect([{ minSize: 50, mutations: ['Gold'] }, { minSize: 80, mutations: ['Rainbow'] }]);
  assert.equal(protectionReason(crop(undefined, ['Gold']), 'Carrot'), null);
  assert.ok(protectionReason(crop(undefined, ['Rainbow']), 'Carrot'));
});
