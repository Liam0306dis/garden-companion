import type { PlantSlot } from '../types.js';
import { feature } from '../config.js';
import { protectionReason } from './crop-protection.js';
import { mutationMultiplier } from '../mutation-value.js';
import { page } from '../page.js';
import { activePets, crystalStrengthBonus, petMetrics } from '../pets.js';
import { findPixiCard } from '../pixi.js';
import { onQuinoaEngine, quinoaEngine } from '../quinoa-engine.js';
import { state } from '../state.js';
import { formatDuration, NUMBER_LOCALE } from '../utils.js';

/**
 * Crop and egg estimates on the game's own info card: what the selected crop is worth and how long
 * it has left. The card is a PIXI view, so its setState is wrapped and the extra rows are injected
 * into the state it renders; the DOM overlay is only a fallback for when that hook is unavailable.
 */

/**
 * The shared figure, rather than a third copy of the same arithmetic.
 *
 * This used to repeat the formula with its own per-species constants - a turtle's 12000 and 2.5 are
 * just floor(3600 * hoursToMature / 30) and maxScale read out of the catalog by hand - which meant a
 * Strength Crystal's ten had to be remembered in three places, and the turtle timer was the one that
 * got missed. petMetrics carries the bonus, so nothing here has to know about crystals at all.
 */
function petStrength(pet) {
  return petMetrics(pet)?.strength ?? 87 + crystalStrengthBonus();
}

function turtleRate(pets) {
  return pets.filter(pet => pet.hunger > 0 && pet.petSpecies === 'Turtle' && (pet.abilities || []).includes('PlantGrowthBoostII')).reduce((sum, pet) => {
    const strength = petStrength(pet);
    return sum + (strength / 100 * 5) * 60 * (1 - Math.pow(1 - 0.27 * strength / 100, 1 / 60));
  }, 0);
}

const EGG_ABILITIES = { EggGrowthBoost: [7, .21], EggGrowthBoostI: [9, .24], EggGrowthBoostII_NEW: [9, .24], EggGrowthBoostII: [11, .27] };
const EGG_PETS = new Set(['Chicken', 'Turkey', 'Turtle']);
function eggRate(pets) {
  let total = 0;
  for (const pet of pets) {
    if (!EGG_PETS.has(pet.petSpecies) || pet.hunger <= 0) continue;
    const strength = petStrength(pet);
    for (const ability of pet.abilities || []) {
      const rule = EGG_ABILITIES[ability];
      if (rule) total += (strength / 100 * rule[0]) * 60 * (1 - Math.pow(1 - rule[1] * strength / 100, 1 / 60));
    }
  }
  return total;
}

const VALUE_PREFIX = '🪙 ';
const GROWTH_PREFIX = '🐢 ';
const LOCK = '🔒';

/**
 * Which crop the game's own card is showing. It resolves the selected id the same way, and the
 * fallback is the point: harvesting leaves gaps in the slot ids, so an id that is no longer present
 * resolves to the next one above it rather than to whichever crop happens to be first in the array.
 * Picking the first element instead put our estimate on a different crop to the one on screen.
 */
function selectedCrop(crops: PlantSlot[]): PlantSlot | null {
  if (!crops.length) return null;
  const selected = Number(state.selectedSlotId) || 0;
  const exact = crops.find(slot => Number(slot?.slotId) === selected);
  if (exact) return exact;
  const bySlotId = [...crops].sort((left, right) => Number(left?.slotId) - Number(right?.slotId));
  return bySlotId.find(slot => Number(slot?.slotId) >= selected) ?? bySlotId[0] ?? null;
}

/**
 * The two estimate rows, each behind its own switch. They answer different questions - what this is
 * worth, and how long it has left - and someone who wants one on the card rarely wants both, so
 * neither is allowed to drag the other onto it.
 */
function estimateLines(): string[] {
  const pets = state.slot?.data?.petSlots || [];
  const crops = Array.isArray(state.currentCrop) ? state.currentCrop : [];
  const crop = selectedCrop(crops);
  const egg = state.currentEgg || (crop?.species?.endsWith('Egg') ? crop : null);
  if (egg) {
    // An egg is never worth coins on the card, so it has only the one row to offer.
    if (!feature('turtleTimer')) return [];
    const end = Number(egg.maturedAt || egg.endTime || 0);
    const rate = eggRate(pets);
    return end > Date.now() && rate > 0 ? [`${GROWTH_PREFIX}${formatDuration((end - Date.now()) / (rate + 1))}`] : [];
  }
  if (!crop) return [];
  const lines = [];
  if (feature('cropValues')) {
    const base = Number(page.__gardenCompanionPlantPrice?.(crop.species) || 0);
    if (base) lines.push(`${VALUE_PREFIX}${Math.round(base * Number(crop.targetScale || 1) * mutationMultiplier([...(crop.mutations || [])]) * (1 + Math.min(5, Math.max(0, (state.room?.players?.length || 1) - 1)) * .1)).toLocaleString(NUMBER_LOCALE)}`);
  }
  if (feature('turtleTimer')) {
    const end = Number(crop.endTime || 0), rate = turtleRate(pets);
    if (end > Date.now() && rate > 0) lines.push(`${GROWTH_PREFIX}${formatDuration((end - Date.now()) / (rate + 1))}`);
  }
  return lines;
}

