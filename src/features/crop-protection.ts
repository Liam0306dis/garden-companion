import type { PlantSlot } from '../types.js';
import { config, feature, saveConfig } from '../config.js';
import { MUTATION_CATALOG, PLANT_CATALOG, plantName } from '../constants.js';
import { bindListSearch } from '../list-search.js';
import { mutationSprite, produceSprite } from '../pets.js';
import { panelActions } from '../panel-actions.js';
import { state } from '../state.js';
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

function atMaxSize(slot: PlantSlot, species: string): boolean {
  const maxScale = Number(PLANT_CATALOG[species]?.crop?.maxScale) || 0;
  return maxScale > 0 && Number(slot.targetScale ?? 0) >= maxScale - 1e-6;
}

/**
 * Why this crop is protected, or null to let it through. Mutations and size are checked before the
 * species list so that turning a species off cannot expose a crop the mutation rules still cover.
 */
export function protectionReason(slot: PlantSlot | undefined, species: string): string | null {
  if (!slot || !feature('cropProtection')) return null;
  const mutations = protectedMutations();
  const matched = (slot.mutations ?? []).find(mutation => mutations.has(mutation));
  if (matched) return MUTATION_CATALOG[matched]?.name || humanize(matched);
  if (config.protectMaxSize === true && atMaxSize(slot, species)) return 'max size';
  if (protectedSpecies()[species] === true) return plantName(species);
  return null;
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

/**
 * Whether this outgoing frame should be dropped. Nothing is parsed unless the frame mentions a
 * harvest, so an ordinary session pays one substring scan per message.
 */
export function blockOutgoingHarvest(data: unknown): HarvestTarget | null {
  if (!feature('cropProtection') || typeof data !== 'string' || !data.includes('HarvestCrop')) return null;
  let target: HarvestTarget | null = null;
  try { target = harvestTarget(JSON.parse(data) as Record<string, any>); }
  catch { return null; }
  if (!target) return null;
  // Nothing to check against yet. A harvest cannot be taken back, so the moments after connecting
  // or changing room - where our garden has not arrived - hold rather than wave crops through.
  const garden = state.slot?.data?.garden?.tileObjects;
  if (!garden) return announce(target, 'Harvest held - your garden has not loaded yet.');
  const tile = garden[target.tile];
  // A tile or slot the garden does not have is a crop that is already gone, not an unknown one.
  const crop = (tile?.slots ?? []).find(candidate => String(candidate.slotId) === target.slotId);
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
  return `<p class="gc-note">Blocks a harvest before it is sent when the crop is protected. Ticking Gold or Rainbow locks them outright, rather than leaving them on the game's own press and hold. Crop Protection and the instant harvest key cannot both be on.</p>
<div class="gc-list"><label class="gc-toggle"><span><b>Crop Protection</b><small>Block harvest commands aimed at a protected crop</small></span><input type="checkbox" data-protect-enabled ${on ? 'checked' : ''}><i></i></label></div>
<section class="gc-card"><div class="gc-row"><h3>Mutations and size</h3></div><p class="gc-note">A crop matching any of these stays protected even when its species is switched off below.</p><div class="gc-check-grid">${mutationRows}</div></section>
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
  });
  const maxSize = main.querySelector<HTMLInputElement>('[data-protect-max-size]');
  if (maxSize) maxSize.onchange = () => { config.protectMaxSize = maxSize.checked; saveConfig(); };
  const enabled = main.querySelector<HTMLInputElement>('[data-protect-enabled]');
  if (enabled) enabled.onchange = () => {
    config.cropProtection = enabled.checked;
    // The two features want opposite things from the same crops, so only one may be on.
    if (enabled.checked) config.instantHarvest = false;
    saveConfig();
    panelActions.renderPanelPreservingScroll();
  };
  bindListSearch(main.querySelector('[data-protect-search]'));
}
