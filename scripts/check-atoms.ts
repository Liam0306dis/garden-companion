import { readFile, readdir, writeFile } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { escapeRegExp } from './bundle-catalogs.js';
import { argValue, readSnapshot, ROOT, snapshotDirs, type Snapshot } from './bundle-snapshot.js';

/**
 * Drift check for the game's jotai atoms the companion reaches into.
 *
 * Atom variables are minified and change every build, but the game gives each atom a stable
 * `debugLabel`, which is what the companion finds them by. For every label the source looks up,
 * this confirms the label is still defined in the captured bundle and counts references to its
 * variable, flagging one that is defined but barely used (dead, or wired to something transient).
 *
 * A label surviving is not enough on its own: bundle 1333 kept `activeModalStateAtom` but changed
 * its value from a bare modal id to `{ modal, openId }`, and every keybind that wrote the old shape
 * silently stopped opening anything. So each atom's initial value is also compared against the
 * baseline in atom-shapes.json, and any change is drift until someone has looked at it.
 *
 * Exit: 0 = no drift, 1 = a label is missing or its shape changed, 2 = error. Usage:
 *   npm run check-atoms                                         # newest snapshot in bundles/
 *   npm run check-atoms -- --dir bundles/bundle-1260-20260924   # a specific snapshot
 *   npm run check-atoms -- --accept                             # record current shapes as the baseline
 */

export const SHAPES_FILE = resolve(ROOT, 'scripts/atom-shapes.json');

/**
 * Labels deliberately no longer expected, each with the live atom that replaced it. Keep in step
 * with game-atoms.ts and the feature hooks; empty while the companion only looks up live atoms.
 */
const KNOWN_ABSENT: Record<string, string> = {};

/**
 * Atoms bundle 1206 folded into currentRoomAtom's state instance. They have no debugLabel and are
 * reached by property path (game-room-state.ts), so each is confirmed by its definition in the
 * room-state class body instead. `[A-Za-z_$]+(` is the game's atom factory under whatever minified
 * name it has this build.
 */
