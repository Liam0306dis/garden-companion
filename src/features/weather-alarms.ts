import { alertMuteButton, armAlarmAudio, setAlarmSilenced, showAlarmBanner, stopAlarm, updateAlarmDetail } from '../alarms.js';
import { config, saveConfig } from '../config.js';
import { page } from '../page.js';
import { serverNow, shopSecondsLeft } from '../server-clock.js';
import { state } from '../state.js';
import { escapeHtml } from '../utils.js';
import { currentWeather, weatherLabel, weatherRemainingText, WEATHER_TYPES } from './weather-timer.js';

/**
 * An alarm when a weather you are waiting for arrives.
 *
 * Only one weather runs at a time, so this is a single banner rather than the queue the shop alarms
 * deal with, and it clears itself the moment the weather ends rather than waiting to be dismissed -
 * an alarm for something that has already passed is worse than none.
 *
 * Like the shop alarms, arriving during a weather is not an arrival of it: the first report only
 * says what is running, and firing on that would sound on every reload for ten minutes. Ticking one
 * on while its weather is running fires straight away, which covers wanting to know right now.
 *
 * There is no switch over the five: a ticked weather is the switch, and none ticked is off.
 */

const OWNER = 'weather';

// --- Night ---
// The Haunt event adds a day/night cycle. Nothing in state says it is night - the client works it out
// from the clock, so this does the same (AsyncEpoch chunk: `{day:570,sunset:10,midnight:10,sunrise:10}`,
// phase = (serverTime % cycle) / cycle, starting at sunrise; its upcoming-nights list runs from sunset
// start to sunrise end).
const NIGHT = 'Night';
const NIGHT_OWNER = 'night';
const MINUTE_MS = 60_000;
/** Minutes of each phase, in the order the cycle runs from the server epoch. */
const DAY_CYCLE: Array<[NightPhase, number]> = [['sunrise', 10], ['day', 570], ['sunset', 10], ['midnight', 10]];
const CYCLE_MS = DAY_CYCLE.reduce((sum, [, minutes]) => sum + minutes, 0) * MINUTE_MS;
type NightPhase = 'sunrise' | 'day' | 'sunset' | 'midnight';

/**
 * The game has a night at all: the Haunt event is on - its `ghostCatches` is in the game state (which the
 * server may leave out until the first catch) or the player has today's `spookyQuest`. Otherwise the Night
 * row stays hidden instead of alarming for a night the game does not have.
 */
function hasNightCycle(): boolean {
  if (!state.game) return false;
  const quest = (state.slot?.data as unknown as { spookyQuest?: unknown } | undefined)?.spookyQuest;
  return 'ghostCatches' in (state.game as object) || (!!quest && typeof quest === 'object');
}

/** The phase the client shows right now and how long until it ends. */
function nightPhase(now = serverNow()): { phase: NightPhase; msLeft: number } {
  let into = ((now % CYCLE_MS) + CYCLE_MS) % CYCLE_MS;
  for (const [phase, minutes] of DAY_CYCLE) {
    const length = minutes * MINUTE_MS;
    if (into < length) return { phase, msLeft: length - into };
    into -= length;
  }
  return { phase: 'day', msLeft: 0 };
}

/** Night runs from sunset to the end of sunrise, as the client's upcoming-nights list does. */
const isNight = (phase: NightPhase) => phase !== 'day';

function nightText(): string {
  const { phase, msLeft } = nightPhase();
  const minutes = `${Math.max(1, Math.ceil(msLeft / MINUTE_MS))}m`;
  if (phase === 'sunset') return `Midnight in ${minutes}`;
  if (phase === 'midnight') return `Sunrise in ${minutes}`;
  if (phase === 'sunrise') return `Day in ${minutes}`;
  // Rounded up to whole minutes once, then split, so 1h 59.5m reads 2h 0m rather than 1h 60m.
  const totalMinutes = Math.max(1, Math.ceil(msLeft / MINUTE_MS));
  const hours = Math.floor(totalMinutes / 60);
  return `Sunset in ${hours ? `${hours}h ` : ''}${totalMinutes % 60}m`;
}

function alerts(): Record<string, boolean> {
  return config.weatherAlerts && typeof config.weatherAlerts === 'object' ? config.weatherAlerts : {};
}

function muted(): Record<string, boolean> {
  return config.weatherAlertsMuted && typeof config.weatherAlertsMuted === 'object' ? config.weatherAlertsMuted : {};
}

/** Undefined until the first report, so arriving is not mistaken for the weather starting. */
let seen: string | undefined;

function raise(weather: string): void {
  showAlarmBanner({
    owner: OWNER,
    silent: Boolean(muted()[weather]),
    label: 'WEATHER ALARM',
    title: `${weatherLabel(weather)} has started`,
    detail: weatherRemainingText(),
    icon: page.__gardenCompanionWeatherSprites?.[weather],
  });
}

/** Undefined until the first check, so arriving at night is not mistaken for night falling. */
let seenNight: boolean | undefined;

function raiseNight(): void {
  showAlarmBanner({
    owner: NIGHT_OWNER,
    silent: Boolean(muted()[NIGHT]),
    label: 'WEATHER ALARM',
    title: 'Night has fallen',
    detail: nightText(),
  });
}

