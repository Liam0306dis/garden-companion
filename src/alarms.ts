import type { CompanionAlarmOptions } from './types.js';
import { config, feature } from './config.js';
import { page } from './page.js';
import { escapeHtml } from './utils.js';

/**
 * The alarm banner and its tone. Any feature can raise one, so this owns nothing shop-specific:
 * alarms are keyed by an `owner` string and only one shows at a time, the rest queue behind it.
 */

let alarm: { timer: ReturnType<typeof setInterval> | null; options: CompanionAlarmOptions } | null = null;
const alarmQueue: CompanionAlarmOptions[] = [];
let alarmAudioContext: AudioContext | null = null;
let alarmPhase = 0;

export function armAlarmAudio(): AudioContext | null {
  try {
    if (!alarmAudioContext) {
      const AudioConstructor = page.AudioContext as typeof AudioContext || (page as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioConstructor) return null;
      alarmAudioContext = new AudioConstructor({ latencyHint: 'interactive' });
    }
    if (alarmAudioContext.state !== 'running') void alarmAudioContext.resume().catch(() => undefined);
    return alarmAudioContext;
  } catch {
    return null;
  }
}

function playAlarmTone(): void {
  const context = armAlarmAudio();
  if (!context) return;
  const play = () => {
    if (context.state === 'running') alarmTone(context);
  };
  if (context.state === 'running') play();
  else void context.resume().then(play).catch(() => undefined);
}

function alarmTone(context: AudioContext): void {
  const now = context.currentTime;
  const frequency = [880, 660, 880, 660, 0][alarmPhase++ % 5];
  if (!frequency) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = 'sine';
  oscillator.connect(gain); gain.connect(context.destination);
  oscillator.frequency.setValueAtTime(frequency, now);
  gain.gain.setValueAtTime(.25, now);
  gain.gain.exponentialRampToValueAtTime(.001, now + .38);
  oscillator.start(now); oscillator.stop(now + .4);
}

function clearActiveAlarm(): void {
  if (alarm?.timer) clearInterval(alarm.timer);
  document.getElementById('gc-alarm')?.remove();
  alarm = null;
}

/**
 * The queue line keeps its space when empty rather than being removed from the flow, so the banner
 * is the same size and its buttons sit in the same place whether one item alarmed or five did.
 */
function updateAlarmQueueCount(): void {
  const count = document.querySelector<HTMLElement>('#gc-alarm [data-alarm-queue]');
  if (!count) return;
  count.style.visibility = alarmQueue.length ? 'visible' : 'hidden';
  count.textContent = alarmQueue.length === 1 ? '1 more alarm queued' : `${alarmQueue.length} more alarms queued`;
}

export function updateAlarmDetail(owner: string, detail: string): void {
  for (const options of alarmQueue) if (options.owner === owner) options.detail = detail;
  if (alarm?.options.owner !== owner) return;
  alarm.options.detail = detail;
  const element = document.querySelector<HTMLElement>('#gc-alarm [data-alarm-detail]');
  if (element) element.textContent = detail;
}

function dismissCurrentAlarm(): void {
  clearActiveAlarm();
  const next = alarmQueue.shift();
  if (next) renderAlarmBanner(next);
}

export function stopAlarm(owner?: string): void {
  if (!owner) {
    alarmQueue.length = 0;
    clearActiveAlarm();
    return;
  }
  for (let index = alarmQueue.length - 1; index >= 0; index--) {
    if (alarmQueue[index].owner === owner) alarmQueue.splice(index, 1);
  }
  if (alarm?.options.owner === owner) {
    clearActiveAlarm();
    const next = alarmQueue.shift();
    if (next) renderAlarmBanner(next);
  } else updateAlarmQueueCount();
}

function renderAlarmBanner(options: CompanionAlarmOptions): void {
  const banner = document.createElement('div');
  banner.id = 'gc-alarm';
  const detail = options.detail ? `<span data-alarm-detail>${escapeHtml(options.detail)}</span>` : '';
  const action = options.actionLabel ? `<button data-buy>${escapeHtml(options.actionLabel)}</button>` : '';
  banner.innerHTML = `<i class="gc-alarm-icon">!</i><div><small>${escapeHtml(options.label)}</small><strong>${escapeHtml(options.title)}</strong>${detail}<em data-alarm-queue></em></div>${action}<button data-stop>Stop alarm</button>`;
  document.body.appendChild(banner);
  banner.querySelector<HTMLButtonElement>('[data-stop]')!.onclick = dismissCurrentAlarm;
  const actionButton = banner.querySelector<HTMLButtonElement>('[data-buy]');
  if (actionButton && options.onAction) actionButton.onclick = event => { void options.onAction?.(event.currentTarget as HTMLButtonElement); };
  alarmPhase = 0;
  playAlarmTone();
  alarm = { timer: setInterval(playAlarmTone, 420), options };
  updateAlarmQueueCount();
}

export function showAlarmBanner(options: CompanionAlarmOptions): void {
  if (alarm) {
    alarmQueue.push(options);
    updateAlarmQueueCount();
    return;
  }
  renderAlarmBanner(options);
}

/**
 * Browsers only allow audio after a gesture, so every click and keypress is treated as consent to
 * arm the context. Without this the first alarm of a session would be silent.
 */
export function installAlarms(): void {
  // Any feature that can raise a banner has to arm the audio, or its alarm shows up silent.
  // Read straight off the config rather than through the weather module, which imports this one.
  const wantsAlarms = () => feature('shopAlarms') || feature('petHungerAlarm')
    || Object.values(config.weatherAlerts || {}).some(Boolean);
  page.addEventListener('pointerdown', () => { if (wantsAlarms()) armAlarmAudio(); }, true);
  page.addEventListener('keydown', () => { if (wantsAlarms()) armAlarmAudio(); }, true);
  page.__gardenCompanionArmAlarm = armAlarmAudio;
  page.__gardenCompanionStopAlarm = stopAlarm;
  page.__gardenCompanionShowAlarm = showAlarmBanner;
}
