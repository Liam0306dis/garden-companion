import { config, saveConfig } from '../config.js';
import type { SkySettings } from '../types.js';
import { page } from '../page.js';
import { retryUntil } from '../retry.js';
import { createTicker } from '../ticker.js';
import { guarded, hookDisabled } from '../safe-hook.js';
import { escapeHtml } from '../utils.js';

/**
 * Lighting tab: keep a weather or a time of day on screen for good, and tune how the game looks.
 *
 * Nothing here reaches the server. The weather and time are swapped in the frame context the scene
 * draws from - the planner owns that hook and asks this module what to show whenever its own preview
 * is not in use. Night is tuned in the game's own night grade (how far night darkens, how strongly it
 * tints, and the tint colours) as its dayNight system hands it to the night filter each frame - see
 * the Night grade section. Brightness, contrast, saturation, warmth and hue are a CSS filter on the
 * game's canvas, which leaves the panels alone.
 */

export const SKY_WEATHERS: ReadonlyArray<[id: string, label: string]> = [
  ['live', 'Live'], ['clear', 'Clear'], ['Rain', 'Rain'], ['Frost', 'Snow'], ['Thunderstorm', 'Storm'], ['Dawn', 'Dawn'], ['AmberMoon', 'Amber'],
];
export const SKY_TIMES: ReadonlyArray<[id: string, label: string]> = [
  ['live', 'Live'], ['day', 'Day'], ['sunset', 'Sunset'], ['midnight', 'Night'], ['sunrise', 'Sunrise'],
];

/** Colours left empty mean the game's own. */
const DEFAULT_SKY: SkySettings = {
  weather: 'live', time: 'live',
  night: 100, nightColour: 100, glow: 100, nightTint: '', sunsetTint: '', sunriseTint: '',
  brightness: 100, contrast: 100, saturation: 100, warmth: 0, hue: 0,
};
const LIGHTING_KEYS = ['night', 'nightColour', 'glow', 'nightTint', 'sunsetTint', 'sunriseTint', 'brightness', 'contrast', 'saturation', 'warmth', 'hue'] as const;

/**
 * Read on every draw - the frame hook asks for the weather and phase each time any of the game's
 * systems reads them - so the merged settings are kept rather than rebuilt per read, and only
 * refreshed when they are saved here.
 */
let cached: SkySettings | null = null;

export function skySettings(): SkySettings {
  if (cached) return cached;
  const saved = config.sky && typeof config.sky === 'object' ? config.sky as Partial<SkySettings> : {};
  return cached = { ...DEFAULT_SKY, ...saved };
}

/** `persist` is off while a slider is being dragged: the screen follows every step, storage the release. */
function saveSky(next: Partial<SkySettings>, persist = true): void {
  config.sky = { ...skySettings(), ...next };
  cached = null;
  if (persist) saveConfig();
  applySkyFilter();
  applyNightGrade();
  for (const listener of listeners) listener();
}

const listeners = new Set<() => void>();
/** Called whenever a sky setting changes, so the planner can install or keep its frame hook. */
export function onSkyChange(listener: () => void): void {
  listeners.add(listener);
}

/** Whether the planner's scene hooks are needed: a locked weather or time, or glow changed. */
export function skyNeedsFrameHook(): boolean {
  const sky = skySettings();
  return sky.weather !== 'live' || sky.time !== 'live' || sky.glow !== 100;
}

/** How much to scale night glows (decor lights and crops) by, 1 at the default. */
export function glowScale(): number {
  return Math.max(0, skySettings().glow) / 100;
}

function lightingChanged(sky: SkySettings): boolean {
  return LIGHTING_KEYS.some(key => sky[key] !== DEFAULT_SKY[key]);
}

/** The weather to draw: the locked one, or the real one passed through. */
export function skyWeather(real: unknown): unknown {
  const { weather } = skySettings();
  if (weather === 'live') return real;
  return weather === 'clear' ? null : weather;
}