function processNightAlarm(): void {
  if (!hasNightCycle()) { seenNight = undefined; return; }
  const night = isNight(nightPhase().phase);
  // A banner left up keeps counting down through sunset, midnight and sunrise.
  if (night) updateAlarmDetail(NIGHT_OWNER, nightText());
  if (night === seenNight) return;
  const first = seenNight === undefined;
  seenNight = night;
  if (!night) { stopAlarm(NIGHT_OWNER); return; }
  if (!first && alerts()[NIGHT]) raiseNight();
}

/** Called as the game reports new state, alongside the weather timer's own change tracking. */
export function processWeatherAlarms(): void {
  // Weather is on the shared game state, so an empty one is a world that has not arrived rather
  // than clear skies - and clear skies is the gap between weathers, which nothing alarms for.
  if (!state.game) return;
  processNightAlarm();
  const weather = currentWeather();
  if (weather === seen) return;
  const first = seen === undefined;
  seen = weather;
  // Whatever was running has ended, so its banner has nothing left to announce.
  stopAlarm(OWNER);
  if (first || !weather) return;
  if (alerts()[weather]) raise(weather);
}

export function toggleWeatherAlert(weather: string, enabled: boolean): void {
  const next = { ...alerts() };
  if (enabled) next[weather] = true;
  else delete next[weather];
  config.weatherAlerts = next;
  saveConfig();
  if (weather === NIGHT) {
    if (!enabled) stopAlarm(NIGHT_OWNER);
    else {
      armAlarmAudio();
      if (hasNightCycle() && isNight(nightPhase().phase)) raiseNight();
    }
    return;
  }
  if (!enabled) {
    if (currentWeather() === weather) stopAlarm(OWNER);
    return;
  }
  armAlarmAudio();
  // Ticked while it is already raining, the alarm is wanted now rather than in ten minutes.
  if (currentWeather() === weather) raise(weather);
}

/** Mutes or unmutes this weather's alarm sound, live if that weather is already sounding one. */
export function toggleWeatherAlertMuted(weather: string, isMuted: boolean): void {
  const next = { ...muted() };
  if (isMuted) next[weather] = true;
  else delete next[weather];
  config.weatherAlertsMuted = next;
  saveConfig();
  if (weather === NIGHT) setAlarmSilenced(NIGHT_OWNER, isMuted);
  else if (currentWeather() === weather) setAlarmSilenced(OWNER, isMuted);
}

/** Exact time left on the running Rain, read from its shop's restock counter (in whole minutes). */
function rainRemainingText(): string {
  const seconds = shopSecondsLeft(state.game?.shops?.rain);
  if (seconds <= 0) return weatherRemainingText();
  return `${Math.max(1, Math.ceil(seconds / 60))}m left`;
}

export function renderWeatherAlarms(): string {
  const chosen = alerts();
  const mutedNow = muted();
  const running = currentWeather();
  const rows = WEATHER_TYPES.map(weather => {
    const sprite = page.__gardenCompanionWeatherSprites?.[weather] || '';
    const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
    // Rain is not on the fixed lunar slots, so the slot estimate can only narrow it to "5m or 10m
    // left". Its shop restock counter gives the exact time, the same as every other weather shows.
    const note = running === weather ? (weather === 'Rain' ? rainRemainingText() : weatherRemainingText()) : 'Not running';
    return `<label class="gc-check"><input type="checkbox" data-weather-alert="${escapeHtml(weather)}" ${chosen[weather] ? 'checked' : ''}>`
      + `<span class="gc-shop-sprite">${icon}</span>`
      + `<span><b>${escapeHtml(weatherLabel(weather))}</b><small>${escapeHtml(note)}</small></span>`
      + alertMuteButton(`data-weather-mute="${escapeHtml(weather)}"`, Boolean(mutedNow[weather])) + '</label>';
  }).join('');
  // Night: only on a build that has one (see hasNightCycle).
  const nightRow = hasNightCycle()
    ? `<label class="gc-check"><input type="checkbox" data-weather-alert="${NIGHT}" ${chosen[NIGHT] ? 'checked' : ''}>`
      + `<span class="gc-shop-sprite"></span>`
      + `<span><b>${NIGHT}</b><small>${escapeHtml(nightText())}</small></span>`
      + alertMuteButton(`data-weather-mute="${NIGHT}"`, Boolean(mutedNow[NIGHT])) + '</label>'
    : '';
  return `<p class="gc-note">An alarm appears when a selected weather begins. Weather already running when you arrive does not sound one - tick it and the alarm fires straight away if it is running.</p>
<div class="gc-check-grid">${rows}${nightRow}</div>`;
}

/** Redraw as the weather or its countdown moves, so the running row does not go stale. */
export function weatherAlarmSignature(): string {
  const running = currentWeather();
  return `${running}|${running === 'Rain' ? rainRemainingText() : weatherRemainingText()}|${hasNightCycle() ? nightText() : ''}`;
}

export function bindWeatherAlarmEvents(main: HTMLElement): void {
  main.querySelectorAll<HTMLInputElement>('[data-weather-alert]').forEach(input => input.onchange = () => {
    toggleWeatherAlert(input.dataset.weatherAlert!, input.checked);
  });
  main.querySelectorAll<HTMLButtonElement>('[data-weather-mute]').forEach(button => button.onclick = event => {
    // The button sits inside the row's label, so its click must not also toggle the alert checkbox.
    event.preventDefault();
    event.stopPropagation();
    const isMuted = button.dataset.muted !== 'true';
    toggleWeatherAlertMuted(button.dataset.weatherMute!, isMuted);
    button.dataset.muted = String(isMuted);
    button.innerHTML = isMuted ? '&#128263;' : '&#128266;';
  });
}
