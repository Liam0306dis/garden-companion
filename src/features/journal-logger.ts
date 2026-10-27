import { feature } from '../config.js';
import { MUTATION_CATALOG, PET_CATALOG, plantName } from '../constants.js';
import { slotIsMaxSize } from '../crop-size.js';
import { makeDraggable } from '../draggable.js';
import { NOT_SENT_REASON, sendQuinoaCommandAwaitingResult } from '../game-connection.js';
import { mutationSprite, onSpritesReady, petSprite, produceSprite } from '../pets.js';
import { serverNow } from '../server-clock.js';
import { onStateChange, state } from '../state.js';
import { toast } from '../toast.js';
import type { GardenTile, Pet } from '../types.js';
import { escapeHtml, humanize, loadLocal, saveLocal } from '../utils.js';

/**
 * Journal logging without the Camera.
 *
 * The game's photo mode sends one `LogItem` per subject in frame, and the server records whatever
 * that crop or pet has that the journal lacks. This lists every subject the camera would accept, found
 * by the same rules the game uses to pick its photo subjects (photoSubjectAtoms), and sends the same
 * command for the one clicked: ripe grow slots and displayed crops with an unlogged variant, produce
 * in the inventory, and pets - active, in the inventory or in the Pet Hutch - with an unlogged variant.
 *
 * A variant is the crop's or pet's mutations, plus Normal when it has none and Max Weight when it is
 * at full size. The camera would also take a pet for an unlogged ability, but abilities are not part of
 * the journal's variants, so a pet whose variants are all logged is left out rather than suggested
 * again for every ability it rolls.
 */

const POSITION_KEY = 'gardenCompanion.journalLoggerPosition.v1';
const COLLAPSED_KEY = 'gardenCompanion.journalLoggerCollapsed.v1';

type LogTarget =
  | { kind: 'growSlot'; slot: number; slotsIndex: number }
  | { kind: 'petSlot'; petId: string }
  | { kind: 'inventoryItem'; itemId: string }
  | { kind: 'displayedCrop'; tileType: string; localTileIndex: number; cropId: string };

interface JournalRow { variantsLogged?: Array<{ variant?: string }> }

interface Subject {
  /** Changes with the subject's variants, so a crop that gains a mutation is a fresh row. */
  key: string;
  journal: 'produce' | 'pets';
  species: string;
  target: LogTarget;
  name: string;
  where: string;
  sprite: string;
  variants: string[];
}

function journalRow(kind: 'produce' | 'pets', species: string): JournalRow | undefined {
  return (state.slot?.data?.journal?.[kind] as Record<string, JournalRow> | undefined)?.[species];
}

function loggedVariants(row: JournalRow | undefined): string[] {
  return (row?.variantsLogged ?? []).map(entry => entry?.variant ?? '');
}

/** The game's own rule: unlogged mutations, then Normal for an unmutated one, then Max Weight. */
function newVariants(mutations: string[] | undefined, atMax: boolean, logged: string[]): string[] {
  const list = mutations ?? [];
  const fresh = list.filter(mutation => !logged.includes(mutation));
  if (!list.length && !logged.includes('Normal')) fresh.push('Normal');
  if (atMax && !logged.includes('Max Weight')) fresh.push('Max Weight');
  return [...new Set(fresh)];
}

function cropSubject(species: string | undefined, mutations: string[] | undefined, size: number | undefined, key: string, target: LogTarget, where: string): Subject | null {
  if (!species) return null;
  const variants = newVariants(mutations, slotIsMaxSize({ size }), loggedVariants(journalRow('produce', species)));
  if (!variants.length) return null;
  const sprite = produceSprite(species);
  return { key: `${key}:${variants.join(',')}`, journal: 'produce', species, target, name: plantName(species), where, sprite: `<span class="gc-shop-sprite">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}</span>`, variants };
}

function petSubject(pet: Pet, target: LogTarget, where: string): Subject | null {
  const row = journalRow('pets', pet.petSpecies);
  const maxScale = PET_CATALOG[pet.petSpecies]?.maxScale;
  const atMax = Boolean(maxScale) && Number(pet.targetScale) >= maxScale;
  const variants = newVariants(pet.mutations, atMax, loggedVariants(row));
  if (!variants.length) return null;
  const species = PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies);
  return {
    key: `pet:${pet.id}:${variants.join(',')}`,
    journal: 'pets',
    species: pet.petSpecies,
    target,
    name: pet.name && pet.name !== species ? `${pet.name} (${species})` : species,
    where,
    sprite: petSprite(pet),
    variants,
  };
}

