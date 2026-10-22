import type { HarvestCombo, HarvestRule, PlantSlot } from '../types.js';
import { config, feature, saveConfig } from '../config.js';
import { MUTATION_CATALOG, MUTATION_GROUP_LABELS, MUTATION_GROUPS, mutationsInGroup, PLANT_CATALOG, plantName } from '../constants.js';
import { BASE_SIZE, clampSize, MAX_SIZE, slotIsMaxSize, slotSizePercent } from '../crop-size.js';
import { bindListSearch } from '../list-search.js';
import { openCropLocks } from './crop-locks.js';
import { mutationFace, mutationSprite, produceSprite } from '../pets.js';
import { panelActions } from '../panel-actions.js';
import { notifyStateChange, state } from '../state.js';
import { toast } from '../toast.js';
import { escapeHtml, humanize } from '../utils.js';

/**
 * Stops a harvest you did not mean. Outgoing frames are inspected on the socket and a HarvestCrop
 * aimed at a protected crop is dropped before it leaves, which is the only place that catches every
 * route into a harvest - the game's own button, its hotkey, and a stray click alike.
 *
 * Gold and Rainbow are offered alongside the rest. The game guards those behind a press and hold of
 * its own, but a hold is still something a slip can complete, and these are the two crops least
 * worth losing that way, so anyone who wants them locked outright can have it.
 */

function protectableMutations(): string[] {
  return Object.keys(MUTATION_CATALOG);
}

function protectedMutations(): Set<string> {
  const saved = Array.isArray(config.protectedMutations) ? config.protectedMutations : [];
  return new Set(saved.filter(id => MUTATION_CATALOG[id]));
}

function protectedSpecies(): Record<string, boolean> {
  return config.protectedSpecies && typeof config.protectedSpecies === 'object' ? config.protectedSpecies : {};
}

/**
 * A saved combo, tidied: size clamped and anything that is not a mutation id dropped. Ids the catalog
 * does not know are kept on purpose - a mutation newer than this build still has to be on the crop,
 * and dropping it would loosen the combo into releasing crops without it.
 */
function tidyCombo(saved: unknown): HarvestCombo {
  const combo = saved && typeof saved === 'object' ? saved as Partial<HarvestCombo> : {};
  const mutations = (Array.isArray(combo.mutations) ? combo.mutations : []).filter(id => typeof id === 'string' && id !== '');
  return { minSize: clampSize(Number(combo.minSize)), mutations };
}

/**
 * Rules are read on every harvest and every crop card, so each saved set is tidied once. Saving
 * replaces the whole object, which is what lets a new one through.
 */
let tidiedFrom: unknown = null;
let tidiedRules: Record<string, HarvestRule> = {};

function harvestRules(): Record<string, HarvestRule> {
  const saved = config.harvestRules && typeof config.harvestRules === 'object' ? config.harvestRules : {};
  if (saved === tidiedFrom) return tidiedRules;
  tidiedFrom = saved;
  tidiedRules = {};
  for (const [species, rule] of Object.entries(saved)) {
    if (rule && Array.isArray(rule.combos)) tidiedRules[species] = { combos: rule.combos.map(tidyCombo) };
  }
  return tidiedRules;
}

/** A copy of a species' rule, safe to change before saving. */
export function harvestRule(species: string): HarvestRule {
  const rule = harvestRules()[species];
  return { combos: (rule?.combos ?? []).map(combo => ({ minSize: combo.minSize, mutations: [...combo.mutations] })) };
}

/**
 * Whether a combo asks for anything. One with no mutations at the smallest size would let every crop
 * through, which is never what a freshly added, not yet filled in combo means.
 */
function comboIsSet(combo: HarvestCombo): boolean {
  return combo.mutations.length > 0 || combo.minSize > BASE_SIZE;
}

/** A crop with no size on record reads as the smallest, as the game itself treats it. */
function meetsCombo(slot: PlantSlot, combo: HarvestCombo): boolean {
  if (!comboIsSet(combo) || slotSizePercent(slot) < combo.minSize) return false;
  const mutations = new Set(slot.mutations ?? []);
  return combo.mutations.every(id => mutations.has(id));
}

/**
 * The lock from the Mutations and size card that applies to this crop, if any. A combo the crop
 * meets lifts the max size lock, since growing past the combo's size is what ready means, but only
 * the mutation locks it names. A size only combo therefore does not wave a Rainbow crop past a
 * Rainbow lock.
 */
