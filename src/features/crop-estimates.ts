import type { PlantSlot } from '../types.js';
import { feature } from '../config.js';
import { PET_CATALOG } from '../constants.js';
import { mutationMultiplier } from '../mutation-value.js';
import { page } from '../page.js';
import { activePets } from '../pets.js';
import { findPixiCard } from '../pixi.js';
import { onQuinoaEngine, quinoaEngine } from '../quinoa-engine.js';
import { state } from '../state.js';
import { formatDuration } from '../utils.js';

/**
 * Crop and egg estimates on the game's own info card: what the selected crop is worth and how long
 * it has left. The card is a PIXI view, so its setState is wrapped and the extra rows are injected
 * into the state it renders; the DOM overlay is only a fallback for when that hook is unavailable.
 */

function petStrength(pet, xpPerLevel = 12000, maxScale = 2.5) {
  const xp = Math.min(30, Math.floor(Number(pet.xp || 0) / xpPerLevel));
  const max = Math.floor(((Number(pet.targetScale || 1) - 1) / (maxScale - 1)) * 20 + 80);
  return Math.max(0, Math.min(100, max - 30 + xp));
}

function turtleRate(pets) {
  return pets.filter(pet => pet.hunger > 0 && pet.petSpecies === 'Turtle' && (pet.abilities || []).includes('PlantGrowthBoostII')).reduce((sum, pet) => {
    const strength = petStrength(pet);
    return sum + (strength / 100 * 5) * 60 * (1 - Math.pow(1 - 0.27 * strength / 100, 1 / 60));
  }, 0);
}

const EGG_ABILITIES = { EggGrowthBoost: [7, .21], EggGrowthBoostI: [9, .24], EggGrowthBoostII_NEW: [9, .24], EggGrowthBoostII: [11, .27] };
const EGG_PETS = { Chicken: [2880, 2], Turkey: [8640, 2.5], Turtle: [12000, 2.5] };
function eggRate(pets) {
  let total = 0;
  for (const pet of pets) {
    const info = EGG_PETS[pet.petSpecies];
    if (!info || pet.hunger <= 0) continue;
    const strength = petStrength(pet, info[0], info[1]);
    for (const ability of pet.abilities || []) {
      const rule = EGG_ABILITIES[ability];
      if (rule) total += (strength / 100 * rule[0]) * 60 * (1 - Math.pow(1 - rule[1] * strength / 100, 1 / 60));
    }
  }
  return total;
}

const VALUE_PREFIX = '🪙 ';
const GROWTH_PREFIX = '🐢 ';

function turtleLines() {
  const pets = state.slot?.data?.petSlots || [];
  const crops = Array.isArray(state.currentCrop) ? state.currentCrop : [];
  const crop = crops.find(slot => String(slot?.slotId) === String(state.selectedSlotId)) || crops[0] || null;
  const egg = state.currentEgg || (crop?.species?.endsWith('Egg') ? crop : null);
  if (egg) {
    const end = Number(egg.maturedAt || egg.endTime || 0);
    const rate = eggRate(pets);
    return end > Date.now() && rate > 0 ? [`${GROWTH_PREFIX}${formatDuration((end - Date.now()) / (rate + 1))}`] : [];
  }
  if (!crop) return [];
  const lines = [];
  const base = Number(page.__gardenCompanionPlantPrice?.(crop.species) || 0);
  if (base) lines.push(`${VALUE_PREFIX}${Math.round(base * Number(crop.targetScale || 1) * mutationMultiplier([...(crop.mutations || [])]) * (1 + Math.min(5, Math.max(0, (state.room?.players?.length || 1) - 1)) * .1)).toLocaleString()}`);
  const end = Number(crop.endTime || 0), rate = turtleRate(pets);
  if (end > Date.now() && rate > 0) lines.push(`${GROWTH_PREFIX}${formatDuration((end - Date.now()) / (rate + 1))}`);
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

function nativeEstimateSignature(): string {
  return feature('turtleTimer') ? turtleLines().join('\n') : '';
}

function decorateGardenCardState(nextState: GardenCardState, signature = nativeEstimateSignature()): GardenCardState {
  const clean = cleanGardenCardState(nextState);
  if (!clean.card || !signature) return clean;
  const lines = signature.split('\n');
  const attributes = [...(clean.card.attributes || [])];
  const estimateAttributes = lines.map((text, index) => ({
    key: 'time',
    text,
    color: index === 0 && text.startsWith(VALUE_PREFIX) ? 0xffd84d : 0xa9efff,
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
  const bounds = feature('turtleTimer') ? findPixiCard() : null;
  const lines = bounds ? turtleLines() : [];
  if (!lines.length) { overlay?.remove(); return; }
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'gc-turtle'; document.body.appendChild(overlay); }
  overlay.replaceChildren(...lines.map(text => Object.assign(document.createElement('div'), { textContent: text })));
  overlay.style.left = `${Math.round(bounds.centerX)}px`;
  overlay.style.top = `${Math.round(bounds.top - 5)}px`;
}

export function installCropEstimates(): void {
  onQuinoaEngine(hookGardenInfoCard);
}
