import { catalogs } from './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maxSizeMultiplier, sizeFromScale, slotIsMaxSize, slotScale, slotSizePercent } from '../src/crop-size.js';
import { catalogMutationMultiplier } from '../src/mutation-value.js';
import { mutationName, plantName, patchName, PATCH_FAMILY_OF } from '../src/constants.js';
import { escapeHtml, formatDuration, humanize } from '../src/utils.js';

test('crop size reads the new integer size model', () => {
  const crop = { maxSizeMultiplier: 3 };
  assert.equal(slotScale(crop, { size: 50 }), 1);
  assert.equal(slotScale(crop, { size: 100 }), 3);
  assert.equal(slotScale(crop, { size: 75 }), 2);
  assert.equal(slotScale(crop, { size: 140 }), 3, 'size is capped at 100');
  assert.equal(slotIsMaxSize(crop, { size: 100 }), true);
  assert.equal(slotIsMaxSize(crop, { size: 99 }), false);
  assert.equal(slotSizePercent(crop, { size: 73.4 }), 73);
  assert.equal(sizeFromScale(3, 2), 75);
  assert.equal(sizeFromScale(1, 5), 50, 'a fixed-size crop is always 50');
});

test('crop size still reads the old targetScale model', () => {
  const crop = { maxScale: 2 };
  assert.equal(maxSizeMultiplier(crop), 2);
  assert.equal(slotScale(crop, { targetScale: 1.5 }), 1.5);
  assert.equal(slotIsMaxSize(crop, { targetScale: 2 }), true);
  assert.equal(slotSizePercent(crop, { targetScale: 1.5 }), 75);
  assert.equal(slotSizePercent(crop, { targetScale: 1 }), 50);
});

test('mutation multipliers follow the game formula, including the weather and lunar pairs', () => {
  assert.equal(catalogMutationMultiplier([]), 1);
  assert.equal(catalogMutationMultiplier(['Gold']), 25);
  assert.equal(catalogMutationMultiplier(['Rainbow']), 50);
  assert.equal(catalogMutationMultiplier(['Wet']), 2);
  assert.equal(catalogMutationMultiplier(['Wet', 'Dawnlit']), 5);
  // The hand tables this replaced priced these one step low (7 and 10).
  assert.equal(catalogMutationMultiplier(['Wet', 'Dawncharged']), 8);
  assert.equal(catalogMutationMultiplier(['Chilled', 'Ambercharged']), 11);
  assert.equal(catalogMutationMultiplier(['Frozen', 'Ambercharged']), 15);
  assert.equal(catalogMutationMultiplier(['Thundercharged', 'Ambercharged']), 16);
  assert.equal(catalogMutationMultiplier(['Rainbow', 'Frozen', 'Ambercharged']), 750);
  assert.equal(catalogMutationMultiplier(['NotAMutation']), 1, 'unknown ids are ignored');
});

test('the input array is left alone', () => {
  const mutations = ['Dawnlit', 'Wet', 'Gold'];
  catalogMutationMultiplier(mutations);
  assert.deepEqual(mutations, ['Dawnlit', 'Wet', 'Gold']);
});

test('names come from the catalog, with the overrides the panel wants', () => {
  assert.equal(plantName('DawnCelestial'), 'Dawnbinder');
  assert.equal(plantName('ThunderCelestialShroomPlant'), 'Stormcap');
  assert.equal(plantName('OrangeTulip'), catalogs.plants.OrangeTulip.crop.name.replace(/ Fruit$/, ''));
  if (catalogs.plants.DragonFruit) assert.match(plantName('DragonFruit'), /Fruit$/, 'a species named Fruit keeps it');
  assert.equal(mutationName('Ambershine'), 'Amberlit');
  assert.equal(mutationName('Dawncharged'), 'Dawnbound');
  assert.equal(PATCH_FAMILY_OF.PurpleDaisy, 'Daisy');
  assert.ok(patchName('Daisy'));
});

test('text helpers', () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  assert.equal(escapeHtml(null), '');
  assert.equal(humanize('PetXpBoostII'), 'Pet Xp Boost II');
  assert.equal(humanize('ReplenishPotion'), 'Hunger Potion');
  assert.equal(formatDuration(65_000), '1m 05s');
  assert.equal(formatDuration(3_723_000), '1h 02m');
  assert.equal(formatDuration(-5), '0m 00s');
});