function cardLock(slot: PlantSlot, mutations: Set<string>, combo: HarvestCombo | null): string | null {
  const matched = (slot.mutations ?? []).find(mutation => mutations.has(mutation) && !combo?.mutations.includes(mutation));
  if (matched) return MUTATION_CATALOG[matched]?.name || humanize(matched);
  if (config.protectMaxSize === true && slotIsMaxSize(slot) && !combo) return 'max size';
  return null;
}

/**
 * Why this crop is protected, or null to let it through. A protected species that meets one of its
 * own combos is let through, as long as no card lock the combo did not name still applies. Past
 * that, the card locks are checked before the species list so that turning a species off cannot
 * expose a crop they cover.
 */
export function protectionReason(slot: PlantSlot | undefined, species: string): string | null {
  if (!slot || !feature('cropProtection')) return null;
  const isProtected = protectedSpecies()[species] === true;
  const combos = isProtected ? (harvestRules()[species]?.combos ?? []).filter(comboIsSet) : [];
  const locked = protectedMutations();
  if (combos.some(combo => meetsCombo(slot, combo) && !cardLock(slot, locked, combo))) return null;
  const lock = cardLock(slot, locked, null);
  if (lock) return lock;
  if (!isProtected) return null;
  return combos.length ? `${plantName(species)} - not ready yet` : plantName(species);
}

interface HarvestTarget { tile: string; slotId: string; requestId: string | null }

/** Both shapes a harvest reaches the wire in: the game's RPC envelope, and our own flat command. */
function harvestTarget(message: Record<string, any> | null): HarvestTarget | null {
  if (!message || typeof message !== 'object') return null;
  const command = message.type === 'QuinoaCommand' ? message.command : message;
  if (!command || command.type !== 'HarvestCrop') return null;
  if (command.slot == null || command.slotsIndex == null) return null;
  const requestId = typeof message.requestId === 'string' ? message.requestId : null;
  return { tile: String(command.slot), slotId: String(command.slotsIndex), requestId };
}

/**
 * Answers a command we refused to send. The game keeps each request against its id and waits five
 * seconds before giving up, and giving up rejects rather than resolves, which skips the branch that
 * undoes the harvest it had already started drawing. A result now settles it cleanly instead.
 *
 * The code matters: the game treats handler_error as its own failure and stays quiet, so anything
 * else is what makes it run its tidy-up.
 */
export function refuseCommand(socket: WebSocket, requestId: string): void {
  const result = { type: 'QuinoaCommandResult', requestId, ok: false, code: 'garden_companion_blocked' };
  try { socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(result) })); }
  catch { /* the game falls back on its own timeout */ }
}

let lastBlockAt = 0;

/** One message a second: a held harvest key would otherwise bury the screen in toasts. */
function announce(target: HarvestTarget, message: string): HarvestTarget {
  if (Date.now() - lastBlockAt > 1_000) {
    lastBlockAt = Date.now();
    toast(message, 'error');
  }
  return target;
}

/** Whether this outgoing frame, already parsed by the socket hook, should be dropped. */
export function blockOutgoingHarvest(frame: Record<string, any>): HarvestTarget | null {
  if (!feature('cropProtection')) return null;
  const target = harvestTarget(frame);
  if (!target) return null;
  // Nothing to check against yet. A harvest cannot be taken back, so the moments after connecting
  // or changing room - where our garden has not arrived - hold rather than wave crops through.
  const garden = state.slot?.data?.garden?.tileObjects;
  if (!garden) return announce(target, 'Harvest held - your garden has not loaded yet.');
  const tile = garden[target.tile];
  // A tile or slot the garden does not have is a crop that is already gone, not an unknown one.
  // Slots are matched on their id, or on their place on the tile when they carry none - the same
  // number the game (and our instant harvest) sends in that case.
  const slots = tile?.slots ?? [];
  const crop = slots.find(candidate => candidate.slotId != null && String(candidate.slotId) === target.slotId)
    ?? slots.find((candidate, index) => candidate.slotId == null && String(index) === target.slotId);
  const reason = protectionReason(crop, crop?.species || tile?.species || '');
  if (!reason) return null;
  return announce(target, `Harvest blocked - protected ${reason}.`);
}

function ownedSpecies(): Set<string> {
  const owned = new Set<string>();
  for (const tile of Object.values(state.slot?.data?.garden?.tileObjects ?? {})) {
    if (tile.species) owned.add(tile.species);
    for (const slot of tile.slots ?? []) if (slot.species) owned.add(slot.species);
  }
  return owned;
}

/** Only this species' rule is replaced: the others are written back exactly as they were saved. */
function saveHarvestRule(species: string, rule: HarvestRule): void {
  const next = { ...(config.harvestRules && typeof config.harvestRules === 'object' ? config.harvestRules : {}) };
  if (rule.combos.length) next[species] = rule;
  else delete next[species];
  config.harvestRules = next;
  saveConfig();
}

