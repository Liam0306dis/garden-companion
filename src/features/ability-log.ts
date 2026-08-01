import { feature } from '../config.js';
import { ABILITY_DETAILS, ABILITY_FILTER_OPTIONS, ABILITY_GROUPS, ABILITY_SET, LOG_PER_ABILITY, LOG_VISIBLE_ROWS } from '../constants.js';
import { config, saveConfig } from '../config.js';
import { saveAbilityLog, state, trimAbilityLogs } from '../state.js';
import { panelActions } from '../panel-actions.js';
import { LOG_KEY } from '../constants.js';
import { saveLocal } from '../utils.js';
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

function payloadItemName(value: unknown): string {
  if (typeof value === 'string') return humanize(value);
  const item = payloadRecord(value);
  return item ? humanize(item.name || item.species || item.petSpecies || item.eggId || item.id || 'Unknown') : String(value ?? 'Unknown');
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

export function procOutcome(ability: string, data: Record<string, unknown>): string {
  const growSlot = payloadRecord(data.growSlot);
  if (ability.includes('SeedFinder') && data.speciesId) return payloadItemName(data.speciesId);
  if (growSlot?.species) return payloadItemName(growSlot.species);
  if (data.harvestedCrop) return payloadItemName(data.harvestedCrop);
  if (data.extraPet) return payloadItemName(data.extraPet);
  if (data.targetPet) return payloadItemName(data.targetPet);
  if (data.cropsRefunded) return payloadItemList(data.cropsRefunded);
  if (data.petsAffected) return payloadItemList(data.petsAffected);
  if (data.eggsAffected) return payloadItemList(data.eggsAffected);
  if (data.growSlotsAffected) return payloadItemList(data.growSlotsAffected);
  if (data.eggId) return payloadItemName(data.eggId);
  if (data.coinsFound != null) return `${Number(data.coinsFound).toLocaleString()} coins`;
  if (data.bonusCoins != null) return `+${Number(data.bonusCoins).toLocaleString()} coins`;
  if (data.bonusXp != null) return `+${Number(data.bonusXp).toLocaleString()} XP`;
  if (data.secondsReduced != null) return `${Number(data.secondsReduced).toLocaleString()}s reduced`;
  if (data.numPlantsAffected != null) return `${Number(data.numPlantsAffected).toLocaleString()} plants`;
  if (data.hungerRestoreAmount != null) return `${Number(data.hungerRestoreAmount).toLocaleString()} hunger`;
  if (data.sellPrice != null) return `${Number(data.sellPrice).toLocaleString()} coins`;
  if (data.strengthIncrease != null) return `+${Number(data.strengthIncrease).toLocaleString()} STR`;
  if (data.scaleIncreasePercentage != null) return `+${Number(data.scaleIncreasePercentage).toLocaleString()}% size`;
  if (data.mutation || data.targetMutation) return payloadItemName(data.mutation || data.targetMutation);
  const fallback = Object.entries(data).find(([key, value]) => !['pet', 'sourcePet'].includes(key) && ['string', 'number', 'boolean'].includes(typeof value));
  return fallback ? `${humanize(fallback[0])}: ${String(fallback[1])}` : 'Proc recorded';
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

export function renderAbilityLogRows(selectedFilters: Set<string>): string {
  const isVisibleAbility = (ability: string) => ABILITY_SET.has(ability) && ABILITY_FILTER_OPTIONS.some(option => selectedFilters.has(option.key) && option.abilities.includes(ability));
  const search = abilityLogSearch.trim().toLowerCase();
  const matched = state.abilityLog.filter(log => {
    if (!isVisibleAbility(log.ability)) return false;
    if (!search) return true;
    // Searching covers what the row actually shows: the pet, the ability name and the outcome.
    const name = ABILITY_DETAILS[log.ability]?.name || humanize(log.ability);
    return `${log.pet} ${name} ${procOutcome(log.ability, log.data)}`.toLowerCase().includes(search);
  });
  const recent = matched.slice(0, LOG_VISIBLE_ROWS);
  if (!recent.length) return search ? '<p>Nothing matches that search.</p>' : '<p>No ability procs recorded yet.</p>';
  const more = matched.length > recent.length ? `<p>Showing the newest ${recent.length} of ${matched.length} matches.</p>` : '';
  return recent.map(log => `<div><time>${new Date(log.at).toLocaleTimeString()}</time><b>${escapeHtml(log.pet)}</b><span class="gc-proc-result">${escapeHtml(ABILITY_DETAILS[log.ability]?.name || humanize(log.ability))}<i>&rarr; ${escapeHtml(procOutcome(log.ability, log.data))}</i></span></div>`).join('') + more;
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
  return `<section class="gc-card gc-ability-filter"><span>Ability filter</span><details data-ability-filter ${abilityFilterMenuOpen ? 'open' : ''}><summary>${escapeHtml(filterSummary)}</summary><div class="gc-ability-picker"><header><button data-ability-all>All</button><button data-ability-none>None</button></header>${filterOptions}</div></details><small>Choose any combination. Proc history stores up to ${LOG_PER_ABILITY} entries per exact ability.</small></section><section class="gc-card gc-ability-log-card"><div class="gc-row"><h3>Recent tracked procs</h3><input class="gc-search gc-log-search" type="text" data-log-search placeholder="Search pet, ability or result" spellcheck="false" value="${escapeHtml(abilityLogSearch)}"><button data-clear-log>Clear</button></div><div class="gc-log">${renderAbilityLogRows(selectedFilters)}</div></section>`;
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