// The day cycle (dayNight chunk `{day:210,sunset:10,midnight:10,sunrise:10}`, starting at sunrise).
// Kept in step with garden-planner.ts and weather-alarms.ts, which copy the same cycle.
// check-bundle compares DAY_CYCLE against the live bundle.
const DAY_CYCLE: ReadonlyArray<[stage: string, minutes: number]> = [['sunrise', 10], ['day', 210], ['sunset', 10], ['midnight', 10]];
const CYCLE = DAY_CYCLE;
const TOTAL = CYCLE.reduce((sum, [, minutes]) => sum + minutes, 0);
const stageEnd = (stage: string) => {
  let end = 0;
  for (const [name, minutes] of CYCLE) { end += minutes; if (name === stage) break; }
  return end / TOTAL;
};
const SUNRISE_END = stageEnd('sunrise');
const SUNSET_START = stageEnd('day');
const SUNSET_END = stageEnd('sunset');
const STAGE_MIDDLE: Record<string, number> = (() => {
  const middles: Record<string, number> = {};
  let start = 0;
  for (const [stage, minutes] of CYCLE) {
    middles[stage] = (start + minutes / 2) / TOTAL;
    start += minutes;
  }
  return middles;
})();

/** The stage of the day cycle a phase falls in, named as the game names them. */
export function stageAt(phase: number): 'sunrise' | 'day' | 'sunset' | 'midnight' {
  const p = ((phase % 1) + 1) % 1;
  return p < SUNRISE_END ? 'sunrise' : p < SUNSET_START ? 'day' : p < SUNSET_END ? 'sunset' : 'midnight';
}

/** The phase to draw: the middle of the locked stage, or the real phase passed through. */
export function skyPhase(real: number): number {
  const { time } = skySettings();
  return time !== 'live' && STAGE_MIDDLE[time] != null ? STAGE_MIDDLE[time] : real;
}

// --- Night grade ---
//
// Build 2151 removed nightGradeSettingsAtom: the dayNight system now reads a hardcoded grade
// (`{brightness:-71,contrast:-45,color:674293,sunsetColor:14811332,sunriseColor:674293,...}`) and
// hands its filter the result each frame, as `filter.setToneCurve(gain, lift)` and
// `filter.setColor(color, opacity)`. So the night settings now rewrite those two calls on the
// captured dayNight system (page.__gardenCompanionFarmSystems.dayNight). check-bundle watches the
// calls and the colour literal below.

/** The game's night tint colours, the defaults behind any tint left empty here. */
export const GAME_NIGHT_COLOURS = { color: 674293, sunsetColor: 14811332, sunriseColor: 674293 } as const;

/** The guard name every night-grade wrapper shares, so one failing switches them all off. */
const NIGHT_GRADE = 'Night lighting';
const NIGHT_PATCHED = '__gcNightGradePatched';

type NightFilter = { setToneCurve: (gain: number, lift: number) => unknown; setColor: (color: number, opacity: number) => unknown } & Record<string, unknown>;

function dayNightSystem(): Record<string, any> | null {
  const system = page.__gardenCompanionFarmSystems?.dayNight as Record<string, any> | null | undefined;
  return system && typeof system.draw === 'function' ? system : null;
}

function nightFilterOf(system: Record<string, any>): NightFilter | null {
  const filter = system.filter as NightFilter | undefined;
  return filter && typeof filter.setToneCurve === 'function' && typeof filter.setColor === 'function' ? filter : null;
}

function nightTuned(sky = skySettings()): boolean {
  return sky.night !== 100 || sky.nightColour !== 100 || !!sky.nightTint || !!sky.sunsetTint || !!sky.sunriseTint;
}

/** Whether the night controls can work on this build (its dayNight system was caught, with a filter to tune). */
export function nightGradeAvailable(): boolean {
  return !hookDisabled(NIGHT_GRADE) && guarded(NIGHT_GRADE, () => {
    const system = dayNightSystem();
    return !!system && !!nightFilterOf(system);
  }, false);
}

const hexToNumber = (hex: string, fallback: number) => /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : fallback;
const numberToHex = (value: number) => `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`;

/** The game's colour blend: each channel moved `t` of the way from `a` to `b`, rounded. */
export function mixColour(a: number, b: number, t: number): number {
  const channel = (shift: number) => {
    const from = (a >> shift) & 255;
    return Math.round(from + (((b >> shift) & 255) - from) * t);
  };
  return (channel(16) << 16) | (channel(8) << 8) | channel(0);
}

/**
 * How dark the night is at a phase, 0 by day to 1 at midnight, as the game works it out: falling
 * through sunrise, 0 all day, rising through sunset.
 */
export function nightStrength(phase: number): number {
  const p = ((phase % 1) + 1) % 1;
  if (p < SUNRISE_END) return 1 - p / SUNRISE_END;
  if (p < SUNSET_START) return 0;
  if (p < SUNSET_END) return (p - SUNSET_START) / (SUNSET_END - SUNSET_START);
  return 1;
}

