import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isAtlas, manifestCandidates } from '../src/pet-sprites.js';

const BASE = 'https://magicgarden.gg/version/2151/assets/';

test('the manifest the page names comes first, then the old names under the asset base', () => {
  const meta = document.createElement('meta');
  meta.name = 'magiccircle-asset-manifest-rgba8';
  meta.content = '/runtime-assets/manifest.rgba8.1d8f7471fc1f204a9fc9.json';
  document.head.appendChild(meta);
  try {
    assert.deepEqual(manifestCandidates(BASE).map(c => c.url), [
      'https://magicgarden.gg/runtime-assets/manifest.rgba8.1d8f7471fc1f204a9fc9.json',
      `${BASE}manifest.rgba8.json`,
      `${BASE}manifest.json`,
    ]);
  } finally {
    meta.remove();
  }
  assert.deepEqual(manifestCandidates(BASE).map(c => c.name), ['manifest.rgba8.json', 'manifest.json']);
});

test('atlases are found by their source before build 2151 and by their alias since', () => {
  assert.equal(isAtlas('atlases/sprites-0.json', undefined), true);
  assert.equal(isAtlas('/runtime-assets/sprites-0.rgba8.4f72b21d09a0cd7da59f.json', ['atlases/sprites-0.json']), true);
  assert.equal(isAtlas('/runtime-assets/pets-silhouettes.9ca95805e5c397070c76.json', ['rive/pets-silhouettes.json']), false);
  assert.equal(isAtlas('/runtime-assets/Bat.5f9a3582f478d1f4040e.riv', ['rive/pets/Bat.riv']), false);
});
