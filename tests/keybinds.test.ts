import './setup.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { config } from '../src/config.js';
import { OVERVIEW_SHORTCUT_KEY } from '../src/constants.js';
import { beginKeybindCapture, claimKeybind, initKeybinds } from '../src/keybinds.js';
import { page } from '../src/page.js';
import { setPanelActions } from '../src/panel-actions.js';

const press = (init: KeyboardEventInit) => window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

test('a combo belongs to one action: claiming it releases it everywhere else', () => {
  claimKeybind('interface:seedShop', 'K');
  claimKeybind('team:alpha', 'K');
  assert.equal(config.interfaceKeybinds.seedShop, undefined);
  assert.equal(config.teamKeybinds.alpha, 'K');
  claimKeybind('overview', 'K');
  assert.equal(config.teamKeybinds.alpha, undefined);
  assert.equal(localStorage.getItem(OVERVIEW_SHORTCUT_KEY), 'K');
  claimKeybind('interface:toolShop', 'K');
  assert.equal(localStorage.getItem(OVERVIEW_SHORTCUT_KEY), null);
});

test('the overview hears about its shortcut changing', () => {
  const heard: string[] = [];
  page.__gardenCompanionOverviewShortcutChanged = shortcut => { heard.push(shortcut); };
  claimKeybind('overview', 'Ctrl+O');
  claimKeybind('overview', '');
  assert.deepEqual(heard, ['Ctrl+O', '']);
});

test('recording: modifiers alone wait, Escape clears', () => {
  claimKeybind('interface:eggShop', 'E');
  const input = document.createElement('input');
  document.body.appendChild(input);
  beginKeybindCapture(input, 'interface:eggShop', 'Press keys... Esc clears');
  assert.equal(input.value, 'Press keys... Esc clears');
  press({ key: 'Shift', shiftKey: true });
  assert.equal(config.interfaceKeybinds.eggShop, 'E', 'a lone modifier is not a combo');
  press({ key: 'Escape' });
  assert.equal(config.interfaceKeybinds.eggShop, undefined);
  beginKeybindCapture(input, 'interface:eggShop', 'Press keys...');
  press({ key: 'g', ctrlKey: true });
  assert.equal(config.interfaceKeybinds.eggShop, 'Ctrl+G');
  input.remove();
});

test('a bound key toggles the panel, but not while typing in a field', () => {
  let toggles = 0;
  const notReady = () => { throw new Error('unexpected'); };
  setPanelActions({ renderPanel: notReady, renderPanelPreservingScroll: notReady, refreshOpenPanel: notReady, cancelPanelRefresh: notReady, openPanel: notReady, closePanel: notReady, activeTab: () => '', togglePanel: () => { toggles++; } });
  initKeybinds();
  claimKeybind('interface:companionPanel', 'Alt+G');
  press({ key: 'g', altKey: true });
  assert.equal(toggles, 1);
  const field = document.createElement('input');
  document.body.appendChild(field);
  field.focus();
  press({ key: 'g', altKey: true });
  assert.equal(toggles, 1);
  field.remove();
});
