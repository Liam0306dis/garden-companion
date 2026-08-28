import type { Pet, ProduceItem } from './types.js';
import { ABILITY_DETAILS, HUNGER_MINUTES, PASSIVE_REQUIRED_WEATHER, PET_CATALOG, STACKED_PASSIVE_BY_ABILITY } from './constants.js';
import { mutationMultiplier } from './mutation-value.js';
import { sendBareCommand, sendQuinoaCommand } from './game-connection.js';
import { page } from './page.js';
import { state } from './state.js';
import { escapeHtml, humanize, NUMBER_LOCALE } from './utils.js';

/** Everything derived from the player's pets: where they are, how they look, and how strong they are. */

export function allPets() {
  const data = state.slot?.data || {};
  const active = (data.petSlots || []).map(pet => ({ ...pet, location: 'Active' }));
  const inventory = (data.inventory?.items || []).filter(item => item.itemType === 'Pet').map(pet => ({ ...pet, location: 'Inventory' }));
  const stored = (data.inventory?.storages || []).flatMap(storage => (storage.items || []).filter(item => item.itemType === 'Pet').map(pet => ({ ...pet, location: humanize(storage.decorId || 'Storage') })));
  const seen = new Set();
  return [...active, ...inventory, ...stored].filter(pet => pet.id && !seen.has(pet.id) && seen.add(pet.id));
}

export function activePets(): Pet[] {
  return state.slot?.data?.petSlots || [];
}

export function heldProduce(): ProduceItem[] {
  const items = (state.slot?.data?.inventory?.items || []) as unknown as ProduceItem[];
  return items.filter(item => item?.itemType === 'Produce' && item.species && item.id);
}

export function produceValue(item: ProduceItem): number {
  const base = Number(page.__gardenCompanionPlantPrice?.(item.species) || 0) || 1;
  return base * Number(item.scale || 1) * mutationMultiplier([...(item.mutations || [])]);
}

export function petDiet(species: string): string[] {
  return PET_CATALOG[species]?.diet || [];
}

export function produceSprite(species: string): string {
  return page.__gardenCompanionProduceSprites?.[species] || page.__gardenCompanionShopSprites?.[species] || '';
}

/** The game's own mutation icon, keyed by mutation id. Empty until the sprite atlases finish. */
export function mutationSprite(mutation: string): string {
  return page.__gardenCompanionMutationSprites?.[mutation] || '';
}

const spriteReadyListeners = new Set<() => void>();

/**
 * Atlases decode well after the page loads, so anything drawn before then falls back to plain text
 * and has to be redrawn once the art lands. The loader only calls one page-level hook, so features
 * subscribe here rather than each claiming that hook and silently replacing the last one.
 */
export function onSpritesReady(listener: () => void): void {
  spriteReadyListeners.add(listener);
  if (spriteReadyListeners.size > 1) return;
  const previous = page.__gardenCompanionPetSpritesReady;
  page.__gardenCompanionPetSpritesReady = () => {
    previous?.();
    for (const notify of spriteReadyListeners) {
      try { notify(); } catch {}
    }
  };
}

const mutatedPetSprites = new Map<string, string>();
const pendingPetSprites = new Set<string>();

/**
 * The game ships one sprite per species, so Gold and Rainbow pets are tinted here on a canvas and
 * cached. Rendering is async, so any sprite already on the page is swapped in when it finishes.
 */
