import { warn } from './diagnostics.js';

/**
 * Saved state, kept in the userscript manager's storage (GM_*) rather than the page's localStorage.
 *
 * localStorage belongs to the site: clearing that site's data wipes it, and each site the script
 * runs on has its own. GM storage belongs to the script, so it survives clearing site data and is the
 * same on every site the script matches.
 *
 * The same on every site also means the same for every account, and people play different accounts
 * on different sites. So what belongs to an account - egg luck, the minigame records, the activity
 * log window - is stored under that account's id (`accountValue`), while preferences and window
 * positions are stored once for everyone (`sharedValue`).
 *
 * Moving over. The first time a value is read on a site, whatever that site's localStorage held under
 * the old key is merged into GM storage, and the localStorage copy is left exactly where it was as a
 * backup. Each GM value carries the list of sites already merged into it, written in the same write as
 * the value itself, which is what keeps this from losing or doubling anything:
 *  - a site is merged once and never again, so deleting something later is not undone by its old copy;
 *  - if GM storage is lost (the script reinstalled), each site's copy is merged back in on its next visit;
 *  - two tabs on two sites moving at the same moment cannot drop each other: whichever writes last
 *    writes a value that lacks the other site's data and a list that lacks the other site, so that
 *    site is merged again on its next visit rather than silently left out.
 *
 * A site's localStorage never recorded whose it was, so its account data goes to the first account
 * seen on that site after the move (SITE_ACCOUNTS_KEY); any other account starts empty there.
 *
 * Without GM storage (a manager that refuses the grant) everything stays in localStorage as before,
 * per site and not keyed by account.
 */

/** Which account each site's old localStorage data was given to. */
const SITE_ACCOUNTS_KEY = 'gardenCompanion.siteAccounts.v1';

/** What GM storage holds for each value: the value, when there is one, and the sites merged into it. */
interface Saved { v?: unknown; sites: string[] }

/** Folds a site's old copy into what GM storage already has. Only ever called with both present. */
export type Merge<T> = (saved: T, incoming: T) => T;

interface Options<T> {
  /** How a site's old copy joins one already in GM storage. Left out, the one already there wins. */
  merge?: Merge<T>;
  /** Stored as a bare string rather than JSON, as a few of the oldest keys were. */
  raw?: boolean;
}

export interface Stored<T> {
  load(): T;
  /** False when the write did not land; the value is still kept for the rest of the session. */
  save(value: T): boolean;
}

const keepSaved = <T>(saved: T): T => saved;

let gmUsable: boolean | null = null;

function gmAvailable(): boolean {
  if (gmUsable === null) {
    try { GM_getValue(SITE_ACCOUNTS_KEY, null); gmUsable = typeof GM_setValue === 'function'; }
    catch { gmUsable = false; }
  }
  return gmUsable;
}

function currentSite(): string {
  try { return location.origin; } catch { return ''; }
}

/**
 * Each value as this tab last read or wrote it. A save writes back the sites list that came with the
 * value its caller last loaded, never a newer list read since from another tab, which would mark a
 * site merged whose data the value being written does not hold.
 */
const loaded = new Map<string, Saved>();

/** Values whose site copy has been dealt with this load: merged, found already in, or not ours to take. */
const moved = new Set<string>();

/** Values whose last write here did not land, so GM storage is behind what this tab holds. */
const unsaved = new Set<string>();

let account: string | null = null;
/** The account this site's old localStorage data belongs to, once one has been seen. */
let siteAccount: string | null = null;
const accountListeners: Array<() => void> = [];

function clone<T>(value: T): T {
  return value === null || typeof value !== 'object' ? value : structuredClone(value);
}

function readLocal(key: string, raw: boolean): { found: boolean; value?: unknown } {
  try {
    const text = localStorage.getItem(key);
    if (text === null) return { found: false };
    return { found: true, value: raw ? text : JSON.parse(text) };
  } catch { return { found: false }; }
}

function writeLocal(key: string, value: unknown, raw: boolean): boolean {
  try {
    if (value === null || value === undefined || (raw && value === '')) localStorage.removeItem(key);
    else localStorage.setItem(key, raw ? String(value) : JSON.stringify(value));
    return true;
  } catch { return false; }
}

function writeGm(gmKey: string, saved: Saved): boolean {
  loaded.set(gmKey, saved);
  // Kept in memory either way, so this session carries on; the site stays unmarked in GM storage
  // until a write lands, so a failed move is simply tried again on the next load.
  try {
    GM_setValue(gmKey, saved);
    unsaved.delete(gmKey);
    return true;
  } catch (error) {
    warn(`Could not save ${gmKey}.`, error);
    unsaved.add(gmKey);
    return false;
  }
}

function readGm(gmKey: string): Saved {
  try {
    const stored = GM_getValue<unknown>(gmKey, null) as Partial<Saved> | null;
    if (stored && typeof stored === 'object' && Array.isArray(stored.sites)) return stored as Saved;
  } catch {}
  return { sites: [] };
}

/**
 * The value under `gmKey`, with this site's old copy merged in first if it has not been yet.
 *
 * `fresh` reads GM storage again rather than this tab's copy, so a load sees what other tabs have
 * saved since - the planner reads its layouts right before adding one, and a stale list would write
 * another tab's new layout out of existence. A save reads nothing fresh: it writes back beside the
 * sites list its caller's value came with. A value this tab failed to write keeps this tab's copy,
 * since GM storage is behind it.
 */
