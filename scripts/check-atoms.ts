import { readFile, readdir } from 'node:fs/promises';
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
 * Exit: 0 = no drift, 1 = a label is missing, 2 = error. Usage:
 *   npm run check-atoms                                         # newest snapshot in bundles/
 *   npm run check-atoms -- --dir bundles/bundle-1260-20260924   # a specific snapshot
 */

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
  { name: 'currentRoomAtom.isCinematicMode', where: 'game-atoms.ts', pattern: /isCinematicMode=[A-Za-z_$]+\([^)]*\);selection=\{/ },
  { name: 'currentRoomAtom.selection.itemId', where: 'features/planter-pot-selection.ts, game-atoms.ts', pattern: /selection=\{itemId:/ },
  { name: 'currentRoomAtom.selection.lastExplicitItemId', where: 'features/planter-pot-selection.ts', pattern: /selection=\{[^}]*lastExplicitItemId:/ },
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

export interface AtomCheck { missing: string[]; warnings: string[]; ok: string[] }

export function checkAtoms(snapshot: Snapshot, labels: Map<string, Set<string>>): AtomCheck {
  const result: AtomCheck = { missing: [], warnings: [], ok: [] };
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
  console.log(`atom drift check: ${labels.size} labels against ${relative(ROOT, dir)} (${snapshot.files.size} files)\n`);
  const result = checkAtoms(snapshot, labels);
  for (const line of result.ok) console.log(`  OK       ${line}`);
  for (const line of result.warnings) console.log(`  WARN     ${line}`);
  for (const line of result.missing) console.log(`  MISSING  ${line}`);
  if (!result.missing.length) {
    console.log(`\nNo atom drift${result.warnings.length ? ` with ${result.warnings.length} warning(s)` : ''}.`);
    process.exit(0);
  }
  console.log(`\n${result.missing.length} atom(s) missing - a hook will silently never bind.`);
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  main().catch(error => { console.error('check failed:', (error as Error).message); process.exit(2); });
}
