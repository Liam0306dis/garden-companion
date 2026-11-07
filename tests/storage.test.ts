import { gmStore } from './setup.js';
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { accountValue, mergeLists, resetStorageForTests, setStorageAccount, sharedValue } from '../src/storage.js';

/**
 * Each site keeps its own localStorage, while GM storage is one store for all of them. A visit swaps
 * the page over to a site with whatever that site's localStorage held when it was last left, and
 * forgets what the script had read, as a page load would.
 */
const siteStorage = new Map<string, Record<string, string>>();
let currentSite = '';

function visit(origin: string): void {
  if (currentSite) siteStorage.set(currentSite, Object.fromEntries(Object.entries(localStorage)));
  (window as unknown as { happyDOM: { setURL(url: string): void } }).happyDOM.setURL(`${origin}/r/test-room`);
  currentSite = origin;
  localStorage.clear();
  for (const [key, value] of Object.entries(siteStorage.get(origin) ?? {})) localStorage.setItem(key, value);
  resetStorageForTests();
}

const WEB = 'https://magicgarden.gg';
const DISCORD = 'https://1227719606223765687.discordsays.com';

beforeEach(() => {
  gmStore.clear();
  siteStorage.clear();
  currentSite = '';
});

test('a shared value is moved over on first read, and the old copy is left as it was', () => {
  visit(WEB);
  localStorage.setItem('test.view', JSON.stringify({ zoom: 1.5 }));
  resetStorageForTests();
  assert.deepEqual(sharedValue('test.view', {}).load(), { zoom: 1.5 });
  assert.equal(localStorage.getItem('test.view'), JSON.stringify({ zoom: 1.5 }));
  visit(DISCORD);
  assert.deepEqual(sharedValue('test.view', {}).load(), { zoom: 1.5 }, 'the other site sees it too');
});

test('a second site does not overwrite a preference, but its list is merged in', () => {
  visit(WEB);
  localStorage.setItem('test.view', JSON.stringify({ zoom: 1.5 }));
  localStorage.setItem('test.list', JSON.stringify(['a', 'b']));
  visit(DISCORD);
  localStorage.setItem('test.view', JSON.stringify({ zoom: 1 }));
  localStorage.setItem('test.list', JSON.stringify(['b', 'c']));
  visit(WEB);
  sharedValue('test.view', {}).load();
  sharedValue<string[]>('test.list', [], { merge: mergeLists }).load();
  visit(DISCORD);
  assert.deepEqual(sharedValue('test.view', {}).load(), { zoom: 1.5 });
  assert.deepEqual(sharedValue<string[]>('test.list', [], { merge: mergeLists }).load(), ['a', 'b', 'c']);
});

test('a site is merged once: deleting something later is not undone by its old copy', () => {
  visit(WEB);
  localStorage.setItem('test.list', JSON.stringify(['a', 'b']));
  const list = () => sharedValue<string[]>('test.list', [], { merge: mergeLists });
  assert.deepEqual(list().load(), ['a', 'b']);
  list().save(['a']);
  visit(WEB);
  assert.deepEqual(list().load(), ['a']);
});

test('lost GM storage is filled back in from each site on its next visit', () => {
  visit(WEB);
  localStorage.setItem('test.list', JSON.stringify(['a']));
  sharedValue<string[]>('test.list', []).load();
  gmStore.clear();
  visit(WEB);
  assert.deepEqual(sharedValue<string[]>('test.list', []).load(), ['a']);
});

test('a site dropped by another tab writing at the same moment is merged again', () => {
  visit(WEB);
  localStorage.setItem('test.list', JSON.stringify(['web']));
  sharedValue<string[]>('test.list', [], { merge: mergeLists }).load();
  // The Discord tab read GM storage before the web tab's move reached it, and writes last.
  gmStore.set('test.list', { v: ['discord'], sites: [DISCORD] });
  visit(WEB);
  assert.deepEqual(sharedValue<string[]>('test.list', [], { merge: mergeLists }).load(), ['discord', 'web']);
});

