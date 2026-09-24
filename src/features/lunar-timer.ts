import { feature } from '../config.js';
import { LUNAR_MINIMISED_KEY, LUNAR_POSITION_KEY, UPDATE_URL } from '../constants.js';
import { makeDraggable } from '../draggable.js';
import { page } from '../page.js';
import { createTicker } from '../ticker.js';
import { escapeHtml, formatDuration, loadLocal, saveLocal, scriptVersion } from '../utils.js';
import { forecastStatus, nextWeather } from '../weather-forecast.js';
import { weatherLabel } from './weather-timer.js';

/**
 * The draggable timer widget: the next lunar event or weather, the room connection's health, and
 * the script's own update check.
 */

function nextLunarAt(now = Date.now()) {
  const date = new Date(now);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const slots = [0, 48, 96, 144, 192, 240];
  for (const day of [0, 1]) for (const slot of slots) {
    const at = midnight + day * 86400000 + slot * 300000;
    if (at > now) return at;
  }
  return midnight + 86400000;
}

/**
 * Minimised, the timer becomes an icon parked beside the Garden Overview button. The countdown
 * still ticks into its tooltip, so the panel is worth collapsing rather than turning off.
 */
let lunarMinimised = loadLocal<boolean>(LUNAR_MINIMISED_KEY, false);
/**
 * Which timer is showing. Lunar events are on fixed slots and the weather between them is not, so
 * the two answer different questions - and the panel only has room to answer one.
 */
const LUNAR_MODE_KEY = 'gardenCompanion.lunarMode.v1';
type LunarMode = 'lunar' | 'weather';
let lunarMode: LunarMode = loadLocal<LunarMode>(LUNAR_MODE_KEY, 'weather') === 'lunar' ? 'lunar' : 'weather';
/** The countdown only ticks while it is on screen; the minimised icon refreshes its tooltip on hover. */
const lunarTicker = createTicker(() => updateLunarTimer(), 1000);

function setLunarMode(mode: LunarMode): void {
  lunarMode = mode;
  saveLocal(LUNAR_MODE_KEY, mode);
  updateLunarTimer();
}

function setLunarMinimised(minimised: boolean): void {
  lunarMinimised = minimised;
  saveLocal(LUNAR_MINIMISED_KEY, minimised);
  updateLunarTimer();
}

