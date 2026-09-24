import type { PlantSlot } from '../types.js';
import { feature } from '../config.js';
import { PLANT_CATALOG } from '../constants.js';
import { slotScale } from '../crop-size.js';
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
/** The game's colour for a crop's size when it is not at max size. */
const GAME_ATTRIBUTE_COLOR = 0xb5b5b5;

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
    if (base) lines.push(`${VALUE_PREFIX}${Math.round(base * slotScale(PLANT_CATALOG[crop.species ?? '']?.crop, crop) * mutationMultiplier([...(crop.mutations || [])]) * (1 + Math.min(5, Math.max(0, (state.room?.players?.length || 1) - 1)) * .1)).toLocaleString(NUMBER_LOCALE)}`);
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
  const estimateAttributes = lines.map(text => ({
    key: 'time',
    text,
    // The same grey the game gives a crop's size, so our lines read as part of its card.
    color: text.startsWith(LOCK) ? 0xfca5a5 : GAME_ATTRIBUTE_COLOR,
    gardenCompanionEstimate: true,
  }));
  return {
    ...clean,
    card: { ...clean.card, attributes: [...attributes, ...estimateAttributes] },
  };
}

type PixiNode = Record<string, any>;

function nativeEstimateChip(node: PixiNode): PixiNode | null {
  let chip = node;
  while (chip.parent && !['GardenInfoAttributeRow', 'GardenInfoAttributeBand'].includes(chip.parent.label)) chip = chip.parent;
  return chip.parent ? chip : null;
}

function nodeText(node: PixiNode): string {
  return typeof node.text === 'string' ? node.text : typeof node._text === 'string' ? node._text : '';
}

/** Our estimate chips on the card, keyed by the line they show. */
function findEstimateChips(card: PixiNode, lines: string[]): Map<string, PixiNode> {
  const wanted = new Set(lines);
  const found = new Map<string, PixiNode>();
  const stack = [...(card.children || [])];
  while (stack.length) {
    const node = stack.pop();
    if (!node || typeof node !== 'object') continue;
    const text = nodeText(node);
    if (wanted.has(text) && !found.has(text)) {
      const chip = nativeEstimateChip(node);
      if (chip) found.set(text, chip);
    }
    if (Array.isArray(node.children)) stack.push(...node.children);
  }
  return found;
}

/** Lays chips out left to right, returning the unscaled width of the run. */
function packChips(chips: PixiNode[], gap: number): number {
  let x = 0;
  for (const chip of chips) { chip.x = x; x += chip.width + gap; }
  return chips.length ? x - gap : 0;
}

/**
 * The game's card became a fixed 210-220px wide in bundle 1246, with a large picture of the crop taking
 * the left of it. The row holding size, mutations and our estimates is scaled down to fit whatever is
 * left (the band's `scale.set(n / u)`), so a coin value next to a few mutations came out tiny.
 *
 * This runs straight after the game rebuilds the card, before its layout pass positions the sections,
 * so everything it changes is in place for the same frame. It takes our chips out of that band, gives
 * each estimate its own line under it, widens the card until the band no longer has to shrink
 * (capped to the width the game itself would allow), and makes the card taller when the new lines
 * need it - moving the multi-harvest page dots down so they stay underneath.
 */