interface GardenCardState {
  card?: { attributes?: Array<Record<string, unknown>>; [key: string]: unknown } | null;
  [key: string]: unknown;
}

interface NativeGardenCardHook {
  view: Record<string, any>;
  originalSetState: (state: GardenCardState) => unknown;
  sourceState: GardenCardState | null;
  signature: string;
}

let nativeGardenCardHook: NativeGardenCardHook | null = null;

function cleanGardenCardState(nextState: GardenCardState): GardenCardState {
  if (!nextState.card || !Array.isArray(nextState.card.attributes)) return nextState;
  let changed = false;
  const attributes = nextState.card.attributes.flatMap(attribute => {
    if (attribute.gardenCompanionEstimate !== true) return [attribute];
    changed = true;
    if (!('gardenCompanionOriginalText' in attribute)) return [];
    const restored: Record<string, unknown> = { ...attribute, text: attribute.gardenCompanionOriginalText };
    delete restored.gardenCompanionEstimate;
    delete restored.gardenCompanionOriginalText;
    return [restored];
  });
  return !changed ? nextState : {
    ...nextState,
    card: { ...nextState.card, attributes },
  };
}

/**
 * A padlock on the card whenever the crop under you is protected, so the rule shows where the
 * harvest would happen rather than only in the panel. It rides the same card hook as the estimates
 * but is independent of them: protection has nothing to do with the turtle timer being on.
 */
function protectionLines(): string[] {
  const crops = Array.isArray(state.currentCrop) ? state.currentCrop : [];
  const crop = selectedCrop(crops);
  if (!crop) return [];
  // Just the padlock. Which rule caught it belongs in the panel, not on a card you walk past.
  return protectionReason(crop, crop.species || '') ? [LOCK] : [];
}

function cardLines(): string[] {
  // A pet card is never a crop, so nothing of ours belongs on it.
  if (cardShowsPet) return [];
  return [...protectionLines(), ...estimateLines()];
}

function nativeEstimateSignature(): string {
  return cardLines().join('\n');
}

function decorateGardenCardState(nextState: GardenCardState, signature = nativeEstimateSignature()): GardenCardState {
  const clean = cleanGardenCardState(nextState);
  if (!clean.card || !signature) return clean;
  const lines = signature.split('\n');
  const attributes = [...(clean.card.attributes || [])];
  const estimateAttributes = lines.map((text, index) => ({
    key: 'time',
    text,
    color: text.startsWith(LOCK) ? 0xfca5a5 : index === 0 && text.startsWith(VALUE_PREFIX) ? 0xffd84d : 0xa9efff,
    gardenCompanionEstimate: true,
  }));
  return {
    ...clean,
    card: { ...clean.card, attributes: [...attributes, ...estimateAttributes] },
  };
}

function nativeEstimateChip(node: Record<string, any>): Record<string, any> | null {
  let chip = node;
  while (chip.parent && !['GardenInfoAttributeRow', 'GardenInfoWrappedAttributeBand'].includes(chip.parent.label)) chip = chip.parent;
  return chip.parent ? chip : null;
}

function shiftNativeRowToCardCenter(card: Record<string, any>, row: Record<string, any>, chip: Record<string, any>): void {
  const peers = (row.children || []).filter((candidate: Record<string, any>) => Math.abs(Number(candidate.y) - Number(chip.y)) < .5);
  if (!peers.length) return;
  const bounds = peers.map((peer: Record<string, any>) => peer.getBounds?.()).filter(Boolean);
  if (!bounds.length) return;
  const left = Math.min(...bounds.map((item: Record<string, number>) => item.x));
  const right = Math.max(...bounds.map((item: Record<string, number>) => item.x + item.width));
  const cardBounds = card.getBounds();
  const offset = cardBounds.x + cardBounds.width / 2 - (left + right) / 2;
  const worldScale = Math.abs(Number(row.worldTransform?.a)) || 1;
  if (Number.isFinite(offset) && Math.abs(offset) > .25) for (const peer of peers) peer.x += offset / worldScale;
}