export function updateLunarTimer(): void {
  const root = document.getElementById('gc-lunar');
  const mini = document.getElementById('gc-lunar-mini');
  if (!root) return;
  // Cinematic mode is for screenshots, so the panel and its icon both step aside - but only when
  // the player asked for it. Our own scenes claim cinematic as well, and hiding there would take
  // the timer away from the very screens it was opened alongside.
  const shown = feature('lunarTimer') && !page.__gardenCompanionCinematicFromGame?.();
  // The game is asked what is coming rather than us working it out, so there is nothing to show
  // when it has not answered yet - or cannot, which is what a game update would look like.
  const forecast = lunarMode === 'weather' ? nextWeather() : null;
  // Unavailable is a settled answer, not a slow one: the borrow reached a game that no longer
  // offers what it needs. Saying so beats a countdown that would never start moving.
  const unavailable = lunarMode === 'weather' && forecastStatus() === 'unavailable';
  // A lunar event is announced as one rather than by name: which of the two it is belongs to the
  // lunar timer, and naming it here would say more than the game's own station does at a glance.
  const label = lunarMode === 'weather'
    ? forecast ? forecast.lunar ? 'Lunar event' : weatherLabel(forecast.weatherId) : 'Next weather'
    : 'Lunar event';
  const remaining = unavailable ? 'Unavailable'
    : lunarMode === 'weather'
      ? forecast ? formatDuration(forecast.startsAtMs - Date.now())
        : forecastStatus() === 'ready' ? 'Not forecast' : '--'
      : formatDuration(nextLunarAt() - Date.now());
  const countingDown = !unavailable && (lunarMode === 'lunar' || Boolean(forecast));
  root.hidden = !shown || lunarMinimised;
  lunarTicker.sync(!root.hidden);
  const countdown = root.querySelector<HTMLElement>('.gc-lunar-countdown');
  // Marked rather than measured, so the word can be set at a size that fits where the digits sat.
  if (countdown) countdown.dataset.message = unavailable ? 'true' : '';
  root.querySelector('strong')!.textContent = remaining;
  root.querySelector('.gc-lunar-title span')!.textContent = label;
  const swap = root.querySelector<HTMLElement>('[data-swap]');
  if (swap) {
    swap.dataset.mode = lunarMode;
    // Says what the press will do rather than what the button is, since the two modes look alike
    // once the countdown is the only thing on screen.
    swap.title = lunarMode === 'weather'
      ? 'Showing the next weather event - switch to the lunar timer'
      : 'Showing the lunar timer - switch to the next weather event';
  }
  // The dial becomes the weather it is counting down to. These decode with the first pass rather
  // than the deferred one, so they are here without a panel ever being opened; onSpritesReady
  // redraws the timer for the moment between the first tick and the decode finishing.
  // Only the weather takes a sprite. A lunar event keeps the mod's dial, since its own icon would
  // give away which of the two is coming.
  const sprite = forecast && !forecast.lunar ? page.__gardenCompanionWeatherSprites?.[forecast.weatherId] || '' : '';
  const mark = root.querySelector<HTMLElement>('.gc-lunar-mark');
  if (mark) {
    mark.innerHTML = sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : '';
    // Removed rather than blanked: an empty attribute still answers to [data-weather], which would
    // strip the dial of its face and leave an empty circle behind.
    if (sprite) mark.dataset.weather = forecast!.weatherId;
    else delete mark.dataset.weather;
  }
  if (mini) {
    mini.hidden = !shown || !lunarMinimised;
    // The heading drops the "in" because the number sits under it; the tooltip is one line, so it
    // reads as a sentence - unless the value is a message, which nothing can be "in".
    mini.title = countingDown ? `${label} in ${remaining}` : `${label} - ${remaining}`;
  }
}

type SocketStatus = 'connecting' | 'connected' | 'disconnected';
let socketStatus: SocketStatus = 'connecting';
let watchedSocket: WebSocket | null = null;

function renderSocketStatus(): void {
  const indicator = document.getElementById('gc-ws-health');
  if (!indicator) return;
  indicator.dataset.status = socketStatus;
  const label = indicator.querySelector('b');
  if (label) label.textContent = socketStatus === 'connected' ? 'Connected' : socketStatus === 'connecting' ? 'Connecting' : 'Disconnected';
}

/**
 * Follows the newest room socket through its own events. Every room socket passes through the
 * constructor hook, so a reconnect hands us the replacement without anything having to poll for it.
 */
export function watchSocketHealth(socket: WebSocket): void {
  if (socket === watchedSocket) return;
  watchedSocket = socket;
  const setCurrentSocketStatus = (status: SocketStatus) => {
    if (watchedSocket !== socket) return;
    socketStatus = status;
    renderSocketStatus();
  };
  socket.addEventListener('open', () => setCurrentSocketStatus('connected'));
  socket.addEventListener('close', () => setCurrentSocketStatus('disconnected'));
  socket.addEventListener('error', () => setCurrentSocketStatus('disconnected'));
  setCurrentSocketStatus(socket.readyState === WebSocket.OPEN ? 'connected'
    : socket.readyState === WebSocket.CONNECTING ? 'connecting'
    : 'disconnected');
}

type UpdateStatus = 'checking' | 'current' | 'available' | 'failed';
let updateStatus: UpdateStatus = 'checking';
let availableVersion = '';

function versionParts(version: string): number[] {
  return version.split('.').map(part => Number.parseInt(part, 10) || 0);
}

