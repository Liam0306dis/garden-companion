import { EGG_CATALOG, PET_CATALOG } from '../constants.js';
import { page } from '../page.js';
import { panelActions } from '../panel-actions.js';
import { mutationSprite } from '../pets.js';
import type { ActivityLogEntry, Pet } from '../types.js';
import { escapeHtml, humanize, loadLocal, NUMBER_LOCALE, saveLocal } from '../utils.js';

/**
 * What each egg has actually given you, and how close each guaranteed outcome is.
 *
 * The game runs Bad Luck Protection on every egg: miss the outcome and its counter climbs, get it
 * and the counter drops to zero, and at the threshold the next hatch is forced. Those counters live
 * under `serverOnly` in the player state and are stripped before the client sees them, so the only
 * way to know where you stand is to count hatches yourself.
 *
 * `hatchEgg` is the one activity log entry carrying everything needed - the egg it came from and the
 * whole pet, mutations included - so a hatch seen while the script is running can be attributed
 * exactly. Hatches that happen while it is not are missed outright and cannot be recovered: the game
 * keeps only the last 25 log entries of any kind, which a minute of watering flushes.
 *
 * A pet handed over by an ability is not a pull. Double Hatch's second pet touches no counter at
 * all - it neither advances one nor resets one, and it receives no guarantee of its own - so it is
 * counted among the pets you own and kept out of the counters entirely. That is why pulls are
 * tallied apart from hatches: the bars measure the first, the odds table the second.
 *
 * Such a pet is recognised by the `extraPet` it arrives with rather than by the name of the entry
 * carrying it. The ability is tiered, so matching the name would quietly stop counting those pets the
 * day another tier ships, while the parameter stays put.
 */

/**
 * Pulls of an egg before its outcome is forced.
 *
 * The colours are stated; the species are not. Every egg but one guarantees its rarest species at
 * 40, which is why taking the lowest spawn weight and applying one constant worked for years - and
 * the Amber Egg breaks both halves of that at once. It guarantees two species, FireHorse at 40 and
 * Phoenix at 100, so the rarest is not the only one and 40 is not its number. The game states the
 * pair per egg, so they are read from the catalog rather than inferred.
 */
export const PITY_THRESHOLDS: Record<string, number> = { species: 40, Gold: 200, Rainbow: 2000 };

const EGG_LUCK_KEY = 'gardenCompanion.eggLuck.v1';

const COLOURS = ['Gold', 'Rainbow'];

interface Counter {
  /** Hatches since this outcome last landed, which is the counter the game itself keeps. */
  misses: number;
  /**
   * Whether `misses` is known to match the game's own figure. Counting starts from zero at a point
   * the real counter was already somewhere unknown, so until the outcome has been seen once - which
   * resets the real counter too, however it was reached - ours is only ever a lower bound.
   */
  synced: boolean;
}

interface EggRecord {
  /** Pets this egg has produced, the ones an ability handed over included. */
  hatches: number;
  /** Hatches that actually rolled against a bad luck counter, which excludes ability pets. */
  pulls: number;
  species: Record<string, number>;
  colours: Record<string, number>;
  /** Gold/Rainbow counts broken down by species, so a card can show how many of each you have found. */
  speciesColours: Record<string, Record<string, number>>;
  counters: Record<string, Counter>;
}

function emptyCounter(): Counter {
  return { misses: 0, synced: false };
}

function blankEgg(): EggRecord {
  return { hatches: 0, pulls: 0, species: {}, colours: {}, speciesColours: {}, counters: {} };
}