function renderMutatedPetSprite(key: string, source: string, mutation: string): void {
  if (mutatedPetSprites.has(key) || pendingPetSprites.has(key)) return;
  pendingPetSprites.add(key);
  const image = new Image();
  image.onload = () => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      if (!context) return;
      context.drawImage(image, 0, 0);
      if (mutation === 'gold') {
        context.globalCompositeOperation = 'source-atop';
        context.globalAlpha = .7;
        context.fillStyle = 'rgb(235,200,0)';
        context.fillRect(0, 0, canvas.width, canvas.height);
      } else {
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let minimum = canvas.width + canvas.height;
        let maximum = 0;
        for (let y = 0; y < canvas.height; y += 2) for (let x = 0; x < canvas.width; x += 2) {
          if (pixels[(y * canvas.width + x) * 4 + 3] < 8) continue;
          minimum = Math.min(minimum, x + y);
          maximum = Math.max(maximum, x + y);
        }
        if (maximum <= minimum) { minimum = 0; maximum = canvas.width + canvas.height; }
        const gradient = context.createLinearGradient(minimum / 2, minimum / 2, maximum / 2, maximum / 2);
        ['#ff1744', '#ff9100', '#ffea00', '#00e676', '#2979ff', '#d500f9'].forEach((color, index, colors) => gradient.addColorStop(index / (colors.length - 1), color));
        context.globalCompositeOperation = 'color';
        context.globalAlpha = 1;
        context.fillStyle = gradient;
        context.fillRect(0, 0, canvas.width, canvas.height);
      }
      context.globalAlpha = 1;
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(image, 0, 0);
      const result = canvas.toDataURL('image/png');
      mutatedPetSprites.set(key, result);
      document.querySelectorAll<HTMLImageElement>('img[data-pet-mutation-key]').forEach(element => {
        if (element.dataset.petMutationKey === key) element.src = result;
      });
    } finally {
      pendingPetSprites.delete(key);
    }
  };
  image.onerror = () => pendingPetSprites.delete(key);
  image.src = source;
}

/** A pet carries at most one colour mutation, and Rainbow wins when both are somehow present. */
export function petOverlay(pet: Pet): string {
  const mutations = pet.mutations || [];
  return mutations.includes('Rainbow') ? 'rainbow' : mutations.includes('Gold') ? 'gold' : '';
}

/**
 * The sprite URL for a pet, tinted for its colour mutation once that render finishes. Callers that
 * draw rather than emit markup use this, since the tint is cached asynchronously and the plain
 * sprite is the right thing to show until it lands.
 */
export function petSpriteSource(pet: Pet): string | undefined {
  const source = page.__gardenCompanionPetSprites?.[pet.petSpecies];
  const overlay = petOverlay(pet);
  if (!source || !overlay) return source;
  const key = `${pet.petSpecies}:${overlay}`;
  renderMutatedPetSprite(key, source, overlay);
  return mutatedPetSprites.get(key) || source;
}

export function petSprite(pet: Pet): string {
  const source = page.__gardenCompanionPetSprites?.[pet.petSpecies];
  const overlay = petOverlay(pet);
  const mutationKey = source && overlay ? `${pet.petSpecies}:${overlay}` : '';
  if (source && overlay) renderMutatedPetSprite(mutationKey, source, overlay);
  const displayedSource = mutationKey ? mutatedPetSprites.get(mutationKey) || source : source;
  return `<span class="gc-pet-sprite">${displayedSource ? `<img src="${escapeHtml(displayedSource)}" alt="${escapeHtml(pet.petSpecies)}"${mutationKey ? ` data-pet-mutation-key="${escapeHtml(mutationKey)}"` : ''}>` : `<i>${escapeHtml((PET_CATALOG[pet.petSpecies]?.name || pet.petSpecies || '?').slice(0, 1))}</i>`}</span>`;
}

/**
 * Some abilities only work in a specific weather (the Snowy/Dawn/Amber/Thunder variants). This is
 * true for a plain ability with no weather requirement, and only in the matching weather otherwise.
 */
export function abilityActiveInWeather(ability: string): boolean {
  const weather = PASSIVE_REQUIRED_WEATHER.get(ability);
  return !weather || state.game?.weather === weather;
}