/**
 * Combos being edited, as "species:index". A filled in combo folds down to its chips; a new, empty
 * one starts open. Held for this session only - folding is not worth a saved setting.
 */
const openCombos = new Set<string>();

/** One combo: its size, then a row of pills per mutation group, at most one picked from each. */
function renderCombo(species: string, combo: HarvestCombo, index: number): string {
  const groups = MUTATION_GROUPS.map(group => {
    const pills = mutationsInGroup(group).map(id => {
      const name = MUTATION_CATALOG[id]?.name || humanize(id);
      return `<button class="gc-value-pill${combo.mutations.includes(id) ? ' on' : ''}" title="${escapeHtml(name)}" data-ready-mutation="${escapeHtml(id)}" data-ready-group="${escapeHtml(group)}">${mutationFace(id)}</button>`;
    }).join('');
    return pills ? `<div class="gc-value-group"><b>${escapeHtml(MUTATION_GROUP_LABELS[group] || group)}</b><div>${pills}</div></div>` : '';
  }).join('');
  // Ids this build does not know (a mutation added or renamed since) get a row of their own, so they
  // can still be unpicked without rebuilding the combo.
  const unknown = combo.mutations.filter(id => !MUTATION_CATALOG[id]).map(id =>
    `<button class="gc-value-pill on" title="${escapeHtml(humanize(id))}" data-ready-mutation="${escapeHtml(id)}" data-ready-group="">${mutationFace(id)}</button>`).join('');
  const other = unknown ? `<div class="gc-value-group"><b>Other</b><div>${unknown}</div></div>` : '';
  const open = comboIsOpen(species, combo, index);
  const size = `<label class="gc-ready-size-input"><span>Min size</span><input type="number" min="${BASE_SIZE}" max="${MAX_SIZE}" step="1" value="${combo.minSize}" data-ready-size>%</label>`;
  return `<div class="gc-ready-combo" data-ready-combo="${index}"><div class="gc-ready-picked">${comboHeader(species, combo, index)}</div>${open ? size + groups + other : ''}</div>`;
}

function comboIsOpen(species: string, combo: HarvestCombo, index: number): boolean {
  return !comboIsSet(combo) || openCombos.has(`${species}:${index}`);
}

/**
 * The chips naming what the combo asks for, so it reads without scanning the pills, and its Edit or
 * Done and Remove buttons.
 */
function comboHeader(species: string, combo: HarvestCombo, index: number): string {
  const chips = combo.mutations.map(id => `<span class="gc-ready-chip">${mutationFace(id, true)}</span>`);
  if (combo.minSize > BASE_SIZE) chips.unshift(`<span class="gc-ready-chip gc-ready-size">${combo.minSize >= MAX_SIZE ? 'Max size' : `Size ${combo.minSize}+`}</span>`);
  const summary = chips.join('<i>+</i>') || '<span class="gc-ready-chip gc-ready-any">Pick a size or mutations</span>';
  const toggle = comboIsSet(combo) ? `<button data-ready-toggle-combo>${comboIsOpen(species, combo, index) ? 'Done' : 'Edit'}</button>` : '';
  return `<div>${summary}</div><span>${toggle}<button data-ready-remove-combo>Remove</button></span>`;
}

function ruleSummary(rule: HarvestRule): string {
  return rule.combos.some(comboIsSet) ? 'Harvest allowed once ready' : 'Always locked';
}

/**
 * Lets a protected species through once it is ready, so it can stay switched on rather than being
 * turned off to harvest and forgotten.
 */
function renderReadyRules(): string {
  const protectedList = protectedSpecies();
  const species = Object.keys(protectedList).filter(id => protectedList[id] === true)
    .sort((left, right) => plantName(left).localeCompare(plantName(right)));
  if (!species.length) return '<p class="gc-note">Tick a species below to set when it is ready to harvest.</p>';
  return species.map(id => {
    const rule = harvestRule(id);
    const sprite = produceSprite(id);
    const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
    const combos = rule.combos.map((combo, index) => renderCombo(id, combo, index)).join('');
    return `<div class="gc-ready-rule" data-ready-species="${escapeHtml(id)}">
<div class="gc-ready-head"><span class="gc-shop-sprite">${icon}</span><span><b>${escapeHtml(plantName(id))}</b><small data-ready-summary>${ruleSummary(rule)}</small></span></div>
${combos}<button data-ready-add-combo>Add combo</button></div>`;
  }).join('');
}

