import { feature } from '../config.js';
import { ABILITY_DETAILS, ABILITY_FILTER_OPTIONS, ABILITY_GROUP_BY_ID, ABILITY_GROUPS, ABILITY_SET, LOG_PER_ABILITY, LOG_VISIBLE_ROWS } from '../constants.js';
import { config, saveConfig } from '../config.js';
import { allPets, petSprite } from '../pets.js';
import { saveAbilityLog, state, trimAbilityLogs, type AbilityLogRow } from '../state.js';
import { panelActions } from '../panel-actions.js';
import { LOG_KEY } from '../constants.js';
import type { Pet } from '../types.js';
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

export function processActivities() {
  if (!feature('abilities')) return;
  const entries = state.slot?.data?.activityLogs;
  if (!Array.isArray(entries)) return;
  const fresh = entries.filter(entry => Number(entry?.timestamp) > state.activityCursor).sort((a, b) => a.timestamp - b.timestamp);
  if (!fresh.length) return;
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
  state.activityCursor = Math.max(state.activityCursor, ...fresh.map(entry => Number(entry.timestamp) || 0));
  localStorage.setItem('gardenCompanion.activityCursor', String(state.activityCursor));
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
  return humanize(raw);
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


export function selectedAbilityFilters(): Set<string> {
  const saved = new Set(config.trackedAbilities || []);
  const hasGroupedKeys = ABILITY_GROUPS.some(([label]) => saved.has(label));
  return new Set(ABILITY_FILTER_OPTIONS.filter(option =>
    saved.has(option.key) || !hasGroupedKeys && option.abilities.some(ability => saved.has(ability)),
  ).map(option => option.key));
}

function abilityFilterSummary(selectedFilters: Set<string>): string {
  return selectedFilters.size === ABILITY_FILTER_OPTIONS.length ? 'All abilities' : selectedFilters.size === 0 ? 'No abilities' : selectedFilters.size === 1 ? ABILITY_FILTER_OPTIONS.find(option => selectedFilters.has(option.key))?.label || 'No abilities' : `${selectedFilters.size} selections`;
}

function triggeringPet(log: AbilityLogRow): Pet | null {
  const raw = payloadRecord(log.data.pet) || payloadRecord(log.data.sourcePet);
  const id = String(raw?.id || '');
  const owned = allPets().find(pet => id ? pet.id === id : pet.name === log.pet);
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

function procDateParts(timestamp: number): { date: string; time: string; iso: string } {
  const value = new Date(timestamp);
  return {
    date: value.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }),
    time: value.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    iso: value.toISOString(),
  };
}

export function renderAbilityLogRows(selectedFilters: Set<string>): string {
  const isVisibleAbility = (ability: string) => ABILITY_SET.has(ability) && ABILITY_FILTER_OPTIONS.some(option => selectedFilters.has(option.key) && option.abilities.includes(ability));
  const search = abilityLogSearch.trim().toLowerCase();
  const matched = state.abilityLog.filter(log => {
    if (!isVisibleAbility(log.ability)) return false;
    if (!search) return true;
    // Searching covers the pet, the ability name and the outcome, plus whatever the row moved into
    // its tooltip: a growth boost shows only a count, and the species it touched are still worth
    // being able to find.
    const name = ABILITY_DETAILS[log.ability]?.name || humanize(log.ability);
    const detail = procOutcomeTooltip(log.ability, log.data);
    return `${log.pet} ${name} ${procOutcome(log.ability, log.data)} ${detail}`.toLowerCase().includes(search);
  });
  const recent = matched.slice(0, LOG_VISIBLE_ROWS);
  if (!recent.length) return search ? '<p>Nothing matches that search.</p>' : '<p>No ability procs recorded yet.</p>';
  const more = matched.length > recent.length ? `<p>Showing the newest ${recent.length} of ${matched.length} matches.</p>` : '';
  return recent.map(log => {
    const when = procDateParts(log.at);
    const pet = triggeringPet(log);
    const sprite = pet ? petSprite(pet) : '<span class="gc-pet-sprite"><i>?</i></span>';
    const tooltip = procOutcomeTooltip(log.ability, log.data);
    return `<article class="gc-ability-log-row"><time datetime="${escapeHtml(when.iso)}"><b>${escapeHtml(when.time)}</b><span>${escapeHtml(when.date)}</span></time><div class="gc-ability-log-pet" title="${escapeHtml(log.pet)}">${sprite}</div><div class="gc-ability-log-name"><b>${escapeHtml(ABILITY_DETAILS[log.ability]?.name || humanize(log.ability))}</b></div><div class="gc-ability-log-payload"${tooltip ? ` title="${escapeHtml(tooltip)}" data-detail` : ''}>${escapeHtml(procOutcome(log.ability, log.data))}</div></article>`;
  }).join('') + more;
}

