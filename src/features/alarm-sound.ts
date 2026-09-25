import { ALARM_PRESETS, alarmSoundSettings, clearCustomAlarmSound, CUSTOM_SOUND_MAX_SECONDS, previewAlarmSound, savedCustomSound, setCustomAlarmSound } from '../alarms.js';
import { config, saveConfig } from '../config.js';
import { toast } from '../toast.js';
import type { AlarmSoundSettings } from '../types.js';
import { escapeHtml } from '../utils.js';

/**
 * One sound for every alarm - shop, weather and hunger alike. The per-alert mute buttons still
 * decide whether a given alarm sounds at all; this only decides what it sounds like.
 */

function saveSettings(change: Partial<AlarmSoundSettings>): void {
  config.alarmSound = { ...alarmSoundSettings(), ...change };
  saveConfig();
}

const pitchText = (pitch: number): string => (pitch > 0 ? `+${pitch}` : String(pitch));

export function renderAlarmSound(): string {
  const settings = alarmSoundSettings();
  const custom = savedCustomSound();
  const options = Object.entries(ALARM_PRESETS).map(([id, preset]) => [id, preset.label]);
  if (custom) options.push(['custom', 'Custom file']);
  return `<p class="gc-note">Every alarm uses this sound. The speaker button on each alert still mutes that one alert.</p>
<section class="gc-card gc-alarm-sound"><h3>Sound</h3>
<select data-alarm-preset>${options.map(([id, label]) => `<option value="${id}" ${id === settings.preset ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}</select>
<label class="gc-value-size"><span>Volume<b data-alarm-volume-value>${settings.volume}%</b></span><input type="range" min="0" max="100" step="5" value="${settings.volume}" data-alarm-volume></label>
<label class="gc-value-size"><span>Pitch<b data-alarm-pitch-value>${pitchText(settings.pitch)}</b><i>semitones</i></span><input type="range" min="-12" max="12" step="1" value="${settings.pitch}" data-alarm-pitch></label>
<button class="gc-primary" data-alarm-preview>Play preview</button></section>
<section class="gc-card gc-launch-row"><div><h3>Custom sound</h3><p>${custom ? `Using <b>${escapeHtml(custom.name)}</b>.` : `MP3, WAV, OGG or M4A. Anything over ${CUSTOM_SOUND_MAX_SECONDS} seconds is trimmed to its start.`} It repeats until the alarm is stopped.</p></div>
<div class="gc-alarm-file-actions">${custom ? '<button class="gc-danger" data-alarm-remove>Remove</button>' : ''}<button data-alarm-upload>${custom ? 'Replace' : 'Choose file'}</button></div>
<input type="file" accept="audio/*" hidden data-alarm-file></section>`;
}

export function bindAlarmSoundEvents(main: HTMLElement, rerender: () => void): void {
  const preset = main.querySelector<HTMLSelectElement>('[data-alarm-preset]');
  if (!preset) return;
  preset.onchange = () => { saveSettings({ preset: preset.value }); void previewAlarmSound(); };
  // A slider only previews once it has been let go and left alone for a moment: some browsers fire
  // change for every step of a drag, and a sound per step is a pile-up rather than a preview.
  let previewTimer: ReturnType<typeof setTimeout> | null = null;
  const previewSoon = () => {
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => { previewTimer = null; void previewAlarmSound(); }, 300);
  };
  const volume = main.querySelector<HTMLInputElement>('[data-alarm-volume]')!;
  const volumeValue = main.querySelector<HTMLElement>('[data-alarm-volume-value]')!;
  volume.oninput = () => { volumeValue.textContent = `${volume.value}%`; };
  volume.onchange = () => { saveSettings({ volume: Number(volume.value) }); previewSoon(); };
  const pitch = main.querySelector<HTMLInputElement>('[data-alarm-pitch]')!;
  const pitchValue = main.querySelector<HTMLElement>('[data-alarm-pitch-value]')!;
  pitch.oninput = () => { pitchValue.textContent = pitchText(Number(pitch.value)); };
  pitch.onchange = () => { saveSettings({ pitch: Number(pitch.value) }); previewSoon(); };
  main.querySelector<HTMLButtonElement>('[data-alarm-preview]')!.onclick = () => { void previewAlarmSound(); };
  const file = main.querySelector<HTMLInputElement>('[data-alarm-file]')!;
  main.querySelector<HTMLButtonElement>('[data-alarm-upload]')!.onclick = () => file.click();
  file.onchange = async () => {
    const picked = file.files?.[0];
    file.value = '';
    if (!picked) return;
    try {
      const trimmed = await setCustomAlarmSound(picked);
      // Picking a file is choosing it, so it becomes the sound straight away.
      saveSettings({ preset: 'custom' });
      toast(trimmed ? `Custom alarm sound saved - trimmed to its first ${CUSTOM_SOUND_MAX_SECONDS} seconds.` : 'Custom alarm sound saved.', 'success');
      rerender();
      void previewAlarmSound();
    } catch (error) {
      toast((error as Error).message, 'error');
    }
  };
  main.querySelector<HTMLButtonElement>('[data-alarm-remove]')?.addEventListener('click', () => {
    clearCustomAlarmSound();
    if (alarmSoundSettings().preset === 'custom') saveSettings({ preset: 'classic' });
    rerender();
  });
}