function layoutNativeEstimates(view: Record<string, any>, signature: string): boolean {
  if (!signature) return false;
  const card = view.container?.getChildByLabel?.('GardenInfoObjectCard', true);
  if (!card || typeof card.getBounds !== 'function') return false;
  const estimateLines = new Set(signature.split('\n'));
  const estimateChips: Record<string, any>[] = [];
  const stack = [...(card.children || [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const text = typeof node.text === 'string' ? node.text : typeof node._text === 'string' ? node._text : '';
    if (estimateLines.has(text)) {
      const chip = nativeEstimateChip(node);
      if (chip && !estimateChips.includes(chip)) estimateChips.push(chip);
    }
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  if (!estimateChips.length) return false;
  if (!signature.startsWith(VALUE_PREFIX)) return false;
  for (const chip of estimateChips) shiftNativeRowToCardCenter(card, chip.parent, chip);
  return false;
}

/**
 * The garden info card is shared: it shows a crop, an egg, a decor or a pet, whichever you last
 * opened. The estimate belongs only on a crop or egg card, but `state.currentCrop` can still be set
 * from the tile you are standing on while the card itself has switched to a pet you moused over - so
 * without this the timer was injected into the pet's card. Watching what the card was opened for lets
 * a pet card be left alone. Anything not clearly a pet keeps the old behaviour, so crops are safe.
 */
let cardShowsPet = false;

/**
 * A pet's card always carries a Strength attribute; a crop or egg card never does. That is the one
 * field that tells them apart in the state, so it is what decides whether the card is a pet's.
 */
function cardStateIsPet(nextState: GardenCardState): boolean {
  const attributes = nextState?.card?.attributes;
  return Array.isArray(attributes) && attributes.some(attribute => attribute?.key === 'strength');
}

/** Re-hooks the card whenever the game hands us a new engine. */
function hookGardenInfoCard(engine: ReturnType<typeof quinoaEngine>): void {
  if (!engine || typeof engine.getSystem !== 'function') {
    nativeGardenCardHook = null;
    return;
  }
  const view = engine.getSystem('gardenInfoCard')?.view;
  if (!view || typeof view.setState !== 'function' || nativeGardenCardHook?.view === view || view.__gardenCompanionEstimateHook) return;
  const originalSetState = view.setState;
  const originalLayout = view.layout;
  const hook: NativeGardenCardHook = { view, originalSetState, sourceState: null, signature: '' };
  view.setState = function(nextState: GardenCardState) {
    // Decide from the card being set whether it is a pet's, so the estimate can be kept off it. Set
    // before the signature is worked out, since that is what reads it.
    cardShowsPet = cardStateIsPet(nextState);
    hook.sourceState = cleanGardenCardState(nextState);
    hook.signature = nativeEstimateSignature();
    return originalSetState.call(this, decorateGardenCardState(hook.sourceState, hook.signature));
  };
  if (typeof originalLayout === 'function') view.layout = function(...args: unknown[]) {
    const result = originalLayout.apply(this, args);
    layoutNativeEstimates(this, hook.signature);
    return result;
  };
  view.__gardenCompanionEstimateHook = true;
  nativeGardenCardHook = hook;
  if (view.state) view.setState(view.state);
  document.getElementById('gc-turtle')?.remove();
}

function refreshNativeGardenCard(): boolean {
  const hook = nativeGardenCardHook;
  if (!hook || hook.view.container?.destroyed) {
    if (hook) nativeGardenCardHook = null;
    return false;
  }
  const signature = nativeEstimateSignature();
  if (hook.sourceState && signature !== hook.signature) {
    hook.signature = signature;
    hook.originalSetState.call(hook.view, decorateGardenCardState(hook.sourceState, signature));
  }
  document.getElementById('gc-turtle')?.remove();
  return true;
}

export function renderTurtleOverlay() {
  if (refreshNativeGardenCard()) return;
  let overlay = document.getElementById('gc-turtle');
  // Lines first: finding the card walks the scene graph, and this runs four times a second, so
  // there is no reason to look for a card when nothing wants to be drawn on it.
  const lines = cardLines();
  if (!lines.length) { overlay?.remove(); return; }
  const bounds = findPixiCard();
  if (!bounds) { overlay?.remove(); return; }
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'gc-turtle'; document.body.appendChild(overlay); }
  overlay.replaceChildren(...lines.map(text => Object.assign(document.createElement('div'), { textContent: text })));
  overlay.style.left = `${Math.round(bounds.centerX)}px`;
  overlay.style.top = `${Math.round(bounds.top - 5)}px`;
}

export function installCropEstimates(): void {
  onQuinoaEngine(hookGardenInfoCard);
}
