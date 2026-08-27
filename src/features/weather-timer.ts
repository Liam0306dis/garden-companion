import { page } from '../page.js';
import { findVisiblePixiNodes, pixiSurface } from '../pixi.js';
import { quinoaEngine } from '../quinoa-engine.js';
import { state } from '../state.js';
import { escapeHtml, formatDuration, humanize } from '../utils.js';

/**
 * How long the current weather has left, shown under the game's own weather tooltip.
 *
 * Every weather runs for ten minutes, and the game lays them out in five minute slots counted from
 * the start of the day, so a run is two slots and every boundary falls on a ten minute mark. That
 * is enough to work out the remaining time from the clock alone, without reaching into the game's
 * own schedule - which lives in private, minified code that renames itself every release.
 *
 * A change we watch happen is still better than arithmetic, so that is preferred when we have it:
 * the grid only stands in for the weather that was already running when we arrived.
 *
 * Clear skies is not an event but the gap between them, and the gap has no fixed length, so nothing
 * is shown then - the game's own tooltip already says the weather is clear.
 */

const TOOLTIP_ID = 'gc-weather-timer';
const STYLE_ID = 'gc-weather-timer-style';
/** The game gives both weather groups a duration of ten minutes. */
const WEATHER_MS = 10 * 60 * 1000;
/** Clear of whatever it hangs beneath, without drifting away from it. */
const DROP_PX = 8;

/**
 * What the game calls each weather, which is not always its id: Frost is shown as Snow. Held here
 * rather than read from the game because it is five entries that change about as often as the
 * weather types themselves do, and an unknown id simply falls back to its own name.
 */
const WEATHER_NAMES: Record<string, string> = {
  Rain: 'Rain',
  Frost: 'Snow',
  Thunderstorm: 'Thunderstorm',
  Dawn: 'Dawn',
  AmberMoon: 'Amber Moon',
};

/** Undefined until the first report, so arriving is not mistaken for watching the weather change. */
let seenWeather: string | undefined;
let seenAt = 0;
/** When the current weather must end, once a slot boundary has settled which of the two it was. */
let boundaryEnd = 0;
let lastBoundaryAt = 0;

/**
 * Called as the game reports new state, not on a timer. Noticing the change is the whole basis of
 * the exact answer, and nobody is hovering the button at the moment it happens.
 */
export function noteWeatherChange(): void {
  const now = Date.now();
  const weather = currentWeather();
  const boundary = now + nextBoundaryMs(now);
  if (weather !== seenWeather) {
    // The first report only tells us what is running, not when it began: it was already under way
    // when we loaded. Only a change from something we had already seen is a start we witnessed.
    const first = seenWeather === undefined;
    seenWeather = weather;
    seenAt = first ? 0 : now;
    boundaryEnd = 0;
    lastBoundaryAt = boundary;
    return;
  }
  // A weather runs for two slots, so it can outlast one boundary and no more. Watching one pass
  // with the weather unchanged says it began in the earlier slot, which settles when it ends -
  // even though we never saw it start.
  if (lastBoundaryAt && boundary > lastBoundaryAt + 1_000) boundaryEnd = boundary;
  lastBoundaryAt = boundary;
}
let pointer = { x: -1, y: -1 };

export function currentWeather(): string {
  return state.game?.weather || '';
}

export function weatherLabel(weather = currentWeather()): string {
  return WEATHER_NAMES[weather] ?? humanize(weather);
}

/** Every weather the game runs, in the order its own tables list them. */
export const WEATHER_TYPES = Object.keys(WEATHER_NAMES);

const SLOT_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Dawn and Amber Moon run on fixed slots, every four hours from midnight. */
const LUNAR_SLOTS = [0, 48, 96, 144, 192, 240];
const LUNAR_WEATHER = new Set(['Dawn', 'AmberMoon']);

/**
 * Three weathers open a shop for as long as they last, and the game reads that shop's restock
 * counter as the time until it closes - its own atom for it is named snowShopClosesSeconds. So for
 * these the game is already telling us exactly how long is left, however late we arrived.
 */
