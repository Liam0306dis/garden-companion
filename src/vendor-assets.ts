import { page } from './page.js';
import { VENDOR_URLS } from './vendor-urls.js';

/**
 * Third-party files the sprite loader needs - the texture transcoder's wasm and the Rive runtimes -
 * fetched only when sprites actually have to be built, and kept in IndexedDB afterwards. They used
 * to travel inside the userscript, which carried and parsed them on every page load for the sake of
 * the rare load that decodes anything. Each URL pins an exact version, and the wasm is also checked
 * against the hash of the copy the script was built and tested with.
 */
const DB_NAME = 'gardenCompanionVendor';
const STORE = 'files';

let connection: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  return connection ??= new Promise(resolve => {
    try {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

async function readStored<T>(url: string): Promise<T | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise(resolve => {
    try {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(url);
      request.onsuccess = () => resolve((request.result as T) ?? null);
      request.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

/** Stores a file and drops any whose URL is no longer one we use - an older pinned version. */
async function store(url: string, value: string | ArrayBuffer): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const files = db.transaction(STORE, 'readwrite').objectStore(STORE);
    files.put(value, url);
    const keys = files.getAllKeys();
    keys.onsuccess = () => {
      for (const key of keys.result) if (typeof key === 'string' && !VENDOR_URLS.has(key)) files.delete(key);
    };
  } catch {}
}

/**
 * The page's own content policy can forbid the host these live on - a Discord activity allows its
 * own origin and nothing else. The userscript runs outside that policy, so it fetches on the page's
 * behalf. Binary files come back base64 encoded, so only a string crosses between the two.
 */
function viaUserscript(url: string, binary: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const bridge = page.__gardenCompanionVendorSource;
    if (typeof bridge !== 'function') { reject(new Error('No way to fetch outside the page policy.')); return; }
    bridge(url, text => (text ? resolve(text) : reject(new Error(`${url} could not be fetched.`))), binary);
  });
}

async function download(url: string, binary: boolean): Promise<string | ArrayBuffer> {
  try {
    const response = await fetch(url);
    if (response.ok) return binary ? await response.arrayBuffer() : await response.text();
  } catch {}
  const text = await viaUserscript(url, binary);
  if (!binary) return text;
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
  return bytes.buffer;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  let raw = '';
  for (const byte of digest) raw += String.fromCharCode(byte);
  return btoa(raw);
}

const inflight = new Map<string, Promise<string | ArrayBuffer>>();

function load(url: string, binary: boolean, expectedHash?: string): Promise<string | ArrayBuffer> {
  let pending = inflight.get(url);
  if (pending) return pending;
  pending = (async () => {
    const check = async (value: string | ArrayBuffer) =>
      !expectedHash || (value instanceof ArrayBuffer && await sha256(value) === expectedHash);
    const stored = await readStored<string | ArrayBuffer>(url);
    if (stored != null && await check(stored)) return stored;
    const fresh = await download(url, binary);
    if (!await check(fresh)) throw new Error(`${url} did not match the expected file.`);
    void store(url, fresh);
    return fresh;
  })();
  // A failure is not remembered, so the next attempt fetches again.
  pending.catch(() => inflight.delete(url));
  inflight.set(url, pending);
  return pending;
}

export function vendorText(url: string): Promise<string> {
  return load(url, false) as Promise<string>;
}

export function vendorBytes(url: string, expectedHash: string): Promise<ArrayBuffer> {
  return load(url, true, expectedHash) as Promise<ArrayBuffer>;
}
