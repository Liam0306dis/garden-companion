import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { blockOutgoingHarvest, protectionReason } from '../src/features/crop-protection.js';
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

test('a harvest before the garden has loaded is held rather than waved through', () => {
  config.cropProtection = true;
  state.slot = null;
  assert.ok(blockOutgoingHarvest(harvest(7, 0)));
});

test('anything that is not a harvest passes', () => {
  config.cropProtection = true;
  assert.equal(blockOutgoingHarvest({ type: 'QuinoaCommand', command: { type: 'FeedPet' } }), null);
});