function read<T>(gmKey: string, localKey: string, options: Options<T>, takeLocal: boolean, fresh: boolean): Saved {
  const known = loaded.get(gmKey);
  if (known && (!fresh || unsaved.has(gmKey))) return known;
  const saved = readGm(gmKey);
  const site = currentSite();
  if (moved.has(gmKey) || !takeLocal || !site || saved.sites.includes(site)) {
    // A site dropped by another tab's write is merged again on the next load, not mid-session.
    moved.add(gmKey);
    loaded.set(gmKey, saved);
    return saved;
  }
  moved.add(gmKey);
  const local = readLocal(localKey, Boolean(options.raw));
  const merged: Saved = { sites: [...saved.sites, site] };
  if ('v' in saved && local.found && local.value !== null) {
    try { merged.v = (options.merge ?? keepSaved)(saved.v as T, local.value as T); }
    catch (error) {
      // Left unmarked, so the old copy is still waiting to be merged next time rather than written off.
      warn(`Could not move ${localKey} over from this site's storage.`, error);
      loaded.set(gmKey, saved);
      return saved;
    }
  } else if ('v' in saved) merged.v = saved.v;
  else if (local.found) merged.v = local.value;
  writeGm(gmKey, merged);
  return merged;
}

function store<T>(gmKey: () => string | null, localKey: string, fallback: T, options: Options<T>, takeLocal: () => boolean): Stored<T> {
  return {
    load() {
      if (!gmAvailable()) {
        const local = readLocal(localKey, Boolean(options.raw));
        return clone(local.found ? ((local.value ?? fallback) as T) : fallback);
      }
      const key = gmKey();
      // Cloned like a saved value, so a caller editing what it was handed cannot change the default.
      if (!key) return clone(fallback);
      const saved = read(key, localKey, options, takeLocal(), true);
      return clone('v' in saved && saved.v !== null && saved.v !== undefined ? saved.v as T : fallback);
    },
    save(value) {
      if (!gmAvailable()) return writeLocal(localKey, value, Boolean(options.raw));
      const key = gmKey();
      // Account data cannot be filed before we know whose it is. Nothing that writes it runs before
      // the first room state, which is what names the account, so this is a guard and not a path.
      if (!key) return false;
      // Read first: this site's old copy has to be in before anything is written over it.
      const { sites } = read(key, localKey, options, takeLocal(), false);
      return writeGm(key, value === null || value === undefined ? { sites } : { v: clone(value), sites });
    },
  };
}

/** A value shared by every site and account, moved over from the localStorage key of the same name. */
export function sharedValue<T>(key: string, fallback: T, options: Options<T> = {}): Stored<T> {
  return store(() => key, key, fallback, options, () => true);
}

/**
 * A value kept per account, moved over from the localStorage key of the same name. Until the account
 * is known it loads as `fallback`, so anything holding it should reload on `onStorageAccountChange`.
 */
export function accountValue<T>(key: string, fallback: T, options: Options<T> = {}): Stored<T> {
  return store(() => (account ? `${key}@${account}` : null), key, fallback, options, () => account !== null && account === siteAccount);
}

export function storageAccount(): string | null {
  return account;
}

/** Called with our own player id whenever the room state names it. */
export function setStorageAccount(id: string | null): void {
  if (!id || id === account) return;
  account = id;
  siteAccount = claimSite(id);
  for (const listener of accountListeners) {
    try { listener(); } catch (error) { warn('Saved data could not be reloaded for this account.', error); }
  }
}

export function onStorageAccountChange(listener: () => void): void {
  accountListeners.push(listener);
}

/** The account this site's old data goes to: whichever was here first, or this one if none was. */
function claimSite(id: string): string | null {
  const site = currentSite();
  if (!gmAvailable() || !site) return null;
  try {
    const stored = GM_getValue<unknown>(SITE_ACCOUNTS_KEY, {}) as Record<string, unknown> | null;
    const claims = stored && typeof stored === 'object' ? { ...stored } : {};
    const owner = claims[site];
    if (typeof owner === 'string' && owner) return owner;
    claims[site] = id;
    GM_setValue(SITE_ACCOUNTS_KEY, claims);
    return id;
  } catch { return null; }
}

/** Merges a site's list into the saved one, keeping the saved order and adding what it lacks. */
export function mergeLists<T>(saved: T[], incoming: T[]): T[] {
  if (!Array.isArray(saved)) return Array.isArray(incoming) ? incoming : [];
  if (!Array.isArray(incoming)) return saved;
  return [...new Set([...saved, ...incoming])];
}

/**
 * A name not yet taken in `taken`, made by numbering `name`. `limit` keeps the numbered name within a
 * length the caller allows, trimming the name rather than the number.
 */
export function freeName(name: string, taken: (candidate: string) => boolean, limit = Infinity): string {
  for (let number = 2; ; number++) {
    const suffix = ` (${number})`;
    const candidate = `${name.slice(0, Math.max(1, limit - suffix.length))}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
}

/** Forgets everything this tab has read, as a fresh page load would. For tests. */
export function resetStorageForTests(): void {
  loaded.clear();
  moved.clear();
  unsaved.clear();
  account = null;
  siteAccount = null;
  gmUsable = null;
}
