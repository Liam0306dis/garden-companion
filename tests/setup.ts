/**
 * Test environment. Imported first by every test file, before any source module, so everything the
 * userscript expects at load time exists: a DOM, the userscript manager's GM_* functions, and the
 * build-time catalog constants the bundler would normally inline - read from the same captured game
 * bundle the build uses, so tests run against the real catalogs.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { catalogsFromSnapshots } from '../scripts/bundle-catalogs.js';
import { snapshotDirs } from '../scripts/bundle-snapshot.js';

GlobalRegistrator.register({ url: 'https://magicgarden.gg/r/test-room', width: 1280, height: 800 });

const dirs = await snapshotDirs();
if (!dirs.length) throw new Error('Tests need a captured game bundle: run `npm run check-bundle` (or `npm run build`) first.');
export const catalogs = await catalogsFromSnapshots(dirs);

const globals = globalThis as Record<string, unknown>;
Object.assign(globals, {
  __ABILITY_CATALOG__: catalogs.abilities,
  __ABILITY_DETAILS__: catalogs.abilityDetails,
  __PET_CATALOG__: catalogs.pets,
  __PLANT_CATALOG__: catalogs.plants,
  __EGG_CATALOG__: catalogs.eggs,
  __MUTATION_CATALOG__: catalogs.mutations,
  __DECOR_CATALOG__: catalogs.decor,
  __TOOL_LIMITS__: catalogs.toolLimits,
  __ABILITY_COLOURS__: catalogs.abilityColours,
  __PET_WASM_B64__: '',
  __PET_SPRITE_LOADER__: '',
  __GARDEN_COMPANION_CSS__: '',
});

/** What the userscript saved through GM_setValue, readable by tests. */
export const gmStore = new Map<string, unknown>();
/** Requests made through GM_xmlhttpRequest; none are answered unless a test answers them. */
export const gmRequests: Array<Record<string, any>> = [];
Object.assign(globals, {
  GM_getValue: (key: string, fallback: unknown) => (gmStore.has(key) ? structuredClone(gmStore.get(key)) : fallback),
  GM_setValue: (key: string, value: unknown) => { gmStore.set(key, structuredClone(value)); },
  GM_info: { script: { version: '9.9.9-test' } },
  GM_xmlhttpRequest: (request: Record<string, any>) => { gmRequests.push(request); },
});

/**
 * A stand-in for the game's room socket: open, and recording what is sent. `receive` delivers a
 * frame the way the server would.
 */
export class FakeSocket extends EventTarget {
  readyState: number = WebSocket.OPEN;
  sent: string[] = [];
  url = 'wss://magicgarden.gg/api/rooms/test-room/connect';
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = WebSocket.CLOSED; }
  receive(frame: unknown): void {
    this.dispatchEvent(new MessageEvent('message', { data: typeof frame === 'string' ? frame : JSON.stringify(frame) }));
  }
  /** The commands sent inside the QuinoaCommand envelope, unwrapped. */
  commands(): Array<Record<string, any>> {
    return this.sent.map(data => JSON.parse(data)).map(frame => (frame.type === 'QuinoaCommand' ? frame.command : frame));
  }
}

/** Lets queued microtasks (state notifications, awaited promises) run. */
export function flushMicrotasks(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}