/** Combined Hunger Boost across the active team, as the percentage the bar's lifetime is extended by. */
function teamHungerBoostPercent(team: Pet[]): number {
  let total = 0;
  for (const pet of team) {
    if (Number(pet.hunger) <= 0) continue;
    const strength = petMetrics(pet)?.strength ?? 100;
    for (const ability of pet.abilities ?? []) {
      if (STACKED_PASSIVE_BY_ABILITY.get(ability)?.key !== 'HungerBoost' || !abilityActiveInWeather(ability)) continue;
      total += Number(ABILITY_DETAILS[ability]?.baseParameters?.hungerRefundPercentage || 0) * strength / 100;
    }
  }
  return total;
}

/**
 * How often the team's Hunger Restore procs fire, and how big one is as a fraction of the bar it
 * lands in. Each ability rolls on its own, so two pets carrying Restore II do not make a proc worth
 * more - there are simply twice as many of them, which is why the rates are added rather than
 * combined. Expectation is linear, so the sum holds even on a tick where both fire. The per-second
 * chance uses the same model as the ability panel.
 *
 * Rate and size are kept apart because a proc cannot overfill a bar, so how much of it actually
 * lands depends on the target - which the caller knows and this does not.
 */
function teamHungerRestore(team: Pet[]): { procsPerSecond: number; capFraction: number } {
  let procsPerSecond = 0;
  let weightedCap = 0;
  for (const pet of team) {
    if (Number(pet.hunger) <= 0) continue;
    const strength = petMetrics(pet)?.strength ?? 100;
    for (const ability of pet.abilities ?? []) {
      const restore = ABILITY_DETAILS[ability]?.baseParameters?.hungerRestorePercentage;
      const chance = ABILITY_DETAILS[ability]?.baseProbability;
      if (restore == null || !chance || !abilityActiveInWeather(ability)) continue;
      const perSecondChance = 1 - Math.pow(1 - chance * strength / 10000, 1 / 60);
      procsPerSecond += perSecondChance;
      // Weighted by rate, so a team mixing Restore II and III gets the size its procs average out to.
      weightedCap += perSecondChance * (restore * strength / 100) / 100;
    }
  }
  return { procsPerSecond, capFraction: procsPerSecond > 0 ? weightedCap / procsPerSecond : 0 };
}

/**
 * What one proc is worth to a bar that is `fill` full, averaged over its descent to empty.
 *
 * A proc gives its whole share unless the bar lacks the room, so the top `cap` of a bar is a zone
 * where procs are cut short - a turtle sitting near full throws most of every proc away, which is
 * why measured procs on one averaged a quarter of their cap while a fast-draining bee got 94% of
 * its own. Below that zone nothing is lost, so the descent is split at the boundary and the two
 * parts weighted by how much of the fall each accounts for.
 */
function restorePerProc(fill: number, cap: number): number {
  if (fill <= 0) return 0;
  const clipped = Math.max(0, fill - (1 - cap)) / fill;
  const averageRoomWhileClipped = ((1 - fill) + cap) / 2;
  return clipped * averageRoomWhileClipped + (1 - clipped) * cap;
}

/**
 * Hunger drains at a fixed rate per species (a full bar lasts HUNGER_MINUTES[species] minutes), but
 * the active team bends that rate: Hunger Boost passively slows depletion and Hunger Restore
 * periodically tops bars back up. Both are team-wide, so the whole active team is needed. Returns the
 * seconds this pet's bar will last, Infinity when the team out-restores the drain, or null when the
 * timing or the hunger value is unknown.
 */