const WEATHER_SHOPS: Record<string, string> = { Frost: 'snow', Thunderstorm: 'thunder', Dawn: 'dawn' };

function shopSecondsLeft(weather: string): number {
  const shop = WEATHER_SHOPS[weather];
  const seconds = shop ? Number(state.game?.shops?.[shop]?.secondsUntilRestock) : 0;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

/** Start of the most recent fixed lunar slot, or null when none has begun within a weather's run. */
function lunarStart(now: number): number | null {
  const midnight = now - (now % DAY_MS);
  for (const slot of [...LUNAR_SLOTS].reverse()) {
    const start = midnight + slot * SLOT_MS;
    if (start <= now && now - start < WEATHER_MS) return start;
  }
  return null;
}

/**
 * How long until the next five minute slot begins. The seed shop restocks on that boundary, so its
 * own countdown answers it; the clock is only the fallback for before any shop data has arrived.
 */
function nextBoundaryMs(now: number): number {
  const seconds = Number(state.game?.shops?.seed?.secondsUntilRestock);
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= SLOT_MS / 1000) return seconds * 1000;
  return SLOT_MS - (now % SLOT_MS);
}

/**
 * What is left, and how sure we are of it.
 *
 * The shop counter comes first where there is one, since that is the game's own answer rather than
 * ours. Then a change we watched. Then Amber Moon, which keeps to fixed slots so its start is known
 * outright. That leaves only Rain, which has no shop and is scheduled at random, so all that can be
 * said is that it began on one of the last two five minute slots - a five minute window rather than
 * a single number.
 */
function remaining(now: number): { low: number; high: number } {
  const weather = currentWeather();
  const shopLeft = shopSecondsLeft(weather) * 1000;
  if (shopLeft) return { low: shopLeft, high: shopLeft };
  if (seenAt && now - seenAt < WEATHER_MS) {
    const left = WEATHER_MS - (now - seenAt);
    return { low: left, high: left };
  }
  if (boundaryEnd > now) return { low: boundaryEnd - now, high: boundaryEnd - now };
  if (LUNAR_WEATHER.has(weather)) {
    const start = lunarStart(now);
    if (start !== null) {
      const left = WEATHER_MS - (now - start);
      return { low: left, high: left };
    }
  }
  // Rain has no shop of its own, but the ordinary shops restock on the same five minute slot the
  // weather is scheduled in, so their countdown is where the next boundary falls - asked for rather
  // than assumed from the clock. Rain ends on that boundary or the one after it.
  const toBoundary = nextBoundaryMs(now);
  return { low: toBoundary, high: toBoundary + SLOT_MS };
}

/**
 * How long the running weather has left, phrased as the tooltip phrases it. Rain is scheduled at
 * random and has no shop counter, so when it started before we arrived the answer is a pair of
 * possible ends rather than one.
 */
