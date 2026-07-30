import { build } from 'esbuild';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const workspace = resolve(root, '..');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string };
const wasmSource = await readFile(resolve(workspace, 'wasm_b64.js'), 'utf8');
const wasmBase64 = wasmSource.match(/window\._WASM_B64\s*=\s*'([A-Za-z0-9+/=]+)'/)?.[1];
if (!wasmBase64) throw new Error('Pet sprite decoder data was not found.');

interface BundleCatalogs {
  abilities: string[];
  abilityDetails: Record<string, { name: string; trigger: string; baseProbability?: number; baseParameters?: Record<string, number> }>;
  pets: Record<string, { name: string; maxHunger: number; maxScale: number; hoursToMature: number }>;
}

async function catalogsFromBundle(): Promise<BundleCatalogs> {
  const bundleRoot = resolve(workspace, 'mgafk-pi', 'json');
  const directories = (await readdir(bundleRoot, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && /^bundle-\d+-\d+$/.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));

  for (const directory of directories) {
    const files = (await readdir(resolve(bundleRoot, directory))).filter(name => /^main-.*\.js$/.test(name));
    for (const file of files) {
      const bundle = await readFile(resolve(bundleRoot, directory, file), 'utf8');
      if (!bundle.includes('innateAbilityWeights')) continue;
      const matches = [...bundle.matchAll(/([A-Za-z][A-Za-z0-9_]+):\{name:`([^`]+)`,trigger:`([^`]+)`(?:,baseProbability:([0-9.e+-]+))?(?:,baseParameters:\{([^}]*)\})?/g)];
      if (matches.length > 0) {
        const abilityDetails = Object.fromEntries(matches.map(match => {
          const baseParameters = Object.fromEntries(
            [...(match[5] || '').matchAll(/([A-Za-z][A-Za-z0-9_]*):([0-9.e+-]+)/g)]
              .map(parameter => [parameter[1], Number(parameter[2])]),
          );
          return [match[1], {
            name: match[2],
            trigger: match[3],
            ...(match[4] ? { baseProbability: Number(match[4]) } : {}),
            ...(Object.keys(baseParameters).length ? { baseParameters } : {}),
          }];
        }));
        const petMatches = [...bundle.matchAll(/([A-Za-z][A-Za-z0-9_]+):\{sprite:U\.Pet\.([A-Za-z][A-Za-z0-9_]+),name:`([^`]+)`,coinsToFullyReplenishHunger:([0-9.e+-]+),innateAbilityWeights:\{[^}]*\},maxScale:([0-9.e+-]+),.*?hoursToMature:([0-9.e+-]+)/g)];
        if (!petMatches.length) continue;
        const pets = Object.fromEntries(petMatches.map(match => [match[1], {
          name: match[3],
          maxHunger: Number(match[4]),
          maxScale: Number(match[5]),
          hoursToMature: Number(match[6]),
        }]));
        return { abilities: Object.keys(abilityDetails).sort(), abilityDetails, pets };
      }
    }
  }
  throw new Error('No ability catalog was found in the captured game bundles.');
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
  catalogsFromBundle(),
  readFile(resolve(root, 'src', 'style.css'), 'utf8'),
]);

const petSpriteBuild = await build({
  entryPoints: [resolve(root, 'src', 'pet-sprites-page.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  charset: 'utf8',
  legalComments: 'none',
  write: false,
  define: {
    __PET_CATALOG__: JSON.stringify(catalogs.pets),
    __PET_WASM_B64__: JSON.stringify(wasmBase64),
  },
});
const petSpriteLoader = petSpriteBuild.outputFiles[0].text;

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
    __PET_SPRITE_LOADER__: JSON.stringify(petSpriteLoader),
    __GARDEN_COMPANION_CSS__: JSON.stringify(css),
  },
});

const output = await readFile(resolve(root, 'dist', 'garden-companion.user.js'), 'utf8');
if (output.includes('\u2014')) throw new Error('The generated userscript contains an em dash.');
console.log(`Built dist/garden-companion.user.js (${output.length.toLocaleString()} characters, ${catalogs.abilities.length} abilities, ${Object.keys(catalogs.pets).length} pets)`);
