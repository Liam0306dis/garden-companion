import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { catalogsFromSnapshots } from './bundle-catalogs.js';
import { argValue, ensureLatestSnapshot, ROOT as root, snapshotDirs } from './bundle-snapshot.js';
import { buildSpriteLoader } from './sprite-loader-build.js';

const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string };

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

// A guarantee is a few dozen pulls, a hundred or so at most. Anything outside that is a misread -
// 0.8.92 shipped every egg at 4,294,967,295 after a minified name resolved to the wrong constant -
// so the build refuses rather than putting it in front of players.
const badThresholds = Object.entries(catalogs.eggs).flatMap(([egg, { pityThresholds }]) =>
  Object.entries(pityThresholds).filter(([, pulls]) => !Number.isInteger(pulls) || pulls < 1 || pulls > 1000).map(([species, pulls]) => `${egg}.${species}=${pulls}`));
if (badThresholds.length) throw new Error(`Egg pity thresholds look misread: ${badThresholds.join(', ')}`);

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

// The caps are matched out of the game's item catalog by shape. A game update that reshapes it
// would leave this empty, and every capped tool would quietly go back to alarming at 99, so an
// empty list is called out rather than built in silence.
if (!Object.keys(catalogs.toolLimits).length) {
  console.warn('WARNING: no tool inventory caps (maxInventoryQuantity) were found in the bundle - shop alarms will not skip capped tools. Check the pattern in scripts/bundle-catalogs.ts.');
}

const petSpriteLoader = await buildSpriteLoader(catalogs, { withoutSprites });

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
