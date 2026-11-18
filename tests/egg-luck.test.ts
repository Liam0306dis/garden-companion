import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setStorageAccount } from '../src/storage.js';
import { eggLuckSignature, recordEggHatches, renderEggLuck, syncEggPityCounters } from '../src/features/egg-luck.js';

setStorageAccount('egg-luck-test');

function hatch(eggId: string, petSpecies: string, mutations: string[] = [], id = `${Math.random()}`) {
  return { action: 'hatchEgg', timestamp: Date.now(), parameters: { eggId, pet: { id, petSpecies, mutations } } };
}

function counters(): Record<string, Record<string, { misses: number; synced: boolean }>> {
  const raw = JSON.parse(eggLuckSignature()).luck as Record<string, { counters: Record<string, { misses: number; synced: boolean }> }>;
  return Object.fromEntries(Object.entries(raw).map(([eggId, record]) => [eggId, record.counters]));
}

test('game counters overrule counted ones and are marked synced', () => {
  recordEggHatches([hatch('CommonEgg', 'Worm'), hatch('CommonEgg', 'Worm')]);
  assert.deepEqual(counters().CommonEgg.Bee, { misses: 2, synced: false });

  syncEggPityCounters({ egg: { CommonEgg: { species: { Bee: 37 }, growthMutation: { Gold: 150, Rainbow: 1999 } } } });
  const common = counters().CommonEgg;
  assert.deepEqual(common.Bee, { misses: 37, synced: true });
  assert.deepEqual(common.Gold, { misses: 150, synced: true });
  assert.deepEqual(common.Rainbow, { misses: 1999, synced: true });
});

test('an egg the game leaves out reads as zero, and untouched eggs get no record', () => {
  syncEggPityCounters({ egg: {} });
  assert.deepEqual(counters().CommonEgg.Bee, { misses: 0, synced: true });
  assert.equal(counters().MythicalEgg, undefined);
});

test('Amber Egg keeps a counter per guaranteed species', () => {
  syncEggPityCounters({ egg: { AmberEgg: { species: { FireHorse: 12, Phoenix: 80 } } } });
  const amber = counters().AmberEgg;
  assert.equal(amber.FireHorse.misses, 12);
  assert.equal(amber.Phoenix.misses, 80);
  assert.equal(amber.Gold.misses, 0);
});

test('missing pityCounters leaves the store alone', () => {
  const before = eggLuckSignature();
  syncEggPityCounters(undefined);
  assert.equal(eggLuckSignature(), before);
});

test('the note says the bars come from the game once read', () => {
  assert.match(renderEggLuck(), /read straight from the game/);
});
