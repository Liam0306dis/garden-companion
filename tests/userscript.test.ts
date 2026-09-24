import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

/** Checks on the built userscript itself: what users actually install. Run after `npm run build`. */
const root = resolve(import.meta.dirname, '..');
const built = await readFile(resolve(root, 'dist', 'garden-companion.user.js'), 'utf8');
const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { version: string };
const header = built.slice(0, built.indexOf('// ==/UserScript==') + 18);

test('the header matches the package and asks only for what it uses', () => {
  assert.match(header, new RegExp(`// @version\\s+${packageJson.version.replace(/\./g, '\\.')}\\n`));
  assert.deepEqual([...header.matchAll(/@grant\s+(\S+)/g)].map(match => match[1]).sort(), ['GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest', 'unsafeWindow']);
  assert.deepEqual([...header.matchAll(/@connect\s+(\S+)/g)].map(match => match[1]).sort(), ['ariedam.fr', 'raw.githubusercontent.com', 'unpkg.com']);
  assert.match(header, /@run-at\s+document-start/);
});

test('nothing third-party is imported from a CDN except the pinned Rive runtime', () => {
  const cdn = [...new Set([...built.matchAll(/https:\/\/unpkg\.com\/[^'"`\s\\]+/g)].map(match => match[0]))];
  assert.deepEqual(cdn, ['https://unpkg.com/@rive-app/canvas-single@2.38.5/rive.js']);
  assert.ok(built.includes('BasisUniversal'), 'the transcoder is bundled');
});

test('no em dashes reach users', () => {
  assert.equal(built.includes('—'), false);
});

test('the lockfile carries the same version', async () => {
  const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8')) as { version: string; packages: Record<string, { version: string }> };
  assert.equal(lock.version, packageJson.version);
  assert.equal(lock.packages[''].version, packageJson.version);
});