export function refreshAbilityFilterUi(main: HTMLElement): void {
  const selectedFilters = selectedAbilityFilters();
  const summary = main.querySelector<HTMLElement>('[data-ability-filter] summary');
  if (summary) summary.textContent = abilityFilterSummary(selectedFilters);
  main.querySelectorAll<HTMLButtonElement>('[data-ability-option]').forEach(button => {
    const active = selectedFilters.has(button.dataset.abilityOption || '');
    button.dataset.active = String(active);
    const marker = button.querySelector<HTMLElement>('i');
    if (marker) marker.innerHTML = active ? '&#10003;' : '';
  });
  const log = main.querySelector<HTMLElement>('.gc-log');
  if (log) {
    const scrollTop = log.scrollTop;
    log.innerHTML = renderAbilityLogRows(selectedFilters);
    log.scrollTop = scrollTop;
  }
}

export function renderAbilityLog() {
  const selectedFilters = selectedAbilityFilters();
  const filterSummary = abilityFilterSummary(selectedFilters);
  const filterOptions = ABILITY_FILTER_OPTIONS.map(option => `<button data-ability-option="${escapeHtml(option.key)}" data-active="${selectedFilters.has(option.key)}"><span>${escapeHtml(option.label)}</span><i>${selectedFilters.has(option.key) ? '&#10003;' : ''}</i></button>`).join('');
  return `<section class="gc-card gc-ability-log-card"><div class="gc-ability-log-toolbar"><div><h3>Pet ability history</h3><small>Up to ${LOG_PER_ABILITY} entries are stored per ability.</small></div><div class="gc-ability-log-actions"><input class="gc-search gc-log-search" type="text" data-log-search placeholder="Search history" spellcheck="false" value="${escapeHtml(abilityLogSearch)}"><details class="gc-ability-filter" data-ability-filter ${abilityFilterMenuOpen ? 'open' : ''}><summary>${escapeHtml(filterSummary)}</summary><div class="gc-ability-picker"><header><button data-ability-all>All</button><button data-ability-none>None</button></header>${filterOptions}</div></details><button data-clear-log>Clear</button></div></div><div class="gc-ability-log-columns"><span>Time &amp; date</span><span>Pet</span><span>Ability</span><span>Payload</span></div><div class="gc-log">${renderAbilityLogRows(selectedFilters)}</div></section>`;
}

export function bindAbilityLogEvents(main: HTMLElement): void {
  main.querySelector('[data-clear-log]')?.addEventListener('click', () => { state.abilityLog = []; saveLocal(LOG_KEY, []); panelActions.renderPanel(); });
  // Only the rows are redrawn, so the field keeps its focus and caret while typing.
  main.querySelector('[data-log-search]')?.addEventListener('input', event => {
    setAbilityLogSearch((event.target as HTMLInputElement).value);
    refreshAbilityFilterUi(main);
    const log = main.querySelector('.gc-log') as HTMLElement | null;
    if (log) log.scrollTop = 0;
  });
  const abilityFilter = main.querySelector('[data-ability-filter]') as HTMLDetailsElement | null;
  if (!abilityFilter) return;
  abilityFilter.ontoggle = () => {
    setAbilityFilterMenuOpen(abilityFilter.open);
    setAbilityFilterInteracting(abilityFilter.open);
    if (abilityFilter.open) panelActions.cancelPanelRefresh();
  };
  abilityFilter.addEventListener('focusout', () => setTimeout(() => {
    if (!abilityFilter.contains(document.activeElement)) {
      abilityFilter.open = false;
      setAbilityFilterMenuOpen(false);
      setAbilityFilterInteracting(false);
    }
  }));
  main.querySelectorAll<HTMLButtonElement>('[data-ability-option]').forEach(button => button.onclick = event => {
    event.preventDefault();
    const selected = new Set(config.trackedAbilities || []);
    const currentKeys = new Set(ABILITY_FILTER_OPTIONS.filter(option => selected.has(option.key) || option.abilities.some(ability => selected.has(ability))).map(option => option.key));
    const key = button.dataset.abilityOption!;
    currentKeys.has(key) ? currentKeys.delete(key) : currentKeys.add(key);
    config.trackedAbilities = [...currentKeys];
    saveConfig(); setAbilityFilterMenuOpen(true); setAbilityFilterInteracting(true); refreshAbilityFilterUi(main);
  });
  main.querySelector('[data-ability-all]')?.addEventListener('click', event => { event.preventDefault(); config.trackedAbilities = ABILITY_FILTER_OPTIONS.map(option => option.key); saveConfig(); setAbilityFilterMenuOpen(true); setAbilityFilterInteracting(true); refreshAbilityFilterUi(main); });
  main.querySelector('[data-ability-none]')?.addEventListener('click', event => { event.preventDefault(); config.trackedAbilities = []; saveConfig(); setAbilityFilterMenuOpen(true); setAbilityFilterInteracting(true); refreshAbilityFilterUi(main); });
}
