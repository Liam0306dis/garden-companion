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
 */

/**
 * Pulls of an egg before its outcome is forced. The game holds one constant for every egg's rarest
 * species and one each for the two pet colours, so these are stated rather than scraped.
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
  hatches: number;
  species: Record<string, number>;
  colours: Record<string, number>;
  counters: Record<string, Counter>;
}

function emptyCounter(): Counter {
  return { misses: 0, synced: false };
}

function blankEgg(): EggRecord {
  return { hatches: 0, species: {}, colours: {}, counters: {} };
}

/** Repairs whatever a hand-edited or older store is missing, so a render never meets a hole. */
function normaliseEgg(value: unknown): EggRecord {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<EggRecord>;
  const counters = (raw.counters && typeof raw.counters === 'object' ? raw.counters : {}) as Record<string, Partial<Counter>>;
  const numbers = (source: unknown): Record<string, number> => Object.fromEntries(
    Object.entries((source && typeof source === 'object' ? source : {}) as Record<string, unknown>)
      .map(([key, count]) => [key, Number(count) || 0]),
  );
  return {
    hatches: Number(raw.hatches) || 0,
    species: numbers(raw.species),
    colours: numbers(raw.colours),
    counters: Object.fromEntries(Object.entries(counters).map(([key, saved]) => [key, {
      misses: Number(saved?.misses) || 0,
      synced: saved?.synced === true,
    }])),
  };
}

let luck: Record<string, EggRecord> = Object.fromEntries(
  Object.entries(loadLocal<Record<string, unknown>>(EGG_LUCK_KEY, {}))
    .map(([eggId, record]) => [eggId, normaliseEgg(record)]),
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
  const weights = EGG_CATALOG[eggId]?.spawnWeights || {};
  return Object.keys(weights).sort((left, right) => (weights[left] || 0) - (weights[right] || 0))[0] || '';
}

function bump(record: EggRecord, key: string, hit: boolean): void {
  const existing = record.counters[key] ?? emptyCounter();
  // A hit resets the game's counter whether pity forced it or the roll simply landed, so this is
  // also the moment our own count stops being a floor and becomes the real one.
  record.counters[key] = hit ? { misses: 0, synced: true } : { misses: existing.misses + 1, synced: existing.synced };
}

/** Folds every hatch in this batch of log entries into the tally. */
export function recordEggHatches(entries: ActivityLogEntry[]): void {
  let changed = false;
  for (const entry of entries) {
    if (entry.action !== 'hatchEgg') continue;
    const parameters = entry.parameters || {};
    const eggId = typeof parameters.eggId === 'string' ? parameters.eggId : '';
    const pet = (parameters.pet && typeof parameters.pet === 'object' ? parameters.pet : null) as Pet | null;
    if (!eggId || !pet?.petSpecies) continue;
    const record = luck[eggId] ?? blankEgg();
    const mutations = Array.isArray(pet.mutations) ? pet.mutations : [];
    record.hatches += 1;
    record.species[pet.petSpecies] = (record.species[pet.petSpecies] || 0) + 1;
    for (const colour of COLOURS) {
      if (mutations.includes(colour)) record.colours[colour] = (record.colours[colour] || 0) + 1;
      bump(record, colour, mutations.includes(colour));
    }
    const rarest = pitySpecies(eggId);
    if (rarest) bump(record, 'species', pet.petSpecies === rarest);
    luck[eggId] = record;
    changed = true;
  }
  if (changed) save();
}

/** Redraw only when a hatch has actually landed, rather than on every state frame. */
export function eggLuckSignature(): string {
  return JSON.stringify(luck);
}

export function resetEggLuck(eggId: string): void {
  delete luck[eggId];
  save();
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
  const keys = [pitySpecies(eggId) ? 'species' : '', ...COLOURS].filter(Boolean);
  return keys.filter(key => (record.counters[key]?.misses ?? 0) >= (PITY_THRESHOLDS[key] ?? PITY_THRESHOLDS.species)).length;
}

/**
 * One guarantee's progress. An unsynced counter is shown as a floor rather than a figure, because
 * the hatches from before tracking began are in the game's count and not in ours.
 */
function pityRow(label: string, sprite: string, record: EggRecord, key: string): string {
  const threshold = PITY_THRESHOLDS[key] ?? PITY_THRESHOLDS.species;
  const { misses, synced } = record.counters[key] ?? emptyCounter();
  const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
  const title = synced
    ? `${label} last landed ${misses.toLocaleString(NUMBER_LOCALE)} hatches ago. Guaranteed at ${threshold.toLocaleString(NUMBER_LOCALE)}.`
    : `At least ${misses.toLocaleString(NUMBER_LOCALE)} hatches - ${label} has not landed since tracking began, so the game's own count may be higher. Guaranteed at ${threshold.toLocaleString(NUMBER_LOCALE)}.`;
  return `<div class="gc-egg-pity" data-due="${misses >= threshold}" title="${escapeHtml(title)}">`
    + `<span class="gc-shop-sprite">${icon}</span>`
    + `<span class="gc-egg-pity-label">${escapeHtml(label)}</span>`
    + `<span class="gc-egg-bar"><i style="width:${Math.min(100, misses / threshold * 100).toFixed(1)}%"></i></span>`
    + `<span class="gc-egg-pity-count">${synced ? '' : '&#8805;'}${misses.toLocaleString(NUMBER_LOCALE)} / ${threshold.toLocaleString(NUMBER_LOCALE)}</span>`
    + '</div>';
}

