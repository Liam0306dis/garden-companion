import { state } from './state.js';

// Until bundle 1141 the client computed the weather schedule itself from a
// deterministic model (fixed slots + drop-table weights + an Alea seed), and this
// module borrowed that function out of the game chunk to ask it what was next.
// 1141 removed the model: weather is now server-authoritative and arrives in the
// game state as `weather` (current), `weatherWindow` (the active spell) and
// `weatherForecast` (upcoming entries). So we just read the forecast the game was
// handed - no chunk fetching, no prediction.

export interface WeatherWindow {
  weatherId: string;
  startsAtMs: number;
  endsAtMs: number;
  lunar: boolean;
}

export type ForecastStatus = 'pending' | 'ready' | 'unavailable';

// Dawn and Amber Moon are the fixed-slot lunar events. The panel announces them
// as "Lunar event" rather than by name, so we only need to know a weather IS one.
const LUNAR_WEATHER = new Set(['Dawn', 'AmberMoon']);

interface ForecastEntry { weatherId?: unknown; groupId?: unknown; startsAtMs?: unknown; endsAtMs?: unknown }

/**
 * The upcoming-weather list from game state, or null when the game has not sent
 * state yet (pending) or the running build does not carry the field at all
 * (unavailable - e.g. a client older than 1141).
 */
function forecastEntries(): ForecastEntry[] | null {
  const game = state.game as ({ weatherForecast?: unknown } | null);
  if (!game) return null;
  return Array.isArray(game.weatherForecast) ? game.weatherForecast as ForecastEntry[] : null;
}

export function forecastStatus(): ForecastStatus {
  if (!state.game) return 'pending';
  return forecastEntries() ? 'ready' : 'unavailable';
}

export function forecastTrace(): Record<string, unknown> {
  const entries = forecastEntries();
  return {
    source: 'gameState.weatherForecast',
    status: forecastStatus(),
    count: entries ? entries.length : null,
    next: nextWeather(),
  };
}

/**
 * The soonest weather event that has not started yet, or null when nothing is
 * forecast. Read straight from state on each call - it is a cheap array scan, so
 * unlike the old borrowed model there is nothing to cache or retry.
 */
export function nextWeather(): WeatherWindow | null {
  const entries = forecastEntries();
  if (!entries || !entries.length) return null;
  const now = Date.now();
  let best: WeatherWindow | null = null;
  for (const entry of entries) {
    // Lunar events ride the forecast under groupId "Lunar" with a null weatherId - the game names
    // them only as a group, since which of the two is coming is not meant to be read off in advance.
    // So a Lunar entry is a valid event even without a weatherId, and the panel shows it as one.
    const lunar = entry.groupId === 'Lunar' || (typeof entry.weatherId === 'string' && LUNAR_WEATHER.has(entry.weatherId));
    const weatherId = typeof entry.weatherId === 'string' ? entry.weatherId : '';
    const startsAtMs = Number(entry.startsAtMs);
    if ((!weatherId && !lunar) || !Number.isFinite(startsAtMs) || startsAtMs <= now) continue;   // current or malformed
    if (best && startsAtMs >= best.startsAtMs) continue;                                          // keep the earliest
    const endsAtMs = Number(entry.endsAtMs);
    best = {
      weatherId,
      startsAtMs,
      endsAtMs: Number.isFinite(endsAtMs) ? endsAtMs : 0,
      lunar,
    };
  }
  return best;
}
