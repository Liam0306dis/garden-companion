import { panelActions } from './panel-actions.js';
import { escapeHtml } from './utils.js';

/**
 * The guided tour behind the Tour button in the companion's footer. Each step opens the tab it is
 * about, dims everything else and puts a short caption beside what it is pointing at.
 *
 * Targets are selectors rather than elements: the panel replaces its contents on every render and
 * the live tabs redraw every second, so an element held from the start of a step would be gone a
 * moment later. The spotlight looks its targets up again every frame instead.
 */

interface TourStep {
  /** Panel tab to open before the step is shown. Steps without one leave the panel as it is. */
  tab?: string;
  /** Selectors to spotlight; every match counts and the spotlight covers them all. None centres the card. */
  targets?: string[];
  /** Skip the step when nothing matches, for widgets that can be turned off or minimised. */
  optional?: boolean;
  /** Element scrolled to the top of the tab, for a step about part of a tab while the whole tab stays lit. */
  scrollTo?: string;
  title: string;
  text: string;
}

const CONTENT = '#gc-panel .gc-content';

const STEPS: TourStep[] = [
  { title: 'Welcome to Garden Companion', text: 'A quick look at what each part of the companion does. Use the arrow keys or the buttons below to move through it, and Escape to leave at any point.' },
  { targets: ['#gc-panel nav'], title: 'Navigation', text: 'Tabs are grouped by what they deal with: pets, crops, alerts and tools. Click a group heading to fold it away if you never use it.' },
  { tab: 'abilities', targets: [CONTENT], title: 'Active Pets', text: 'Hunger, strength and ability stats for the pets you have out, updated live as they change.' },
  { tab: 'abilityLog', targets: [CONTENT], title: 'Pet Abilities', text: 'Every ability your pets have triggered, newest first. Filter it down to the abilities you care about.' },
  { tab: 'teams', targets: [CONTENT], title: 'Pet Teams', text: 'Save the pets you have out as a team, then swap between teams in one click or with a keybind.' },
  { tab: 'petFood', targets: [CONTENT], title: 'Pet Food', text: 'Pick which crops each species eats. The feed panel then feeds your active pets with the right food.' },
  { targets: ['#gc-petfood [data-food-row]'], optional: true, title: 'Feed panel', text: 'Feed buttons beside each of your active pets, one click to feed them their chosen food. Turn them on or off from the Features tab.' },
  { tab: 'eggLuck', targets: [CONTENT], title: 'Egg Luck', text: 'How your hatches compare with the odds, and how close you are to pity.' },
  { tab: 'protection', targets: [CONTENT], title: 'Crop Protection', text: 'Stop harvests of crops you want to keep growing, so a stray click cannot pick them early.' },
  { tab: 'journal', targets: [CONTENT], title: 'Journal', text: 'Which species and variants your journal is still missing.' },
  { tab: 'shops', targets: [CONTENT], title: 'Shop Alarms', text: 'Pick the seeds, eggs and tools you want, and get an alarm when they come back in stock.' },
  { tab: 'weatherAlarms', targets: [CONTENT], title: 'Weather Alarms', text: 'Get an alarm when the weather you care about arrives.' },
  { tab: 'alarmSound', targets: [CONTENT], title: 'Alert Settings', text: 'Sounds, volume and layout for every alarm the companion raises, plus pet alarms.' },
  { tab: 'silence', targets: [CONTENT], title: 'Ignore Alerts', text: 'Hide the game\'s own popups for abilities you no longer need to see.' },
  { tab: 'calculators', targets: [CONTENT], title: 'Calculators', text: 'XP, dust and value maths for your pets and crops.' },
  { tab: 'rooms', targets: [CONTENT], title: 'Rooms', text: 'Public rooms with space for you, ready to join.' },
  { tab: 'keybinds', targets: [CONTENT], title: 'Keybinds', text: 'Every shortcut lives here: teams, tools and companion windows. Click one and press the keys you want.' },
  { tab: 'features', targets: [CONTENT], title: 'Features', text: 'Optional tools you can switch on or off, such as plant drag move, crop estimates and background mode.' },
  { tab: 'features', targets: [CONTENT], scrollTo: '#gc-panel main .gc-launch-row', title: 'Extra windows', text: 'The Garden Overview, Farm Manager, Crop Cleanser, Layout planner, Celestial layout and the minigames all open from here.' },
  { targets: ['#gc-overview-button'], optional: true, title: 'Garden Overview button', text: 'The quickest way into the Garden Overview: growth, value, mutation progress and completion estimates for your whole garden.' },
  { targets: ['#gc-lunar:not([hidden])', '#gc-lunar-mini:not([hidden])'], optional: true, title: 'Lunar timer', text: 'Counts down to the next lunar event, or the next weather with the swap button. The gear opens this panel and the dot shows whether you are connected.' },
  { targets: ['#gc-panel [data-whats-new]'], title: "What's new", text: 'The version number lists the latest changes. A dot on it means there are notes you have not read yet.' },
  { targets: ['#gc-panel [data-tab="supporter"]'], title: 'Support the Tool', text: 'If the companion has been useful, this is where to leave a tip. Nothing is locked behind it.' },
  { targets: ['#gc-panel [data-tour]'], title: 'That is everything', text: 'Run the tour again from here whenever you like.' },
];

