import { config, saveConfig } from '../config.js';
import type { JotaiAtom, SkySettings } from '../types.js';
import { findAtom } from '../atom-cache.js';
import { gameStore } from '../game-store.js';
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
 * is not in use. Night is tuned through the game's own night grade (nightGradeSettingsAtom: how far
 * night darkens, how strongly it tints, and the tint colours), written through the store the game
 * publishes as window.__jotaiStore. Brightness, contrast, saturation, warmth and hue are a CSS filter
 * on the game's canvas, which leaves the panels alone.
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

interface NightGrade {
  brightness: number;
  contrast: number;
  color: number;
  sunsetColor: number;
  sunriseColor: number;
  colorOpacity: number;
  [key: string]: number;
}


let gradeAtom: JotaiAtom | null = null;
/** The game's own grade, taken before anything here changes it, so every setting scales from it. */
let baseGrade: NightGrade | null = null;
let gradeTouched = false;
/** The grade last written, so a store that dropped it (a reload of the game's state) is noticed. */
let writtenGrade: NightGrade | null = null;

function gradeReady(): boolean {
  if (baseGrade && gradeAtom) return true;
  const store = gameStore();
  gradeAtom ??= findAtom('nightGradeSettingsAtom');
  if (!store || !gradeAtom) return false;
  const value = store.get(gradeAtom) as Partial<NightGrade> | undefined;
  if (!value || typeof value.brightness !== 'number' || typeof value.colorOpacity !== 'number') return false;
  baseGrade = { ...value } as NightGrade;
  return true;
}

/** The guard name the night grade's writes and watcher share, so one failing switches both off. */
const NIGHT_GRADE = 'Night lighting';

/** Whether the night controls can work on this build (it publishes its store and has a night grade). */
export function nightGradeAvailable(): boolean {
  return !hookDisabled(NIGHT_GRADE) && guarded(NIGHT_GRADE, gradeReady, false);
}

const hexToNumber = (hex: string, fallback: number) => /^#[0-9a-f]{6}$/i.test(hex) ? parseInt(hex.slice(1), 16) : fallback;
const numberToHex = (value: number) => `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`;

/**
 * Night darkness scales the grade's darkening (its brightness and contrast pull) and night colour
 * its tint opacity, both from the game's own values - so 80% is simply a fifth lighter, in the same
 * colour, and the crop and lamp glows stay as they are. Back at the defaults the game's grade is put
 * back as it was.
 */
function applyNightGrade(): void {
  guarded(NIGHT_GRADE, writeNightGrade, undefined);
}

function writeNightGrade(): void {
  if (!gradeReady()) return;
  const sky = skySettings();
  const store = gameStore()!;
  const base = baseGrade!;
  const changed = sky.night !== 100 || sky.nightColour !== 100 || sky.nightTint || sky.sunsetTint || sky.sunriseTint;
  if (!changed) {
    if (gradeTouched) { store.set(gradeAtom!, { ...base }); gradeTouched = false; writtenGrade = null; }
    gradeWatch.stop();
    return;
  }
  const darkness = Math.max(0, sky.night) / 100;
  // Every field is checked to be a number, so a grade the game reshapes is left alone, not corrupted.
  if (!['brightness', 'contrast', 'colorOpacity', 'color', 'sunsetColor', 'sunriseColor'].every(key => Number.isFinite(base[key]))) return;
  store.set(gradeAtom!, writtenGrade = {
    ...base,
    brightness: base.brightness * darkness,
    contrast: base.contrast * darkness,
    colorOpacity: Math.min(1, base.colorOpacity * Math.max(0, sky.nightColour) / 100),
    color: hexToNumber(sky.nightTint, base.color),
    sunsetColor: hexToNumber(sky.sunsetTint, base.sunsetColor),
    sunriseColor: hexToNumber(sky.sunriseTint, base.sunriseColor),
  });
  gradeTouched = true;
  gradeWatch.start();
}

/** While a night setting is in use, put it back if the game's state replaces the grade under it. */
const gradeWatch = createTicker(() => guarded(NIGHT_GRADE, () => {
  const store = gameStore();
  if (gradeTouched && store && gradeAtom && store.get(gradeAtom) !== writtenGrade) writeNightGrade();
}, undefined), 5000);

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
  const sky = skySettings();
  if (sky.night !== 100 || sky.nightColour !== 100 || sky.nightTint || sky.sunsetTint || sky.sunriseTint) {
    retryUntil(() => { applyNightGrade(); return gradeTouched; }, 'the night lighting');
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
  const base = baseGrade;
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
${colourInput('nightTint', 'Night tint', sky.nightTint, base?.color, !grade)}
${colourInput('sunsetTint', 'Sunset tint', sky.sunsetTint, base?.sunsetColor, !grade)}
${colourInput('sunriseTint', 'Sunrise tint', sky.sunriseTint, base?.sunriseColor, !grade)}
</div>${grade ? '' : '<p class="gc-note">The night settings need a game build with its night grade and store (1604 or later).</p>'}</section>
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