function subjects(): Subject[] {
  const data = state.slot?.data;
  if (!data) return [];
  const found: Subject[] = [];
  const push = (subject: Subject | null) => { if (subject) found.push(subject); };
  const now = serverNow();

  // Unripe slots are not photo subjects: the camera only publishes a slot once its endTime passes.
  for (const [index, tile] of Object.entries(data.garden?.tileObjects ?? {})) {
    if (tile?.objectType !== 'plant') continue;
    for (const [position, slot] of (tile.slots ?? []).entries()) {
      if (slot.endTime == null || slot.endTime > now) continue;
      // The slot's place in the list stands in for a missing slotId, as the instant harvest key does.
      const slotsIndex = Number(slot.slotId ?? position);
      push(cropSubject(slot.species, slot.mutations, slot.size, `slot:${index}:${slotsIndex}`, { kind: 'growSlot', slot: Number(index), slotsIndex }, 'Garden'));
    }
  }

  // Crops on display stands, which can sit on the dirt or on the boardwalk.
  const boards: Array<[string, Record<string, GardenTile> | undefined]> = [
    ['Dirt', data.garden?.tileObjects],
    ['Boardwalk', data.garden?.boardwalkTileObjects],
  ];
  for (const [tileType, tiles] of boards) {
    for (const [index, tile] of Object.entries(tiles ?? {})) {
      const crop = tile?.objectType === 'decor' ? tile.mountedCrop : undefined;
      if (crop) push(cropSubject(crop.species, crop.mutations, crop.size, `display:${crop.id}`, { kind: 'displayedCrop', tileType, localTileIndex: Number(index), cropId: crop.id }, 'On display'));
    }
  }

  for (const pet of data.petSlots ?? []) push(petSubject(pet, { kind: 'petSlot', petId: pet.id }, 'Active'));

  // Only the Pet Hutch, and only while it stands in the garden: the game photographs pets in no
  // other storage, and none in a hutch that is not placed.
  const hutch = (data.inventory?.storages ?? []).find(storage => storage.decorId === 'PetHutch');
  const hutchPlaced = boards.some(([, tiles]) => Object.values(tiles ?? {}).some(tile => tile?.objectType === 'decor' && tile.decorId === 'PetHutch'));
  for (const pet of hutchPlaced ? hutch?.items ?? [] : []) {
    if (pet.itemType === 'Pet') push(petSubject(pet, { kind: 'inventoryItem', itemId: pet.id }, 'Pet Hutch'));
  }

  for (const item of (data.inventory?.items ?? []) as unknown as Array<Pet & { species?: string; size?: number }>) {
    const target: LogTarget = { kind: 'inventoryItem', itemId: item.id };
    if (item.itemType === 'Pet') push(petSubject(item, target, 'Inventory'));
    else if (item.itemType === 'Produce') push(cropSubject(item.species, item.mutations, item.size, `item:${item.id}`, target, 'Inventory'));
  }
  return withoutCovered(found);
}

/**
 * Logging a subject logs its variants for the whole species, so one whose new variants another of
 * the same species also offers adds nothing: twenty Gold carrots are one row, not twenty. Of two
 * offering exactly the same, the first is kept.
 */
function withoutCovered(found: Subject[]): Subject[] {
  return found.filter((subject, index) => !found.some((other, otherIndex) => otherIndex !== index
    && other.journal === subject.journal && other.species === subject.species
    && subject.variants.every(variant => other.variants.includes(variant))
    && (other.variants.length > subject.variants.length || otherIndex < index)));
}

function variantChip(variant: string): string {
  const label = variant === 'Max Weight' ? 'Max Size' : MUTATION_CATALOG[variant]?.name || variant;
  const icon = mutationSprite(variant);
  return `<span class="gc-cleanser-mutation" title="${escapeHtml(label)}">${icon ? `<img src="${escapeHtml(icon)}" alt="">` : ''}${escapeHtml(label)}</span>`;
}

/** Keys sent and not yet answered, or answered and not yet gone from state. */
const pending = new Set<string>();
let current: Subject[] = [];
let lastSignature = '';
let collapsed = loadLocal<boolean>(COLLAPSED_KEY, false);

function panel(): HTMLElement | null {
  return document.getElementById('gc-journal-logger');
}

function ensurePanel(): HTMLElement {
  const existing = panel();
  if (existing) return existing;
  const root = document.createElement('section');
  root.id = 'gc-journal-logger';
  root.hidden = true;
  root.innerHTML = '<header><div><i></i><span data-journal-logger-title>New for journal</span></div><span><button data-journal-logger-all title="Log every one">Log all</button><button data-journal-logger-collapse aria-label="Collapse"></button></span></header><main data-journal-logger-body></main>';
  root.querySelector<HTMLButtonElement>('[data-journal-logger-collapse]')!.onclick = () => {
    collapsed = !collapsed;
    saveLocal(COLLAPSED_KEY, collapsed);
    lastSignature = '';
    refreshJournalLogger();
  };
  root.querySelector<HTMLButtonElement>('[data-journal-logger-all]')!.onclick = () => { void logAll(); };
  document.body.appendChild(root);
  makeDraggable(root, POSITION_KEY);
  return root;
}

/** How long a log that got no answer stays disabled before it can be tried again. */
const TIMED_OUT_HOLD_MS = 15_000;