function relayoutNativeEstimates(view: PixiNode, signature: string): void {
  if (!signature) return;
  const card: PixiNode | null = view.container?.getChildByLabel?.('GardenInfoObjectCard', true);
  if (!card?.hitArea || !Array.isArray(card.children)) return;
  const lines = signature.split('\n');
  const chipsByLine = findEstimateChips(card, lines);
  if (!chipsByLine.size) return;

  const oldWidth = Number(card.hitArea.width);
  if (!(oldWidth > 0)) return;
  // The game's own responsive sizes: its card is 220 wide at the md breakpoint and 210 or less below it.
  const md = oldWidth >= 220;
  const edgePad = md ? 14 : 10, verticalPad = md ? 14 : 8, rowGap = md ? 8 : 4, lineGap = md ? 5 : 2;
  const background = card.children.find((child: PixiNode) => 'fillSprite' in child);
  const mount = card.children.find((child: PixiNode) => child.label === 'GardenInfoMiniCardMount');
  const dots = card.children.find((child: PixiNode) => child.label === 'GardenInfoCropPageDots');
  if (!background || !mount) return;
  // The height the game built, read from where it centred the crop picture rather than from the hit
  // area: another mod may already have made the card taller, and starting from that size added our
  // lines on top of its growth and left a band of empty card underneath.
  const drawnHeight = Number(card.hitArea.height);
  const oldHeight = Number(mount.y) > 0 ? Number(mount.y) * 2 : drawnHeight;
  if (!(oldHeight > 0)) return;
  // The mini card sits one inset in from the left and the column starts one gap after it; the game
  // uses the same value for both, so the column's left edge is exactly twice the mount's centre.
  const columnLeft = Number(mount.x) * 2;
  const oldColumn = oldWidth - edgePad - columnLeft;
  if (!(oldColumn > 0)) return;

  // Only the game's own rows are restacked: they all sit in the column right of the mini card and
  // inside the card. Other mods add their own children to this card too - an outline drawn over the
  // whole card, for one - and treating one of those as a row stacked everything else underneath it.
  const others = card.children.filter((child: PixiNode) => child !== background && child !== mount && child !== dots);
  // Told apart by the game's own labels rather than by position: a mod's invisible container sitting in
  // the column still counted as a row, and a full-height one doubled the card. The one unlabelled
  // game row (abilities, display crop) is recognised by the labelled pieces inside it.
  const GAME_ROW_LABELS = ['GardenInfoObjectTitleRow', 'GardenInfoAttributeRow', 'GardenInfoAttributeBand'];
  const holdsGameLabel = (node: PixiNode, depth = 0): boolean => depth < 3 && Array.isArray(node.children)
    && node.children.some((child: PixiNode) => String(child.label || '').startsWith('GardenInfo') || holdsGameLabel(child, depth + 1));
  const isGameRow = (child: PixiNode) => Number(child.x) >= columnLeft - 2
    && (GAME_ROW_LABELS.includes(child.label) || (!child.label && holdsGameLabel(child)));
  const rows = others.filter(isGameRow);
  // A foreign overlay the size of the card is stretched with it, so a border stays on the card's edge.
  // Looked for beside the card as well, in the frame that holds it, since a mod may draw there instead.
  const cardSized = (child: PixiNode) => Math.abs(Number(child.width) - oldWidth) <= 8
    && [oldHeight, drawnHeight].some(height => Math.abs(Number(child.height) - height) <= 8) && typeof child.scale?.set === 'function';
  const frameSiblings = (card.parent?.children || []).filter((child: PixiNode) => child !== card && child.label !== 'GardenInfoPreservedBadge');
  const overlays = [...others.filter((child: PixiNode) => !isGameRow(child)), ...frameSiblings].filter(cardSized);
  const original = rows.map((row: PixiNode) => ({ row, y: Number(row.y), height: Number(row.height) })).sort((a, b) => a.y - b.y);

  // Pull our chips out of the rows the game put them in, and close up whatever they leave behind.
  const bands: Array<{ row: PixiNode; width: number }> = [];
  for (const parent of new Set([...chipsByLine.values()].map(chip => chip.parent))) {
    const before = [...parent.children].sort((a: PixiNode, b: PixiNode) => a.x - b.x);
    const gap = before.length > 1 ? Math.max(0, before[1].x - before[0].x - before[0].width) : 0;
    for (const chip of chipsByLine.values()) if (chip.parent === parent) parent.removeChild(chip);
    const remaining = before.filter((child: PixiNode) => child.parent === parent);
    if (!remaining.length) { parent.parent?.removeChild(parent); parent.destroy({ children: true }); continue; }
    bands.push({ row: parent, width: packChips(remaining, gap) });
  }

  // One line per estimate, the padlock riding along on the first one.
  const lock = chipsByLine.get(LOCK);
  const estimates = lines.filter(line => line !== LOCK).map(line => chipsByLine.get(line)).filter(Boolean) as PixiNode[];
  const groups = estimates.length ? estimates.map((chip, index) => index === 0 && lock ? [lock, chip] : [chip]) : lock ? [[lock]] : [];
  const ourRows = groups.map(group => {
    const row = new (card.constructor as new () => PixiNode)();
    row.label = 'GardenCompanionEstimateRow';
    const height = Math.max(...group.map(chip => Number(chip.height)));
    for (const chip of group) { row.addChild(chip); chip.y = (height - Number(chip.height)) / 2; }
    return { row, width: packChips(group, md ? 6 : 4) };
  });

  // Widen to whatever the content wants at full size, never past what the game allows on screen.
  const rendererWidth = Number(view.lastRendererWidth) || 0;
  const maxWidth = rendererWidth > 0 ? Math.max(oldWidth, 160, rendererWidth - (32 + (md ? 8 : 2)) * 2 - 24) : oldWidth;
  const wanted = Math.max(
    oldColumn,
    ...bands.map(band => band.width),
    ...ourRows.map(ours => ours.width),
  );
  const column = Math.min(wanted, maxWidth - edgePad - columnLeft);
  const extraWidth = Math.max(0, column - oldColumn);
  const newWidth = oldWidth + extraWidth;

  for (const band of bands) band.row.scale.set(Math.min(1, column / band.width));
  for (const ours of ourRows) ours.row.scale.set(Math.min(1, column / ours.width));
  // A title the game had to squeeze can use the extra room too, unless it shares its row with stats.
  const title = card.children.find((child: PixiNode) => child.label === 'GardenInfoObjectTitleRow');
  if (extraWidth && title?.children?.length === 1 && 'maxWidth' in title.children[0]) title.children[0].maxWidth = column;

  // Restack: the game's rows keep their gaps, then our lines go underneath.
  const stack: Array<{ row: PixiNode; gap: number }> = [];
  let previousBottom: number | null = null;
  for (const entry of original) {
    const gap = previousBottom === null ? 0 : Math.max(0, entry.y - previousBottom);
    previousBottom = entry.y + entry.height;
    if (entry.row.destroyed || entry.row.parent !== card) continue;
    stack.push({ row: entry.row, gap: stack.length ? gap : 0 });
  }
  ourRows.forEach((ours, index) => {
    card.addChild(ours.row);
    stack.push({ row: ours.row, gap: stack.length ? index === 0 ? rowGap : lineGap : 0 });
  });
  const contentHeight = stack.reduce((sum, entry) => sum + entry.gap + Number(entry.row.height), 0);
  const bottomPad = dots ? Math.max(verticalPad, oldHeight - Number(dots.y) + 2) : verticalPad;
  const newHeight = Math.max(oldHeight, verticalPad + contentHeight + bottomPad);
  let y = verticalPad + (newHeight - verticalPad - bottomPad - contentHeight) / 2;
  const centre = columnLeft + column / 2;
  for (const entry of stack) {
    y += entry.gap;
    const width = Number(entry.row.width);
    entry.row.position.set(Math.max(columnLeft, centre - width / 2), y);
    y += Number(entry.row.height);
  }

  const extraHeight = newHeight - oldHeight;
  if (!extraWidth && !extraHeight && drawnHeight === oldHeight) return;
  // The background is two nine-slice sprites drawn at a bake scale; resize them the way its draw does.
  for (const sprite of [background.fillSprite, background.borderSprite]) {
    if (!sprite?.visible || typeof sprite.setSize !== 'function') continue;
    const bake = 1 / (Number(sprite.scale?.y) || 1);
    sprite.setSize(newWidth * bake, newHeight * bake);
  }
  for (const area of [background.hitArea, card.hitArea]) if (area) { area.width = newWidth; area.height = newHeight; }
  for (const overlay of overlays) overlay.scale.set(Number(overlay.scale.x) * newWidth / Number(overlay.width), Number(overlay.scale.y) * newHeight / Number(overlay.height));
  mount.y = newHeight / 2;
  if (dots) { dots.x += extraWidth / 2; dots.y += extraHeight; }

  const frame = card.parent;
  const badge = frame?.getChildByLabel?.('GardenInfoPreservedBadge');
  if (badge) badge.x += extraWidth;
  const section = (view.sections || []).find((candidate: PixiNode) => candidate.container === frame || candidate.container === frame?.parent);
  if (!section) return;
  // The crop picture overhangs the bottom of a short card; a taller card swallows some of that.
  const overhang = Math.max(0, Number(section.height) - Number(card.y) - oldHeight);
  const newOverhang = Math.max(0, Math.ceil(overhang - extraHeight / 2));
  const heightChange = extraHeight - overhang + newOverhang;
  section.width += extraWidth;
  section.height = Number(section.height) + heightChange;
  if (section.topOverhang) section.topOverhang.openToXPx += extraWidth;
  const right = section.container.getChildByLabel?.('GardenInfoBrowseButton:right');
  const left = section.container.getChildByLabel?.('GardenInfoBrowseButton:left');
  if (right) right.x += extraWidth;
  for (const button of [left, right]) if (button) button.y += extraHeight;
  if (view.cropPopTarget?.container === frame) {
    view.cropPopTarget.width += extraWidth;
    view.cropPopTarget.height += heightChange;
  }
}

