import { feature } from '../config.js';
import { ABILITY_DETAILS, ABILITY_FILTER_OPTIONS, ABILITY_GROUP_BY_ID, ABILITY_SET, LOG_PER_ABILITY, LOG_VISIBLE_ROWS, mutationName, PET_CATALOG } from '../constants.js';
import { config, saveConfig } from '../config.js';
import { allPets, petOverlay, petSpriteSource } from '../pets.js';
import { page } from '../page.js';
import { saveAbilityLog, state, trimAbilityLogs, type AbilityLogRow } from '../state.js';
import { panelActions } from '../panel-actions.js';
import { LOG_KEY } from '../constants.js';
import type { ActivityLogEntry, Pet } from '../types.js';
import { NUMBER_LOCALE, saveLocal } from '../utils.js';
import { escapeHtml, humanize } from '../utils.js';

let abilityLogSearch = '';
let abilityFilterMenuOpen = false;
let abilityFilterInteracting = false;

export function abilityLogUiState() {
  return { get menuOpen() { return abilityFilterMenuOpen; }, get interacting() { return abilityFilterInteracting; } };
}

export function setAbilityFilterMenuOpen(open: boolean): void {
  abilityFilterMenuOpen = open;
}

export function setAbilityFilterInteracting(interacting: boolean): void {
  abilityFilterInteracting = interacting;
}

export function setAbilityLogSearch(query: string): void {
  abilityLogSearch = query;
}

/**
 * The Pet Abilities tab: the running history of ability procs, and the filter and search over it.
 * Entries are read from the game's own activity log, which only keeps the most recent few, so they
 * are copied into our own history as they appear.
 */

export function recordAbilityActivities(fresh: ActivityLogEntry[]) {
  for (const entry of fresh) {
    if (!ABILITY_SET.has(entry.action)) continue;
    const pet = (entry.parameters?.pet || entry.parameters?.sourcePet || {}) as Record<string, unknown>;
    state.abilityLog.unshift({
      at: Number(entry.timestamp),
      ability: entry.action,
      pet: String(pet.name || pet.petSpecies || 'Pet'),
      data: snapshotPayload(entry.parameters || {}),
    });
  }
  state.abilityLog = trimAbilityLogs(state.abilityLog);
  saveAbilityLog();
}


function snapshotPayload(data: Record<string, unknown>): Record<string, unknown> {
  try { return JSON.parse(JSON.stringify(data)) as Record<string, unknown>; }
  catch { return {}; }
}

function payloadRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function displayedItemName(value: unknown): string {
  const raw = String(value ?? 'Unknown');
  if (raw === 'MoonCelestial' || raw === 'Moon Celestial') return 'Moonbinder';
  if (raw === 'DawnCelestial' || raw === 'Dawn Celestial') return 'Dawnbinder';
  // A mutation carries a name of its own - a granter's log line said Ambershine where the game says
  // Amberlit, and Ambercharged where it says Amberbound. Anything else falls through to humanize
  // inside mutationName, which is what this used to do directly.
  return mutationName(raw);
}

function payloadItemName(value: unknown): string {
  if (typeof value === 'string') return displayedItemName(value);
  const item = payloadRecord(value);
  return item ? displayedItemName(item.name || item.species || item.petSpecies || item.eggId || item.id || 'Unknown') : String(value ?? 'Unknown');
}

function payloadItemList(value: unknown): string {
  if (!Array.isArray(value)) return payloadItemName(value);
  const counts = new Map<string, number>();
  for (const item of value) {
    const name = payloadItemName(item);
    counts.set(name, (counts.get(name) ?? 0) + Number(payloadRecord(item)?.quantity || 1));
  }
  return [...counts].map(([name, quantity]) => quantity > 1 ? `${name} x${quantity}` : name).join(', ');
}

function payloadItemCount(value: unknown): number {
  if (!Array.isArray(value)) return value == null ? 0 : 1;
  return value.reduce((total, item) => total + Number(payloadRecord(item)?.quantity || 1), 0);
}

