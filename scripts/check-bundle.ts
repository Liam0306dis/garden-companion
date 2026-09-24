import { readFile, readdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { catalogsFromSnapshots } from './bundle-catalogs.js';
import { argValue, pullSnapshot, readSnapshot, ROOT, type Snapshot } from './bundle-snapshot.js';

/**
 * Game-bundle drift check for what garden-companion depends on.
 *
 * Pulls the live bundle into `bundles/` (or reads one with `--dir <snapshot>`) and checks:
 *   - every command the companion sends inside the QuinoaCommand envelope is still wrapped by the
 *     game, and every one it sends bare is still sent bare - read from the companion's own source,
 *     so the list cannot fall behind it;
 *   - the envelope still carries exactly the fields the sequencer stamps;
 *   - the weather forecast fields and weather ids the timer and alarms read;
 *   - the connection and map markers the socket hooks and scenes read;
 *   - that the build can still scrape its catalogs out of this bundle.
 *
 * Exit code: 0 = no drift, 1 = drift, 2 = error. Usage:
 *   npm run check-bundle                                    # pull live, then check
 *   npm run check-bundle -- --dir bundles/bundle-1260-20260924   # check a capture offline
 */

/** Fields the envelope literal holds. `scopePath` is merged in by the send call, not the literal. */
const EXPECTED_ENVELOPE_FIELDS = ['command', 'commandSequence', 'requestId', 'type'];

/** Weather ids the timer, alarms and weather-shop keybind are keyed by. */
const WEATHER_IDS = ['Rain', 'Frost', 'Thunderstorm', 'Dawn', 'AmberMoon'];

/** Names the socket hooks, sequencer and world scenes read straight off the game. */
const SCHEMA_MARKERS = [
  'selfPlayerId',
  'executedCommandSequence',
  'lastDistributedRoomPublication',
  'subscribeToPatches',
  'MagicCircle_RoomConnection',
  'currentWebSocket',
  'userSlotIdxAndDirtTileIdxToGlobalTileIdx',
  'userSlotIdxAndBoardwalkTileIdxToGlobalTileIdx',
  'activityLogs',
  'secondsUntilRestock',
  'shopPurchases',
];

async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

export interface SentCommands { wrapped: Map<string, Set<string>>; bare: Map<string, Set<string>> }

/** Every command type the companion puts on the wire, split by how it is sent. */
export async function companionCommands(srcDir = resolve(ROOT, 'src')): Promise<SentCommands> {
  const wrapped = new Map<string, Set<string>>();
  const bare = new Map<string, Set<string>>();
  const note = (target: Map<string, Set<string>>, type: string, file: string) => {
    if (!target.has(type)) target.set(type, new Set());
    target.get(type)!.add(file);
  };
  for (const file of await walkTs(srcDir)) {
    const text = await readFile(file, 'utf8');
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    for (const match of text.matchAll(/sendQuinoaCommand\(\{\s*type:\s*'([A-Z]\w+)'/g)) note(wrapped, match[1], rel);
    for (const match of text.matchAll(/type:\s*'QuinoaCommand',[\s\S]{0,120}?command:\s*\{\s*type:\s*'([A-Z]\w+)'/g)) note(wrapped, match[1], rel);
    for (const match of text.matchAll(/sendBareCommand\(\{\s*type:\s*'([A-Z]\w+)'/g)) note(bare, match[1], rel);
    for (const match of text.matchAll(/scopePath:\s*\['Room',\s*'Quinoa'\],\s*type:\s*'([A-Z]\w+)'/g)) {
      if (match[1] !== 'QuinoaCommand') note(bare, match[1], rel);
    }
  }
  return { wrapped, bare };
}

/** Top-level keys of the envelope literal the game's wrapper builds. */
export function envelopeFields(source: string): Set<string> {
  const out = new Set<string>();
  const at = source.indexOf('`QuinoaCommand`,requestId');
  if (at < 0) return out;
  const open = source.lastIndexOf('{', at);
  let depth = 0;
  let key = '';
  for (let index = open; index < source.length; index++) {
    const char = source[index];
    if ('{[('.includes(char)) { depth++; key = ''; continue; }
    if ('}])'.includes(char)) { depth--; key = ''; if (depth === 0) break; continue; }
    if (depth !== 1) continue;
    if (char === ',') { key = ''; continue; }
    if (char === ':') { if (/^[A-Za-z_$][\w$]*$/.test(key)) out.add(key); key = ''; continue; }
    key += char;
  }
  return out;
}

/** Commands the game dispatches through a sender: type-first literals handed to a function. */
export function dispatchedByGame(source: string): Set<string> {
  return new Set([...source.matchAll(/[(=]\{type:`([A-Z][A-Za-z0-9_]*)`/g)].map(match => match[1]));
}

/**
 * Commands the game sends bare, outside the envelope.
 *
 * The bare sender is one small function - `sendMessage({scopePath:[`Room`,`Quinoa`],...e})` - but
 * every chunk reaches it under its own minified alias, so a type-first literal alone cannot say
 * which sender it went to. Each file's exports and imports are followed to learn every local name
 * the bare sender goes by, and only calls through one of those count.
 */
export function bareByGame(files: Map<string, string>): Set<string> {
  const bareLocal = new Map<string, Set<string>>();
  const exported = new Map<string, Map<string, string>>();
  for (const [file, text] of files) {
    const local = new Set<string>();
    for (const match of text.matchAll(/function\s*([A-Za-z_$][\w$]*)\(([A-Za-z_$][\w$]*)\)\{[^{}]*?sendMessage\(\{scopePath:\[`Room`,`Quinoa`\],\.\.\.\2\}\)/g)) local.add(match[1]);
    bareLocal.set(file, local);
    const names = new Map<string, string>();
    for (const block of text.matchAll(/export\{([^}]*)\}/g)) {
      for (const part of block[1].split(',')) {
        const [from, to] = part.trim().split(/\s+as\s+/);
        if (from) names.set(to ?? from, from);
      }
    }
    exported.set(file, names);
  }
  const bare = new Set<string>();
  for (const [file, text] of files) {
    const aliases = new Set(bareLocal.get(file));
    for (const block of text.matchAll(/import\{([^}]*)\}from\s*["'`]\.\/([^"'`]+)["'`]/g)) {
      const source = block[2];
      for (const part of block[1].split(',')) {
        const [name, alias] = part.trim().split(/\s+as\s+/);
        const local = exported.get(source)?.get(name);
        if (local && bareLocal.get(source)?.has(local)) aliases.add(alias ?? name);
      }
    }
    const compact = text.replace(/\s+/g, '');
    for (const alias of aliases) {
      const call = new RegExp(`(?<![\\w$])${alias.replace(/\$/g, '\\$')}\\(\\{type:\`([A-Z][A-Za-z0-9_]*)\``, 'g');
      for (const match of compact.matchAll(call)) bare.add(match[1]);
    }
    for (const match of compact.matchAll(/sendMessage\(\{scopePath:\[`Room`,`Quinoa`\],type:`([A-Z][A-Za-z0-9_]*)`/g)) bare.add(match[1]);
  }
  return bare;
}

export function typeLiteralPresent(source: string, type: string): boolean {
  return new RegExp(`type:\`${type}\``).test(source);
}

export interface CheckResult { drift: string[]; warnings: string[]; ok: string[] }

export async function checkSnapshot(snapshot: Snapshot, sent: SentCommands): Promise<CheckResult> {
  const result: CheckResult = { drift: [], warnings: [], ok: [] };
  const source = [...snapshot.files.values()].join('\n').replace(/\s+/g, '');
  if (snapshot.failed.length) {
    result.warnings.push(`${snapshot.failed.length} chunk(s) failed to download - anything reported missing may just be missing from this capture.`);
  }

  const bare = bareByGame(snapshot.files);
  const dispatched = dispatchedByGame(source);
  if (!bare.size) result.drift.push('could not find the game\'s bare sender (minified layout changed) - wrapped and bare commands cannot be told apart');
  for (const [type, files] of [...sent.wrapped].sort()) {
    if (!typeLiteralPresent(source, type)) result.drift.push(`${type} (sent by ${[...files].join(', ')}) no longer exists in the bundle`);
    else if (bare.has(type) || !dispatched.has(type)) result.drift.push(`${type} is sent wrapped by ${[...files].join(', ')}, but the game now sends it bare`);
    else result.ok.push(`wrapped ${type}`);
  }
  for (const [type, files] of [...sent.bare].sort()) {
    if (!typeLiteralPresent(source, type)) result.drift.push(`${type} (sent bare by ${[...files].join(', ')}) no longer exists in the bundle`);
    else if (!bare.has(type) && dispatched.has(type)) result.drift.push(`${type} is sent bare by ${[...files].join(', ')}, but the game now wraps it in the QuinoaCommand envelope`);
    else result.ok.push(`bare ${type}`);
  }

  const fields = [...envelopeFields(source)].sort();
  if (!fields.length) result.drift.push('could not read the QuinoaCommand envelope literal (minified layout changed)');
  else {
    const added = fields.filter(field => !EXPECTED_ENVELOPE_FIELDS.includes(field));
    const gone = EXPECTED_ENVELOPE_FIELDS.filter(field => !fields.includes(field));
    for (const field of added) result.drift.push(`new envelope field ${field} - game-connection.ts must set it`);
    for (const field of gone) result.drift.push(`envelope field ${field} is gone - stop sending it`);
    if (!added.length && !gone.length) result.ok.push(`envelope fields ${fields.join(', ')}`);
  }

  const forecastFields: Array<[string, RegExp]> = [
    ['weather', /[,{]weather:null[,}]/],
    ['weatherWindow', /[,{]weatherWindow:null[,}]/],
    ['weatherForecast', /[,{]weatherForecast:\[\]/],
  ];
  for (const [field, pattern] of forecastFields) {
    if (pattern.test(source)) result.ok.push(`room state field ${field}`);
    else result.drift.push(`room state field ${field} not found - the weather timer and alarms read it`);
  }
  for (const id of WEATHER_IDS) {
    if (new RegExp(`\\.${id}\\]:\\{groupId:`).test(source)) result.ok.push(`weather ${id}`);
    else result.drift.push(`weather ${id} is no longer defined - weather-timer.ts and keybinds.ts key on it`);
  }
  if (/\.Lunar\]:\{durationMinutes:/.test(source)) result.ok.push('weather group Lunar');
  else result.warnings.push('weather group Lunar not found - weather-forecast.ts matches groupId "Lunar"');

  for (const marker of SCHEMA_MARKERS) {
    if (source.includes(marker)) result.ok.push(`marker ${marker}`);
    else result.warnings.push(`marker ${marker} not found in the bundle`);
  }

  try {
    const catalogs = await catalogsFromSnapshots([snapshot.dir]);
    result.ok.push(`catalogs (${catalogs.abilities.length} abilities, ${Object.keys(catalogs.pets).length} pets, ${Object.keys(catalogs.plants).length} plants)`);
  } catch (error) {
    result.drift.push(`the build cannot scrape its catalogs from this bundle: ${(error as Error).message}`);
  }
  return result;
}

async function main(): Promise<void> {
  const dir = argValue('--dir');
  let snapshot: Snapshot;
  if (dir) snapshot = await readSnapshot(resolve(dir));
  else {
    console.log('pulling live game bundle...');
    snapshot = await pullSnapshot(argValue('--origin') ?? undefined, text => process.stdout.write(text));
    process.stdout.write('\n');
  }
  console.log(`bundle drift check: ${relative(ROOT, snapshot.dir)}${snapshot.version ? ` (game version ${snapshot.version})` : ''}, ${snapshot.files.size} files\n`);
  const result = await checkSnapshot(snapshot, await companionCommands());
  for (const line of result.ok) console.log(`  OK     ${line}`);
  for (const line of result.warnings) console.log(`  WARN   ${line}`);
  for (const line of result.drift) console.log(`  DRIFT  ${line}`);
  if (!result.drift.length) {
    console.log(`\nNo drift${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}.`);
    process.exit(0);
  }
  console.log(`\n${result.drift.length} drift difference(s).`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch(error => { console.error('check failed:', (error as Error).message); process.exit(2); });
}