export function weatherRemainingText(): string {
  const { low, high } = remaining(Date.now());
  // Whole minutes, unlike the tooltip: this one is read from a panel that redraws when it changes,
  // and a ticking seconds field would rebuild the tab every second to move a digit.
  const minutes = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))}m`;
  return low === high ? `${minutes(low)} left` : `${minutes(low)} or ${minutes(high)} left`;
}

/**
 * The game's own tooltip, which opens on the same hover and is drawn beside the button rather than
 * beneath it. Sitting under that reads as one panel; the button is the fallback for the moment
 * before it appears.
 */
function tooltipRect(): { left: number; right: number; bottom: number } | null {
  const surface = pixiSurface();
  if (!surface) return null;
  const popup = findVisiblePixiNodes(surface, ['TooltipPopup']).get('TooltipPopup');
  if (!popup || typeof popup.getBounds !== 'function') return null;
  try {
    const bounds = popup.getBounds();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0) return null;
    return {
      left: surface.toScreenX(bounds.x),
      right: surface.toScreenX(bounds.x + bounds.width),
      bottom: surface.toScreenY(bounds.y + bounds.height),
    };
  } catch { return null; }
}

/** The game's weather button, which lives on the right hand rail beside the friend bonus. */
function buttonRect(): { left: number; right: number; top: number; bottom: number } | null {
  const surface = pixiSurface();
  const rail = quinoaEngine()?.getSystem?.('rightSideRail') as { weatherButton?: { viewContainer?: Record<string, any> } } | undefined;
  const container = rail?.weatherButton?.viewContainer;
  if (!surface || !container || container.destroyed || typeof container.getBounds !== 'function') return null;
  try {
    const bounds = container.getBounds();
    if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0) return null;
    return {
      left: surface.toScreenX(bounds.x),
      right: surface.toScreenX(bounds.x + bounds.width),
      top: surface.toScreenY(bounds.y),
      bottom: surface.toScreenY(bounds.y + bounds.height),
    };
  } catch { return null; }
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
#${TOOLTIP_ID} { position:fixed;z-index:99993;pointer-events:none;transform:translateX(-50%);
  padding:6px 10px;border-radius:9px;border:1px solid rgba(125,211,252,.16);
  background:linear-gradient(145deg,#10151a,#090b0f 72%);box-shadow:0 12px 32px rgba(0,0,0,.6);
  color:#e4e4e7;font:600 12px/1.25 system-ui,sans-serif;white-space:nowrap; }
#${TOOLTIP_ID}[hidden] { display:none; }
#${TOOLTIP_ID} b { color:#a9efff;font-weight:700; }
#${TOOLTIP_ID} small { display:block;margin-top:2px;color:var(--gc-muted,#a1a1aa);font-size:10px;font-weight:600; }`;
  document.head.appendChild(style);
}

function tooltip(): HTMLElement {
  ensureStyle();
  let root = document.getElementById(TOOLTIP_ID);
  if (!root) {
    root = document.createElement('div');
    root.id = TOOLTIP_ID;
    root.hidden = true;
    document.body.appendChild(root);
  }
  return root;
}

function render(): void {
  const now = Date.now();
  const root = document.getElementById(TOOLTIP_ID);
  const rect = buttonRect();
  // The button's own bounds, so a differently sized rail is still hit exactly.
  const hovering = rect
    && pointer.x >= rect.left && pointer.x <= rect.right
    && pointer.y >= rect.top && pointer.y <= rect.bottom;
  if (!rect || !hovering || !currentWeather()) {
    if (root) root.hidden = true;
    return;
  }
  const element = tooltip();
  const { low, high } = remaining(now);
  // Two possible answers rather than a spread: it ends on the next slot boundary or the one after,
  // so a range would claim every value between them is possible when only the two ends are.
  const left = low === high
    ? `<b>${escapeHtml(formatDuration(low))}</b> left`
    : `<b>${escapeHtml(formatDuration(low))} or ${escapeHtml(formatDuration(high))}</b> left<small>started before you arrived</small>`;
  element.innerHTML = `${escapeHtml(weatherLabel())} ${left}`;
  element.hidden = false;
  const under = tooltipRect() ?? rect;
  element.style.left = `${Math.round((under.left + under.right) / 2)}px`;
  element.style.top = `${Math.round(under.bottom + DROP_PX)}px`;
}

/**
 * Drawn when the pointer moves, and once a second only while it is actually showing. Measuring the
 * button means asking the engine for the rail and taking bounds off it, which is not work to do
 * four times a second at a cursor that is sitting still.
 */
export function initWeatherTimer(): void {
  let ticking = 0;
  const stopTicking = () => { if (ticking) { clearInterval(ticking); ticking = 0; } };
  const update = () => {
    render();
    const showing = !document.getElementById(TOOLTIP_ID)?.hidden;
    // The tick calls back into here rather than straight to render, so it stops itself once the
    // tooltip goes - the weather ending is not something a pointer event will tell us about.
    if (showing && !ticking) ticking = window.setInterval(update, 1_000);
    else if (!showing) stopTicking();
  };
  page.addEventListener('pointermove', event => {
    pointer = { x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY };
    update();
  }, true);
  page.addEventListener('pointerleave', () => { pointer = { x: -1, y: -1 }; update(); }, true);
}