/** Repairs whatever a hand-edited or older store is missing, so a render never meets a hole. */
function normaliseEgg(value: unknown, eggId = ''): EggRecord {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<EggRecord>;
  const counters = (raw.counters && typeof raw.counters === 'object' ? raw.counters : {}) as Record<string, Partial<Counter>>;
  const numbers = (source: unknown): Record<string, number> => Object.fromEntries(
    Object.entries((source && typeof source === 'object' ? source : {}) as Record<string, unknown>)
      .map(([key, count]) => [key, Number(count) || 0]),
  );
  return {
    hatches: Number(raw.hatches) || 0,
    // Stores written before ability pets were separated counted every hatch as a pull, which is
    // what they were taken to be at the time, so that is the honest figure to carry forward.
    pulls: Number(raw.pulls ?? raw.hatches) || 0,
    species: numbers(raw.species),
    colours: numbers(raw.colours),
    speciesColours: Object.fromEntries(Object.entries(
      (raw.speciesColours && typeof raw.speciesColours === 'object' ? raw.speciesColours : {}) as Record<string, unknown>,
    ).map(([species, colours]) => [species, numbers(colours)])),
    // Species counters used to share one 'species' key, because an egg only ever guaranteed one.
    // The count is real progress towards a real guarantee, so it is carried onto the species that
    // key stood for rather than dropped - which would reset a bar that may be hundreds of pulls in.
    counters: Object.fromEntries(Object.entries(counters).map(([key, saved]) => [
      key === 'species' ? pitySpeciesList(eggId)[0] || key : key,
      { misses: Number(saved?.misses) || 0, synced: saved?.synced === true },
    ])),
  };
}

let luck: Record<string, EggRecord> = Object.fromEntries(
  Object.entries(loadLocal<Record<string, unknown>>(EGG_LUCK_KEY, {}))
    .map(([eggId, record]) => [eggId, normaliseEgg(record, eggId)]),
);

function save(): void {
  saveLocal(EGG_LUCK_KEY, luck);
}

const EGG_COLLAPSED_KEY = 'gardenCompanion.eggLuckCollapsed.v1';

// Ten eggs of tables and bars is a long scroll when you only care about one, so each card folds
// away and remembers it. Kept apart from the tally: clearing one must not disturb the other.
const savedCollapsed = loadLocal<unknown>(EGG_COLLAPSED_KEY, []);
const collapsed = new Set(Array.isArray(savedCollapsed) ? savedCollapsed.filter((id): id is string => typeof id === 'string') : []);

function toggleEggCollapsed(eggId: string): void {
  collapsed.has(eggId) ? collapsed.delete(eggId) : collapsed.add(eggId);
  saveLocal(EGG_COLLAPSED_KEY, [...collapsed]);
}

/**
 * The species an egg guarantees, which is the least likely one it can hatch. The game names it per
 * egg rather than deriving it, but the one it names is always the rarest, so the spawn table answers
 * it without a second catalog to keep in step.
 */
export function pitySpecies(eggId: string): string {
  return pitySpeciesList(eggId)[0] ?? '';
}

/**
 * Every species this egg guarantees, in the order the game lists them.
 *
 * The fallback is the old rule - the single rarest by spawn weight - so an egg from a bundle
 * captured before the thresholds were read still shows a bar rather than none at all.
 */
export function pitySpeciesList(eggId: string): string[] {
  const declared = Object.keys(EGG_CATALOG[eggId]?.pityThresholds || {});
  if (declared.length) return declared;
  const weights = EGG_CATALOG[eggId]?.spawnWeights || {};
  const rarest = Object.keys(weights).sort((left, right) => (weights[left] || 0) - (weights[right] || 0))[0];
  return rarest ? [rarest] : [];
}

/** A counter's threshold: stated for the colours, read from the egg for a species. */
function pityThreshold(eggId: string, key: string): number {
  return PITY_THRESHOLDS[key] ?? EGG_CATALOG[eggId]?.pityThresholds?.[key] ?? PITY_THRESHOLDS.species;
}

function bump(record: EggRecord, key: string, hit: boolean): void {
  const existing = record.counters[key] ?? emptyCounter();
  // A hit resets the game's counter whether pity forced it or the roll simply landed, so this is
  // also the moment our own count stops being a floor and becomes the real one.
  record.counters[key] = hit ? { misses: 0, synced: true } : { misses: existing.misses + 1, synced: existing.synced };
}

