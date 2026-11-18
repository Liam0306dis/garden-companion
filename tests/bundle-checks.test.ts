import { catalogs } from './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeRegExp } from '../scripts/bundle-catalogs.js';
import { extractChunkReferences, readSnapshot, snapshotDirs } from '../scripts/bundle-snapshot.js';
import { bareByGame, checkSnapshot, companionCommands, dispatchedByGame, envelopeFields } from '../scripts/check-bundle.js';
import { atomShape, checkAtoms, companionAtomLabels, readShapeBaseline } from '../scripts/check-atoms.js';

const snapshot = await readSnapshot((await snapshotDirs())[0]);

test('the captured bundle still has everything the companion sends and reads', async () => {
  const result = await checkSnapshot(snapshot, await companionCommands());
  assert.deepEqual(result.drift, []);
});

test('every atom the companion hooks is still defined', async () => {
  const result = checkAtoms(snapshot, await companionAtomLabels());
  assert.deepEqual(result.missing, []);
});

test('every atom the companion hooks still starts with the value it was written against', async () => {
  const result = checkAtoms(snapshot, await companionAtomLabels(), await readShapeBaseline());
  assert.deepEqual(result.changed, []);
});

test('atom shapes ignore minified names but keep keys, properties and literals', () => {
  assert.equal(atomShape('M({modal:null,openId:0})'), atomShape('A({modal:null,openId:0})'));
  assert.notEqual(atomShape('M(null)'), atomShape('M({modal:null,openId:0})'));
  assert.equal(atomShape('A(e=>e(Am).modal)'), '_(_=>_(_).modal)');
  assert.equal(atomShape('A(e=>e?t:!1)'), '_(_=>_?_:!1)');
});

test('the companion\'s own command list is read from its source', async () => {
  const sent = await companionCommands();
  for (const type of ['HarvestCrop', 'PurchaseShopItem', 'PotPlant', 'PlantGardenPlant', 'Preserve', 'CropCleanser']) assert.ok(sent.wrapped.has(type), type);
  // Nothing is sent bare since the XP potion stopped stepping onto the pet first (build 1558); the
  // bare/wrapped split itself is covered by the module-alias test below.
  assert.deepEqual([...sent.bare.keys()], []);
});

test('bare and wrapped senders are told apart through module aliases', () => {
  const files = new Map([
    ['net.js', 'function Xm(e){client.getInstance().sendMessage({scopePath:[`Room`,`Quinoa`],...e})}function JT(e){return{type:`QuinoaCommand`,requestId:a,commandSequence:n(),command:e}}export{Xm as ko,JT as wr};'],
    ['game.js', 'import{ko as no,wr as G}from"./net.js";no({type:`PlayerPosition`,position:s});G({type:`PlantGardenPlant`,slot:n})'],
  ]);
  const joined = [...files.values()].join('');
  assert.deepEqual([...bareByGame(files)], ['PlayerPosition']);
  assert.ok(dispatchedByGame(joined).has('PlantGardenPlant'));
  assert.deepEqual([...envelopeFields(joined)].sort(), ['command', 'commandSequence', 'requestId', 'type']);
});

test('chunk references stay on the asset origin', () => {
  const base = 'https://magicgarden.gg/version/768/assets/';
  const result = extractChunkReferences([
    'import "./local-Abc12345.js";', '"assets/dynamic-Def67890.js"', '"/version/768/assets/root-Ghi12345.js"',
    '"https://magicgarden.gg/version/768/assets/same-Jkl67890.js"', '"https://cdn.example.com/sdk.js"', '{"files":["rive.js"]}',
  ].join('\n'), base);
  assert.deepEqual(result.chunks.map(chunk => chunk.name).sort(), ['dynamic-Def67890.js', 'local-Abc12345.js', 'root-Ghi12345.js', 'same-Jkl67890.js']);
  assert.deepEqual(result.externalScripts, ['https://cdn.example.com/sdk.js']);
});

