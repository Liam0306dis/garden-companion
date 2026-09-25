import type { AlarmSoundSettings, CompanionAlarmOptions } from './types.js';
import { config, feature } from './config.js';
import { page } from './page.js';
import { toast } from './toast.js';
import { escapeHtml } from './utils.js';

/**
 * The alarm banner and its tone. Any feature can raise one, so this owns nothing shop-specific:
 * alarms are keyed by an `owner` string and only one shows at a time, the rest queue behind it.
 */

let alarm: { timer: ReturnType<typeof setInterval> | null; options: CompanionAlarmOptions } | null = null;
const alarmQueue: CompanionAlarmOptions[] = [];
let alarmAudioContext: AudioContext | null = null;
let alarmPhase = 0;

/**
 * The far-right speaker button shared by every alert row. It toggles whether that one alert makes a
 * sound; the banner still appears either way. `dataAttr` carries the row's own key so the feature
 * binding it knows which alert was clicked.
 */
export function alertMuteButton(dataAttr: string, muted: boolean): string {
  const title = muted ? 'Alarm sound muted for this alert. Click to unmute.' : 'Alarm sound on for this alert. Click to mute.';
  return `<button type="button" class="gc-alert-mute" data-muted="${muted}" ${dataAttr} title="${escapeHtml(title)}" aria-label="Toggle alarm sound">${muted ? '&#128263;' : '&#128266;'}</button>`;
}

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

/**
 * The tone belongs to the whole stack of alarms, not the one banner on top: as long as a single
 * outstanding alarm (showing or queued behind it) is unmuted, it sounds. So a muted alarm sitting on
 * top of unmuted ones still rings for them, and a stack that is muted through and through is silent.
 */
function anyUnmutedAlarm(): boolean {
  return Boolean(alarm && !alarm.options.silent) || alarmQueue.some(options => !options.silent);
}

function maybePlayAlarmTone(): void {
  if (anyUnmutedAlarm()) playAlarmTone();
}

/** Retunes a pending alarm's sound after the player mutes or unmutes that alert while it is up. */
export function setAlarmSilenced(owner: string, silent: boolean): void {
  if (alarm?.options.owner === owner) alarm.options.silent = silent;
  for (const options of alarmQueue) if (options.owner === owner) options.silent = silent;
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

/**
 * The built-in sounds. Each step is one 420ms tick of the alarm timer and a 0 is a rest, so the
 * pattern repeats for as long as the banner is up. `level` evens out how loud each waveform reads -
 * a square wave at the same gain as a sine is far harsher.
 *
 * A step given as [from, to] glides between the two over its length. `hold` keeps the note at full
 * volume until it ends instead of letting it ring away, which is what makes a buzzer or a siren
 * sound continuous rather than struck. `detune` adds a second voice that many cents off, and the
 * beating between the two is the rasp of a buzzer.
 */
type AlarmStep = number | [number, number];
export const ALARM_PRESETS: Record<string, { label: string; wave: OscillatorType; steps: AlarmStep[]; length: number; level: number; hold?: boolean; detune?: number }> = {
  classic: { label: 'Classic', wave: 'sine', steps: [880, 660, 880, 660, 0], length: .38, level: 1 },
  chime: { label: 'Chime', wave: 'triangle', steps: [1047, 1319, 1568, 0, 0, 0], length: .9, level: 1.3 },
  beep: { label: 'Soft beep', wave: 'sine', steps: [660, 0, 660, 0, 0, 0], length: .25, level: .8 },
  buzzer: { label: 'Buzzer', wave: 'sawtooth', steps: [110, 110, 0], length: .36, level: .55, hold: true, detune: 40 },
  // Each step runs slightly past its tick so the next one starts before it has let go, and the
  // wail up and down reads as one unbroken sweep.
  siren: { label: 'Siren', wave: 'triangle', steps: [[620, 1150], [1150, 620]], length: .44, level: 1.4, hold: true },
};

/** Longest custom file kept, both on disk and in playback, so a stray song cannot become the alarm. */
export const CUSTOM_SOUND_MAX_BYTES = 1024 * 1024;
export const CUSTOM_SOUND_MAX_SECONDS = 10;
/**
 * Kept apart from the main config: that is rewritten on every toggle anywhere in the panel, and
 * dragging a megabyte of audio through each of those saves would be waste.
 */
const CUSTOM_SOUND_KEY = 'gardenCompanion.alarmSound.v1';

export interface CustomAlarmSound { name: string; data: string }

let customBuffer: AudioBuffer | null = null;
let customLoading: Promise<AudioBuffer | null> | null = null;
let customSource: AudioBufferSourceNode | null = null;
let customEndsAt = 0;

export function alarmSoundSettings(): AlarmSoundSettings {
  const saved: Partial<AlarmSoundSettings> = config.alarmSound && typeof config.alarmSound === 'object' ? config.alarmSound : {};
  const number = (value: unknown, fallback: number, min: number, max: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  const preset = typeof saved.preset === 'string' && (saved.preset === 'custom' || ALARM_PRESETS[saved.preset]) ? saved.preset : 'classic';
  return { preset, volume: number(saved.volume, 60, 0, 100), pitch: Math.round(number(saved.pitch, 0, -12, 12)) };
}

export function savedCustomSound(): CustomAlarmSound | null {
  let saved: unknown = null;
  try { saved = GM_getValue(CUSTOM_SOUND_KEY, null); }
  catch {
    try { saved = JSON.parse(localStorage.getItem(CUSTOM_SOUND_KEY) || 'null'); } catch {}
  }
  const sound = saved as CustomAlarmSound | null;
  return sound && typeof sound.name === 'string' && typeof sound.data === 'string' ? sound : null;
}

function writeCustomSound(sound: CustomAlarmSound | null): void {
  try { GM_setValue(CUSTOM_SOUND_KEY, sound); }
  catch { localStorage.setItem(CUSTOM_SOUND_KEY, JSON.stringify(sound)); }
}

function base64Bytes(data: string): ArrayBuffer {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

function bytesBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}

/** Decoded once and kept; the saved copy is only the file's bytes, which every alarm would re-decode. */
function loadCustomSound(context: AudioContext): Promise<AudioBuffer | null> {
  if (customBuffer) return Promise.resolve(customBuffer);
  if (customLoading) return customLoading;
  const sound = savedCustomSound();
  if (!sound) return Promise.resolve(null);
  customLoading = context.decodeAudioData(base64Bytes(sound.data))
    .then(buffer => (customBuffer = buffer))
    .catch(() => null)
    .finally(() => { customLoading = null; });
  return customLoading;
}

/**
 * The first ten seconds of a sound as a mono 22kHz WAV - about 440KB at most, whatever went in.
 * Resampled through an offline context, which also mixes the channels down.
 */
async function trimmedWav(buffer: AudioBuffer): Promise<{ bytes: ArrayBuffer; buffer: AudioBuffer }> {
  const rate = 22050;
  const length = Math.ceil(Math.min(buffer.duration, CUSTOM_SOUND_MAX_SECONDS) * rate);
  const Offline = (page.OfflineAudioContext as typeof OfflineAudioContext | undefined) || OfflineAudioContext;
  const offline = new Offline(1, length, rate);
  const source = offline.createBufferSource();
  source.buffer = buffer;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0);
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); text(8, 'WAVE');
  text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let index = 0; index < samples.length; index++) view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, samples[index])) * 0x7fff, true);
  return { bytes, buffer: rendered };
}