const BONUS_PETS_KEY = 'gardenCompanion.eggLuckBonusPets.v1';

/**
 * Ids of pets an ability handed over, so one cannot be taken for a pull.
 *
 * Double Hatch reports its extra pet on its own log entry, the way Double Harvest reports its extra
 * crop, so ordinarily no hatchEgg is written for it and nothing here is ever consulted. It is kept
 * because being wrong about that would corrupt a counter silently and permanently - a bonus pet
 * taken for a pull would zero a counter that should still be climbing, and mark it synced.
 */
const savedBonus = loadLocal<unknown>(BONUS_PETS_KEY, []);
let bonusPets = Array.isArray(savedBonus) ? savedBonus.filter((id): id is string => typeof id === 'string') : [];

function noteBonusPet(id: string): void {
  if (!id || bonusPets.includes(id)) return;
  bonusPets = [...bonusPets.slice(-49), id];
  saveLocal(BONUS_PETS_KEY, bonusPets);
}

function petOf(value: unknown): Pet | null {
  const pet = (value && typeof value === 'object' ? value : null) as Pet | null;
  return pet?.petSpecies ? pet : null;
}

/** The pets an egg produced, whether or not they rolled against a counter. */
function tally(record: EggRecord, pet: Pet): string[] {
  const mutations = Array.isArray(pet.mutations) ? pet.mutations : [];
  record.hatches += 1;
  record.species[pet.petSpecies] = (record.species[pet.petSpecies] || 0) + 1;
  for (const colour of COLOURS) {
    if (!mutations.includes(colour)) continue;
    record.colours[colour] = (record.colours[colour] || 0) + 1;
    const perSpecies = record.speciesColours[pet.petSpecies] ?? (record.speciesColours[pet.petSpecies] = {});
    perSpecies[colour] = (perSpecies[colour] || 0) + 1;
  }
  return mutations;
}

/** Folds every hatch in this batch of log entries into the tally. */
export function recordEggHatches(entries: ActivityLogEntry[]): void {
  let changed = false;
  // Whether the extra pet reaches us before or after any hatchEgg written for it is not ours to
  // choose, so the batch is read for ability pets first and the pulls are matched against them.
  const bonusInBatch = new Set(entries
    .map(entry => String(petOf(entry.parameters?.extraPet)?.id ?? ''))
    .filter(Boolean));

  for (const entry of entries) {
    const parameters = entry.parameters || {};

    if (parameters.extraPet) {
      const pet = petOf(parameters.extraPet);
      if (!pet) continue;
      // Remembered before anything else can rule the pet out. Which egg it came from decides only
      // whether it can be tallied; that it was handed over by an ability is true regardless, and
      // that is the half worth keeping - forgetting it would leave any hatchEgg written for the pet
      // to be counted as a pull, which is the silent corruption this guards against.
      noteBonusPet(String(pet.id ?? ''));
      // The entry names no egg of its own, so an extra pet that has forgotten where it came from
      // cannot be attributed to one and is left out rather than guessed at.
      const eggId = typeof pet.sourceEggId === 'string' ? pet.sourceEggId : '';
      if (!eggId) continue;
      const record = luck[eggId] ?? blankEgg();
      tally(record, pet);
      luck[eggId] = record;
      changed = true;
      continue;
    }

    if (entry.action !== 'hatchEgg') continue;
    const eggId = typeof parameters.eggId === 'string' ? parameters.eggId : '';
    const pet = petOf(parameters.pet);
    if (!eggId || !pet) continue;
    const petId = String(pet.id ?? '');
    // Already counted as an ability pet, so counting it again would both double the tally and put
    // a pull against a hatch that never rolled for one.
    if (petId && (bonusInBatch.has(petId) || bonusPets.includes(petId))) continue;
    const record = luck[eggId] ?? blankEgg();
    const mutations = tally(record, pet);
    record.pulls += 1;
    for (const colour of COLOURS) bump(record, colour, mutations.includes(colour));
    // One counter per guaranteed species, keyed by the species itself: an egg with two of them
    // cannot share a single 'species' counter, since each runs to its own threshold.
    for (const species of pitySpeciesList(eggId)) bump(record, species, pet.petSpecies === species);
    luck[eggId] = record;
    changed = true;
  }
  if (changed) save();
}

