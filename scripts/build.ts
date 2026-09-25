import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { catalogsFromSnapshots } from './bundle-catalogs.js';
import { argValue, ensureLatestSnapshot, ROOT as root, snapshotDirs } from './bundle-snapshot.js';

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string };
const wasmSource = await readFile(resolve(root, 'vendor', 'wasm_b64.js'), 'utf8');
const wasmBase64 = wasmSource.match(/window\._WASM_B64\s*=\s*'([A-Za-z0-9+/=]+)'/)?.[1];
if (!wasmBase64) throw new Error('Pet sprite decoder data was not found in vendor/wasm_b64.js.');

/**
 * The catalogs come from a captured game bundle. `--bundles <dir>` reads snapshots from somewhere
 * else as they are. Otherwise `bundles/` is used, and the live bundle is pulled first whenever the
 * game has moved past the newest capture; `--offline` skips that check.
 */
async function bundleDirs(): Promise<string[]> {
  const override = argValue('--bundles');
  if (override) return snapshotDirs(resolve(override));
  return ensureLatestSnapshot({ offline: process.argv.includes('--offline') });
}

const header = `// ==UserScript==
// @name         Garden Companion
// @namespace    https://github.com/Liam0306dis/garden-companion
// @version      ${packageJson.version}
// @description  Manual garden tools, pet teams, alerts, timers, and room browsing
// @author       Liam
// @match        https://1227719606223765687.discordsays.com/*
// @match        https://magiccircle.gg/r/*
// @match        https://magicgarden.gg/r/*
// @match        https://starweaver.org/r/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      ariedam.fr
// @connect      raw.githubusercontent.com
// @connect      unpkg.com
// @updateURL    https://raw.githubusercontent.com/Liam0306dis/garden-companion/main/dist/garden-companion.user.js
// @downloadURL  https://raw.githubusercontent.com/Liam0306dis/garden-companion/main/dist/garden-companion.user.js
// @run-at       document-start
// ==/UserScript==`;

const [catalogs, css] = await Promise.all([
  bundleDirs().then(catalogsFromSnapshots),
  readFile(resolve(root, 'src', 'style.css'), 'utf8'),
]);

/**
 * > garden-companion@0.8.77 build
> tsx scripts/build.ts --no-sprites
No captured game bundle in bundles/ - pulling the live one first...
.....
Built dist/garden-companion.user.js from bundle-1260-20260924 (1,522,638 characters, 88 abilities, 29 pets, 69 plants, 11 eggs, 82 ability colours, 11 mutations, 60 decor) ships the script without the sprite pipeline: no 485KB WASM
 * transcoder, no atlas decoding. Only useful for measuring what the sprite loader actually costs
 * on a cold load - the resulting build has no pet, crop or decor artwork.
 */
const withoutSprites = process.argv.includes('--no-sprites');

/**
 * The sprite loader runs in the page, so it is built on its own and injected as source. The Basis
 * transcoder is bundled into it from npm rather than imported from a CDN at runtime: pinned to the
 * version whose wasm is vendored beside it, and nothing third-party is fetched and run in the page.
 * Its Node branch reaches for fs, which never runs in a browser, so fs is left external.
 */
async function buildSpriteLoader(): Promise<string> {
  if (withoutSprites) return 'console.warn("[Garden Companion] Built with --no-sprites: artwork is disabled.");';
  const result = await build({
    entryPoints: [resolve(root, 'src', 'pet-sprites-page.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2022'],
    charset: 'utf8',
    legalComments: 'none',
    write: false,
    external: ['fs'],
    define: {
      __PET_CATALOG__: JSON.stringify(catalogs.pets),
      __PLANT_CATALOG__: JSON.stringify(catalogs.plants),
      __DECOR_CATALOG__: JSON.stringify(catalogs.decor),
      __MUTATION_CATALOG__: JSON.stringify(catalogs.mutations),
      __PET_WASM_B64__: JSON.stringify(wasmBase64),
    },
  });
  return result.outputFiles[0].text;
}

const petSpriteLoader = await buildSpriteLoader();

await build({
  entryPoints: [resolve(root, 'src', 'index.ts')],
  outfile: resolve(root, 'dist', 'garden-companion.user.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  charset: 'utf8',
  legalComments: 'none',
  sourcemap: false,
  banner: { js: header },
  define: {
    __ABILITY_CATALOG__: JSON.stringify(catalogs.abilities),
    __ABILITY_DETAILS__: JSON.stringify(catalogs.abilityDetails),
    __PET_CATALOG__: JSON.stringify(catalogs.pets),
    __PLANT_CATALOG__: JSON.stringify(catalogs.plants),
    __EGG_CATALOG__: JSON.stringify(catalogs.eggs),
    __MUTATION_CATALOG__: JSON.stringify(catalogs.mutations),
    __DECOR_CATALOG__: JSON.stringify(catalogs.decor),
    __TOOL_LIMITS__: JSON.stringify(catalogs.toolLimits),
    __ABILITY_COLOURS__: JSON.stringify(catalogs.abilityColours),
    __PET_SPRITE_LOADER__: JSON.stringify(petSpriteLoader),
    __GARDEN_COMPANION_CSS__: JSON.stringify(css),
  },
});

const output = await readFile(resolve(root, 'dist', 'garden-companion.user.js'), 'utf8');
if (output.includes('\u2014')) throw new Error('The generated userscript contains an em dash.');
console.log(`Built dist/garden-companion.user.js${withoutSprites ? ' [--no-sprites]' : ''} from ${catalogs.source} (${output.length.toLocaleString()} characters, ${catalogs.abilities.length} abilities, ${Object.keys(catalogs.pets).length} pets, ${Object.keys(catalogs.plants).length} plants, ${Object.keys(catalogs.eggs).length} eggs, ${Object.keys(catalogs.abilityColours).length} ability colours, ${Object.keys(catalogs.mutations).length} mutations, ${Object.keys(catalogs.decor).length} decor)`);