/**
 * Night darkness scales the darkening the game asks for, and keeps its shape: the game's gain and
 * lift are each a blend from no change (1 and 0) towards the grade, so scaling that blend is the same
 * as scaling the grade's brightness and contrast, which is what this did through the old atom.
 * Null when there is nothing to change, so the game's own values go through untouched.
 */
export function tunedToneCurve(gain: number, lift: number, sky = skySettings()): [number, number] | null {
  const darkness = Math.max(0, sky.night) / 100;
  if (darkness === 1) return null;
  return [1 + (gain - 1) * darkness, lift * darkness];
}

/**
 * Tint strength scales the opacity the game asks for. A tint colour replaces the game's in its own
 * blend: night colour towards the sunset or sunrise colour, most strongly midway through the change.
 */
export function tunedNightColour(color: number, opacity: number, phase: unknown, sky = skySettings()): [number, number] | null {
  const strength = Math.max(0, sky.nightColour) / 100;
  const tinted = !!(sky.nightTint || sky.sunsetTint || sky.sunriseTint);
  if (strength === 1 && !tinted) return null;
  let colour = color;
  if (tinted && typeof phase === 'number' && Number.isFinite(phase)) {
    const p = ((phase % 1) + 1) % 1;
    const t = nightStrength(p);
    const edge = p > 0.5
      ? hexToNumber(sky.sunsetTint, GAME_NIGHT_COLOURS.sunsetColor)
      : hexToNumber(sky.sunriseTint, GAME_NIGHT_COLOURS.sunriseColor);
    colour = mixColour(hexToNumber(sky.nightTint, GAME_NIGHT_COLOURS.color), edge, 4 * t * (1 - t));
  }
  return [colour, opacity * strength];
}

/**
 * Wraps the dayNight system's draw (to know the phase it draws) and its filter's two calls. Once in,
 * the wrappers stay: at the default settings they pass the game's values straight through. A rebuilt
 * system (a reconnect) is a new object, caught by the watcher below. True once patched.
 */
export function patchNightGrade(): boolean {
  const system = dayNightSystem();
  const filter = system && nightFilterOf(system);
  if (!system || !filter) return false;
  if (system[NIGHT_PATCHED] === filter) return true;
  system[NIGHT_PATCHED] = filter;
  // The frame is kept, not its phase: a locked time of day is only swapped in while the scene draws,
  // which the filter calls are inside, so the phase is read there.
  if (!system.__gcNightDrawPatched) {
    system.__gcNightDrawPatched = true;
    const draw = system.draw;
    system.draw = function(this: unknown, ...args: unknown[]) {
      system.__gcNightFrame = args[0] && typeof args[0] === 'object' ? args[0] : null;
      return draw.apply(this, args);
    };
  }
  const { setToneCurve, setColor } = filter;
  filter.setToneCurve = function(this: unknown, gain: number, lift: number) {
    const tuned = guarded(NIGHT_GRADE, () => tunedToneCurve(gain, lift), null);
    return tuned ? setToneCurve.call(this, tuned[0], tuned[1]) : setToneCurve.call(this, gain, lift);
  };
  filter.setColor = function(this: unknown, color: number, opacity: number) {
    const tuned = guarded(NIGHT_GRADE, () => tunedNightColour(color, opacity, system.__gcNightFrame?.dayNightPhase01), null);
    return tuned ? setColor.call(this, tuned[0], tuned[1]) : setColor.call(this, color, opacity);
  };
  return true;
}

/** Takes effect on the next frame the game draws night; nothing to put back at the defaults. */
function applyNightGrade(): void {
  if (!nightTuned()) { gradeWatch.stop(); return; }
  guarded(NIGHT_GRADE, patchNightGrade, false);
  gradeWatch.start();
}

/** While a night setting is in use, catch a dayNight system the game rebuilt. */
const gradeWatch = createTicker(() => { guarded(NIGHT_GRADE, patchNightGrade, false); }, 5000);

// --- Canvas filter ---

let filterStyle: HTMLStyleElement | null = null;