// Seeded so it is never empty: the panel treats an empty signature as "always redraw".
let frozenSignature = JSON.stringify(luck);

/** Redraw only when a hatch has actually landed, rather than on every state frame. */
export function eggLuckSignature(): string {
  // Held while a card is being edited: the edits change the tally, and a live refresh landing on
  // the focusout from a pity box would redraw before the click on Done arrives and swallow it. The
  // edit buttons redraw for themselves, so nothing is lost by waiting.
  if (!editing.size) frozenSignature = JSON.stringify(luck);
  return frozenSignature;
}

export function resetEggLuck(eggId: string): void {
  delete luck[eggId];
  save();
}

/** Eggs whose card is open for hand edits. Not saved: a reload should land back on the plain view. */
const editing = new Set<string>();

/** Leaves edit mode on every card, for when the panel closes or the tab changes without Done. */
export function endEggLuckEditing(): void {
  editing.clear();
}

/**
 * Hand-adjusts one egg+species tally, for hatches made before install or in a session without the
 * script. `field` is 'hatched' or a colour. The counts are kept consistent with each other - a Gold
 * pet is also a hatch, so adding one past the species' hatch count adds the hatch too, and removing
 * hatches trims colours that would no longer fit. Pity counters are left alone; they are set directly.
 */
function adjustEggLuck(eggId: string, species: string, field: string, delta: number): void {
  const record = luck[eggId] ?? blankEgg();
  const perSpecies = record.speciesColours[species] ?? (record.speciesColours[species] = {});
  const setHatched = (next: number): void => {
    const change = next - (record.species[species] || 0);
    record.species[species] = next;
    record.hatches = Math.max(0, record.hatches + change);
    record.pulls = Math.max(0, record.pulls + change);
    for (const colour of COLOURS) {
      const over = (perSpecies[colour] || 0) - next;
      if (over <= 0) continue;
      perSpecies[colour] = next;
      record.colours[colour] = Math.max(0, (record.colours[colour] || 0) - over);
    }
  };
  if (field === 'hatched') {
    setHatched(Math.max(0, (record.species[species] || 0) + delta));
  } else if (COLOURS.includes(field)) {
    const next = Math.max(0, (perSpecies[field] || 0) + delta);
    record.colours[field] = Math.max(0, (record.colours[field] || 0) + next - (perSpecies[field] || 0));
    perSpecies[field] = next;
    if (next > (record.species[species] || 0)) setHatched(next);
  }
  luck[eggId] = record;
  save();
}

/** Sets a pity counter by hand. The player is stating the game's figure, so it counts as synced. */
function setPityCount(eggId: string, key: string, misses: number): void {
  const record = luck[eggId] ?? blankEgg();
  record.counters[key] = { misses: Math.max(0, Math.floor(misses) || 0), synced: true };
  luck[eggId] = record;
  save();
}

/**
 * Sets how many of an egg's hatches came from Double Hatch. The hatch total is left as the species
 * rows have it and the pulls take up the difference, since an ability pet is a hatch but not a pull.
 */
function setBonusCount(eggId: string, bonus: number): void {
  const record = luck[eggId] ?? blankEgg();
  record.pulls = record.hatches - Math.min(record.hatches, Math.max(0, Math.floor(bonus) || 0));
  luck[eggId] = record;
  save();
}