test("a load sees what another tab saved since, and the default can't be edited through it", () => {
  visit(WEB);
  const layouts = () => sharedValue<Record<string, number>>('test.layouts', {});
  const empty = layouts().load();
  empty.stray = 1;
  assert.deepEqual(layouts().load(), {});
  layouts().save({ mine: 1 });
  gmStore.set('test.layouts', { v: { mine: 1, theirs: 2 }, sites: [WEB] });
  assert.deepEqual(layouts().load(), { mine: 1, theirs: 2 });
});

test('bare string values are read as they were stored', () => {
  visit(WEB);
  localStorage.setItem('test.shortcut', 'Ctrl+O');
  const shortcut = sharedValue<string>('test.shortcut', '', { raw: true });
  assert.equal(shortcut.load(), 'Ctrl+O');
  shortcut.save('');
  assert.equal(sharedValue<string>('test.shortcut', '', { raw: true }).load(), '');
});

test('account data waits for the account, then goes to the first account seen on the site', () => {
  const record = () => accountValue<Record<string, number>>('test.record', {});
  visit(WEB);
  localStorage.setItem('test.record', JSON.stringify({ runs: 4 }));
  resetStorageForTests();
  assert.deepEqual(record().load(), {}, 'nothing until the account is known');
  assert.equal(record().save({ runs: 9 }), false, 'nor is anything filed under no one');
  setStorageAccount('alice');
  assert.deepEqual(record().load(), { runs: 4 });
  visit(WEB);
  setStorageAccount('bob');
  assert.deepEqual(record().load(), {}, "another account on the same site does not get alice's data");
  record().save({ runs: 1 });
  visit(WEB);
  setStorageAccount('alice');
  assert.deepEqual(record().load(), { runs: 4 });
});

test("one account's data from two sites is merged, and other accounts are left alone", () => {
  const merge = (saved: Record<string, number>, incoming: Record<string, number>) => ({ runs: saved.runs + incoming.runs });
  const record = () => accountValue<Record<string, number>>('test.record', {}, { merge });
  visit(WEB);
  localStorage.setItem('test.record', JSON.stringify({ runs: 4 }));
  setStorageAccount('alice');
  record().load();
  visit(DISCORD);
  localStorage.setItem('test.record', JSON.stringify({ runs: 3 }));
  setStorageAccount('alice');
  assert.deepEqual(record().load(), { runs: 7 });
  visit(DISCORD);
  setStorageAccount('alice');
  assert.deepEqual(record().load(), { runs: 7 }, 'and only once');
});

test('without GM storage everything stays in localStorage', () => {
  visit(WEB);
  const getValue = globalThis.GM_getValue;
  (globalThis as Record<string, unknown>).GM_getValue = () => { throw new Error('not granted'); };
  try {
    resetStorageForTests();
    localStorage.setItem('test.view', JSON.stringify({ zoom: 1.5 }));
    const view = sharedValue('test.view', {});
    assert.deepEqual(view.load(), { zoom: 1.5 });
    view.save({ zoom: 1 });
    assert.equal(localStorage.getItem('test.view'), JSON.stringify({ zoom: 1 }));
  } finally {
    (globalThis as Record<string, unknown>).GM_getValue = getValue;
  }
});

test("egg luck from two sites adds up, and a counter both saw becomes the higher floor", async () => {
  const { eggLuckSignature } = await import('../src/features/egg-luck.js');
  const egg = (hatches: number, misses: number) => JSON.stringify({
    CommonEgg: { hatches, pulls: hatches, species: { Worm: hatches }, colours: {}, speciesColours: {}, counters: { Gold: { misses, synced: true } } },
  });
  visit(WEB);
  localStorage.setItem('gardenCompanion.eggLuck.v1', egg(5, 5));
  setStorageAccount('alice');
  visit(DISCORD);
  localStorage.setItem('gardenCompanion.eggLuck.v1', egg(3, 2));
  setStorageAccount('alice');
  const record = JSON.parse(eggLuckSignature()).CommonEgg;
  assert.equal(record.hatches, 8);
  assert.equal(record.species.Worm, 8);
  assert.deepEqual(record.counters.Gold, { misses: 5, synced: false });
});