/**
 * Checks and stores a file the player picked. Decoding it here is the format check: whatever the
 * browser can play is accepted, and anything it cannot is refused with a reason rather than saved
 * and left to fail silently at the next alarm.
 *
 * A file that is short and small is kept as it came. Anything longer or larger is cut to its first
 * ten seconds and re-encoded, so a whole song is accepted rather than refused. Resolves true when
 * the sound was trimmed.
 */
export async function setCustomAlarmSound(file: File): Promise<boolean> {
  // Only a guard against decoding something enormous; what is saved is capped far below this.
  if (file.size > 50 * 1024 * 1024) throw new Error('That file is over 50 MB. Pick a smaller one.');
  const context = armAlarmAudio();
  if (!context) throw new Error('This browser has no audio support.');
  let bytes = await file.arrayBuffer();
  let buffer: AudioBuffer;
  // decodeAudioData detaches what it is handed, so it gets a copy and the original is what is saved.
  try { buffer = await context.decodeAudioData(bytes.slice(0)); }
  catch { throw new Error('That file could not be played. Try an MP3, WAV, OGG or M4A.'); }
  const trimmed = buffer.duration > CUSTOM_SOUND_MAX_SECONDS + .05;
  if (trimmed || bytes.byteLength > CUSTOM_SOUND_MAX_BYTES) {
    try { ({ bytes, buffer } = await trimmedWav(buffer)); }
    catch { throw new Error('That sound could not be shortened. Try a shorter file.'); }
  }
  try { writeCustomSound({ name: file.name, data: bytesBase64(bytes) }); }
  catch { throw new Error('The sound could not be saved - storage is full.'); }
  stopCustomSound();
  customBuffer = buffer;
  return trimmed;
}

export function clearCustomAlarmSound(): void {
  stopCustomSound();
  writeCustomSound(null);
  customBuffer = null;
}

function stopCustomSound(): void {
  try { customSource?.stop(); } catch {}
  customSource = null;
  customEndsAt = 0;
}

/** Everything a preview has scheduled, so a newer preview can cut it off instead of playing over it. */
let previewNodes: OscillatorNode[] = [];

