import { config, feature, saveConfig } from './config.js';
import { OVERVIEW_SHORTCUT_KEY } from './constants.js';
import { activeTeamIds, applyPetTeam, teams } from './features/pet-teams.js';
import { GAME_INTERFACES, openGameInterface } from './game-atoms.js';
import { send } from './game-connection.js';
import { page } from './page.js';
import { panelActions } from './panel-actions.js';
import { toast } from './toast.js';
import { escapeHtml } from './utils.js';

/**
 * Every keyboard shortcut: capturing them, storing them, and the tab that lists them. A combo can
 * only belong to one action, so claiming one clears it from wherever it was.
 */
export const PLANNER_KEY = { id: 'layoutPlanner', label: 'Layout planner' };
export const CROP_CLEANSER_KEY = { id: 'cropCleanserHelper', label: 'Crop Cleanser Helper' };

export const TEAM_CYCLE_KEYS = [
  { id: 'teamCycleNext', label: 'Next pet team', step: 1 },
  { id: 'teamCyclePrevious', label: 'Previous pet team', step: -1 },
] as const;

let activeCapture: (() => void) | null = null;
export function initKeybinds(): void {
  installShortcutListener();
}

function refreshVisibleKeybindInputs(): void {
  document.querySelectorAll<HTMLInputElement>('#gc-panel [data-team-key]').forEach(field => {
    field.value = config.teamKeybinds[field.dataset.teamKey!] || '';
  });
  document.querySelectorAll<HTMLInputElement>('#gc-panel [data-interface-key]').forEach(field => {
    field.value = config.interfaceKeybinds[field.dataset.interfaceKey!] || '';
  });
  document.querySelectorAll<HTMLInputElement>('#gc-panel [data-overview-key]').forEach(field => {
    field.value = localStorage.getItem(OVERVIEW_SHORTCUT_KEY) || '';
  });
}
export function claimKeybind(owner: string, combo: string): void {
  const [kind, id = ''] = owner.split(':', 2);
  if (kind === 'team') delete config.teamKeybinds[id];
  if (kind === 'interface') delete config.interfaceKeybinds[id];
  let overviewShortcutChanged: string | null = null;
  if (owner === 'overview') {
    localStorage.removeItem(OVERVIEW_SHORTCUT_KEY);
    overviewShortcutChanged = '';
  }

  if (combo) {
    for (const key of Object.keys(config.interfaceKeybinds)) {
      if (config.interfaceKeybinds[key] === combo) delete config.interfaceKeybinds[key];
    }
    for (const key of Object.keys(config.teamKeybinds)) {
      if (config.teamKeybinds[key] === combo) delete config.teamKeybinds[key];
    }
    if (owner !== 'overview' && localStorage.getItem(OVERVIEW_SHORTCUT_KEY) === combo) {
      localStorage.removeItem(OVERVIEW_SHORTCUT_KEY);
      overviewShortcutChanged = '';
    }
    if (kind === 'team') config.teamKeybinds[id] = combo;
    if (kind === 'interface') config.interfaceKeybinds[id] = combo;
    if (owner === 'overview') {
      localStorage.setItem(OVERVIEW_SHORTCUT_KEY, combo);
      overviewShortcutChanged = combo;
    }
  }

  saveConfig();
  refreshVisibleKeybindInputs();
  if (overviewShortcutChanged !== null) page.__gardenCompanionOverviewShortcutChanged?.(overviewShortcutChanged);
}

function comboFromEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(event.key.length === 1 ? event.key.toUpperCase() : event.key);
  return parts.join('+');
}

export function isTyping() {
  const element = document.activeElement;
  return Boolean(element && (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName) || (element as HTMLElement).isContentEditable));
}

function installShortcutListener(): void {
  window.addEventListener('keydown', event => {
  if (isTyping() || event.repeat) return;
  const combo = comboFromEvent(event);
  if (config.interfaceKeybinds.companionPanel === combo) {
    event.preventDefault(); event.stopPropagation();
    panelActions.togglePanel();
    return;
  }
  if (config.interfaceKeybinds[CROP_CLEANSER_KEY.id] === combo) {
    event.preventDefault(); event.stopPropagation();
    page.__gardenCompanionToggleCropCleanser?.();
    return;
  }
  const gameInterface = feature('interfaceShortcuts')
    ? GAME_INTERFACES.find(item => config.interfaceKeybinds[item.id] === combo)
    : undefined;
  if (gameInterface) {
    event.preventDefault(); event.stopPropagation();
    openGameInterface(gameInterface.id);
    return;
  }
  if (!feature('petTeams')) return;
  if (config.interfaceKeybinds[PLANNER_KEY.id] === combo) {
    event.preventDefault(); event.stopPropagation();
    page.__gardenCompanionTogglePlanner?.();
    return;
  }
  const cycle = TEAM_CYCLE_KEYS.find(item => config.interfaceKeybinds[item.id] === combo);
  if (cycle) {
    event.preventDefault(); event.stopPropagation();
    cyclePetTeam(cycle.step);
    return;
  }
  const team = teams().find(item => config.teamKeybinds[item.id] === combo);
  if (!team) return;
  event.preventDefault(); event.stopPropagation();
  applyPetTeam(team.id);
  toast(`Switching to ${team.name}.`, 'success');
  }, true);
}