/** The canvas filter for the display sliders; removed entirely at the defaults. */
export function applySkyFilter(): void {
  const { brightness, contrast, saturation, warmth, hue } = skySettings();
  const parts = [
    brightness !== 100 ? `brightness(${brightness / 100})` : '',
    contrast !== 100 ? `contrast(${contrast / 100})` : '',
    saturation !== 100 ? `saturate(${saturation / 100})` : '',
    warmth ? `sepia(${warmth / 100})` : '',
    hue ? `hue-rotate(${hue}deg)` : '',
  ].filter(Boolean);
  if (!parts.length) { filterStyle?.remove(); filterStyle = null; return; }
  if (!filterStyle) {
    filterStyle = document.createElement('style');
    filterStyle.id = 'gc-sky-filter';
    (document.head || document.documentElement).appendChild(filterStyle);
  }
  filterStyle.textContent = `.QuinoaCanvas canvas { filter: ${parts.join(' ')}; }`;
}

export function initSky(): void {
  applySkyFilter();
  // The store and the atom arrive with the game, so a saved night setting is applied once they do.
  if (nightTuned()) {
    retryUntil(() => guarded(NIGHT_GRADE, patchNightGrade, false), 'the night lighting');
    gradeWatch.start();
  }
}

// --- Tab ---

/** Each button's icon, from the game's own weather and time artwork. */
const CHOICE_ICONS: Record<string, string> = {
  clear: 'skyClear', Rain: 'Rain', Frost: 'Frost', Thunderstorm: 'Thunderstorm', Dawn: 'Dawn', AmberMoon: 'AmberMoon',
  day: 'skyDay', sunset: 'skySunset', midnight: 'Night', sunrise: 'skySunrise',
};

function choiceButtons(key: 'weather' | 'time', choices: ReadonlyArray<[string, string]>, current: string): string {
  return choices.map(([id, text]) => {
    const sprite = page.__gardenCompanionWeatherSprites?.[CHOICE_ICONS[id] ?? ''] || '';
    const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
    return `<button data-sky-${key}="${escapeHtml(id)}" class="${id === current ? 'active' : ''}">${icon}<span>${escapeHtml(text)}</span></button>`;
  }).join('');
}

type SliderKey = 'night' | 'nightColour' | 'glow' | 'brightness' | 'contrast' | 'saturation' | 'warmth' | 'hue';
const SLIDER_UNITS: Record<SliderKey, string> = { night: '%', nightColour: '%', glow: '%', brightness: '%', contrast: '%', saturation: '%', warmth: '%', hue: '°' };

function slider(key: SliderKey, label: string, min: number, max: number, value: number, note = '', disabled = false): string {
  return `<label class="gc-sky-slider" data-disabled="${disabled}"${note ? ` title="${escapeHtml(note)}"` : ''}><span class="gc-sky-slider-head"><b>${label}</b><em data-sky-value="${key}">${value}${SLIDER_UNITS[key]}</em></span>`
    + `<input type="range" min="${min}" max="${max}" step="5" value="${value}" data-sky-slider="${key}" ${disabled ? 'disabled' : ''}></label>`;
}

function colourInput(key: 'nightTint' | 'sunsetTint' | 'sunriseTint', label: string, value: string, fallback: number | undefined, disabled: boolean): string {
  const shown = value || (fallback != null ? numberToHex(fallback) : '#000000');
  return `<label class="gc-sky-colour"><input type="color" value="${escapeHtml(shown)}" data-sky-colour="${key}" ${disabled ? 'disabled' : ''}><span>${label}${value ? '' : '<small>game default</small>'}</span></label>`;
}

const labelOf = (choices: ReadonlyArray<[string, string]>, id: string) => choices.find(([choice]) => choice === id)?.[1] ?? id;

/** One line saying what is on screen now, so a lock left on is never a mystery. */
function statusLine(sky: SkySettings): string {
  const locks = [
    sky.weather !== 'live' ? labelOf(SKY_WEATHERS, sky.weather) : '',
    sky.time !== 'live' ? labelOf(SKY_TIMES, sky.time) : '',
  ].filter(Boolean);
  const tuned = lightingChanged(sky);
  if (!locks.length && !tuned) return '<b>Live</b><span>Showing the real weather and time.</span>';
  return `<b>${escapeHtml(locks.length ? locks.join(' · ') : 'Live')}</b><span>${tuned ? 'Lighting adjusted.' : 'Only on your screen.'}</span>`
    + '<button data-sky-live>Back to live</button>';
}

