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

test("the pets note drops the floor marker once the game's counters are read", () => {
  const html = renderEggLuck();
  assert.match(html, /Hatch counts only include hatches made while/);
  assert.doesNotMatch(html, /count may be higher/);
});

/** Draws the tab into a stand-in panel and clicks a sub-tab, the way the panel itself would redraw. */
function openLuckTab(tab: string): string {
  const main = document.createElement('main');
  setPanelActions({ ...panelActions, renderPanel: () => { main.innerHTML = renderEggLuck(); bindEggLuckEvents(main); } });
  panelActions.renderPanel();
  main.querySelector<HTMLButtonElement>(`[data-luck-tab="${tab}"]`)!.click();
  return main.innerHTML;
}

test('plants and capsules sit on their own sub-tabs', () => {
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
  // Carrot (Common) comes before Clover (Uncommon) even though Clover is due; a crop with nothing missed is left out.
  assert.ok(plants.indexOf('>Carrot<') < plants.indexOf('>Clover<'));
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

test('an egg with game counters but no hatches seen here still shows its bars', () => {
  syncPityCounters({ egg: { MythicalEgg: { species: { Capybara: 12 } } }, growSlot: {}, capsule: {} });
  const main = document.createElement('main');
  main.innerHTML = renderEggLuck();
  const cardOf = (eggId: string) => main.querySelector(`[data-egg-edit="${eggId}"]`)!.closest('section')!;
  assert.match(cardOf('MythicalEgg').textContent!, /12 \/ 40/);
  // An egg the game counts nothing for stays the one-line empty card.
  assert.equal(cardOf('LegendaryEgg').dataset.empty, 'true');
});

test('the Plants list can be searched, and crops picked off and put back', () => {
  syncPityCounters({
    egg: {},
    growSlot: {
      Carrot: { growthMutation: { Gold: 20, Rainbow: 3 } },
      Clover: { growthMutation: { Gold: 199 }, species: { FourLeafClover: 500 } },
      Tomato: { growthMutation: { Gold: 5 } },
    },
    capsule: {},
  });
  const main = document.createElement('main');
  const draw = () => { main.innerHTML = renderEggLuck(); bindEggLuckEvents(main); };
  setPanelActions({ ...panelActions, renderPanel: draw, renderPanelPreservingScroll: draw });
  draw();
  const click = (selector: string) => main.querySelector<HTMLButtonElement>(selector)!.click();
  click('[data-luck-tab="plants"]');
  const cards = () => [...main.querySelectorAll<HTMLElement>('.gc-filter-list section')].filter(card => !card.hidden).map(card => card.querySelector('h3')!.textContent);
  assert.deepEqual(cards().sort(), ['Carrot', 'Clover', 'Tomato']);

  // The chooser lists every tracked crop; hiding one takes it off the list and says so.
  assert.equal(main.querySelector('[data-luck-plant]'), null);
  click('[data-luck-picker]');
  click('[data-luck-plant="Carrot"]');
  assert.deepEqual(cards().sort(), ['Clover', 'Tomato']);
  assert.match(main.innerHTML, /1 hidden/);
  assert.equal(main.querySelector<HTMLElement>('[data-luck-plant="Carrot"]')!.dataset.active, 'false');

  click('[data-luck-plants="none"]');
  assert.deepEqual(cards(), []);
  assert.match(main.innerHTML, /Every tracked crop is hidden/);
  click('[data-luck-plant="Clover"]');
  assert.deepEqual(cards(), ['Clover']);
  click('[data-luck-plants="all"]');
  assert.deepEqual(cards().sort(), ['Carrot', 'Clover', 'Tomato']);

  // A search hides cards in place, finds a crop by its rare crop, and survives the next redraw.
  const search = main.querySelector<HTMLInputElement>('[data-luck-search]')!;
  search.value = 'four-leaf';
  search.dispatchEvent(new Event('input'));
  assert.deepEqual(cards(), ['Clover']);
  draw();
  assert.deepEqual(cards(), ['Clover']);
  // Cleared on the redrawn box, so the tests after this one start from an unfiltered list.
  const redrawn = main.querySelector<HTMLInputElement>('[data-luck-search]')!;
  redrawn.value = '';
  redrawn.dispatchEvent(new Event('input'));
  click('[data-luck-picker]');
  click('[data-luck-tab="pets"]');
});

test("crops are listed in the game's order: by rarity, then its own order, with crops newer than the build last", () => {
  syncPityCounters({
    egg: {},
    growSlot: {
      // Not in any catalog this build knows: it must still be listed, chosen and named.
      AuroraMelon: { growthMutation: { Gold: 1 } },
      Starweaver: { growthMutation: { Gold: 1 } },
      Tomato: { growthMutation: { Gold: 1 } },
      Carrot: { growthMutation: { Gold: 1 } },
      Clover: { growthMutation: { Gold: 1 } },
      Aloe: { growthMutation: { Gold: 1 } },
      Apple: { growthMutation: { Gold: 1 } },
    },
    capsule: {},
  });
  const main = document.createElement('main');
  const draw = () => { main.innerHTML = renderEggLuck(); bindEggLuckEvents(main); };
  setPanelActions({ ...panelActions, renderPanel: draw, renderPanelPreservingScroll: draw });
  draw();
  main.querySelector<HTMLButtonElement>('[data-luck-tab="plants"]')!.click();
  main.querySelector<HTMLButtonElement>('[data-luck-picker]')!.click();
  // The game's order, not the alphabet: Carrot before Aloe, Clover before Apple, Celestial after both -
  // and the unknown crop after every rarity rather than among the Commons.
  const order = [...main.querySelectorAll<HTMLElement>('[data-luck-plant]')].map(chip => chip.dataset.luckPlant);
  assert.deepEqual(order, ['Carrot', 'Aloe', 'Clover', 'Apple', 'Tomato', 'Starweaver', 'AuroraMelon']);
  // The cards follow the same order, so a crop sits in the same place in the list and the filter.
  const cards = [...main.querySelectorAll<HTMLElement>('.gc-filter-list section h3')].map(heading => heading.textContent);
  assert.deepEqual(cards, ['Carrot', 'Aloe', 'Clover', 'Apple', 'Tomato', 'Starweaver', 'Aurora Melon']);
  assert.match(main.querySelector('[data-luck-plant="AuroraMelon"]')!.textContent!, /Aurora Melon/);
  main.querySelector<HTMLButtonElement>('[data-luck-plant="AuroraMelon"]')!.click();
  assert.equal(main.querySelector<HTMLElement>('[data-luck-plant="AuroraMelon"]')!.dataset.active, 'false');
  main.querySelector<HTMLButtonElement>('[data-luck-plant="AuroraMelon"]')!.click();
  main.querySelector<HTMLButtonElement>('[data-luck-picker]')!.click();
  main.querySelector<HTMLButtonElement>('[data-luck-tab="pets"]')!.click();
});