const FIELD_ATOMS: Array<{ name: string; where: string; pattern: RegExp }> = [
  { name: 'currentRoomAtom.isCinematicMode', where: 'game-atoms.ts', pattern: /[;{]isCinematicMode=[A-Za-z_$]+\(!1\)/ },
  { name: 'currentRoomAtom.toasts', where: 'features/levelup-silencer.ts', pattern: /[;{]toasts=[A-Za-z_$]+\(\[\]\)/ },
];

/** Below this many references in its defining file, a label is only its own definition. */
const LOW_REF_THRESHOLD = 3;

async function walkTs(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walkTs(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

/**
 * Every atom label the companion looks up: string literals ending in `Atom` in a value position -
 * an argument, array element, assignment or property value. A literal may carry a leading path
 * segment (`endsWith('/isCinematicModeAtom')`), so the trailing name is what is captured.
 */
export async function companionAtomLabels(srcDir = resolve(ROOT, 'src')): Promise<Map<string, Set<string>>> {
  const labels = new Map<string, Set<string>>();
  for (const file of await walkTs(srcDir)) {
    const text = await readFile(file, 'utf8');
    const rel = relative(srcDir, file).replace(/\\/g, '/');
    for (const match of text.matchAll(/[=:([,]\s*['"`][^'"`]*?([A-Za-z_][A-Za-z0-9_]*Atom)['"`]/g)) {
      if (match[1] === 'JotaiAtom') continue;
      if (!labels.has(match[1])) labels.set(match[1], new Set());
      labels.get(match[1])!.add(rel);
    }
  }
  return labels;
}

/** Where a label is defined and how often its variable is referenced in that file. */
export function locateAtom(label: string, snapshot: Snapshot): { file: string; refs: number } | null {
  const definition = new RegExp('([A-Za-z_$][A-Za-z0-9_$]*)\\.debugLabel=`' + escapeRegExp(label) + '`');
  for (const [file, text] of snapshot.files) {
    const match = text.match(definition);
    if (!match) continue;
    const token = new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(match[1])}(?![A-Za-z0-9_$])`, 'g');
    return { file, refs: (text.match(token) || []).length };
  }
  return null;
}

/**
 * The source text of an atom's initial value: the second argument to the game's
 * `jotaiAtomCache.get(\`.../label\`, <init>)`, read up to its balanced closing paren. Quoted text is
 * skipped so a bracket inside a string cannot unbalance the scan.
 */
export function atomInitializer(label: string, source: string): string | null {
  const start = source.match(new RegExp('jotaiAtomCache\\.get\\(`[^`]*/' + escapeRegExp(label) + '`,'));
  if (start?.index === undefined) return null;
  let depth = 1, quote = '';
  const from = start.index + start[0].length;
  for (let index = from; index < source.length; index++) {
    const char = source[index];
    if (quote) {
      if (char === '\\') index++;
      else if (char === quote) quote = '';
    } else if (char === '`' || char === '"' || char === "'") quote = char;
    else if ('([{'.includes(char)) depth++;
    else if (')]}'.includes(char) && --depth === 0) return source.slice(from, index);
  }
  return null;
}

/**
 * An initializer with the minifier's noise taken out, so only real changes show: short identifiers
 * (minified variables, renamed every build) become `_`, while property names after a dot, object
 * keys, and literals stay as they are. A name followed by `:` is only a key straight after `{` or
 * `,`; elsewhere it is the middle of a ternary and still a variable.
 */
export function atomShape(initializer: string): string {
  return initializer.replace(/(?<![A-Za-z0-9_$.])[A-Za-z_$][A-Za-z0-9_$]{0,2}(?![A-Za-z0-9_$])/g, (name, offset: number, text: string) => {
    const isKey = text[offset + name.length] === ':' && /[{,]/.test(text[offset - 1] ?? '');
    return isKey ? name : '_';
  });
}

export function atomShapes(snapshot: Snapshot, labels: Iterable<string>): Record<string, string> {
  const shapes: Record<string, string> = {};
  for (const label of [...labels].sort()) {
    for (const text of snapshot.files.values()) {
      const init = atomInitializer(label, text);
      if (init !== null) { shapes[label] = atomShape(init); break; }
    }
  }
  return shapes;
}

export async function readShapeBaseline(file = SHAPES_FILE): Promise<Record<string, string>> {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}

export interface AtomCheck { missing: string[]; changed: string[]; warnings: string[]; ok: string[] }

export function checkAtoms(snapshot: Snapshot, labels: Map<string, Set<string>>, baseline: Record<string, string> = {}): AtomCheck {
  const result: AtomCheck = { missing: [], changed: [], warnings: [], ok: [] };
  const shapes = atomShapes(snapshot, labels.keys());
  for (const [label, shape] of Object.entries(shapes)) {
    const where = [...labels.get(label)!].sort().join(', ');
    if (!(label in baseline)) result.warnings.push(`${label} has no recorded shape - run with --accept to record \`${shape}\``);
    else if (baseline[label] !== shape) result.changed.push(`${label} initial value changed: \`${baseline[label]}\` -> \`${shape}\` <- check how ${where} reads or writes it, then --accept`);
  }
  for (const label of [...labels.keys()].sort()) {
    const where = [...labels.get(label)!].sort().join(', ');
    const found = locateAtom(label, snapshot);
    if (!found) {
      if (label in KNOWN_ABSENT) result.ok.push(`${label} absent, known: ${KNOWN_ABSENT[label]}`);
      else result.missing.push(`${label} is not defined in the bundle <- looked up in ${where}`);
    } else if (label in KNOWN_ABSENT) {
      result.warnings.push(`${label} is listed KNOWN_ABSENT but is present again - drop it from KNOWN_ABSENT`);
    } else if (found.refs < LOW_REF_THRESHOLD) {
      result.warnings.push(`${label} is defined but only has ${found.refs} ref(s) in ${found.file} - may be dead or transient`);
    } else result.ok.push(`${label} (${found.refs} refs in ${found.file})`);
  }
  for (const label of Object.keys(KNOWN_ABSENT)) {
    if (!labels.has(label)) result.warnings.push(`${label} is in KNOWN_ABSENT but no longer looked up - remove it`);
  }
  const text = [...snapshot.files.values()];
  for (const field of FIELD_ATOMS) {
    if (text.some(source => field.pattern.test(source))) result.ok.push(`${field.name} (field atom)`);
    else result.missing.push(`${field.name} field atom pattern not found <- read in ${field.where}`);
  }
  return result;
}

async function main(): Promise<void> {
  const dir = argValue('--dir') ? resolve(argValue('--dir')!) : (await snapshotDirs())[0];
  if (!dir) { console.error('No captured bundle in bundles/ - run npm run check-bundle first.'); process.exit(2); }
  const snapshot = await readSnapshot(dir);
  const labels = await companionAtomLabels();
  if (process.argv.includes('--accept')) {
    const shapes = atomShapes(snapshot, labels.keys());
    await writeFile(SHAPES_FILE, JSON.stringify(shapes, null, 2) + '\n');
    console.log(`Recorded ${Object.keys(shapes).length} atom shapes from ${relative(ROOT, dir)} in ${relative(ROOT, SHAPES_FILE)}.`);
    return;
  }
  console.log(`atom drift check: ${labels.size} labels against ${relative(ROOT, dir)} (${snapshot.files.size} files)\n`);
  const result = checkAtoms(snapshot, labels, await readShapeBaseline());
  for (const line of result.ok) console.log(`  OK       ${line}`);
  for (const line of result.warnings) console.log(`  WARN     ${line}`);
  for (const line of result.missing) console.log(`  MISSING  ${line}`);
  for (const line of result.changed) console.log(`  CHANGED  ${line}`);
  if (!result.missing.length && !result.changed.length) {
    console.log(`\nNo atom drift${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}.`);
    process.exit(0);
  }
  if (result.missing.length) console.log(`\n${result.missing.length} atom(s) missing - a hook will silently never bind.`);
  if (result.changed.length) console.log(`\n${result.changed.length} atom(s) changed shape - code that reads or writes them may silently misbehave.`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch(error => { console.error('check failed:', (error as Error).message); process.exit(2); });
}