/**
 * Growth savings arrive as raw seconds, and four figures of them is unreadable: 204s is really
 * 3m 24s. Sub-minute values keep just the seconds rather than gaining an empty minutes place.
 */
function formatReduction(value: unknown): string {
  const total = Math.max(0, Math.round(Number(value) || 0));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${minutes}m`;
  const remainder = minutes % 60;
  return remainder ? `${Math.floor(minutes / 60)}h ${String(remainder).padStart(2, '0')}m` : `${Math.floor(minutes / 60)}h`;
}

/** Reads as "what was affected, then what it got", rather than two facts sitting side by side. */
const ARROW = '->';

function withReduction(text: string, seconds: unknown): string {
  return seconds != null ? `${text} ${ARROW} ${formatReduction(seconds)} reduced` : text;
}

function countLabel(count: number, noun: string): string {
  return `${count.toLocaleString(NUMBER_LOCALE)} ${noun}${count === 1 ? '' : 's'}`;
}

export function procOutcome(ability: string, data: Record<string, unknown>): string {
  const growSlot = payloadRecord(data.growSlot);
  // What was touched, then what it gained. The species moves to the tooltip so the row keeps the
  // shape every other boost has: an amount, then the effect on it.
  if (ABILITY_GROUP_BY_ID.get(ability) === 'Crop Size Boost') {
    const count = data.numPlantsAffected != null ? countLabel(Number(data.numPlantsAffected), 'plant') : '';
    const boost = data.scaleIncreasePercentage != null ? `+${Number(data.scaleIncreasePercentage).toFixed(1)}% boosted` : '';
    if (count && boost) return `${count} ${ARROW} ${boost}`;
    if (count || boost) return count || boost;
  }
  if (ability.includes('SeedFinder') && data.speciesId) return payloadItemName(data.speciesId);
  if (growSlot?.species) return payloadItemName(growSlot.species);
  if (data.harvestedCrop) return payloadItemName(data.harvestedCrop);
  if (data.extraPet) return payloadItemName(data.extraPet);
  if (data.targetPet) return payloadItemName(data.targetPet);
  if (data.cropsRefunded) return payloadItemList(data.cropsRefunded);
  if (data.petsAffected) return payloadItemList(data.petsAffected);
  // Growth boosts touch everything growing at once, so the row gets the count and the time saved
  // and the full breakdown moves to the tooltip - a list of forty eggs is unreadable in a cell.
  if (data.eggsAffected) return withReduction(countLabel(payloadItemCount(data.eggsAffected), 'egg'), data.secondsReduced);
  if (data.growSlotsAffected) return withReduction(countLabel(payloadItemCount(data.growSlotsAffected), 'plant'), data.secondsReduced);
  if (data.eggId) return payloadItemName(data.eggId);
  if (data.coinsFound != null) return `${Number(data.coinsFound).toLocaleString(NUMBER_LOCALE)} coins`;
  if (data.bonusCoins != null) return `+${Number(data.bonusCoins).toLocaleString(NUMBER_LOCALE)} coins`;
  if (data.bonusXp != null) return `+${Number(data.bonusXp).toLocaleString(NUMBER_LOCALE)} XP`;
  // Plant growth reports a plain count rather than a list of slots, and the count came second, so
  // the time alone was winning here and the number of plants was never reached.
  if (data.secondsReduced != null) {
    const saved = `${formatReduction(data.secondsReduced)} reduced`;
    return data.numPlantsAffected != null ? `${countLabel(Number(data.numPlantsAffected), 'plant')} ${ARROW} ${saved}` : saved;
  }
  if (data.numPlantsAffected != null) return `${Number(data.numPlantsAffected).toLocaleString(NUMBER_LOCALE)} plants`;
  if (data.hungerRestoreAmount != null) return `${Number(data.hungerRestoreAmount).toLocaleString(NUMBER_LOCALE)} hunger`;
  if (data.sellPrice != null) return `${Number(data.sellPrice).toLocaleString(NUMBER_LOCALE)} coins`;
  if (data.strengthIncrease != null) return `+${Number(data.strengthIncrease).toLocaleString(NUMBER_LOCALE)} STR`;
  if (data.scaleIncreasePercentage != null) return `+${Number(data.scaleIncreasePercentage).toLocaleString(NUMBER_LOCALE)}% size`;
  if (data.mutation || data.targetMutation) return payloadItemName(data.mutation || data.targetMutation);
  const fallback = Object.entries(data).find(([key, value]) => !['pet', 'sourcePet'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value));
  return fallback ? `${humanize(fallback[0])}: ${String(fallback[1])}` : 'Proc recorded';
}

export function procOutcomeTooltip(ability: string, data: Record<string, unknown>): string {
  const family = ABILITY_GROUP_BY_ID.get(ability);
  if (family === 'XP Boost') {
    const gained = data.bonusXp ?? data.xpGranted;
    if (gained != null) return `XP gained: +${Math.floor(Number(gained)).toLocaleString(NUMBER_LOCALE)} XP`;
  }
  if (family === 'Hunger Restore' && data.hungerRestoreAmount != null) {
    return `Hunger gained: ${Number(data.hungerRestoreAmount).toLocaleString(NUMBER_LOCALE)}`;
  }
  // The row only has room for a count, so what was actually boosted lives here.
  if (data.eggsAffected) return payloadItemList(data.eggsAffected);
  if (data.growSlotsAffected) return payloadItemList(data.growSlotsAffected);
  if (family === 'Crop Size Boost') {
    const species = payloadRecord(data.growSlot)?.species;
    if (species) return payloadItemName(species);
  }
  return '';
}


/**
 * The individual abilities the picker can toggle, in display order. A filter option can list a tier
 * that this bundle's catalog does not have yet (the tables come from a preview build), so an option
 * that always draws empty is dropped, and within a group only the abilities that actually exist are
 * offered - toggling one no pet can have does nothing.
 */
const FILTERABLE_ABILITIES: string[] = (() => {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const option of ABILITY_FILTER_OPTIONS) {
    for (const ability of option.abilities) {
      if (ABILITY_SET.has(ability) && !seen.has(ability)) { seen.add(ability); order.push(ability); }
    }
  }
  return order;
})();

/** Only the options that have at least one released ability to show. */
const VISIBLE_FILTER_OPTIONS = ABILITY_FILTER_OPTIONS
  .map(option => ({ ...option, items: option.abilities.filter(ability => ABILITY_SET.has(ability)) }))
  .filter(option => option.items.length > 0);

function abilityDisplayName(ability: string): string {
  return ABILITY_DETAILS[ability]?.name || humanize(ability);
}

/**
 * The abilities the history should show. The config stores individual ability ids (so a granter can
 * be shown while its siblings are hidden); a group label left over from an older build is expanded
 * to its members on read, so nothing has to be migrated.
 */
export function enabledAbilities(): Set<string> {
  const saved = config.trackedAbilities || [];
  const enabled = new Set<string>();
  for (const value of saved) {
    if (ABILITY_SET.has(value)) { enabled.add(value); continue; }
    const group = ABILITY_FILTER_OPTIONS.find(option => option.key === value);
    if (group) for (const ability of group.abilities) if (ABILITY_SET.has(ability)) enabled.add(ability);
  }
  return enabled;
}

type GroupState = 'all' | 'some' | 'none';

function groupState(items: readonly string[], enabled: Set<string>): GroupState {
  const on = items.reduce((total, ability) => total + (enabled.has(ability) ? 1 : 0), 0);
  return on === 0 ? 'none' : on === items.length ? 'all' : 'some';
}

const STATE_MARKER: Record<GroupState, string> = { all: '&#10003;', some: '&#8211;', none: '' };

function abilityFilterSummary(enabled: Set<string>): string {
  const total = FILTERABLE_ABILITIES.length;
  const on = FILTERABLE_ABILITIES.reduce((count, ability) => count + (enabled.has(ability) ? 1 : 0), 0);
  if (on === total) return 'All abilities';
  if (on === 0) return 'No abilities';
  if (on === 1) return abilityDisplayName(FILTERABLE_ABILITIES.find(ability => enabled.has(ability)) || '');
  return `${on} abilities`;
}

/**
 * Indexed once per render. triggeringPet used to reach for allPets() itself, which rebuilds the
 * whole list - every active, stored and inventory pet spread into a new object - and it did that
 * for each of up to four hundred rows, on every keystroke.
 */
interface OwnedPets { byId: Map<string, Pet>; byName: Map<string, Pet> }

function indexOwnedPets(): OwnedPets {
  const byId = new Map<string, Pet>();
  const byName = new Map<string, Pet>();
  for (const pet of allPets()) {
    if (pet.id) byId.set(pet.id, pet);
    // First wins, matching the find() this replaced.
    if (pet.name && !byName.has(pet.name)) byName.set(pet.name, pet);
  }
  return { byId, byName };
}

function triggeringPet(log: AbilityLogRow, owners: OwnedPets): Pet | null {
  const raw = payloadRecord(log.data.pet) || payloadRecord(log.data.sourcePet);
  const id = String(raw?.id || '');
  const owned = id ? owners.byId.get(id) : owners.byName.get(log.pet);
  const petSpecies = String(raw?.petSpecies || raw?.species || owned?.petSpecies || '');
  if (!petSpecies) return null;
  return {
    id: id || owned?.id || '',
    name: String(raw?.name || owned?.name || log.pet),
    petSpecies,
    hunger: Number(raw?.hunger ?? owned?.hunger ?? 0),
    mutations: Array.isArray(raw?.mutations) ? raw.mutations.filter(value => typeof value === 'string') as string[] : owned?.mutations,
  };
}

/**
 * Held rather than made per call: passing options to toLocaleDateString builds a formatter every
 * time, and the log draws hundreds of rows on every keystroke. The locale is left to the browser,
 * since a date in the reader's own format is right where a grouped number would not be.
 */
const LOG_DATE_FORMAT = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
const LOG_TIME_FORMAT = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function procDateParts(timestamp: number): { date: string; time: string; iso: string } {
  const value = new Date(timestamp);
  return {
    date: LOG_DATE_FORMAT.format(value),
    time: LOG_TIME_FORMAT.format(value),
    iso: value.toISOString(),
  };
}

/**
 * Searching covers the pet, the ability name and the outcome, plus whatever the row moved into its
 * tooltip: a growth boost shows only a count, and the species it touched are still worth being able
 * to find. Building that costs two payload formatters, and a row never changes once recorded, so it
 * is kept rather than rebuilt for every keystroke over the whole history.
 */
const searchTextCache = new WeakMap<AbilityLogRow, string>();

function searchText(log: AbilityLogRow): string {
  const cached = searchTextCache.get(log);
  if (cached !== undefined) return cached;
  const name = ABILITY_DETAILS[log.ability]?.name || humanize(log.ability);
  const text = `${log.pet} ${name} ${procOutcome(log.ability, log.data)} ${procOutcomeTooltip(log.ability, log.data)}`.toLowerCase();
  searchTextCache.set(log, text);
  return text;
}

/**
 * A pet sprite is a decoded PNG carried inline as a data url, and the same few pets account for
 * hundreds of rows. Writing one into every row means megabytes of markup to build and parse on each
 * keystroke, so rows carry a key and the sources are attached afterwards, where identical rows
 * share one string rather than repeating it.
 */
const logSpriteSources = new Map<string, string>();

function logSprite(pet: Pet | null): string {
  if (!pet) return '<span class="gc-pet-sprite"><i>?</i></span>';
  const source = petSpriteSource(pet);
  if (!source) return `<span class="gc-pet-sprite"><i>${escapeHtml((PET_CATALOG[pet.petSpecies]?.name || pet.petSpecies || '?').slice(0, 1))}</i></span>`;
  const overlay = petOverlay(pet);
  const key = `${pet.petSpecies}:${overlay}`;
  logSpriteSources.set(key, source);
  // Gold and Rainbow tints are rendered on a canvas in the background and swapped into any sprite
  // already on the page by this key, so the rows keep carrying it.
  const mutation = overlay ? ` data-pet-mutation-key="${escapeHtml(key)}"` : '';
  return `<span class="gc-pet-sprite"><img data-log-sprite="${escapeHtml(key)}" alt="${escapeHtml(pet.petSpecies)}"${mutation}></span>`;
}

/** Rows are markup until this runs, so it has to follow every path that writes them into the page. */
function hydrateAbilityLogSprites(root: HTMLElement): void {
  root.querySelectorAll<HTMLImageElement>('img[data-log-sprite]').forEach(image => {
    const source = logSpriteSources.get(image.dataset.logSprite || '');
    if (source && image.src !== source) image.src = source;
  });
}

export function renderAbilityLogRows(enabled: Set<string>): string {
  const search = abilityLogSearch.trim().toLowerCase();
  const matched = state.abilityLog.filter(log => enabled.has(log.ability) && (!search || searchText(log).includes(search)));
  const recent = matched.slice(0, LOG_VISIBLE_ROWS);
  if (!recent.length) return search ? '<p>Nothing matches that search.</p>' : '<p>No ability procs recorded yet.</p>';
  const more = matched.length > recent.length ? `<p>Showing the newest ${recent.length} of ${matched.length} matches.</p>` : '';
  const owners = indexOwnedPets();
  logSpriteSources.clear();
  return recent.map(log => {
    const when = procDateParts(log.at);
    const pet = triggeringPet(log, owners);
    const sprite = logSprite(pet);
    const tooltip = procOutcomeTooltip(log.ability, log.data);
    return `<article class="gc-ability-log-row"><time datetime="${escapeHtml(when.iso)}"><b>${escapeHtml(when.time)}</b><span>${escapeHtml(when.date)}</span></time><div class="gc-ability-log-pet" title="${escapeHtml(log.pet)}">${sprite}</div><div class="gc-ability-log-name"><b>${escapeHtml(ABILITY_DETAILS[log.ability]?.name || humanize(log.ability))}</b></div><div class="gc-ability-log-payload"${tooltip ? ` title="${escapeHtml(tooltip)}" data-detail` : ''}>${escapeHtml(procOutcome(log.ability, log.data))}</div></article>`;
  }).join('') + more;
}

/** Groups start collapsed; the user expands only the ones they want to fine-tune. */
const expandedGroups = new Set<string>();

/** A single ungrouped ability, shown as its own toggle row. */
function renderStandaloneItem(option: { label: string; items: string[] }, enabled: Set<string>): string {
  const ability = option.items[0];
  const active = enabled.has(ability);
  return `<div class="gc-ability-standalone"><button data-ability-item="${escapeHtml(ability)}" data-active="${active}"><span>${escapeHtml(option.label)}</span><i>${active ? '&#10003;' : ''}</i></button></div>`;
}

/** A collapsible group: a header that toggles the whole group, a caret, and a row per member. */
function renderFilterGroup(option: { key: string; label: string; items: string[] }, enabled: Set<string>): string {
  const state = groupState(option.items, enabled);
  const on = option.items.reduce((count, ability) => count + (enabled.has(ability) ? 1 : 0), 0);
  const expanded = expandedGroups.has(option.key);
  const items = option.items.map(ability => {
    const active = enabled.has(ability);
    return `<button data-ability-item="${escapeHtml(ability)}" data-active="${active}"><span>${escapeHtml(abilityDisplayName(ability))}</span><i>${active ? '&#10003;' : ''}</i></button>`;
  }).join('');
  return `<section class="gc-ability-group" data-group="${escapeHtml(option.key)}"><div class="gc-ability-group-head"><button class="gc-ability-expand" data-ability-expand="${escapeHtml(option.key)}" aria-expanded="${expanded}">${expanded ? '&#9662;' : '&#9656;'}</button><button class="gc-ability-group-toggle" data-ability-group="${escapeHtml(option.key)}" data-state="${state}"><span>${escapeHtml(option.label)}</span><small>${on}/${option.items.length}</small><i>${STATE_MARKER[state]}</i></button></div><div class="gc-ability-group-items"${expanded ? '' : ' hidden'}>${items}</div></section>`;
}

function renderAbilityFilterBody(enabled: Set<string>): string {
  return VISIBLE_FILTER_OPTIONS.map(option =>
    option.abilities.length === 1 ? renderStandaloneItem(option, enabled) : renderFilterGroup(option, enabled),
  ).join('');
}

/**
 * The dialog lives on the page body, not inside the panel, so the panel's periodic redraw never
 * disturbs it. That means the panel's own filter button and log rows have to be updated by hand when
 * a selection changes, since the auto-refresh is held off while the dialog is open.
 */
function refreshAbilityPanel(): void {
  const enabled = enabledAbilities();
  const openButton = page.document.querySelector<HTMLElement>('[data-ability-filter-open]');
  if (openButton) openButton.textContent = abilityFilterSummary(enabled);
  const log = page.document.querySelector<HTMLElement>('.gc-ability-log-card .gc-log');
  if (log) {
    const scrollTop = log.scrollTop;
    log.innerHTML = renderAbilityLogRows(enabled);
    hydrateAbilityLogSprites(log);
    log.scrollTop = scrollTop;
  }
}

const ABILITY_MODAL_ID = 'gc-ability-filter-modal';

function abilityModalMarkup(enabled: Set<string>): string {
  return `<div class="gc-ability-modal" role="dialog" aria-label="Ability history filter"><header class="gc-modal-head"><h3>Show which abilities</h3><button class="gc-modal-close" data-ability-close aria-label="Close">&times;</button></header><div class="gc-modal-tools"><span class="gc-modal-summary" data-ability-summary>${escapeHtml(abilityFilterSummary(enabled))}</span><div><button data-ability-all>All</button><button data-ability-none>None</button></div></div><div class="gc-modal-body" data-ability-body>${renderAbilityFilterBody(enabled)}</div></div>`;
}

/** Redraw just the modal's option list and summary, keeping which groups are expanded. */
function redrawAbilityModal(root: HTMLElement): void {
  const enabled = enabledAbilities();
  const body = root.querySelector<HTMLElement>('[data-ability-body]');
  if (body) body.innerHTML = renderAbilityFilterBody(enabled);
  const summary = root.querySelector<HTMLElement>('[data-ability-summary]');
  if (summary) summary.textContent = abilityFilterSummary(enabled);
}

function onAbilityModalKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.stopPropagation(); closeAbilityFilterDialog(); }
}

export function closeAbilityFilterDialog(): void {
  page.document.getElementById(ABILITY_MODAL_ID)?.remove();
  page.document.removeEventListener('keydown', onAbilityModalKey, true);
  setAbilityFilterMenuOpen(false);
  setAbilityFilterInteracting(false);
}

/**
 * The filter opens in its own dialog rather than a cramped dropdown, so every group and ability fits
 * with room to collapse the ones that are not being tuned. It is delegated off the backdrop so the
 * option list can be redrawn on every change without rebinding a handler per button.
 */
export function openAbilityFilterDialog(): void {
  closeAbilityFilterDialog();
  const backdrop = page.document.createElement('div');
  backdrop.id = ABILITY_MODAL_ID;
  backdrop.className = 'gc-modal-backdrop';
  backdrop.innerHTML = abilityModalMarkup(enabledAbilities());
  page.document.body.appendChild(backdrop);
  // The dialog is the interaction now, so hold off the panel's redraw while it is open.
  setAbilityFilterMenuOpen(true);
  setAbilityFilterInteracting(true);
  panelActions.cancelPanelRefresh();

  // Individual abilities are the stored truth, so every control writes the resolved set back out.
  const commit = (enabled: Set<string>) => {
    config.trackedAbilities = [...enabled];
    saveConfig();
    redrawAbilityModal(backdrop);
    refreshAbilityPanel();
  };

  backdrop.addEventListener('click', event => {
    const target = event.target as HTMLElement;
    if (target === backdrop || target.closest('[data-ability-close]')) { closeAbilityFilterDialog(); return; }

    const expand = target.closest<HTMLElement>('[data-ability-expand]');
    if (expand) {
      event.preventDefault();
      const key = expand.dataset.abilityExpand!;
      expandedGroups.has(key) ? expandedGroups.delete(key) : expandedGroups.add(key);
      redrawAbilityModal(backdrop);
      return;
    }
    const item = target.closest<HTMLElement>('[data-ability-item]');
    if (item) {
      event.preventDefault();
      const enabled = enabledAbilities();
      const ability = item.dataset.abilityItem!;
      enabled.has(ability) ? enabled.delete(ability) : enabled.add(ability);
      commit(enabled);
      return;
    }
    const group = target.closest<HTMLElement>('[data-ability-group]');
    if (group) {
      event.preventDefault();
      const option = VISIBLE_FILTER_OPTIONS.find(entry => entry.key === group.dataset.abilityGroup);
      if (!option) return;
      // A group whose members are all on turns the whole group off; anything else fills the group in.
      const enabled = enabledAbilities();
      const turningOff = groupState(option.items, enabled) === 'all';
      for (const ability of option.items) turningOff ? enabled.delete(ability) : enabled.add(ability);
      commit(enabled);
      return;
    }
    if (target.closest('[data-ability-all]')) { event.preventDefault(); commit(new Set(FILTERABLE_ABILITIES)); return; }
    if (target.closest('[data-ability-none]')) { event.preventDefault(); commit(new Set()); return; }
  });

  page.document.addEventListener('keydown', onAbilityModalKey, true);
}

export function renderAbilityLog() {
  const enabled = enabledAbilities();
  const filterSummary = abilityFilterSummary(enabled);
  return `<section class="gc-card gc-ability-log-card"><div class="gc-ability-log-toolbar"><div><h3>Pet ability history</h3><small>Up to ${LOG_PER_ABILITY} entries are stored per ability.</small></div><div class="gc-ability-log-actions"><input class="gc-search gc-log-search" type="text" data-log-search placeholder="Search history" spellcheck="false" value="${escapeHtml(abilityLogSearch)}"><button class="gc-ability-filter" data-ability-filter-open title="Choose which abilities to show">${escapeHtml(filterSummary)}</button><button data-clear-log>Clear</button></div></div><div class="gc-ability-log-columns"><span>Time &amp; date</span><span>Pet</span><span>Ability</span><span>Payload</span></div><div class="gc-log">${renderAbilityLogRows(enabled)}</div></section>`;
}

export function bindAbilityLogEvents(main: HTMLElement): void {
  // The panel writes the rows itself, so this is the other path that has to attach the sources.
  hydrateAbilityLogSprites(main);
  main.querySelector('[data-clear-log]')?.addEventListener('click', () => { state.abilityLog = []; saveLocal(LOG_KEY, []); panelActions.renderPanel(); });
  // Only the rows are redrawn, so the field keeps its focus and caret while typing.
  main.querySelector('[data-log-search]')?.addEventListener('input', event => {
    setAbilityLogSearch((event.target as HTMLInputElement).value);
    const log = main.querySelector<HTMLElement>('.gc-log');
    if (log) { log.innerHTML = renderAbilityLogRows(enabledAbilities()); hydrateAbilityLogSprites(log); log.scrollTop = 0; }
  });
  main.querySelector('[data-ability-filter-open]')?.addEventListener('click', event => { event.preventDefault(); openAbilityFilterDialog(); });
}