export function hungerSecondsRemaining(pet: Pet, team: Pet[]): number | null {
  const maximum = Number(PET_CATALOG[pet.petSpecies]?.maxHunger || 0);
  const minutes = HUNGER_MINUTES[pet.petSpecies];
  const value = Number(pet.hunger);
  if (!maximum || !minutes || !Number.isFinite(value)) return null;
  if (value <= 0) return 0;
  // Work in fractions of a full bar per second, so the pet's own max cancels out of both terms.
  const fraction = Math.min(1, value / maximum);
  // The game calls this a hunger refund and describes it as reducing the depletion rate, so the
  // boost is taken off the rate rather than added to the lifetime: refunding 60% of what is eaten
  // leaves 40% being spent, which makes a 60-minute bar last 150 minutes rather than 96. The two
  // readings barely differ at 10% and are miles apart by 90%, which is as high as three pets can
  // stack it - a ceiling that only means anything if 100% would be a bar that never empties.
  const drainPerSecond = Math.max(0, 1 - teamHungerBoostPercent(team) / 100) / (minutes * 60);
  // A proc feeds one whole pet, never a share of one - but it picks uniformly among the active pets,
  // so across three of them this one is fed by roughly every third proc. Dividing the team's proc
  // rate by the active count is that long-run average, which is the only thing a single ETA can
  // show; the real bar jumps by a third of itself when a proc lands and drains untouched otherwise.
  const activeCount = Math.max(1, team.filter(member => member?.id).length);
  const restore = teamHungerRestore(team);
  const restorePerSecond = restore.procsPerSecond / activeCount * restorePerProc(fraction, restore.capFraction);
  const netPerSecond = drainPerSecond - restorePerSecond;
  if (netPerSecond <= 0) return Infinity;
  return fraction / netPerSecond;
}

interface HungerParts { title: string; percent: string; width: string; tone: string; eta: { label: string; tone: string } | null }

function hungerParts(pet: Pet, team?: Pet[]): HungerParts {
  const maximum = Number(PET_CATALOG[pet.petSpecies]?.maxHunger || 0);
  const value = Math.max(0, Number(pet.hunger || 0));
  const percent = maximum > 0 ? Math.min(100, value / maximum * 100) : value > 0 ? 100 : 0;
  const seconds = team ? hungerSecondsRemaining(pet, team) : null;
  return {
    // Hunger is fractional, and toLocaleString shows three decimals by default - 1458.723 then reads
    // as a number in the millions at a glance. The fraction is noise next to a 1500 point bar.
    title: `${Math.round(value).toLocaleString(NUMBER_LOCALE)} / ${maximum.toLocaleString(NUMBER_LOCALE)}`,
    percent: `${Math.round(percent)}%`,
    width: `${percent.toFixed(2)}%`,
    tone: percent < 20 ? 'low' : percent < 50 ? 'medium' : 'good',
    eta: seconds == null ? null : {
      label: seconds === Infinity ? 'Sustained' : seconds <= 0 ? 'Empty' : `Lasts ~${formatEstimate(seconds)}`,
      tone: seconds === Infinity ? 'good' : seconds <= 0 ? 'low' : seconds < 600 ? 'low' : seconds < 1800 ? 'medium' : 'good',
    },
  };
}

export function hungerDisplay(pet: Pet, team?: Pet[]): string {
  const parts = hungerParts(pet, team);
  const eta = parts.eta ? `<small class="gc-hunger-eta" data-tone="${parts.eta.tone}">${parts.eta.label}</small>` : '';
  return `<div class="gc-hunger" data-hunger-pet="${escapeHtml(pet.id)}" title="${escapeHtml(parts.title)}"><div><span>Hunger</span><b>${parts.percent}</b></div><i><u data-tone="${parts.tone}" style="width:${parts.width}"></u></i>${eta}</div>`;
}

/**
 * Rewrites one hunger block from live state without replacing it. The panel holds still while the
 * pointer is on it - redrawing under the cursor takes the hovered element and its tooltip with it -
 * so the values are refreshed in place as each block is entered, and the tooltip that follows the
 * hover is built from what the game reports right now rather than from the last full draw.
 */
export function refreshHungerDisplay(node: HTMLElement): void {
  const team = activePets();
  const pet = team.find(member => member?.id === node.dataset.hungerPet);
  if (!pet) return;
  const parts = hungerParts(pet, team);
  node.title = parts.title;
  const percent = node.querySelector('b');
  if (percent) percent.textContent = parts.percent;
  const fill = node.querySelector<HTMLElement>('u');
  if (fill) { fill.style.width = parts.width; fill.dataset.tone = parts.tone; }
  const eta = node.querySelector<HTMLElement>('.gc-hunger-eta');
  if (eta && parts.eta) { eta.textContent = parts.eta.label; eta.dataset.tone = parts.eta.tone; }
}