/** A table cell's count, or in edit mode a box to type it into, between - and + buttons. */
function stepCell(eggId: string, species: string, field: string, count: number, editMode: boolean): string {
  if (!editMode) return count ? count.toLocaleString(NUMBER_LOCALE) : (field === 'hatched' ? '0' : '-');
  const target = `data-species="${escapeHtml(species)}" data-field="${escapeHtml(field)}"`;
  const data = `data-egg-adjust="${escapeHtml(eggId)}" ${target}`;
  return `<span class="gc-egg-step"><button ${data} data-delta="-1" title="Remove one">&#8722;</button>`
    + `<input type="number" min="0" step="1" value="${count}" data-egg-set="${escapeHtml(eggId)}" ${target} title="Type a count, then press Enter">`
    + `<button ${data} data-delta="1" title="Add one">+</button></span>`;
}

/** The count a typed box is measured against, so setting it can go through adjustEggLuck's rules. */
function currentCount(eggId: string, species: string, field: string): number {
  const record = luck[eggId];
  if (!record) return 0;
  return field === 'hatched' ? record.species[species] || 0 : record.speciesColours[species]?.[field] || 0;
}

function eggName(eggId: string): string {
  return EGG_CATALOG[eggId]?.name || humanize(eggId);
}

function speciesName(id: string): string {
  return PET_CATALOG[id]?.name || humanize(id);
}

function share(part: number, whole: number): string {
  return whole > 0 ? `${(part / whole * 100).toFixed(1)}%` : '-';
}

/** Guarantees standing at or past their threshold, so a folded card can still say so. */
function dueCount(eggId: string, record: EggRecord): number {
  const keys = [...pitySpeciesList(eggId), ...COLOURS];
  return keys.filter(key => (record.counters[key]?.misses ?? 0) >= pityThreshold(eggId, key)).length;
}

/**
 * One guarantee's progress. An unsynced counter is shown as a floor rather than a figure, because
 * the hatches from before tracking began are in the game's count and not in ours.
 */
function pityRow(eggId: string, label: string, sprite: string, record: EggRecord, key: string, editMode = false): string {
  const threshold = pityThreshold(eggId, key);
  const { misses, synced } = record.counters[key] ?? emptyCounter();
  const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
  const count = editMode
    ? `<input type="number" min="0" value="${misses}" data-egg-pity="${escapeHtml(eggId)}" data-key="${escapeHtml(key)}" title="Pulls since ${escapeHtml(label)} last landed"> / ${threshold.toLocaleString(NUMBER_LOCALE)}`
    : `${synced ? '' : '&#8805;'}${misses.toLocaleString(NUMBER_LOCALE)} / ${threshold.toLocaleString(NUMBER_LOCALE)}`;
  const title = synced
    ? `${label} last landed ${misses.toLocaleString(NUMBER_LOCALE)} pulls ago. Guaranteed at ${threshold.toLocaleString(NUMBER_LOCALE)}.`
    : `At least ${misses.toLocaleString(NUMBER_LOCALE)} pulls - ${label} has not landed since tracking began, so the game's own count may be higher. Guaranteed at ${threshold.toLocaleString(NUMBER_LOCALE)}.`;
  return `<div class="gc-egg-pity" data-due="${misses >= threshold}" title="${escapeHtml(title)}">`
    + `<span class="gc-shop-sprite">${icon}</span>`
    + `<span class="gc-egg-pity-label">${escapeHtml(label)}</span>`
    + `<span class="gc-egg-bar"><i style="width:${Math.min(100, misses / threshold * 100).toFixed(1)}%"></i></span>`
    + `<span class="gc-egg-pity-count">${count}</span>`
    + '</div>';
}