/**
 * Grows the card section's stored height to what it actually draws, returning whether it changed.
 * Only ever grows it, so the game's own overhang allowances are never trimmed.
 */
function fitCardSectionHeight(view: PixiNode): boolean {
  const row = view.container?.getChildByLabel?.('GardenInfoCardRow', true);
  if (!row || typeof row.getLocalBounds !== 'function') return false;
  const section = (view.sections || []).find((candidate: PixiNode) => candidate.container === row);
  if (!section) return false;
  const bounds = row.getLocalBounds();
  const drawn = Math.ceil(Number(bounds.y) + Number(bounds.height));
  if (!Number.isFinite(drawn) || drawn <= Number(section.height) + .5) return false;
  section.height = drawn;
  return true;
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
  const originalRebuild = view.rebuild;
  const hook: NativeGardenCardHook = { view, originalSetState, sourceState: null, signature: '' };
  view.setState = function(nextState: GardenCardState) {
    // Decide from the card being set whether it is a pet's, so the estimate can be kept off it. Set
    // before the signature is worked out, since that is what reads it.
    cardShowsPet = cardStateIsPet(nextState);
    hook.sourceState = cleanGardenCardState(nextState);
    hook.signature = nativeEstimateSignature();
    return originalSetState.call(this, decorateGardenCardState(hook.sourceState, hook.signature));
  };
  // The game rebuilds the card inside its layout pass, just before positioning the sections, so
  // reshaping it here lands in the same frame.
  if (typeof originalRebuild === 'function') view.rebuild = function(...args: unknown[]) {
    const result = originalRebuild.apply(this, args);
    try { relayoutNativeEstimates(this, hook.signature); } catch (error) { console.warn('[GC] card estimate layout failed', error); }
    return result;
  };
  // The layout pass stacks the card above the action buttons from each section's stored height. If
  // anything grows the card after our relayout - another mod reshaping it too - that height is stale
  // and the card slides down behind the Harvest button. Measured after the pass, and when the card
  // has outgrown its height the pass is run once more (no rebuild this time) with the corrected one.
  const originalLayout = view.layout;
  if (typeof originalLayout === 'function') view.layout = function(...args: unknown[]) {
    const result = originalLayout.apply(this, args);
    try { if (fitCardSectionHeight(this)) originalLayout.apply(this, args); } catch (error) { console.warn('[GC] card height check failed', error); }
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