/**
 * A pet whose hunger has not arrived is not starving, it is unknown. Elsewhere an absent value can
 * safely read as zero and draw an empty bar; here it would raise an alarm over nothing.
 */
export function petIsStarving(pet: Pet): boolean {
  const hunger = Number(pet?.hunger);
  return Number.isFinite(hunger) && hunger <= 0;
}

/**
 * True only once every active pet has run out. A single hungry pet is normal and self-correcting;
 * the whole team at zero is the state where abilities have stopped and nothing will restart them.
 */
export function allActivePetsStarving(): boolean {
  const pets = activePets().filter(pet => pet?.id);
  return pets.length > 0 && pets.every(petIsStarving);
}

/**
 * The strength every pet is currently lent by a crystal on the farm.
 *
 * A Strength Crystal adds a flat ten while it runs, and the game applies it the same way we do -
 * `(strength + bonus) / 100` - so it is added to the figure rather than to a multiplier, and it is
 * not capped at a pet's own maximum. Crystals sit on the boardwalk as readily as the dirt, and stop
 * counting the moment their timer runs out, which is why both maps are read and the seconds checked.
 *
 * The same table lends a Hunger Crystal a 0.9 hunger rate and an XP Crystal a 1.1 XP rate. Those are
 * not applied here; only strength is.
 */
export function crystalStrengthBonus(): number {
  const garden = state.slot?.data?.garden;
  const tiles = [...Object.values(garden?.tileObjects || {}), ...Object.values(garden?.boardwalkTileObjects || {})];
  // objectType is lower case where crystalType is not - the game writes `crystal` beside
  // `Strength`, so matching the casing of one against the other finds nothing at all.
  const active = tiles.some(tile => tile?.objectType === 'crystal'
    && tile.crystalType === 'Strength'
    && Number(tile.remainingActiveSeconds) > 0);
  return active ? 10 : 0;
}

export function petMetrics(pet: Pet | undefined): { strength: number; maxStrength: number; xpPerLevel: number; xpToMax: number } | null {
  const info = PET_CATALOG[pet?.petSpecies || ''];
  if (!pet) return null;
  if (!info?.maxScale || info.maxScale <= 1 || !info.hoursToMature || !pet.targetScale) return null;
  const xpPerLevel = Math.floor(3600 * info.hoursToMature / 30);
  const maxStrength = Math.floor(((pet.targetScale - 1) / (info.maxScale - 1)) * 20 + 80);
  if (maxStrength < 80 || maxStrength > 100) return null;
  const levelProgress = Math.min(30, Math.floor(Number(pet.xp ?? 0) / xpPerLevel));
  const strength = maxStrength - 30 + levelProgress;
  const xpIntoLevel = Number(pet.xp ?? 0) % xpPerLevel;
  // Levelling is measured against the pet's own strength. A crystal lends strength without earning
  // any, so counting it here would report a pet as nearly maxed while the crystal was up and put
  // the estimate back the moment it expired.
  const xpToMax = strength >= maxStrength ? 0 : xpPerLevel - xpIntoLevel + xpPerLevel * (maxStrength - strength - 1);
  return { strength: strength + crystalStrengthBonus(), maxStrength, xpPerLevel, xpToMax };
}

const XP_ABILITY_REGISTRY: Record<string, { baseChance: number; baseXp: number }> = {
  PetXpBoost: { baseChance: 30, baseXp: 300 },
  PetXpBoostI: { baseChance: 30, baseXp: 300 },
  PetXpBoostII: { baseChance: 35, baseXp: 400 },
};