function eggCard(eggId: string): string {
  const record = luck[eggId] ?? blankEgg();
  const sprite = page.__gardenCompanionShopSprites?.[eggId] || '';
  const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
  const title = `<span class="gc-shop-sprite">${icon}</span>${escapeHtml(eggName(eggId))}`;
  // The two only part company once an ability has handed over a pet, so the second figure appears
  // only when there is a difference to explain.
  const pullNote = record.pulls === record.hatches ? '' : ` (${record.pulls.toLocaleString(NUMBER_LOCALE)} pulls)`;
  const hatched = `<span class="gc-pill">${record.hatches.toLocaleString(NUMBER_LOCALE)} hatched${pullNote}</span>`;
  const editMode = editing.has(eggId);
  const editButton = `<button class="gc-egg-edit" data-egg-edit="${escapeHtml(eggId)}" aria-pressed="${editMode}" title="Add or remove hatches, Gold and Rainbow by hand, and set the pity counters">${editMode ? 'Done' : 'Edit'}</button>`;
  // An egg with nothing recorded is already one line, so it stays a plain heading with nothing to
  // fold - a control that opens an empty card would only invite the click. Editing opens it anyway,
  // since that is how hatches from before install get in.
  if (!record.hatches && !editMode) {
    return `<section class="gc-card gc-egg-card" data-empty="true"><div class="gc-row gc-egg-headrow"><h3>${title}</h3>${hatched}${editButton}</div>`
      + '<p>No hatches seen yet.</p></section>';
  }
  const open = !collapsed.has(eggId);
  // A guarantee that has come due is the one thing worth seeing without opening the card.
  const due = dueCount(eggId, record);
  const head = `<div class="gc-egg-headrow"><button class="gc-egg-head" data-egg-toggle="${escapeHtml(eggId)}" aria-expanded="${open}">`
    + `<h3>${title}</h3>`
    + (due ? `<span class="gc-pill gc-egg-due">${due} due</span>` : '')
    + hatched
    // The arrow is its own button so Edit can sit between the pills and it, keeping it at the edge.
    + `</button>${editButton}<button class="gc-egg-head gc-egg-arrow" data-egg-toggle="${escapeHtml(eggId)}" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'}">`
    + `<i>${open ? '&#9650;' : '&#9660;'}</i></button></div>`;

  const weights = EGG_CATALOG[eggId]?.spawnWeights || {};
  const weightTotal = Object.values(weights).reduce((sum, weight) => sum + (Number(weight) || 0), 0);
  // Most likely first, matching the order the game lists a hatch table in. Anything hatched that the
  // spawn table does not mention still gets a line rather than dropping out of the totals.
  const listed = Object.keys(weights).sort((left, right) => (weights[right] || 0) - (weights[left] || 0));
  const rows = [...listed, ...Object.keys(record.species).filter(id => !weights[id])].map(id => {
    const count = record.species[id] || 0;
    const odds = weightTotal > 0 && weights[id] ? `${(weights[id] / weightTotal * 100).toFixed(0)}%` : '-';
    const petSprite = page.__gardenCompanionPetSprites?.[id] || '';
    const petIcon = petSprite ? `<img src="${escapeHtml(petSprite)}" alt="">` : '';
    const gold = record.speciesColours[id]?.Gold || 0;
    const rainbow = record.speciesColours[id]?.Rainbow || 0;
    // Share and odds are read-only and there is no room for them beside the steppers.
    const tail = editMode ? '' : `<td>${share(count, record.hatches)}</td><td>${odds}</td>`;
    return `<tr${count || editMode ? '' : ' class="gc-egg-none"'}><td><span class="gc-shop-sprite">${petIcon}</span>${escapeHtml(speciesName(id))}</td>`
      + `<td>${stepCell(eggId, id, 'hatched', count, editMode)}</td>`
      + `<td>${stepCell(eggId, id, 'Gold', gold, editMode)}</td>`
      + `<td>${stepCell(eggId, id, 'Rainbow', rainbow, editMode)}</td>`
      + `${tail}</tr>`;
  }).join('');
  const goldHead = mutationSprite('Gold') ? `<img src="${escapeHtml(mutationSprite('Gold'))}" alt="Gold">` : 'Gold';
  const rainbowHead = mutationSprite('Rainbow') ? `<img src="${escapeHtml(mutationSprite('Rainbow'))}" alt="Rainbow">` : 'Rainbow';

  const colours = COLOURS
    .map(colour => `<span class="gc-pill">${escapeHtml(colour)} ${(record.colours[colour] || 0).toLocaleString(NUMBER_LOCALE)}</span>`)
    .join('');
  const pity = [
    ...pitySpeciesList(eggId).map(species =>
      pityRow(eggId, speciesName(species), page.__gardenCompanionPetSprites?.[species] || '', record, species, editMode)),
    ...COLOURS.map(colour => pityRow(eggId, colour, mutationSprite(colour), record, colour, editMode)),
  ].join('');
  const tailHead = editMode ? '' : '<th>Yours</th><th>Odds</th>';
  // Hatches minus pulls is the only place Double Hatch pets show, so it gets its own box when editing.
  const bonus = editMode
    ? `<label class="gc-egg-bonus" title="Hatches that came from Double Hatch: counted as hatches, not as pulls">Double Hatch `
      + `<input type="number" min="0" max="${record.hatches}" value="${record.hatches - record.pulls}" data-egg-bonus="${escapeHtml(eggId)}"></label>`
    : '';

  return `<section class="gc-card gc-egg-card"${editMode ? ' data-editing="true"' : ''}>${head}
<div class="gc-egg-body"${open ? '' : ' hidden'}>
<table class="gc-egg-table"><thead><tr><th>Species</th><th>Hatched</th><th class="gc-egg-mut" title="Gold found">${goldHead}</th><th class="gc-egg-mut" title="Rainbow found">${rainbowHead}</th>${tailHead}</tr></thead><tbody>${rows}</tbody></table>
<div class="gc-egg-colours">${colours}${bonus}<button data-egg-reset="${escapeHtml(eggId)}" title="Clear everything recorded for this egg">Reset</button></div>
<div class="gc-egg-pities">${pity}</div></div></section>`;
}

