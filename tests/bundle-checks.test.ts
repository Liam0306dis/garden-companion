import { catalogs } from './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { escapeRegExp } from '../scripts/bundle-catalogs.js';
import { extractChunkReferences, readSnapshot, snapshotDirs } from '../scripts/bundle-snapshot.js';
import { bareByGame, checkSnapshot, companionCommands, dispatchedByGame, envelopeFields } from '../scripts/check-bundle.js';
import { checkAtoms, companionAtomLabels } from '../scripts/check-atoms.js';

const snapshot = await readSnapshot((await snapshotDirs())[0]);

test('the captured bundle still has everything the companion sends and reads', async () => {
  const result = await checkSnapshot(snapshot, await companionCommands());
  assert.deepEqual(result.drift, []);
});

test('every atom the companion hooks is still defined', async () => {
  const result = checkAtoms(snapshot, await companionAtomLabels());
  assert.deepEqual(result.missing, []);
});

test('the companion\'s own command list is read from its source', async () => {
  const sent = await companionCommands();
  for (const type of ['HarvestCrop', 'PurchaseShopItem', 'PotPlant', 'PlantGardenPlant', 'Preserve', 'CropCleanser']) assert.ok(sent.wrapped.has(type), type);
  assert.deepEqual([...sent.bare.keys()], ['PlayerPosition']);
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
  assert.ok(catalogs.plants.FourLeafClover?.slots === catalogs.plants.Clover?.slots, 'a rare patch variant inherits its parent capacity');
  assert.match(catalogs.abilityColours.RainbowGranter, /^linear-gradient\(/);
});

test('identifiers are escaped before they reach a pattern', () => {
  assert.equal(new RegExp(`^${escapeRegExp('a$b.c')}$`).test('a$b.c'), true);
  assert.equal(new RegExp(`^${escapeRegExp('a$b.c')}$`).test('a$bxc'), false);
});