let lastCycledTeamId: string | null = null;

/**
 * Teams are identified by which pets are out, so cycling cannot rely on that alone. Two teams with
 * the same pets are indistinguishable, and immediately after a swap the server has yet to apply,
 * the pets still describe the previous team. The team we last moved to therefore wins whenever it
 * is still a valid reading of the pets out, and stands in when they match no team at all.
 */
export function cyclePetTeam(step: number): void {
  const list = teams();
  if (!list.length) {
    toast('No saved pet teams to cycle.', 'error');
    return;
  }
  const active = activeTeamIds();
  const from = lastCycledTeamId && (active.includes(lastCycledTeamId) || !active.length)
    ? lastCycledTeamId
    : active[0] ?? lastCycledTeamId;
  const current = from ? list.findIndex(team => team.id === from) : -1;
  const next = list[(((current < 0 ? -step : current + step) % list.length) + list.length) % list.length];
  if (!next) return;
  lastCycledTeamId = next.id;
  applyPetTeam(next.id);
  toast(`Switching to ${next.name}.`, 'success');
}



export function renderKeybinds() {
  const shortcutRow = (label: string, attribute: string, value: string) => `<label class="gc-shortcut-row"><b>${escapeHtml(label)}</b><input readonly ${attribute} value="${escapeHtml(value)}" placeholder="Click, then press keys"></label>`;
  const interfaces = [
    shortcutRow('Garden Companion', 'data-interface-key="companionPanel"', config.interfaceKeybinds.companionPanel || ''),
    shortcutRow('Garden Overview', 'data-overview-key', localStorage.getItem(OVERVIEW_SHORTCUT_KEY) || ''),
    ...GAME_INTERFACES.map(item => shortcutRow(item.label, `data-interface-key="${item.id}"`, config.interfaceKeybinds[item.id] || '')),
  ].join('');
  const teamCycling = TEAM_CYCLE_KEYS.map(item => shortcutRow(item.label, `data-interface-key="${item.id}"`, config.interfaceKeybinds[item.id] || '')).join('');
  const planner = shortcutRow(PLANNER_KEY.label, `data-interface-key="${PLANNER_KEY.id}"`, config.interfaceKeybinds[PLANNER_KEY.id] || '');
  const cropCleanser = shortcutRow(CROP_CLEANSER_KEY.label, `data-interface-key="${CROP_CLEANSER_KEY.id}"`, config.interfaceKeybinds[CROP_CLEANSER_KEY.id] || '');
  const teamRows = teams().map(team => shortcutRow(team.name, `data-team-key="${escapeHtml(team.id)}"`, config.teamKeybinds[team.id] || '')).join('');
  return `<p class="gc-note">Click a field, then press the keys you want. Press Escape while recording to clear it. A combination can only belong to one action, so reusing one releases it from the other.</p>
<section class="gc-card gc-shortcuts"><h3>Interfaces</h3><p>Open these from anywhere in a loaded room.</p><div class="gc-shortcut-grid">${interfaces}${planner}${cropCleanser}</div></section>
<section class="gc-card gc-shortcuts"><h3>Pet team cycling</h3><p>Step through your saved teams in order, wrapping at both ends.</p><div class="gc-shortcut-grid">${teamCycling}</div></section>
<section class="gc-card gc-shortcuts"><h3>Pet teams</h3><p>Activate a saved team directly.</p>${teamRows ? `<div class="gc-shortcut-grid">${teamRows}</div>` : '<p class="gc-empty">No saved teams yet.</p>'}</section>`;
}

export function beginKeybindCapture(input: HTMLInputElement, owner: string, prompt: string): void {
  activeCapture?.();
  input.value = prompt;
  const capture = (event: KeyboardEvent) => {
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    cancel();
    claimKeybind(owner, event.key === 'Escape' ? '' : comboFromEvent(event));
    input.blur();
  };
  const cancel = () => {
    window.removeEventListener('keydown', capture, true);
    input.removeEventListener('blur', cancel);
    if (activeCapture === cancel) activeCapture = null;
  };
  activeCapture = cancel;
  window.addEventListener('keydown', capture, true);
  input.addEventListener('blur', cancel, { once: true });
}

/** Drops any in-progress capture, so a redraw cannot leave a listener attached to a dead input. */
export function cancelKeybindCapture(): void {
  activeCapture?.();
}

export function bindKeybindEvents(main: HTMLElement): void {
  main.querySelectorAll<HTMLInputElement>('[data-team-key]').forEach(input => {
    input.onclick = () => beginKeybindCapture(input, `team:${input.dataset.teamKey}`, 'Press keys... Esc cancels');
  });
  main.querySelectorAll<HTMLInputElement>('[data-interface-key]').forEach(input => {
    input.onclick = () => beginKeybindCapture(input, `interface:${input.dataset.interfaceKey}`, 'Press keys...');
  });
  main.querySelectorAll<HTMLInputElement>('[data-overview-key]').forEach(input => {
    input.onclick = () => beginKeybindCapture(input, 'overview', 'Press keys...');
  });
}