export function renderSky(): string {
  const sky = skySettings();
  const grade = nightGradeAvailable();
  const base = GAME_NIGHT_COLOURS;
  return `<section class="gc-card gc-sky-status" data-locked="${skyNeedsFrameHook() || lightingChanged(sky)}">${statusLine(sky)}</section>
<section class="gc-card gc-sky-card"><h3>Scene</h3>
<div class="gc-sky-row"><span>Weather</span><div class="gc-sky-choices">${choiceButtons('weather', SKY_WEATHERS, sky.weather)}</div></div>
<div class="gc-sky-row"><span>Time</span><div class="gc-sky-choices">${choiceButtons('time', SKY_TIMES, sky.time)}</div></div>
<p class="gc-note">Only on your screen: alarms, timers and mutations follow the real weather and time. Time of day needs the game's day/night cycle.</p></section>
<section class="gc-card gc-sky-card"><div class="gc-sky-card-head"><h3>Night</h3></div>
<div class="gc-sky-sliders gc-sky-sliders-3">
${slider('night', 'Darkness', 0, 150, sky.night, 'How far night darkens. Glows stay full.', !grade)}
${slider('nightColour', 'Tint strength', 0, 150, sky.nightColour, 'How strongly night is tinted.', !grade)}
${slider('glow', 'Glow', 0, 300, sky.glow, 'How brightly lamps, lanterns and glowing crops shine at night, up to full strength.')}
</div>
<div class="gc-sky-colours">
${colourInput('nightTint', 'Night tint', sky.nightTint, base.color, !grade)}
${colourInput('sunsetTint', 'Sunset tint', sky.sunsetTint, base.sunsetColor, !grade)}
${colourInput('sunriseTint', 'Sunrise tint', sky.sunriseTint, base.sunriseColor, !grade)}
</div>${grade ? '' : "<p class=\"gc-note\">The night settings appear once the game's day/night system has loaded.</p>"}</section>
<section class="gc-card gc-sky-card"><div class="gc-sky-card-head"><h3>Display</h3><button data-sky-reset>Reset lighting</button></div>
<div class="gc-sky-sliders gc-sky-sliders-3">
${slider('brightness', 'Brightness', 50, 150, sky.brightness)}
${slider('contrast', 'Contrast', 50, 150, sky.contrast)}
${slider('saturation', 'Saturation', 0, 200, sky.saturation)}
${slider('warmth', 'Warmth', 0, 100, sky.warmth)}
${slider('hue', 'Hue', -180, 180, sky.hue)}
</div></section>`;
}

export function bindSkyEvents(main: HTMLElement, rerender: () => void): void {
  for (const key of ['weather', 'time'] as const) {
    main.querySelectorAll<HTMLButtonElement>(`[data-sky-${key}]`).forEach(button => button.onclick = () => {
      saveSky({ [key]: button.getAttribute(`data-sky-${key}`) || 'live' });
      rerender();
    });
  }
  main.querySelectorAll<HTMLInputElement>('[data-sky-slider]').forEach(input => {
    const key = input.dataset.skySlider as SliderKey;
    input.oninput = () => {
      const value = Number(input.value);
      saveSky({ [key]: value }, false);
      const label = main.querySelector<HTMLElement>(`[data-sky-value="${key}"]`);
      if (label) label.textContent = `${value}${SLIDER_UNITS[key]}`;
    };
    // Saved once released, and let go of, so the keys that walk the player do not keep nudging it.
    // A click that leaves the value where it was fires no change, so the release lets go as well.
    input.addEventListener('change', () => {
      saveSky({ [key]: Number(input.value) });
      input.blur();
      rerender();
    });
    input.addEventListener('pointerup', () => input.blur());
  });
  main.querySelectorAll<HTMLInputElement>('[data-sky-colour]').forEach(input => {
    const key = input.dataset.skyColour as 'nightTint' | 'sunsetTint' | 'sunriseTint';
    input.oninput = () => saveSky({ [key]: input.value }, false);
    input.addEventListener('change', () => { saveSky({ [key]: input.value }); rerender(); });
  });
  const live = main.querySelector<HTMLButtonElement>('[data-sky-live]');
  if (live) live.onclick = () => {
    saveSky({ ...DEFAULT_SKY });
    rerender();
  };
  const reset = main.querySelector<HTMLButtonElement>('[data-sky-reset]');
  if (reset) reset.onclick = () => {
    saveSky(Object.fromEntries(LIGHTING_KEYS.map(key => [key, DEFAULT_SKY[key]])) as Partial<SkySettings>);
    rerender();
  };
}