function abilityXpPerHour(strength: number, baseChance: number, baseXp: number): number {
  const multiplier = Math.max(.25, strength / 100);
  const chancePerSecond = Math.min(.95 / 60, baseChance / 60 / 100 * multiplier);
  return 3600 * chancePerSecond * baseXp * multiplier;
}

export function teamXpPerHour(pets: Pet[]): number {
  let total = 3600;
  for (const pet of pets) {
    if (pet.hunger <= 0) continue;
    const strength = petMetrics(pet)?.strength ?? 100;
    for (const ability of pet.abilities ?? []) {
      const xpAbility = XP_ABILITY_REGISTRY[ability];
      if (xpAbility) total += abilityXpPerHour(strength, xpAbility.baseChance, xpAbility.baseXp);
    }
  }
  return total;
}

export function formatEstimate(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'Ready';
  const minutes = Math.ceil(seconds / 60);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor(minutes % 1440 / 60);
  const remainder = minutes % 60;
  return days ? `${days}d ${hours}h` : hours ? `${hours}h ${remainder}m` : `${minutes}m`;
}

/**
 * Tools in storage, which since build 1039 is a place they can be.
 *
 * The Tool Shack stores tools the way the Seed Silo stores seeds, and nothing before it could hold a
 * Tool at all - so code that summed every storage was summing zero, and code that read only the
 * loose inventory was right by accident. Neither is right now, and they want opposite answers: a
 * count to show the player includes the Shack, a check before using a tool must not, because a tool
 * can only be used once it is out.
 */
const TOOL_SHACK = 'ToolShack';
/** The game refuses an item at this many loose slots unless it can stack onto one already there. */
const INVENTORY_SLOTS = 100;

type ToolRow = { itemType?: string; toolId?: string; quantity?: number };

function looseItems(): ToolRow[] {
  return (state.slot?.data?.inventory?.items || []) as unknown as ToolRow[];
}

function shackItems(): ToolRow[] {
  const shack = (state.slot?.data?.inventory?.storages || []).find(storage => storage.decorId === TOOL_SHACK);
  return (shack?.items || []) as unknown as ToolRow[];
}

function countTool(rows: ToolRow[], toolId: string): number {
  return rows
    .filter(item => item?.itemType === 'Tool' && item.toolId === toolId)
    .reduce((total, item) => total + Number(item.quantity || 0), 0);
}

/** Usable right now. A tool in the Shack cannot be used until it has been taken out. */
export function looseToolCount(toolId: string): number {
  return countTool(looseItems(), toolId);
}

/** Waiting in the Tool Shack. */
export function shackToolCount(toolId: string): number {
  return countTool(shackItems(), toolId);
}

/** How many of a tool the player owns, wherever it is. For showing, not for gating. */
export function heldToolCount(toolId: string): number {
  return looseToolCount(toolId) + shackToolCount(toolId);
}

/** Loose slots still open. Nothing stackable needs one, so this is a floor rather than a budget. */
export function freeInventorySlots(): number {
  return Math.max(0, INVENTORY_SLOTS - looseItems().length);
}

/**
 * Whether a retrieval would be accepted, by the game's own rule: full at a hundred loose slots,
 * except that a tool with a stack already out merges into it and needs no slot of its own.
 *
 * `reserveSlots` is for a caller that is about to be handed something else as well - potting a plant
 * gives back a Plant item, and a Plant does not stack, so it needs a slot of its very own on top of
 * whatever the pot costs.
 */
function inventoryCanTakeTool(toolId: string, reserveSlots: number): boolean {
  const items = looseItems();
  const stacks = items.some(item => item?.itemType === 'Tool' && item.toolId === toolId);
  return items.length + (stacks ? 0 : 1) + reserveSlots <= INVENTORY_SLOTS;
}

/**
 * Takes a tool out of the Shack when none is to hand, and waits for it to arrive.
 *
 * Answers whether the tool is usable by the time it returns, so a caller can simply not act when it
 * says no. The wait is for the server's own state rather than a fixed delay: the command is
 * predicted locally, but a prediction that is rolled back would leave us acting on a tool we do not
 * have.
 */