function eggCard(eggId: string): string {
  const record = luck[eggId] ?? blankEgg();
  const sprite = page.__gardenCompanionShopSprites?.[eggId] || '';
  const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
  const title = `<span class="gc-shop-sprite">${icon}</span>${escapeHtml(eggName(eggId))}`;
  const hatched = `<span class="gc-pill">${record.hatches.toLocaleString(NUMBER_LOCALE)} hatched</span>`;
  // An egg with nothing recorded is already one line, so it stays a plain heading with nothing to
  // fold - a control that opens an empty card would only invite the click.
  if (!record.hatches) {
    return `<section class="gc-card gc-egg-card" data-empty="true"><div class="gc-row"><h3>${title}</h3>${hatched}</div>`
      + '<p>No hatches seen yet.</p></section>';
  }
  const open = !collapsed.has(eggId);
  // A guarantee that has come due is the one thing worth seeing without opening the card.
  const due = dueCount(eggId, record);
  const head = `<button class="gc-egg-head" data-egg-toggle="${escapeHtml(eggId)}" aria-expanded="${open}">`
    + `<h3>${title}</h3>`
    + (due ? `<span class="gc-pill gc-egg-due">${due} due</span>` : '')
    + hatched
    + `<i>${open ? '&#9650;' : '&#9660;'}</i></button>`;

  const weights = EGG_CATALOG[eggId]?.spawnWeights || {};
  const weightTotal = Object.values(weights).reduce((sum, weight) => sum + (Number(weight) || 0), 0);
  // Most likely first, matching the order the game lists a hatch table in. Anything hatched that the
  // spawn table does not mention still gets a line rather than dropping out of the totals.
  const listed = Object.keys(weights).sort((left, right) => (weights[right] || 0) - (weights[left] || 0));
  const rows = [...listed, ...Object.keys(record.species).filter(id => !weights[id])].map(id => {
    const count = record.species[id] || 0;
    const odds = weightTotal > 0 && weights[id] ? `${(weights[id] / weightTotal * 100).toFixed(0)}%` : '-';
    return `<tr${count ? '' : ' class="gc-egg-none"'}><td>${escapeHtml(speciesName(id))}</td>`
      + `<td>${count.toLocaleString(NUMBER_LOCALE)}</td>`
      + `<td>${share(count, record.hatches)}</td>`
      + `<td>${odds}</td></tr>`;
  }).join('');

  const colours = COLOURS
    .map(colour => `<span class="gc-pill">${escapeHtml(colour)} ${(record.colours[colour] || 0).toLocaleString(NUMBER_LOCALE)}</span>`)
    .join('');
  const rarest = pitySpecies(eggId);
  const pity = [
    rarest ? pityRow(speciesName(rarest), page.__gardenCompanionPetSprites?.[rarest] || '', record, 'species') : '',
    ...COLOURS.map(colour => pityRow(colour, mutationSprite(colour), record, colour)),
  ].join('');

  return `<section class="gc-card gc-egg-card">${head}
<div class="gc-egg-body"${open ? '' : ' hidden'}>
<table class="gc-egg-table"><thead><tr><th>Species</th><th>Hatched</th><th>Yours</th><th>Odds</th></tr></thead><tbody>${rows}</tbody></table>
<div class="gc-egg-colours">${colours}<button data-egg-reset="${escapeHtml(eggId)}" title="Clear everything recorded for this egg">Reset</button></div>
<div class="gc-egg-pities">${pity}</div></div></section>`;
}

export function renderEggLuck(): string {
  // Catalog order, which is the order the shop lists eggs in. WinterEgg is the old name for SnowEgg
  // and hatches nothing new, so it shows only if something was recorded against it.
  const eggs = Object.keys(EGG_CATALOG).filter(eggId => eggId !== 'WinterEgg' || luck[eggId]?.hatches);
  const hatched = eggs.reduce((sum, eggId) => sum + (luck[eggId]?.hatches || 0), 0);
  return `<p class="gc-note">Every hatch seen while Garden Companion was running, and how close each egg is to its guarantee. The game keeps these counters to itself, so they are counted here instead - anything hatched before you installed, or in a session without the script, is not in them. A count reads <b>&#8805;</b> until that outcome lands once, which syncs it to the game's own.</p>
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
}