function stopPreview(): void {
  for (const node of previewNodes) { try { node.stop(); } catch {} }
  previewNodes = [];
}

function presetTone(context: AudioContext, at: number, step: AlarmStep, settings: AlarmSoundSettings, preview = false): void {
  const preset = ALARM_PRESETS[settings.preset] || ALARM_PRESETS.classic;
  const level = .25 * preset.level * settings.volume / 60;
  if (!level) return;
  const shift = 2 ** (settings.pitch / 12);
  const [from, to] = Array.isArray(step) ? step : [step, step];
  const end = at + preset.length;
  const gain = context.createGain();
  gain.connect(context.destination);
  if (preset.hold) {
    // A few milliseconds in and out, or the square edges of a held note click.
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(level, at + .008);
    gain.gain.setValueAtTime(level, end - .02);
    gain.gain.linearRampToValueAtTime(0, end);
  } else {
    gain.gain.setValueAtTime(level, at);
    gain.gain.exponentialRampToValueAtTime(.001, end);
  }
  for (const cents of preset.detune ? [0, preset.detune] : [0]) {
    const oscillator = context.createOscillator();
    oscillator.type = preset.wave;
    oscillator.detune.value = cents;
    oscillator.connect(gain);
    oscillator.frequency.setValueAtTime(from * shift, at);
    if (to !== from) oscillator.frequency.linearRampToValueAtTime(to * shift, end);
    oscillator.start(at); oscillator.stop(end + .02);
    if (preview) previewNodes.push(oscillator);
  }
}

/** Pitch on a file is its playback rate, so it runs faster as it goes higher, like a record would. */
function playCustom(context: AudioContext, buffer: AudioBuffer, settings: AlarmSoundSettings): void {
  stopCustomSound();
  const rate = 2 ** (settings.pitch / 12);
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  gain.gain.value = settings.volume / 100;
  source.connect(gain); gain.connect(context.destination);
  const length = Math.min(buffer.duration, CUSTOM_SOUND_MAX_SECONDS);
  source.start(context.currentTime, 0, length);
  source.onended = () => { if (customSource === source) customSource = null; };
  customSource = source;
  customEndsAt = context.currentTime + length / rate;
}

function alarmTone(context: AudioContext): void {
  const settings = alarmSoundSettings();
  if (settings.preset === 'custom') {
    if (customBuffer) {
      // A file is played through, then again after a short gap, rather than restarted every tick.
      if (context.currentTime >= customEndsAt + .3) playCustom(context, customBuffer, settings);
      return;
    }
    // Still decoding (or the file has gone): the classic tone covers the gap so the alarm is never silent.
    void loadCustomSound(context);
  }
  const preset = ALARM_PRESETS[settings.preset] || ALARM_PRESETS.classic;
  const step = preset.steps[alarmPhase++ % preset.steps.length];
  if (step) presetTone(context, context.currentTime, step, settings);
}

/**
 * One pass of the chosen sound, for the settings tab. Each call replaces the last rather than
 * joining it, so nudging a slider several times never stacks previews on top of each other.
 */
export async function previewAlarmSound(): Promise<void> {
  const context = armAlarmAudio();
  if (!context) return;
  stopPreview();
  stopCustomSound();
  if (context.state !== 'running') await context.resume().catch(() => undefined);
  const settings = alarmSoundSettings();
  if (settings.preset === 'custom') {
    const buffer = await loadCustomSound(context);
    if (buffer) playCustom(context, buffer, settings);
    return;
  }
  // The pattern twice through, less its trailing rest, so it sounds the way the alarm will.
  const preset = ALARM_PRESETS[settings.preset] || ALARM_PRESETS.classic;
  const steps = [...preset.steps, ...preset.steps];
  while (steps.length && !steps[steps.length - 1]) steps.pop();
  steps.forEach((step, index) => { if (step) presetTone(context, context.currentTime + index * .42, step, settings, true); });
}

function clearActiveAlarm(): void {
  if (alarm?.timer) clearInterval(alarm.timer);
  stopCustomSound();
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
  if (actionButton && options.onAction) {
    actionButton.onclick = async () => {
      // An action that throws part way (a buy loop losing its connection) must not leave the button
      // stuck on its busy label with the alarm still ringing.
      try { await options.onAction?.(actionButton); }
      catch (error) {
        actionButton.disabled = false;
        actionButton.textContent = options.actionLabel ?? '';
        toast((error as Error).message || 'The action failed.', 'error');
      }
    };
  }
  alarmPhase = 0;
  // The timer runs while any alarm is up; each tick decides whether to sound, so a muted banner on
  // top still rings for unmuted alarms queued behind it, and later arrivals start it sounding again.
  alarm = { timer: null, options };
  maybePlayAlarmTone();
  alarm.timer = setInterval(maybePlayAlarmTone, 420);
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
