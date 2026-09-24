import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, posix, resolve } from 'node:path';

/**
 * Captured copies of the game's own client bundle. The build reads its catalogs out of one, and the
 * drift checks compare what this script reaches for against one, so a clone has to be able to make
 * its own: `npm run check-bundle` pulls the live bundle into `bundles/bundle-<version>-<date>/`.
 *
 * The snapshots are the game's code, so they are gitignored and never published with the script.
 */

export const ROOT = resolve(import.meta.dirname, '..');
export const BUNDLES_DIR = resolve(ROOT, 'bundles');
export const DEFAULT_ORIGIN = 'https://magicgarden.gg';

const SNAPSHOT_NAME = /^bundle-\d+-\d+$/;

export interface Snapshot {
  dir: string;
  version: string | null;
  /** Every captured script, by file name. */
  files: Map<string, string>;
  /** Chunks the pull could not fetch. Anything reported missing may just be missing from here. */
  failed: Array<{ name: string; error: string }>;
  externalScripts: string[];
}

/** Snapshot folders, newest build first. */
export async function snapshotDirs(root = BUNDLES_DIR): Promise<string[]> {
  if (!existsSync(root)) return [];
  return (await readdir(root, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && SNAPSHOT_NAME.test(entry.name))
    .map(entry => entry.name)
    .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .map(name => resolve(root, name));
}

export async function readSnapshot(dir: string): Promise<Snapshot> {
  let version: string | null = null;
  let failed: Snapshot['failed'] = [];
  let externalScripts: string[] = [];
  try {
    const meta = JSON.parse(await readFile(resolve(dir, '_meta.json'), 'utf8'));
    version = meta.version || null;
    if (Array.isArray(meta.failed)) failed = meta.failed;
    if (Array.isArray(meta.externalScripts)) externalScripts = meta.externalScripts;
  } catch { /* an older capture without metadata */ }
  const files = new Map<string, string>();
  for (const name of (await readdir(dir)).filter(name => name.endsWith('.js'))) {
    files.set(name, await readFile(resolve(dir, name), 'utf8'));
  }
  return { dir, version, files, failed, externalScripts };
}

/** GET with redirects. Node's fetch decodes gzip and brotli itself. */
async function get(url: string): Promise<string> {
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

/**
 * Same-origin `.js` chunks a script refers to (static imports, dynamic imports, the preload map),
 * plus the external scripts it names. Bare file names are skipped: embedded package metadata holds
 * entries like "rive.js" that are not module references.
 */
export function extractChunkReferences(source: string, assetsBase: string): { chunks: Array<{ name: string; url: string }>; externalScripts: string[] } {
  const chunks = new Map<string, { name: string; url: string }>();
  const externalScripts = new Set<string>();
  const assetsUrl = new URL(assetsBase);
  for (const match of source.matchAll(/["'`]([^"'`\s]+\.js(?:[?#][^"'`\s]*)?)["'`]/g)) {
    const ref = match[1];
    let url: URL;
    if (/^https?:\/\//i.test(ref)) {
      url = new URL(ref);
      if (url.origin !== assetsUrl.origin) { externalScripts.add(url.toString()); continue; }
    } else if (ref.startsWith('./') || ref.startsWith('../')) url = new URL(ref, assetsUrl);
    else if (ref.startsWith('assets/')) url = new URL(ref.slice('assets/'.length), assetsUrl);
    else if (ref.startsWith('/')) url = new URL(ref, assetsUrl.origin);
    else continue;
    if (url.origin !== assetsUrl.origin || !url.pathname.startsWith(assetsUrl.pathname)) continue;
    const name = posix.basename(url.pathname);
    if (/^[A-Za-z0-9._-]+\.js$/.test(name)) chunks.set(url.toString(), { name, url: url.toString() });
  }
  return { chunks: [...chunks.values()], externalScripts: [...externalScripts] };
}

/** The version the live game is serving right now. */
export async function liveVersion(origin = DEFAULT_ORIGIN): Promise<string> {
  const version = String(JSON.parse(await get(`${origin.replace(/\/+$/, '')}/platform/v1/version`)).version || '').trim();
  if (!version) throw new Error('could not read the game version');
  return version;
}

/** The game version a snapshot folder was captured from, read from its name. */
export function snapshotVersion(dir: string): number {
  return Number(/bundle-(\d+)-\d+$/.exec(dir)?.[1] ?? NaN);
}

/**
 * Snapshot folders for a build, newest first, pulling the live bundle first when the game has moved
 * past the newest capture (or there is none). The game ships most days and a stale capture means
 * stale catalogs, so this is checked on every build rather than left to someone remembering.
 *
 * Offline, or with `offline` set, the newest existing capture is used as it is - a build should not
 * fail just because the game cannot be reached.
 */
export async function ensureLatestSnapshot(options: { offline?: boolean; log?: (text: string) => void } = {}): Promise<string[]> {
  const log = options.log ?? (text => process.stdout.write(text));
  const existing = await snapshotDirs();
  if (options.offline) {
    if (!existing.length) throw new Error('No captured game bundle in bundles/, and --offline was given.');
    return existing;
  }
  let version: string;
  try { version = await liveVersion(); }
  catch (error) {
    if (!existing.length) throw new Error(`No captured game bundle, and the live version could not be read: ${(error as Error).message}`);
    log(`Could not reach the game to check its version (${(error as Error).message}) - building from ${basename(existing[0])}.\n`);
    return existing;
  }
  if (existing.length && snapshotVersion(existing[0]) >= Number(version)) return existing;
  log(existing.length
    ? `The game is on version ${version}, newer than ${basename(existing[0])} - pulling the live bundle...`
    : 'No captured game bundle in bundles/ - pulling the live one...');
  const snapshot = await pullSnapshot(DEFAULT_ORIGIN, log);
  log('\n');
  if (snapshot.failed.length) {
    if (!existing.length) throw new Error(`${snapshot.failed.length} bundle chunk(s) failed to download; run the build again.`);
    log(`${snapshot.failed.length} chunk(s) failed to download, so the new capture was not kept - building from ${basename(existing[0])}.\n`);
    return existing;
  }
  return snapshotDirs();
}

/**
 * Pulls the whole live module graph into a new snapshot folder and returns it. The files land in a
 * `.partial` folder first and are only moved into place once every chunk arrived, so an interrupted
 * or incomplete pull can never become the newest capture a build reads.
 */
export async function pullSnapshot(origin = DEFAULT_ORIGIN, log: (text: string) => void = () => {}): Promise<Snapshot> {
  const base = origin.replace(/\/+$/, '');
  const version = await liveVersion(base);
  const html = await get(`${base}/`);
  const originUrl = new URL(base);
  const entryUrls = [...html.matchAll(/(?:src|href)=["']([^"']+\.js)["']/g)].map(match => new URL(match[1], originUrl));
  const localEntries = entryUrls.filter(url => url.origin === originUrl.origin);
  if (!localEntries.length) throw new Error('no same-origin script refs found in the root HTML');
  const assetsBase = new URL('.', localEntries.find(url => url.pathname.includes('/assets/')) ?? localEntries[0]).toString();

  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const finalDir = resolve(BUNDLES_DIR, `bundle-${version}-${date}`);
  const dir = `${finalDir}.partial`;
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, 'index.html'), html);

  const seen = new Set<string>();
  const queue = localEntries.map(url => ({ name: posix.basename(url.pathname), url: url.toString() }));
  const files = new Map<string, string>();
  const failed: Snapshot['failed'] = [];
  const externalScripts = new Set(entryUrls.filter(url => url.origin !== originUrl.origin).map(url => url.toString()));
  while (queue.length) {
    const { name, url } = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    let source: string;
    try { source = await get(url); }
    catch (error) { failed.push({ name, error: (error as Error).message }); continue; }
    await writeFile(resolve(dir, name), source);
    files.set(name, source);
    if (files.size % 25 === 0) log('.');
    const refs = extractChunkReferences(source, assetsBase);
    for (const external of refs.externalScripts) externalScripts.add(external);
    for (const chunk of refs.chunks) if (!seen.has(chunk.url)) queue.push(chunk);
  }
  // Recorded so an offline run can report the version, and so a partial pull is visible rather than
  // passing for drift.
  await writeFile(resolve(dir, '_meta.json'), JSON.stringify({
    version, date: new Date().toISOString(), files: files.size, failed, externalScripts: [...externalScripts],
  }, null, 2));
  if (failed.length) return { dir, version, files, failed, externalScripts: [...externalScripts] };
  // Complete, so it takes its real name - replacing a same-day capture of the same version.
  await rm(finalDir, { recursive: true, force: true });
  await rename(dir, finalDir);
  return { dir: finalDir, version, files, failed, externalScripts: [...externalScripts] };
}

/** `--flag value` from the command line. */
export function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}