function bindReadyRules(holder: HTMLElement): void {
  const redraw = () => { holder.innerHTML = renderReadyRules(); bindReadyRules(holder); };
  /** The species, its rule to change, and the combo the element sits in (-1 outside one). */
  const target = (element: HTMLElement) => {
    const species = element.closest<HTMLElement>('.gc-ready-rule')?.dataset.readySpecies || '';
    const index = Number(element.closest<HTMLElement>('[data-ready-combo]')?.dataset.readyCombo ?? -1);
    return { species, index, rule: harvestRule(species) };
  };
  holder.querySelectorAll<HTMLInputElement>('[data-ready-size]').forEach(input => input.onchange = () => {
    const { species, index, rule } = target(input);
    const combo = rule.combos[index];
    // A box left empty or holding nonsense keeps the size it had, rather than dropping to the
    // smallest size and loosening the rule.
    const typed = Number(input.value);
    if (!combo || input.value.trim() === '' || !Number.isFinite(typed)) {
      if (combo) input.value = String(combo.minSize);
      return;
    }
    combo.minSize = clampSize(typed);
    input.value = String(combo.minSize);
    // Kept open while it is being edited, even now it counts as set.
    openCombos.add(`${species}:${index}`);
    saveHarvestRule(species, rule);
    // Only the header and summary change. Redrawing the whole block would drop the focus a Tab out
    // of this box has just moved on.
    const header = input.closest('[data-ready-combo]')?.querySelector<HTMLElement>('.gc-ready-picked');
    if (header) header.innerHTML = comboHeader(species, combo, index);
    const summary = input.closest('.gc-ready-rule')?.querySelector<HTMLElement>('[data-ready-summary]');
    if (summary) summary.textContent = ruleSummary(rule);
    bindReadyRules(holder);
  });
  holder.querySelectorAll<HTMLButtonElement>('[data-ready-add-combo]').forEach(button => button.onclick = () => {
    const { species, rule } = target(button);
    openCombos.add(`${species}:${rule.combos.length}`);
    rule.combos.push({ minSize: BASE_SIZE, mutations: [] });
    saveHarvestRule(species, rule);
    redraw();
  });
  holder.querySelectorAll<HTMLButtonElement>('[data-ready-remove-combo]').forEach(button => button.onclick = () => {
    const { species, index, rule } = target(button);
    if (index < 0) return;
    rule.combos.splice(index, 1);
    // The combos after it shift down a place, so whatever was open no longer lines up.
    for (const key of [...openCombos]) if (key.startsWith(`${species}:`)) openCombos.delete(key);
    saveHarvestRule(species, rule);
    redraw();
  });
  holder.querySelectorAll<HTMLButtonElement>('[data-ready-toggle-combo]').forEach(button => button.onclick = () => {
    const { species, index } = target(button);
    const key = `${species}:${index}`;
    if (openCombos.has(key)) openCombos.delete(key);
    else openCombos.add(key);
    redraw();
  });
  holder.querySelectorAll<HTMLButtonElement>('[data-ready-mutation]').forEach(button => button.onclick = () => {
    const { species, index, rule } = target(button);
    const combo = rule.combos[index];
    if (!combo) return;
    const id = button.dataset.readyMutation!;
    const group = button.dataset.readyGroup!;
    const had = combo.mutations.includes(id);
    // Picking a second mutation from a group replaces the first: a crop never carries both. One with
    // no group (unknown to this build) only ever unpicks itself.
    combo.mutations = combo.mutations.filter(other => other !== id && (!group || MUTATION_CATALOG[other]?.group !== group));
    if (!had) combo.mutations.push(id);
    saveHarvestRule(species, rule);
    redraw();
  });
}