export async function ensureToolReady(toolId: string, wanted = 1, reserveSlots = 0): Promise<boolean> {
  if (looseToolCount(toolId) >= wanted) return true;
  const shortfall = wanted - looseToolCount(toolId);
  const stored = shackToolCount(toolId);
  if (stored <= 0) return false;
  if (!inventoryCanTakeTool(toolId, reserveSlots)) return false;
  // The index is left off deliberately: without one the game appends, and a stackable tool merges
  // into the stack it already has. Naming a slot is for dragging onto a particular square.
  sendQuinoaCommand({
    type: 'RetrieveItemFromStorage',
    itemId: toolId,
    storageId: TOOL_SHACK,
    quantity: Math.min(shortfall, stored),
  });
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
    if (looseToolCount(toolId) >= wanted) return true;
  }
  return false;
}

interface Tile { x: number; y: number }

/** Where a pet currently stands. Walking pets interpolate along their path by elapsed time. */
function petTileFromMotion(motion: unknown): Tile | null {
  if (!motion || typeof motion !== 'object') return null;
  const value = motion as Record<string, unknown>;
  const round = (tile: unknown): Tile | null => {
    const point = tile as Record<string, unknown> | undefined;
    const x = Number(point?.x), y = Number(point?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : null;
  };
  if (value.kind === 'idle') return round(value.at);
  if (value.kind === 'walking' && Array.isArray(value.path) && value.path.length) {
    const step = Number(value.stepDurationMs) || 0;
    const started = Number(value.startedAtMs) || 0;
    const elapsed = Math.max(0, Date.now() - started);
    const index = step > 0 ? Math.min(value.path.length - 1, Math.floor(elapsed / step)) : 0;
    return round(value.path[index]);
  }
  return null;
}

export function petTile(petItemId: string): Tile | null {
  const infos = (state.slot as unknown as { petSlotInfos?: Record<string, { motion?: unknown }> })?.petSlotInfos;
  return petTileFromMotion(infos?.[petItemId]?.motion);
}

/**
 * Stands the player on the pet before a potion is spent on it.
 *
 * Restored after being taken out on the argument that the reducer never reads a position. That
 * argument was wrong: the reducer is the client's own prediction of what the server will do, not
 * the server's validation, so its silence about position proved nothing - and the game's own
 * handler refuses outright unless there is a pet on the player's tile.
 *
 * Read after the tool has been fetched rather than before. Taking one out of the Tool Shack can
 * take seconds, pets walk while it happens, and standing where the pet used to be spends the potion
 * on nothing.
 */
function standOnPet(petItemId: string): void {
  const tile = petTile(petItemId);
  if (!tile) throw new Error('The pet position is not available yet. Try again in a moment.');
  sendBareCommand({ type: 'PlayerPosition', position: tile });
}

/**
 * Spends one XP Potion on a pet.
 *
 * The player is moved onto the pet's tile first, which the server requires. The game applies the
 * catalog xpAmount, so no value is sent.
 */
export async function useXpPotion(petItemId: string): Promise<void> {
  if (!petTile(petItemId)) throw new Error('The pet position is not available yet. Try again in a moment.');
  if (!await ensureToolReady('XPPotion')) throw new Error('No XP Potion is available to use.');
  standOnPet(petItemId);
  sendQuinoaCommand({ type: 'XPPotion', petItemId });
}

/** Fills a pet's hunger with one Hunger Potion. Same standing requirement as the XP Potion. */
export async function useReplenishPotion(petItemId: string): Promise<void> {
  if (!petTile(petItemId)) throw new Error('The pet position is not available yet. Try again in a moment.');
  if (!await ensureToolReady('ReplenishPotion')) throw new Error('No Hunger Potion is available to use.');
  standOnPet(petItemId);
  sendQuinoaCommand({ type: 'ReplenishPotion', petItemId });
}