export function renderEggLuck(): string {
  // Catalog order, which is the order the shop lists eggs in. WinterEgg is the old name for SnowEgg
  // and hatches nothing new, so it shows only if something was recorded against it.
  const known = Object.keys(EGG_CATALOG).filter(eggId => eggId !== 'WinterEgg' || luck[eggId]?.hatches);
  // The tally takes whatever egg the log names, so an egg added to the game after this build was
  // scraped is already being counted. Walking the catalog alone would collect those hatches and
  // then never show them - and drop them from the total besides.
  const eggs = [...known, ...Object.keys(luck).filter(eggId => !EGG_CATALOG[eggId])];
  const hatched = eggs.reduce((sum, eggId) => sum + (luck[eggId]?.hatches || 0), 0);
  return `<p class="gc-note">Every hatch seen while Garden Companion was running, and how close each egg is to its guarantee. The game keeps these counters to itself, so they are counted here instead - anything hatched before you installed, or in a session without the script, is not in them. A count reads <b>&#8805;</b> until that outcome lands once, which syncs it to the game's own. A pet from Double Hatch is counted among your hatches but not as a pull, because it moves no counter and gets no guarantee.</p>
<section class="gc-card gc-egg-summary"><span><b>${hatched.toLocaleString(NUMBER_LOCALE)}</b> hatches recorded</span></section>
${eggs.map(eggCard).join('')}`;
}