test('the catalogs the build bakes in are complete', () => {
  assert.ok(catalogs.abilities.length >= 60);
  assert.ok(Object.keys(catalogs.pets).length >= 20);
  assert.ok(Object.keys(catalogs.plants).length >= 50);
  assert.ok(Object.keys(catalogs.abilityColours).length >= 40);
  assert.equal(catalogs.mutations.Gold.group, 'Growth');
  assert.equal(catalogs.mutations.Ambershine.name, 'Amberlit');
  assert.ok(catalogs.plants.Carrot.crop.baseSellPrice > 0);
  assert.ok(catalogs.pets.Worm.diet.length > 0);
  assert.ok(Object.values(catalogs.pets).some(pet => pet.abilities.length), 'each species carries its roll table');
  assert.ok(Object.values(catalogs.eggs).some(egg => Object.keys(egg.pityThresholds).length), 'pity thresholds are read');
  for (const [egg, { pityThresholds }] of Object.entries(catalogs.eggs)) {
    for (const [species, pulls] of Object.entries(pityThresholds)) assert.ok(Number.isInteger(pulls) && pulls >= 1 && pulls <= 1000, `${egg}.${species} guarantee is ${pulls} pulls`);
  }
  assert.ok(catalogs.plants.FourLeafClover?.slots === catalogs.plants.Clover?.slots, 'a rare patch variant inherits its parent capacity');
  assert.match(catalogs.abilityColours.RainbowGranter, /^linear-gradient\(/);
});

test('identifiers are escaped before they reach a pattern', () => {
  assert.equal(new RegExp(`^${escapeRegExp('a$b.c')}$`).test('a$b.c'), true);
  assert.equal(new RegExp(`^${escapeRegExp('a$b.c')}$`).test('a$bxc'), false);
});

test('the Bad Luck tab\'s crop and capsule thresholds still match the game', async () => {
  const { CAPSULE_THRESHOLDS, PITY_THRESHOLDS, RARE_CROP_THRESHOLD } = await import('../src/features/egg-luck.js');
  // Everything is read from the one chunk that builds the guarantees, so a minified name is resolved
  // where it is declared rather than matched against an unrelated one of the same name elsewhere.
  const code: string = [...snapshot.files.values()].find(text => text.includes('`Rainbow`,') && /[{,]Dawnbreaker:\d/.test(text)) ?? '';
  assert.ok(code, 'the chunk that builds the guarantees was not found');
  // The game names its guarantees as (outcome, threshold, counter for that outcome), the threshold
  // either a literal or a constant declared nearby, so a name is followed to its value before comparing.
  const resolve = (value: string): number => {
    if (/^[\d.e]+$/.test(value)) return Number(value);
    const declared = code.match(new RegExp(`[,\\s]${escapeRegExp(value)}=([\\d.e]+)[,;]`));
    return declared ? Number(declared[1]) : NaN;
  };
  for (const colour of ['Gold', 'Rainbow']) {
    const guarantee = new RegExp(`\\(\`${colour}\`,([A-Za-z0-9_$.]+),[A-Za-z_$]+\\([A-Za-z_$]+,\`${colour}\`\\)\\)`, 'g');
    const stated = [...code.matchAll(guarantee)].map(match => resolve(match[1]));
    // Once for crops and once for eggs.
    assert.ok(stated.length >= 2, `${colour} guarantees not found`);
    for (const threshold of stated) assert.equal(threshold, PITY_THRESHOLDS[colour], colour);
  }
  assert.match(code, new RegExp(`\\[[A-Za-z_$]+\\([A-Za-z_$]+,${RARE_CROP_THRESHOLD},[A-Za-z_$]+\\(`), 'rare crop threshold');
  for (const [capsule, outcomes] of Object.entries(CAPSULE_THRESHOLDS)) {
    for (const [outcome, threshold] of Object.entries(outcomes)) {
      assert.match(code, new RegExp(`[{,]${outcome}:${threshold}[,}]`), `${capsule} ${outcome}`);
    }
  }
});
