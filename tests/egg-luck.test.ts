import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setStorageAccount } from '../src/storage.js';
import { bindEggLuckEvents, eggLuckSignature, recordEggHatches, renderEggLuck, syncPityCounters } from '../src/features/egg-luck.js';
import { panelActions, setPanelActions } from '../src/panel-actions.js';

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

  syncPityCounters({ egg: { CommonEgg: { species: { Bee: 37 }, growthMutation: { Gold: 150, Rainbow: 1999 } } } });
  const common = counters().CommonEgg;
  assert.deepEqual(common.Bee, { misses: 37, synced: true });
  assert.deepEqual(common.Gold, { misses: 150, synced: true });
  assert.deepEqual(common.Rainbow, { misses: 1999, synced: true });
});

test('an egg the game leaves out reads as zero, and untouched eggs get no record', () => {
  syncPityCounters({ egg: {} });
  assert.deepEqual(counters().CommonEgg.Bee, { misses: 0, synced: true });
  assert.equal(counters().MythicalEgg, undefined);
});

test('Amber Egg keeps a counter per guaranteed species', () => {
  syncPityCounters({ egg: { AmberEgg: { species: { FireHorse: 12, Phoenix: 80 } } } });
  const amber = counters().AmberEgg;
  assert.equal(amber.FireHorse.misses, 12);
  assert.equal(amber.Phoenix.misses, 80);
  assert.equal(amber.Gold.misses, 0);
});

test('missing pityCounters leaves the store alone', () => {
  const before = eggLuckSignature();
  syncPityCounters(undefined);
  assert.equal(eggLuckSignature(), before);
});

test('the note says the bars come from the game once read', () => {
  assert.match(renderEggLuck(), /read straight from the game/);
});

/** Draws the tab into a stand-in panel and clicks a sub-tab, the way the panel itself would redraw. */
function openLuckTab(tab: string): string {
  const main = document.createElement('main');
  setPanelActions({ ...panelActions, renderPanel: () => { main.innerHTML = renderEggLuck(); bindEggLuckEvents(main); } });
  panelActions.renderPanel();
  main.querySelector<HTMLButtonElement>(`[data-luck-tab="${tab}"]`)!.click();
  return main.innerHTML;
}

test('plants and capsules sit on their own sub-tabs, nearest guarantee first', () => {
  syncPityCounters({
    egg: {},
    growSlot: {
      Carrot: { growthMutation: { Gold: 20 } },
      Clover: { growthMutation: { Gold: 199, Rainbow: 5 }, species: { FourLeafClover: 500 } },
      Tomato: { growthMutation: {} },
    },
    capsule: { DawnCapsule: { Ube: 79 }, AmberCapsule: {} },
  });
  const pets = renderEggLuck();
  assert.match(pets, /data-luck-tab="plants"/);
  assert.doesNotMatch(pets, /Four-Leaf Clover/);

  const plants = openLuckTab('plants');
  // Clover is due (its rare crop is at 500/500), so it leads; a crop with nothing missed is left out.
  assert.ok(plants.indexOf('Four-Leaf Clover') < plants.indexOf('Carrot'));
  assert.doesNotMatch(plants, /Tomato/);
  assert.match(plants, /500 \/ 500/);
  assert.match(plants, /<b>2<\/b> crops tracked/);
  assert.doesNotMatch(plants, /Strength Shard/);

  const capsules = openLuckTab('capsules');
  assert.match(capsules, /79 \/ 80/);
  assert.match(capsules, /0 \/ 400/);
  assert.match(capsules, /Strength Shard/);
  assert.doesNotMatch(capsules, /Carrot/);
  openLuckTab('pets');
});