export function bindEggLuckEvents(main: HTMLElement): void {
  main.querySelectorAll<HTMLButtonElement>('[data-egg-toggle]').forEach(button => button.onclick = () => {
    toggleEggCollapsed(button.dataset.eggToggle!);
    panelActions.renderPanelPreservingScroll();
  });
  main.querySelectorAll<HTMLButtonElement>('[data-egg-reset]').forEach(button => button.onclick = () => {
    resetEggLuck(button.dataset.eggReset!);
    panelActions.renderPanelPreservingScroll();
  });
  main.querySelectorAll<HTMLButtonElement>('[data-egg-edit]').forEach(button => button.onclick = () => {
    const eggId = button.dataset.eggEdit!;
    editing.has(eggId) ? editing.delete(eggId) : editing.add(eggId);
    // Opening a folded card for editing unfolds it for real, rather than forcing it open, so the
    // arrow keeps working while editing instead of appearing to do nothing.
    if (editing.has(eggId) && collapsed.has(eggId)) toggleEggCollapsed(eggId);
    panelActions.renderPanelPreservingScroll();
  });
  main.querySelectorAll<HTMLButtonElement>('[data-egg-adjust]').forEach(button => button.onclick = () => {
    adjustEggLuck(button.dataset.eggAdjust!, button.dataset.species!, button.dataset.field!, Number(button.dataset.delta) || 0);
    panelActions.renderPanelPreservingScroll();
  });
  // Applied on change (Enter or leaving the box), not per keystroke: a half-typed 1 on the way to 12
  // would trim Gold and Rainbow down to fit it. Enter redraws so linked counts update; leaving the
  // box does not, for the same swallowed-click reason as the pity boxes below.
  main.querySelectorAll<HTMLInputElement>('[data-egg-set]').forEach(input => {
    input.onchange = () => {
      const { eggSet: eggId, species, field } = input.dataset;
      const next = Math.floor(Number(input.value));
      if (!eggId || !species || !field) return;
      if (input.value.trim() === '' || !Number.isFinite(next) || next < 0) {
        input.value = String(currentCount(eggId, species, field));
        return;
      }
      adjustEggLuck(eggId, species, field, next - currentCount(eggId, species, field));
      // Gold past the hatch count raises it, and fewer hatches trim the colours, so the row's other
      // boxes are brought up to date in place rather than by the redraw this path avoids.
      main.querySelectorAll<HTMLInputElement>('[data-egg-set]').forEach(other => {
        if (other === input || other.dataset.eggSet !== eggId || other.dataset.species !== species) return;
        other.value = String(currentCount(eggId, species, other.dataset.field!));
      });
      // Fewer hatches than the Double Hatch figure pulls it down too, so its box follows.
      main.querySelectorAll<HTMLInputElement>('[data-egg-bonus]').forEach(bonus => {
        const record = luck[eggId];
        if (bonus.dataset.eggBonus !== eggId || !record) return;
        bonus.max = String(record.hatches);
        bonus.value = String(record.hatches - record.pulls);
      });
    };
    input.onkeydown = event => {
      if (event.key !== 'Enter') return;
      input.onchange?.(new Event('change'));
      panelActions.renderPanelPreservingScroll();
    };
  });
  // Saved as typed but not redrawn: a redraw on blur would swap out the button being clicked (Done,
  // or a stepper), swallowing that click. Enter redraws, so the bar can be checked without leaving.
  main.querySelectorAll<HTMLInputElement>('[data-egg-pity]').forEach(input => {
    input.oninput = () => setPityCount(input.dataset.eggPity!, input.dataset.key!, Number(input.value));
    input.onkeydown = event => {
      if (event.key === 'Enter') panelActions.renderPanelPreservingScroll();
    };
  });
  // Same as the pity boxes: saved as typed, redrawn only on Enter.
  main.querySelectorAll<HTMLInputElement>('[data-egg-bonus]').forEach(input => {
    input.oninput = () => {
      const eggId = input.dataset.eggBonus!;
      setBonusCount(eggId, Number(input.value));
      // A figure outside 0 to the hatch count is saved clamped, so the box says so too.
      const record = luck[eggId];
      const typed = Number(input.value);
      if (record && input.value.trim() !== '' && (typed > record.hatches || typed < 0)) input.value = String(record.hatches - record.pulls);
    };
    input.onkeydown = event => {
      if (event.key === 'Enter') panelActions.renderPanelPreservingScroll();
    };
  });
}
