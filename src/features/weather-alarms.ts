import { alertMuteButton, armAlarmAudio, setAlarmSilenced, showAlarmBanner, stopAlarm } from '../alarms.js';
import { config, saveConfig } from '../config.js';
import { page } from '../page.js';
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
  });
}

/** Called as the game reports new state, alongside the weather timer's own change tracking. */
export function processWeatherAlarms(): void {
  // Weather is on the shared game state, so an empty one is a world that has not arrived rather
  // than clear skies - and clear skies is the gap between weathers, which nothing alarms for.
  if (!state.game) return;
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
  if (currentWeather() === weather) setAlarmSilenced(OWNER, isMuted);
}

export function renderWeatherAlarms(): string {
  const chosen = alerts();
  const mutedNow = muted();
  const running = currentWeather();
  const rows = WEATHER_TYPES.map(weather => {
    const sprite = page.__gardenCompanionWeatherSprites?.[weather] || '';
    const icon = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
    const note = running === weather ? weatherRemainingText() : 'Not running';
    return `<label class="gc-check"><input type="checkbox" data-weather-alert="${escapeHtml(weather)}" ${chosen[weather] ? 'checked' : ''}>`
      + `<span class="gc-shop-sprite">${icon}</span>`
      + `<span><b>${escapeHtml(weatherLabel(weather))}</b><small>${escapeHtml(note)}</small></span>`
      + alertMuteButton(`data-weather-mute="${escapeHtml(weather)}"`, Boolean(mutedNow[weather])) + '</label>';
  }).join('');
  return `<p class="gc-note">An alarm appears when a selected weather begins. Weather already running when you arrive does not sound one - tick it and the alarm fires straight away if it is running.</p>
<div class="gc-check-grid">${rows}</div>`;
}

/** Redraw as the weather or its countdown moves, so the running row does not go stale. */
export function weatherAlarmSignature(): string {
  return `${currentWeather()}|${weatherRemainingText()}`;
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
