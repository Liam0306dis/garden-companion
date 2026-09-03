import { loadLocal, saveLocal } from './utils.js';

const SHAPE = /function ([A-Za-z_$][\w$]*)\(e,t\)\{(?:(?!function ).){0,600}?return\{weatherId:[^,]+,startsAtMs:/s;
const WRAPPER_NAME = /function ([A-Za-z_$][\w$]*)\(e\)\{$/;
// The enum holder inside the key can be minified to a name with a `$` (build 1092 named the group
// enum `$o`), which `\w` does not cover - so both classes allow `$` or the table goes unfound and
// the forecast reports itself unavailable.
const WEATHER_TABLE = /([\w$]+)=\{\[[\w$]+\.Rain\]:\{groupId:/;
const GROUP_TABLE = /([\w$]+)=\{\[[\w$]+\.\w+\]:\{durationMinutes:/;
const LIKELY_CHUNK = /iconTextureResolution|ItemRenderResources/;

const CACHE_KEY = 'gardenCompanion.weatherForecastSource.v1';

let trace: Record<string, unknown> = {};

export function forecastTrace(): Record<string, unknown> {
  return { ...trace, status };
}

export interface WeatherWindow {
  weatherId: string;
  startsAtMs: number;
  endsAtMs: number;
  lunar: boolean;
}

interface Source { version: string; url: string; alias: string; weathers: string; groups: string }

type Forecast = (at: Date) => Omit<WeatherWindow, 'lunar'> | null;

interface Borrowed {
  ask: Forecast;
  /** Weather ids whose group is the one the game schedules on fixed slots. */
  fixedSlot: Set<string>;
}

function gameVersion(): string {
  const sources = [
    ...Array.from(document.scripts).map(script => script.src),
    ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]')).map(link => link.href),
  ];
  for (const source of sources) {
    const found = source.match(/\/version\/([^/]+)\//);
    if (found) return found[1];
  }
  return '';
}

function candidateUrls(): string[] {
  const urls = [
    ...Array.from(document.scripts).map(script => script.src),
    ...Array.from(document.querySelectorAll<HTMLLinkElement>('link[href]')).map(link => link.href),
  ].filter(url => /\.js(\?|$)/.test(url));
  const unique = [...new Set(urls)];
  return [...unique.filter(url => LIKELY_CHUNK.test(url)), ...unique.filter(url => !LIKELY_CHUNK.test(url))];
}

function aliasOf(text: string, name: string): string {
  for (const listing of text.matchAll(/export\{([^}]*)\}/g)) {
    for (const entry of listing[1].split(',')) {
      const trimmed = entry.trim();
      if (trimmed.startsWith(`${name} as `)) return trimmed.slice(name.length + 4);
    }
  }
  return '';
}

async function findSource(): Promise<Source | null> {
  const version = gameVersion();
  const cached = loadLocal<Partial<Source>>(CACHE_KEY, {});
  if (version && cached.version === version && cached.url && cached.alias && cached.weathers && cached.groups) return cached as Source;

  for (const url of candidateUrls()) {
    let text: string;
    try { text = await (await fetch(url)).text(); } catch { continue; }
    if (!text.includes('startsAtMs')) continue;
    const shaped = text.match(SHAPE);
    if (!shaped) continue;
    const call = `return ${shaped[1]}(e,()=>!0)}`;
    const at = text.indexOf(call);
    if (at < 0) continue;
    const wrapper = text.slice(Math.max(0, at - 80), at).match(WRAPPER_NAME);
    const alias = wrapper ? aliasOf(text, wrapper[1]) : '';
    if (!alias) continue;
    const weatherTable = text.match(WEATHER_TABLE);
    const groupTable = text.match(GROUP_TABLE);
    const weathers = weatherTable ? aliasOf(text, weatherTable[1]) : '';
    const groups = groupTable ? aliasOf(text, groupTable[1]) : '';
    trace = { ...trace, url, alias, weatherVar: weatherTable?.[1] ?? '', groupVar: groupTable?.[1] ?? '', weathers, groups };
    if (!weathers || !groups) continue;
    const source = { version, url, alias, weathers, groups };
    saveLocal(CACHE_KEY, source);
    return source;
  }
  return null;
}

let forecast: Promise<Borrowed | null> | null = null;
let status: ForecastStatus = 'pending';
let retryAfter = 0;

export type ForecastStatus = 'pending' | 'ready' | 'unavailable';

export function forecastStatus(): ForecastStatus {
  void loadForecast();
  return status;
}

function loadForecast(): Promise<Borrowed | null> {
  if (forecast) return forecast;
  if (Date.now() < retryAfter) return Promise.resolve(null);
  return forecast = (async () => {
    try {
      const source = await findSource();
      if (!source) { return giveUpForNow(); }
      const module = await import(/* @vite-ignore */ source.url) as Record<string, unknown>;
      const found = module[source.alias];
      if (typeof found !== 'function') { return giveUpForNow(); }
      const fixedSlot = fixedSlotWeathers(module[source.weathers], module[source.groups]);
      trace = {
        ...trace,
        exportNames: Object.keys(module).length,
        weatherExport: typeof module[source.weathers],
        groupExport: typeof module[source.groups],
        groupKeys: Object.keys((module[source.groups] ?? {}) as object),
        fixedSlot: [...fixedSlot],
      };
      if (!fixedSlot.size) { return giveUpForNow(); }
      status = 'ready';
      return { ask: found as Forecast, fixedSlot };
    } catch { return giveUpForNow(); }
  })();
}

function giveUpForNow(): null {
  status = 'unavailable';
  retryAfter = Date.now() + 30_000;
  forecast = null;
  return null;
}

function fixedSlotWeathers(weathers: unknown, groups: unknown): Set<string> {
  const found = new Set<string>();
  const weatherTable = weathers as Record<string, { groupId?: unknown }> | undefined;
  const groupTable = groups as Record<string, { fixedTimeSlots?: unknown }> | undefined;
  if (!weatherTable || !groupTable) return found;
  const fixed = Object.entries(groupTable)
    .filter(([, group]) => Array.isArray(group?.fixedTimeSlots))
    .map(([groupId]) => groupId);
  for (const [weatherId, weather] of Object.entries(weatherTable)) {
    if (typeof weather?.groupId === 'string' && fixed.includes(weather.groupId)) found.add(weatherId);
  }
  return found;
}

let held: WeatherWindow | null = null;
let heldUntil = 0;

function askStation({ ask, fixedSlot }: Borrowed): WeatherWindow | null {
  const next = ask(new Date());
  return next ? { ...next, lunar: fixedSlot.has(next.weatherId) } : null;
}

export function nextWeather(): WeatherWindow | null {
  const now = Date.now();
  if (now < heldUntil) return held && now < held.startsAtMs ? held : null;
  void loadForecast().then(borrowed => {
    if (!borrowed) return;
    try {
      const answer = askStation(borrowed);
      held = answer && answer.startsAtMs > Date.now() ? answer : null;
      heldUntil = held ? held.startsAtMs : Date.now() + 60_000;
    } catch {
      status = 'unavailable';
      held = null;
      heldUntil = Date.now() + 60_000;
    }
  });
  return held && now < held.startsAtMs ? held : null;
}