function isNewerVersion(candidate: string, current: string): boolean {
  const next = versionParts(candidate);
  const installed = versionParts(current);
  const length = Math.max(next.length, installed.length);
  for (let index = 0; index < length; index++) {
    const difference = (next[index] ?? 0) - (installed[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function renderUpdateStatus(): void {
  const button = document.getElementById('gc-update-health') as HTMLButtonElement | null;
  if (!button) return;
  button.dataset.status = updateStatus;
  button.textContent = updateStatus === 'checking' ? 'Checking update'
    : updateStatus === 'available' ? `Update ${availableVersion}`
    : updateStatus === 'failed' ? 'Check update'
    : 'Up to date';
  button.title = updateStatus === 'available'
    ? `Install Garden Companion ${availableVersion}`
    : updateStatus === 'failed' ? 'Update check failed. Click to retry.' : 'Click to check for updates.';
}

function checkForUpdate(): void {
  updateStatus = 'checking';
  renderUpdateStatus();
  GM_xmlhttpRequest({
    method: 'GET',
    url: `${UPDATE_URL}?check=${Date.now()}`,
    headers: { 'Cache-Control': 'no-cache' },
    onload: response => {
      const match = response.responseText.match(/^\/\/\s*@version\s+([^\s]+)\s*$/m);
      availableVersion = match?.[1] ?? '';
      updateStatus = response.status >= 200 && response.status < 300 && availableVersion
        ? isNewerVersion(availableVersion, scriptVersion()) ? 'available' : 'current'
        : 'failed';
      renderUpdateStatus();
    },
    onerror: () => { updateStatus = 'failed'; renderUpdateStatus(); },
  });
}

function handleUpdateClick(): void {
  if (updateStatus === 'available') {
    window.open(UPDATE_URL, '_blank', 'noopener,noreferrer');
    return;
  }
  checkForUpdate();
}

/** Builds the widget. `onOptions` is the gear button, which opens the companion panel. */
export function mountLunarTimer(onOptions: () => void): void {
  const lunar = document.createElement('div');
  lunar.id = 'gc-lunar';
  lunar.innerHTML = '<div class="gc-lunar-head"><div class="gc-lunar-title"><i class="gc-lunar-mark"></i><span>Next lunar event</span></div><div id="gc-lunar-head-actions"><button data-swap aria-label="Switch which timer is shown"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h13l-3.5-3.5"/><path d="M20 15H7l3.5 3.5"/></svg></button><button data-minimise aria-label="Minimise the lunar timer" title="Minimise"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button><button data-options aria-label="Open Garden Companion options" title="Open Garden Companion"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/><path d="M19.1 13.5c.1-.5.1-1 0-1.5l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.3-.8L15 4.8h-4l-.4 2.5c-.5.2-.9.5-1.3.8l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 1.5l-2 1.5 2 3.4 2.4-1c.4.3.8.6 1.3.8l.4 2.5h4l.4-2.5c.5-.2.9-.5 1.3-.8l2.4 1 2-3.4-2-1.5Z"/></svg></button></div></div><div class="gc-lunar-countdown"><strong>--</strong></div><div class="gc-health"><span id="gc-ws-health" data-status="connecting"><i></i><b>Connecting</b></span><button id="gc-update-health" data-status="checking">Checking update</button></div>';
  lunar.querySelector<HTMLButtonElement>('[data-options]')!.onclick = onOptions;
  lunar.querySelector<HTMLButtonElement>('[data-minimise]')!.onclick = () => setLunarMinimised(true);
  lunar.querySelector<HTMLButtonElement>('[data-swap]')!.onclick = () => setLunarMode(lunarMode === 'lunar' ? 'weather' : 'lunar');
  lunar.querySelector<HTMLButtonElement>('#gc-update-health')!.onclick = handleUpdateClick;
  document.body.appendChild(lunar);
  makeDraggable(lunar, LUNAR_POSITION_KEY);
  const lunarMini = document.createElement('button');
  lunarMini.id = 'gc-lunar-mini';
  lunarMini.hidden = true;
  lunarMini.setAttribute('aria-label', 'Restore the lunar timer');
  lunarMini.innerHTML = '<i class="gc-lunar-mark"></i>';
  lunarMini.onclick = () => setLunarMinimised(false);
  lunarMini.onpointerenter = updateLunarTimer;
  document.body.appendChild(lunarMini);
  // Reacting to the write rather than the next tick, so entering cinematic mode is not a second of
  // the timer sitting in the shot.
  page.__gardenCompanionOnCinematicChange?.(updateLunarTimer);
  updateLunarTimer();
  renderSocketStatus();
  checkForUpdate();
  setInterval(checkForUpdate, 30 * 60 * 1000);
}