async function logSubject(subject: Subject): Promise<boolean> {
  pending.add(subject.key);
  lastSignature = '';
  refreshJournalLogger();
  let ok = false;
  try {
    const result = await sendQuinoaCommandAwaitingResult({ type: 'LogItem', target: subject.target });
    ok = result.ok;
    // No answer is not a refusal - the log may well have landed, and the row leaves if it did. It
    // stays disabled a while for the journal patch to catch up, so a second click is not refused.
    if (result.timedOut) {
      toast(`No answer for ${subject.name} yet - if it is still listed shortly, try again.`);
      window.setTimeout(() => {
        pending.delete(subject.key);
        lastSignature = '';
        refreshJournalLogger();
      }, TIMED_OUT_HOLD_MS);
      return false;
    }
    if (!ok) toast(result.code === 'not_sent' ? `${subject.name} was not logged: ${NOT_SENT_REASON}.` : `${subject.name} could not be logged.`, 'error');
  } catch (error) {
    toast((error as Error).message, 'error');
  }
  // A logged subject leaves the list once the journal patch lands; until then it stays disabled.
  if (!ok) pending.delete(subject.key);
  lastSignature = '';
  refreshJournalLogger();
  return ok;
}

let loggingAll = false;

/**
 * One at a time behind each result, the way the camera's own captures resolve. The list is read
 * afresh before each send, and a subject whose variants an earlier send this run already logged is
 * passed over: the journal patch can trail the result, and sending it anyway would only be refused.
 */
async function logAll(): Promise<void> {
  if (loggingAll) return;
  loggingAll = true;
  try {
    let logged = 0;
    const tried = new Set<string>();
    const covered = new Set<string>();
    const isCovered = (subject: Subject) => subject.variants.every(variant => covered.has(`${subject.journal}:${subject.species}:${variant}`));
    for (;;) {
      const subject = current.find(next => !pending.has(next.key) && !tried.has(next.key) && !isCovered(next));
      if (!subject) break;
      tried.add(subject.key);
      if (!await logSubject(subject)) break;
      logged += 1;
      for (const variant of subject.variants) covered.add(`${subject.journal}:${subject.species}:${variant}`);
    }
    if (logged) toast(`Logged ${logged} to the journal.`, 'success');
  } finally {
    loggingAll = false;
  }
}

function render(root: HTMLElement): void {
  const count = current.length;
  root.querySelector('[data-journal-logger-title]')!.textContent = `New for journal (${count})`;
  root.dataset.collapsed = String(collapsed);
  const collapse = root.querySelector<HTMLButtonElement>('[data-journal-logger-collapse]')!;
  collapse.textContent = collapsed ? '+' : '−';
  collapse.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
  root.querySelector<HTMLButtonElement>('[data-journal-logger-all]')!.disabled = loggingAll || current.every(subject => pending.has(subject.key));
  const body = root.querySelector<HTMLElement>('[data-journal-logger-body]')!;
  if (collapsed) { body.innerHTML = ''; return; }
  body.innerHTML = current.map((subject, index) => `<div class="gc-journal-logger-row">
${subject.sprite}<span class="gc-journal-logger-name"><b>${escapeHtml(subject.name)}</b><small>${escapeHtml(subject.where)}</small></span>
<span class="gc-cleanser-mutations">${subject.variants.map(variantChip).join('')}</span>
<button data-journal-log="${index}" ${pending.has(subject.key) ? 'disabled' : ''}>${pending.has(subject.key) ? 'Logging' : 'Log'}</button></div>`).join('');
  body.querySelectorAll<HTMLButtonElement>('[data-journal-log]').forEach(button => button.onclick = () => {
    const subject = current[Number(button.dataset.journalLog)];
    if (subject && !pending.has(subject.key)) void logSubject(subject);
  });
}

/** Shown only while the feature is on and something is waiting to be logged. */
export function refreshJournalLogger(): void {
  const enabled = feature('journalLogger');
  current = enabled ? subjects() : [];
  const live = new Set(current.map(subject => subject.key));
  for (const key of pending) if (!live.has(key)) pending.delete(key);
  const signature = JSON.stringify([current.map(subject => subject.key), [...pending], collapsed, loggingAll]);
  if (signature === lastSignature) return;
  lastSignature = signature;
  if (!current.length) {
    const root = panel();
    if (root) root.hidden = true;
    return;
  }
  const root = ensurePanel();
  root.hidden = false;
  render(root);
}

let refreshQueued = false;

/** Patches can arrive many times a second, and each refresh walks the whole garden and inventory. */
function scheduleRefresh(): void {
  if (refreshQueued) return;
  refreshQueued = true;
  window.setTimeout(() => {
    refreshQueued = false;
    refreshJournalLogger();
  }, 250);
}

export function initJournalLogger(): void {
  onStateChange(scheduleRefresh);
  onSpritesReady(() => { lastSignature = ''; refreshJournalLogger(); });
  // A crop ripens on the clock rather than with a patch, so the list is rechecked now and then too.
  window.setInterval(refreshJournalLogger, 5_000);
}