const PAD = 6;
const GAP = 12;

type Box = { left: number; top: number; width: number; height: number };

let running: {
  index: number;
  steps: TourStep[];
  startTab: string;
  root: HTMLElement;
  frame: number;
  /** Where each spotlight is drawn this frame, eased towards its target so moving between steps glides. */
  shown: Box[];
} | null = null;

/**
 * A tab step lights the tab's own button in the nav or footer as well as the pane, so the tour
 * shows where each tab lives and not only what is in it. A button inside a folded nav group has no
 * box and drops out on its own.
 */
function selectors(step: TourStep): string[] {
  return [...(step.targets ?? []), ...(step.tab ? [`#gc-panel [data-tab="${step.tab}"]`] : [])];
}

function visible(selector: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].filter(element => element.getClientRects().length > 0);
}

function matches(step: TourStep): HTMLElement[] {
  return (step.targets ?? []).flatMap(visible);
}

/**
 * The area the targets cover, cut down to what their scroll container shows - the launch rows run
 * past the bottom of the Features tab, and a spotlight hanging off the panel points at nothing.
 */
function targetRect(elements: HTMLElement[]): Box | null {
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const element of elements) {
    const rect = element.getBoundingClientRect();
    left = Math.min(left, rect.left); top = Math.min(top, rect.top);
    right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
  }
  if (left === Infinity) return null;
  const clip = elements[0].closest('#gc-panel main')?.getBoundingClientRect();
  if (clip) {
    left = Math.max(left, clip.left); top = Math.max(top, clip.top);
    right = Math.min(right, clip.right); bottom = Math.min(bottom, clip.bottom);
  }
  // Nav and footer buttons sit flush against their neighbours, so they get a tighter margin.
  const pad = elements[0].matches('[data-tab]') ? 2 : PAD;
  left = Math.max(left - pad, 0); top = Math.max(top - pad, 0);
  right = Math.min(right + pad, innerWidth); bottom = Math.min(bottom + pad, innerHeight);
  return right > left && bottom > top ? { left, top, width: right - left, height: bottom - top } : null;
}

/** One spotlight per selector rather than one around everything, so a nav button and its pane stay separate. */
function stepRects(step: TourStep): Box[] {
  return selectors(step).map(selector => targetRect(visible(selector))).filter((rect): rect is Box => rect !== null);
}

function union(rects: Box[]): Box | null {
  if (!rects.length) return null;
  const left = Math.min(...rects.map(rect => rect.left)), top = Math.min(...rects.map(rect => rect.top));
  const right = Math.max(...rects.map(rect => rect.left + rect.width)), bottom = Math.max(...rects.map(rect => rect.top + rect.height));
  return { left, top, width: right - left, height: bottom - top };
}

function ease(from: Box | undefined, to: Box): Box {
  if (!from) return to;
  const step = (a: number, b: number) => Math.abs(b - a) < .5 ? b : a + (b - a) * .3;
  return { left: step(from.left, to.left), top: step(from.top, to.top), width: step(from.width, to.width), height: step(from.height, to.height) };
}

/** A rounded rectangle as a subpath, cut out of the dimming by the even-odd fill rule. */
function holePath({ left: x, top: y, width: w, height: h }: Box): string {
  const r = Math.min(9, w / 2, h / 2);
  return `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}`
    + `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`;
}

/** Beside the spotlight where there is room, otherwise above or below it, otherwise over its bottom edge. */
function placeCard(card: HTMLElement, box: Box | null): void {
  const width = card.offsetWidth, height = card.offsetHeight;
  const rect = box && { ...box, right: box.left + box.width, bottom: box.top + box.height };
  let x: number, y: number;
  if (!rect) {
    x = (innerWidth - width) / 2;
    y = (innerHeight - height) / 2;
  } else if (innerWidth - rect.right >= width + GAP * 2) {
    x = rect.right + GAP; y = rect.top;
  } else if (rect.left >= width + GAP * 2) {
    x = rect.left - GAP - width; y = rect.top;
  } else if (innerHeight - rect.bottom >= height + GAP * 2) {
    x = rect.left; y = rect.bottom + GAP;
  } else if (rect.top >= height + GAP * 2) {
    x = rect.left; y = rect.top - GAP - height;
  } else {
    x = rect.left + (rect.width - width) / 2; y = rect.bottom - height - GAP;
  }
  card.style.left = `${Math.round(Math.min(Math.max(x, GAP), innerWidth - width - GAP))}px`;
  card.style.top = `${Math.round(Math.min(Math.max(y, GAP), innerHeight - height - GAP))}px`;
}

