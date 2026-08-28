import { state } from '../state.js';
import { humanize } from '../utils.js';

/**
 * How long the current weather has left, for the weather alarm panel.
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
 * is shown then.
 *
 * This used to draw its own readout under the game's weather button on hover. The game now puts a
 * ring on the weather icon showing how long the weather has left, and its Weather Station says so
 * outright, so the readout is gone and only the figure the alarm panel reports is kept.
 */

/** The game gives both weather groups a duration of ten minutes. */
const WEATHER_MS = 10 * 60 * 1000;

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
 * How long the running weather has left. Rain is scheduled at random and has no shop counter, so
 * when it started before we arrived the answer is a pair of possible ends rather than one.
 */
export function weatherRemainingText(): string {
  const { low, high } = remaining(Date.now());
  // Whole minutes: this is read from a panel that redraws when it changes, and a ticking seconds
  // field would rebuild the tab every second to move a digit.
  const minutes = (ms: number) => `${Math.max(1, Math.ceil(ms / 60_000))}m`;
  return low === high ? `${minutes(low)} left` : `${minutes(low)} or ${minutes(high)} left`;
}