export function renderCropProtection(): string {
  const on = feature('cropProtection');
  const mutations = protectedMutations();
  const species = protectedSpecies();
  // Max size sits with the mutations rather than above them: it is the same kind of rule, and the
  // eleven protectable mutations plus this one fill the two column grid exactly.
  const mutationRows = protectableMutations().map(id => {
    const sprite = mutationSprite(id);
    const name = MUTATION_CATALOG[id]?.name || humanize(id);
    const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
    return `<label class="gc-check"><input type="checkbox" data-protect-mutation="${escapeHtml(id)}" ${mutations.has(id) ? 'checked' : ''}><span class="gc-shop-sprite">${icon}</span><span><b>${escapeHtml(name)}</b></span></label>`;
  }).concat(
    // Max size has no sprite of its own, so it borrows the MAX chip the Journal already uses for
    // the same idea rather than leaving an empty tile beside the mutation icons.
    `<label class="gc-check"><input type="checkbox" data-protect-max-size ${config.protectMaxSize === true ? 'checked' : ''}><span class="gc-shop-sprite gc-sprite-text">MAX</span><span><b>Max size</b></span></label>`,
  ).join('');
  const owned = ownedSpecies();
  const speciesRows = Object.keys(PLANT_CATALOG)
    .filter(id => Number(PLANT_CATALOG[id]?.crop?.baseSellPrice) > 0)
    .sort((left, right) => Number(owned.has(right)) - Number(owned.has(left)) || plantName(left).localeCompare(plantName(right)))
    .map(id => {
      const sprite = produceSprite(id);
      const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
      const where = owned.has(id) ? 'In your garden' : '';
      return `<label class="gc-check" data-filter-text="${escapeHtml(`${plantName(id)} ${id}`.toLowerCase())}"><input type="checkbox" data-protect-species="${escapeHtml(id)}" ${species[id] === true ? 'checked' : ''}><span class="gc-shop-sprite">${icon}</span><span><b>${escapeHtml(plantName(id))}</b><small>${where}</small></span></label>`;
    }).join('');
  return `<p class="gc-note">Blocks a harvest before it is sent when the crop is protected. Ticking Gold or Rainbow locks them rather than leaving them on the game's own press and hold, unless a combo below names them. Crop Protection and the instant harvest key cannot both be on.</p>
<section class="gc-card gc-launch-row"><div><h3>Crop Locker</h3><p>Lock or unlock any crop in your garden with the games own system.</p></div><button class="gc-primary" data-open-crop-locks>Crop Locker</button></section>
<div class="gc-list"><label class="gc-toggle"><span><b>Crop Protection</b><small>Blocks harvest commands - doesn't use the games own system</small></span><input type="checkbox" data-protect-enabled ${on ? 'checked' : ''}><i></i></label></div>
<section class="gc-card"><div class="gc-row"><h3>Mutations and size</h3></div><p class="gc-note">A crop matching any of these stays protected even when its species is switched off below.</p><div class="gc-check-grid">${mutationRows}</div></section>
<section class="gc-card"><div class="gc-row"><h3>Ready to harvest</h3></div><p class="gc-note">Protected species stay locked until a crop matches one of their combos. A match also skips Max size and the locks above for the mutations in that combo.</p><div data-ready-rules>${renderReadyRules()}</div></section>
<section class="gc-card"><div class="gc-row"><h3>Species</h3></div><input class="gc-search" data-protect-search placeholder="Search plants"><div class="gc-check-grid gc-filter-list">${speciesRows}</div></section>`;
}

export function bindCropProtectionEvents(main: HTMLElement): void {
  main.querySelectorAll<HTMLInputElement>('[data-protect-mutation]').forEach(input => input.onchange = () => {
    const next = new Set(protectedMutations());
    if (input.checked) next.add(input.dataset.protectMutation!);
    else next.delete(input.dataset.protectMutation!);
    config.protectedMutations = [...next];
    saveConfig();
  });
  main.querySelectorAll<HTMLInputElement>('[data-protect-species]').forEach(input => input.onchange = () => {
    // Only the protected species are kept. Storing the unticked ones too would grow the saved
    // config by a row for every species anyone ever looked at.
    const next = { ...protectedSpecies() };
    if (input.checked) next[input.dataset.protectSpecies!] = true;
    else delete next[input.dataset.protectSpecies!];
    config.protectedSpecies = next;
    saveConfig();
    // Redrawn in place rather than the whole panel, which would lose the search typed below.
    const rules = main.querySelector<HTMLElement>('[data-ready-rules]');
    if (rules) { rules.innerHTML = renderReadyRules(); bindReadyRules(rules); }
  });
  const rules = main.querySelector<HTMLElement>('[data-ready-rules]');
  if (rules) bindReadyRules(rules);
  const maxSize = main.querySelector<HTMLInputElement>('[data-protect-max-size]');
  if (maxSize) maxSize.onchange = () => { config.protectMaxSize = maxSize.checked; saveConfig(); };
  const enabled = main.querySelector<HTMLInputElement>('[data-protect-enabled]');
  if (enabled) enabled.onchange = () => {
    config.cropProtection = enabled.checked;
    // The two features want opposite things from the same crops, so only one may be on.
    if (enabled.checked) config.instantHarvest = false;
    saveConfig();
    // The padlock row on the game's crop card follows this switch.
    notifyStateChange('config');
    panelActions.renderPanelPreservingScroll();
  };
  main.querySelector('[data-open-crop-locks]')?.addEventListener('click', () => { panelActions.closePanel(); openCropLocks(); });
  bindListSearch(main.querySelector('[data-protect-search]'));
}