function track(): void {
  if (!running) return;
  const panel = document.getElementById('gc-panel');
  // Closed from somewhere the catcher does not cover, such as a keybind.
  if (!panel || panel.hidden) { endTour(); return; }
  const targets = stepRects(running.steps[running.index]);
  const shown = running.shown = targets.map((rect, index) => ease(running!.shown[index], rect));
  // The dimming is one path over the whole viewport with a hole per spotlight, since a shadow per
  // spotlight would darken every other spotlight on the step.
  running.root.querySelector('.gc-tour-dim path')!.setAttribute('d', `M0 0H${innerWidth}V${innerHeight}H0Z${shown.map(holePath).join('')}`);
  const rings = running.root.querySelector<HTMLElement>('.gc-tour-rings')!;
  while (rings.children.length < shown.length) rings.appendChild(document.createElement('div'));
  while (rings.children.length > shown.length) rings.lastElementChild!.remove();
  shown.forEach((rect, index) => Object.assign((rings.children[index] as HTMLElement).style, {
    left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
  }));
  placeCard(running.root.querySelector<HTMLElement>('.gc-tour-card')!, union(targets));
  running.frame = requestAnimationFrame(track);
}

function showStep(index: number): void {
  if (!running) return;
  const { steps } = running;
  if (index < 0 || index >= steps.length) { endTour(); return; }
  running.index = index;
  const step = steps[index];
  if (step.tab && step.tab !== panelActions.activeTab()) panelActions.openPanel(step.tab);
  const scrollTarget = step.scrollTo ? document.querySelector<HTMLElement>(step.scrollTo) : null;
  const main = scrollTarget?.closest<HTMLElement>('#gc-panel main');
  if (scrollTarget && main) main.scrollTop += scrollTarget.getBoundingClientRect().top - main.getBoundingClientRect().top - PAD;
  // A tab step starts from the top, which also undoes a scrollTo when stepping back onto the same tab.
  else if (step.tab) document.querySelector<HTMLElement>('#gc-panel main')?.scrollTo({ top: 0 });
  else matches(step)[0]?.scrollIntoView({ block: 'nearest' });
  const card = running.root.querySelector<HTMLElement>('.gc-tour-card')!;
  const last = index === steps.length - 1;
  card.innerHTML = `<small>${index + 1} of ${steps.length}</small><h3>${escapeHtml(step.title)}</h3><p>${escapeHtml(step.text)}</p>`
    + `<footer><button data-tour-skip>${last ? 'Close' : 'Skip tour'}</button><span>`
    + `${index > 0 ? '<button data-tour-back>Back</button>' : ''}<button class="gc-tour-next" data-tour-next>${last ? 'Done' : 'Next'}</button></span></footer>`;
  card.querySelector<HTMLButtonElement>('[data-tour-skip]')!.onclick = endTour;
  card.querySelector<HTMLButtonElement>('[data-tour-back]')?.addEventListener('click', () => showStep(index - 1));
  card.querySelector<HTMLButtonElement>('[data-tour-next]')!.onclick = () => showStep(index + 1);
  card.querySelector<HTMLButtonElement>('[data-tour-next]')!.focus({ preventScroll: true });
}

function onKey(event: KeyboardEvent): void {
  if (!running) return;
  const moves: Record<string, () => void> = {
    Escape: endTour,
    ArrowRight: () => showStep(running!.index + 1),
    ArrowLeft: () => showStep(running!.index - 1),
  };
  const move = moves[event.key];
  if (!move) return;
  // Held back from the game too, which walks your character on the arrow keys.
  event.preventDefault();
  event.stopPropagation();
  move();
}

/** Opens the panel if needed and starts from the first step. A second call while running does nothing. */
export function startTour(): void {
  if (running) return;
  const startTab = panelActions.activeTab();
  panelActions.openPanel(startTab);
  // Widgets that are switched off or minimised are left out up front, so the step count is honest.
  const steps = STEPS.filter(step => !step.optional || matches(step).length > 0);
  const root = document.createElement('div');
  root.id = 'gc-tour';
  root.dataset.gcUi = '';
  root.innerHTML = '<div class="gc-tour-catch"></div><svg class="gc-tour-dim" aria-hidden="true"><path fill-rule="evenodd"/></svg><div class="gc-tour-rings"></div><div class="gc-tour-card" role="dialog" aria-live="polite"></div>';
  document.body.appendChild(root);
  running = { index: 0, steps, startTab, root, frame: 0, shown: [] };
  document.addEventListener('keydown', onKey, true);
  showStep(0);
  track();
}

/** Takes the overlay down and puts the panel back on the tab the tour was started from. */
export function endTour(): void {
  if (!running) return;
  const { root, frame, startTab } = running;
  running = null;
  cancelAnimationFrame(frame);
  document.removeEventListener('keydown', onKey, true);
  root.remove();
  const panel = document.getElementById('gc-panel');
  if (panel && !panel.hidden && panelActions.activeTab() !== startTab) panelActions.openPanel(startTab);
}
