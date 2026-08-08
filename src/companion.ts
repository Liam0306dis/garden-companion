import type {
  CompanionPage,
  FullState,
  GameState,
  Pet,
  PlayerSlot,
  RoomState,
} from './types.js';
import { config, feature, pruneStaleConfig, saveConfig } from './config.js';
import {
  ABILITY_DETAILS,
  GRANTER_CHANCES,
  LUNAR_MINIMISED_KEY,
  LUNAR_POSITION_KEY,
  PASSIVE_REQUIRED_WEATHER,
  PET_CATALOG,
  PROC_RULES,
  STACKED_PASSIVE_BY_ABILITY,
  TRACKED_ABILITY_CATALOG,
  UPDATE_URL,
  XP_PER_POTION,
} from './constants.js';
import { bindCalculatorEvents, calculatorsSignature, renderCalculators } from './features/calculators.js';
import { installAlarms } from './alarms.js';
import { worldSceneActive } from './world-scene.js';
import { send } from './game-connection.js';
import { abilityChips } from './ability-chips.js';
import { installCropEstimates, renderTurtleOverlay } from './features/crop-estimates.js';
import { bindPetFoodEvents, positionPetFood, renderPetFood, renderPetFoodTab, resetPetFoodSignature } from './features/pet-food.js';
import {
  abilityLogUiState,
  bindAbilityLogEvents,
  processActivities,
  renderAbilityLog,
  setAbilityFilterInteracting,
  setAbilityFilterMenuOpen,
} from './features/ability-log.js';
import { bindJournalEvents, journalSignature, renderJournal } from './features/journal.js';
import { bindRoomEvents, renderRooms } from './features/rooms.js';
import { installAtomHooks, installGameModalAccess } from './game-atoms.js';
import { bindKeybindEvents, cancelKeybindCapture, claimKeybind, initKeybinds, isTyping, renderKeybinds } from './keybinds.js';
import { makeDraggable } from './draggable.js';
import { bindListSearch } from './list-search.js';
import { page } from './page.js';
import { setPanelActions } from './panel-actions.js';
import { installPixiCapture } from './pixi.js';
import {
  allPets,
  formatEstimate,
  heldProduce,
  heldToolCount,
  hungerDisplay,
  petMetrics,
  petSprite,
  teamXpPerHour,
  useXpPotion,
} from './pets.js';
import {
  closeTeamPicker,
  bindPetTeamEvents,
  refreshCompletedTeamDelete,
  refreshCompletedTeamSave,
  refreshTeamActiveMarkers,
  renderTeams,
  teams,
  teamsSignature,
} from './features/pet-teams.js';
import { bindShopEvents, processShops, renderShops } from './features/shop-alarms.js';
import { toast } from './toast.js';
import { state } from './state.js';
import { escapeHtml, formatDuration, humanize, loadLocal, saveLocal } from './utils.js';

export function initCompanion(): void {
  'use strict';

  pruneStaleConfig();
  setPanelActions({
    renderPanel, renderPanelPreservingScroll, refreshOpenPanel, cancelPanelRefresh,
    openPanel, togglePanel, closePanel, activeTab: () => activeTab,
  });
  installAlarms();

  page.__gardenCompanionClaimKeybind = claimKeybind;

  (window as unknown as CompanionPage).__gardenCompanionFeature = feature;
  page.__gardenCompanionFeature = feature;
  page.__gardenCompanionConfig = () => config;

  let gameUpdateDetected = false;
  function handleGameUpdateDetected(source: string): void {
    if (gameUpdateDetected) return;
    gameUpdateDetected = true;
    console.info(`[Garden Companion] Game update detected from ${source}.`);
    if (!feature('autoRefreshGameUpdates')) {
      toast('Game update available. Reload the page when ready.', 'error');
      return;
    }
    toast('Game update detected. Refreshing in 5 seconds.', 'success');
    setTimeout(() => page.location.reload(), 5_000);
  }

  function handleGameSocketClose(event: CloseEvent): void {
    if (event.code === 4710 || event.reason.toLowerCase() === 'version expired') handleGameUpdateDetected('WebSocket');
  }

  function installGameUpdateSocketDetector(): void {
    const OriginalWebSocket = page.WebSocket as typeof WebSocket;
    const GardenCompanionWebSocket = function(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
      const socket = new OriginalWebSocket(...args);
      socket.addEventListener('close', handleGameSocketClose);
      return socket;
    } as unknown as typeof WebSocket;
    Object.setPrototypeOf(GardenCompanionWebSocket, OriginalWebSocket);
    GardenCompanionWebSocket.prototype = OriginalWebSocket.prototype;
    page.WebSocket = GardenCompanionWebSocket;
  }

  installGameUpdateSocketDetector();

  function installBackgroundMode(): void {
    if (!feature('backgroundMode')) return;
    try {
      const documentPrototype = Object.getPrototypeOf(page.document);
      Object.defineProperty(documentPrototype, 'hidden', { configurable: true, get: () => false });
      Object.defineProperty(documentPrototype, 'visibilityState', { configurable: true, get: () => 'visible' });
      page.document.hasFocus = () => true;
    } catch (error) {
      console.warn('[Garden Companion] Could not install background visibility mode.', error);
    }
    const keepVisible = (event: Event) => event.stopImmediatePropagation();
    page.document.addEventListener('visibilitychange', keepVisible, true);
    page.addEventListener('blur', keepVisible, true);
    page.addEventListener('focus', keepVisible, true);

    let audioContext: AudioContext | null = null;
    const startSilentAudio = () => {
      if (!feature('backgroundMode')) return;
      if (audioContext) {
        if (audioContext.state !== 'running') void audioContext.resume();
        return;
      }
      try {
        const AudioConstructor = page.AudioContext as typeof AudioContext || (page as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioConstructor) return;
        audioContext = new AudioConstructor({ latencyHint: 'interactive' });
        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();
        oscillator.frequency.value = 1;
        gain.gain.value = 0.00001;
        oscillator.connect(gain).connect(audioContext.destination);
        oscillator.start();
      } catch (error) {
        console.warn('[Garden Companion] Could not start background audio context.', error);
      }
    };
    page.addEventListener('pointerdown', startSilentAudio, true);
    page.addEventListener('keydown', startSilentAudio, true);
  }

  installBackgroundMode();

  function readPlayerId(): string | null {
    try {
      let value = new URL(page.MagicCircle_RoomConnection?.currentWebSocket?.url || '').searchParams.get('playerId');
      if (value?.startsWith('"')) value = JSON.parse(value);
      return value || null;
    } catch { return null; }
  }

  function pickSlot(game: GameState | null, room: RoomState | null, playerId: string | null): { slot: PlayerSlot | null; index: number | null } {
    const slots = Array.isArray(game?.userSlots) ? game.userSlots : [];
    let slot = slots.find(item => item?.playerId === playerId || item?.data?.playerId === playerId);
    if (!slot) {
      const databaseId = room?.players?.find(item => item?.id === playerId)?.databaseUserId;
      slot = slots.find(item => item?.data?.databaseUserId === databaseId || item?.data?.userId === databaseId);
    }
    return { slot: slot || null, index: slot ? slots.indexOf(slot) : null };
  }

  function subscribeToState(attempt = 0) {
    const connection = page.MagicCircle_RoomConnection;
    if (typeof connection?.subscribeToPatches !== 'function') {
      if (attempt < 180) setTimeout(() => subscribeToState(attempt + 1), 500);
      return;
    }
    connection.subscribeToPatches((_patches: unknown[], fullState: FullState) => {
      state.room = fullState?.data || null;
      state.game = fullState?.child?.data || null;
      state.playerId = fullState?.selfPlayerId || state.room?.selfPlayerId || state.playerId || readPlayerId();
      const picked = pickSlot(state.game, state.room, state.playerId);
      state.slot = picked.slot;
      state.slotIndex = picked.index;
      page.__gardenCompanionState = state;
      refreshCompletedTeamSave();
      refreshCompletedTeamDelete();
      processActivities();
      processShops();
      renderPetFood();
      refreshTeamActiveMarkers();
      refreshOpenPanel();
    });
  }

  const GRANTER_MUTATIONS: Record<string, string> = {
    RainDance: 'Wet', SnowGranter: 'Chilled', FrostGranter: 'Frozen', DawnlitGranter: 'Dawnlit',
    AmberlitGranter: 'Ambershine', GoldGranter: 'Gold', RainbowGranter: 'Rainbow', ThunderstruckGranter: 'Thunderstruck',
  };

  function abilityEffectText(ability: string, strength: number, trigger: string | undefined, parameters: Record<string, number> | undefined): string {
    const proc = PROC_RULES[ability];
    if (proc) return proc.effect(strength);
    if (GRANTER_MUTATIONS[ability]) return `Applies the ${GRANTER_MUTATIONS[ability]} mutation`;
    const values = parameters ?? {};
    const scaled = (key: string) => Number(values[key] || 0) * strength / 100;
    const percent = (value: number) => Number(value.toFixed(2)).toLocaleString();
    if (values.hungerRefundPercentage != null) return `Reduces hunger depletion by ${percent(scaled('hungerRefundPercentage'))}%`;
    if (values.hungerRestorePercentage != null) return `Restores ${percent(scaled('hungerRestorePercentage'))}% hunger per proc`;
    if (values.mutationChanceIncreasePercentage != null) return `Mutation chance increase: +${percent(scaled('mutationChanceIncreasePercentage'))}%`;
    if (values.scaleIncreasePercentage != null) return `Crop size increase: +${percent(scaled('scaleIncreasePercentage'))}% per proc`;
    if (values.cropSellPriceIncreasePercentage != null) return `Sell bonus: +${percent(scaled('cropSellPriceIncreasePercentage'))}% coins`;
    if (values.plantGrowthReductionMinutes != null) return `Growth reduction: ${scaled('plantGrowthReductionMinutes').toFixed(1)}m per proc`;
    if (values.eggGrowthTimeReductionMinutes != null) return `Hatch reduction: ${scaled('eggGrowthTimeReductionMinutes').toFixed(1)}m per proc`;
    if (values.baseMaxCoinsFindable != null) return `Coins found: 1 - ${Math.floor(scaled('baseMaxCoinsFindable')).toLocaleString()} per proc`;
    if (values.bonusXp != null) return `Bonus XP: +${Math.floor(scaled('bonusXp')).toLocaleString()} per proc`;
    if (values.maxStrengthIncreasePercentage != null) return `Max STR boost: +${percent(scaled('maxStrengthIncreasePercentage'))}%`;
    if (values.plantAbilityChanceBoostPercentage != null) return `Active pet ability chance: +${percent(scaled('plantAbilityChanceBoostPercentage'))}%`;
    if (values.mutationChancePerMinute != null) return `Mutation chance: ${percent(scaled('mutationChancePerMinute'))}% per minute`;
    if (values.cooldownSeconds != null) {
      const cooldown = values.cooldownSeconds / Math.max(strength / 100, .01);
      const range = values.tileRadius != null ? ` | Range: ${values.tileRadius} tile${values.tileRadius === 1 ? '' : 's'}` : '';
      return `Cooldown: ${formatDuration(cooldown * 1000)}${range}`;
    }
    return humanize(trigger || 'Effect details unavailable');
  }

  function combinedAbilityRows(pets: Pet[]): string {
    const groups = new Map<string, Array<{ ability: string; pet: Pet }>>();
    for (const pet of pets) {
      if (pet.hunger <= 0) continue;
      for (const ability of pet.abilities ?? []) {
        const key = STACKED_PASSIVE_BY_ABILITY.get(ability)?.key ?? ability;
        const group = groups.get(key) ?? [];
        group.push({ ability, pet });
        groups.set(key, group);
      }
    }
    return [...groups].map(([, entries]) => {
      const ability = entries[0].ability;
      const owners = entries.map(entry => entry.pet);
      const strengths = owners.map(pet => petMetrics(pet)?.strength ?? 100);
      const averageStrength = strengths.reduce((sum, value) => sum + value, 0) / strengths.length;
      const details = ABILITY_DETAILS[ability];
      const passiveGroup = STACKED_PASSIVE_BY_ABILITY.get(ability);
      const proc = PROC_RULES[ability];
      const baseChance = passiveGroup ? undefined : details?.baseProbability ?? proc?.chance ?? GRANTER_CHANCES[ability];
      let chance = '';
      if (baseChance != null) {
        const tick = details?.trigger ? details.trigger === 'continuous' : proc?.tick !== false;
        if (tick) {
          const tickRate = 1 - strengths.reduce((remaining, strength) => remaining * Math.pow(1 - baseChance * strength / 10000, 1 / 60), 1);
          const perMinute = (1 - Math.pow(1 - tickRate, 60)) * 100;
          const mean = tickRate > 0 ? 1 / tickRate : null;
          chance = `<div class="gc-ability-rate"><b>${Math.floor(perMinute * 100) / 100}%/min</b>${mean ? `<small>avg ~${formatEstimate(mean)}</small><small>95% within ${formatEstimate(Math.log(20) * mean)}</small>` : ''}</div>`;
        } else {
          const combined = (1 - strengths.reduce((remaining, strength) => remaining * (1 - baseChance * strength / 10000), 1)) * 100;
          chance = `<div class="gc-ability-rate"><b>${combined.toFixed(1)}%</b><small>per trigger</small></div>`;
        }
      }
      let effect: string;
      if (passiveGroup) {
        const total = entries.reduce((sum, entry) => {
          const requiredWeather = PASSIVE_REQUIRED_WEATHER.get(entry.ability);
          if (entry.pet.hunger <= 0 || requiredWeather && state.game?.weather !== requiredWeather) return sum;
          const strength = petMetrics(entry.pet)?.strength ?? 100;
          const base = Number(ABILITY_DETAILS[entry.ability]?.baseParameters?.[passiveGroup.parameter] || 0);
          return sum + base * strength / 100;
        }, 0);
        const amount = Number(total.toFixed(2)).toLocaleString();
        if (passiveGroup.key === 'HungerBoost') effect = `Reduces hunger depletion by ${amount}% combined`;
        else if (passiveGroup.key === 'WeatherMutationBoost') effect = `Weather mutation chance increase: +${amount}% combined`;
        else if (passiveGroup.key === 'PetMutationBoost') effect = `Egg mutation chance increase: +${amount}% combined`;
        else effect = `Active pet ability chance: +${amount}% combined`;
      } else effect = abilityEffectText(ability, averageStrength, details?.trigger, details?.baseParameters);
      const names = owners.map(pet => pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies)).join(', ');
      const label = passiveGroup?.label ?? ABILITY_DETAILS[ability]?.name ?? humanize(ability);
      return `<article class="gc-card gc-ability-summary"><div><h3>${escapeHtml(label)}</h3><p>${escapeHtml(names)}</p><small>${escapeHtml(effect)}</small></div>${chance}</article>`;
    }).join('');
  }

  function installInstantHarvest() {
    window.addEventListener('keydown', event => {
      // Any minigame holding the farm owns the keyboard too, or space harvests behind the scene.
      if (!feature('instantHarvest') || worldSceneActive() || event.code !== 'Space' || event.repeat || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey || isTyping()) return;
      if (state.currentAction && state.currentAction !== 'none' && !['harvest', 'rainbowHarvest', 'goldHarvest'].includes(state.currentAction)) return;
      const tile = state.slot?.data?.garden?.tileObjects?.[String(state.dirtTileIndex)];
      if (!tile?.slots?.length) return;
      const now = Date.now();
      const qualifies = slot => Number(slot?.endTime) <= now && (slot?.mutations || []).some(value => value === 'Gold' || value === 'Rainbow');
      let index = tile.slots.findIndex(slot => String(slot.slotId) === String(state.selectedSlotId));
      if (index >= 0 && !qualifies(tile.slots[index])) return;
      if (index < 0) index = tile.slots.findIndex(qualifies);
      if (index < 0) return;
      event.preventDefault(); event.stopImmediatePropagation();
      const slot = tile.slots[index];
      send({ type: 'HarvestCrop', slot: state.dirtTileIndex, slotsIndex: slot.slotId ?? index });
      toast('Harvest requested.', 'success');
    }, true);
  }

  installPixiCapture();
  installCropEstimates();
  initKeybinds();

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

  function setLunarMinimised(minimised: boolean): void {
    lunarMinimised = minimised;
    saveLocal(LUNAR_MINIMISED_KEY, minimised);
    updateLunarTimer();
  }

  function updateLunarTimer() {
    const root = document.getElementById('gc-lunar');
    const mini = document.getElementById('gc-lunar-mini');
    if (!root) return;
    // Cinematic mode is for screenshots, so the panel and its icon both step aside - but only when
    // the player asked for it. Our own scenes claim cinematic as well, and hiding there would take
    // the timer away from the very screens it was opened alongside.
    const shown = feature('lunarTimer') && !page.__gardenCompanionCinematicFromGame?.();
    const remaining = formatDuration(nextLunarAt() - Date.now());
    root.hidden = !shown || lunarMinimised;
    root.querySelector('strong').textContent = remaining;
    if (mini) {
      mini.hidden = !shown || !lunarMinimised;
      mini.title = `Next lunar event in ${remaining}`;
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

  function watchSocketHealth(): void {
    const socket = page.MagicCircle_RoomConnection?.currentWebSocket ?? null;
    if (socket !== watchedSocket) {
      watchedSocket = socket;
      if (socket) {
        const setCurrentSocketStatus = (status: SocketStatus) => {
          if (watchedSocket !== socket) return;
          socketStatus = status;
          renderSocketStatus();
        };
        socket.addEventListener('open', () => setCurrentSocketStatus('connected'));
        socket.addEventListener('close', event => {
          setCurrentSocketStatus('disconnected');
          handleGameSocketClose(event);
        });
        socket.addEventListener('error', () => setCurrentSocketStatus('disconnected'));
      }
    }
    socketStatus = !socket ? 'connecting'
      : socket.readyState === WebSocket.OPEN ? 'connected'
      : socket.readyState === WebSocket.CONNECTING ? 'connecting'
      : 'disconnected';
    renderSocketStatus();
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

  function currentScriptVersion(): string {
    try { return GM_info.script.version || '0.0.0'; } catch { return '0.0.0'; }
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
          ? isNewerVersion(availableVersion, currentScriptVersion()) ? 'available' : 'current'
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

  function checkForGameUpdateDialog(): boolean {
    const dialogs = document.querySelectorAll<HTMLElement>('[role="alertdialog"], section.chakra-modal__content');
    for (const dialog of dialogs) {
      if (!dialog.textContent?.toLowerCase().includes('game update available')) continue;
      handleGameUpdateDetected('update dialog');
      return true;
    }
    return false;
  }

  function watchForGameUpdateDialog(): void {
    const observer = new MutationObserver(() => { if (!gameUpdateDetected) checkForGameUpdateDialog(); });
    observer.observe(document.body, { childList: true, subtree: true });
    checkForGameUpdateDialog();
    setInterval(checkForGameUpdateDialog, 5_000);
  }

  let activeTab = 'abilities';
  let panelRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelPanelRefresh(): void {
    if (!panelRefreshTimer) return;
    clearTimeout(panelRefreshTimer);
    panelRefreshTimer = null;
  }

  function selectPanelTab(tab: string | undefined): void {
    if (!tab || tab === activeTab) return;
    cancelPanelRefresh();
    activeTab = tab;
    if (activeTab !== 'abilityLog') { setAbilityFilterMenuOpen(false); setAbilityFilterInteracting(false); }
    renderPanel();
  }


  function openPanel(tab = activeTab) {
    // Sprite decoding is held back until the game is idle, so opening a panel is the cue that the
    // artwork is now wanted more than the wait is. The panel shows shop, emblem and mutation icons,
    // which are all in the deferred set.
    page.__gardenCompanionLoadSprites?.();
    page.__gardenCompanionLoadSpriteGroup?.('deferred');
    activeTab = tab;
    let panel = document.getElementById('gc-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'gc-panel';
      document.body.appendChild(panel);
      panel.addEventListener('focusout', () => { if (refreshPending) setTimeout(refreshOpenPanel, 0); });
    }
    panel.hidden = false;
    renderPanel();
  }

  function closePanel() {
    cancelKeybindCapture?.();
    closeTeamPicker();
    const panel = document.getElementById('gc-panel');
    if (panel) panel.hidden = true;
    setAbilityFilterMenuOpen(false);
    setAbilityFilterInteracting(false);
  }
  function togglePanel(): void {
    const panel = document.getElementById('gc-panel');
    if (panel && !panel.hidden) closePanel();
    else openPanel();
  }
  function panelRefreshBlocked(panel: HTMLElement): boolean {
    const abilityUi = abilityLogUiState();
    if (abilityUi.interacting || abilityUi.menuOpen || panel.contains(document.activeElement)) return true;
    if (panel.querySelector<HTMLDetailsElement>('[data-ability-filter]')?.open) return true;
    const abilityLog = activeTab === 'abilityLog' ? panel.querySelector<HTMLElement>('.gc-log') : null;
    if (abilityLog && (abilityLog.matches(':hover') || abilityLog.scrollTop > 0)) return true;
    const scrollable = ['teams', 'petFood', 'calculators', 'journal'].includes(activeTab) ? panel.querySelector<HTMLElement>('main') : null;
    return Boolean(scrollable?.matches(':hover'));
  }

  const LIVE_REFRESH_TABS = ['abilities', 'abilityLog', 'petFood', 'teams', 'calculators', 'journal'];
  let lastTabSignature = '';
  let refreshPending = false;

  function tabRefreshSignature(): string {
    if (activeTab === 'teams') return teamsSignature();
    if (activeTab === 'calculators') return calculatorsSignature();
    if (activeTab === 'journal') return journalSignature();
    if (activeTab === 'petFood') {
      const counts = new Map<string, number>();
      for (const item of heldProduce()) counts.set(item.species, (counts.get(item.species) || 0) + 1);
      return JSON.stringify([[...new Set(allPets().map(pet => pet.petSpecies))].sort(), [...counts].sort(), config.petFoodChoices]);
    }
    return '';
  }

  function refreshOpenPanel() {
    const panel = document.getElementById('gc-panel');
    if (!panel || panel.hidden || !LIVE_REFRESH_TABS.includes(activeTab)) return;
    // A blocked refresh is remembered rather than dropped, otherwise a change made while the
    // pointer rests on the tab stays invisible until the next game patch happens to arrive.
    if (panelRefreshBlocked(panel)) { refreshPending = true; return; }
    refreshPending = false;
    if (panelRefreshTimer) return;
    const signature = tabRefreshSignature();
    if (signature && signature === lastTabSignature) return;
    panelRefreshTimer = setTimeout(() => {
      panelRefreshTimer = null;
      if (panel.hidden || !LIVE_REFRESH_TABS.includes(activeTab)) return;
      if (panelRefreshBlocked(panel)) { refreshPending = true; return; }
      const current = tabRefreshSignature();
      if (current && current === lastTabSignature) return;
      const main = panel.querySelector('main');
      const scrollTop = main?.scrollTop ?? 0;
      renderPanel();
      const nextMain = panel.querySelector('main');
      if (nextMain) nextMain.scrollTop = scrollTop;
    }, 1000);
  }

  const TABS = [['abilities', 'Active Pets'], ['abilityLog', 'Pet Abilities'], ['teams', 'Pet Teams'], ['petFood', 'Pet Food'], ['calculators', 'Calculators'], ['shops', 'Shop Alarms'], ['silence', 'Ignore Alerts'], ['journal', 'Journal'], ['rooms', 'Rooms'], ['keybinds', 'Keybinds'], ['features', 'Features']];

  function renderPanel() {
    cancelKeybindCapture?.();
    const panel = document.getElementById('gc-panel');
    if (!panel) return;
    panel.innerHTML = `<div class="gc-shell"><header><div><small>GARDEN COMPANION</small><h2>${escapeHtml(TABS.find(tab => tab[0] === activeTab)?.[1] || '')}</h2></div><button data-close aria-label="Close">x</button></header><div class="gc-layout"><nav>${TABS.map(([id, label]) => `<button data-tab="${id}" class="${id === activeTab ? 'active' : ''}">${label}</button>`).join('')}</nav><main class="${activeTab === 'abilityLog' ? 'gc-ability-log-tab' : ''}">${renderTab()}</main></div></div>`;
    const main = panel.querySelector<HTMLElement>('main')!;
    main.addEventListener('pointerleave', () => { if (refreshPending) setTimeout(refreshOpenPanel, 0); });
    panel.querySelector<HTMLButtonElement>('[data-close]')!.onclick = closePanel;
    panel.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => {
      button.onpointerdown = event => {
        if (event.button !== 0) return;
        event.preventDefault();
        selectPanelTab(button.dataset.tab);
      };
      button.onclick = () => selectPanelTab(button.dataset.tab);
    });
    bindTabEvents(main);
    lastTabSignature = tabRefreshSignature();
  }

  function renderPanelPreservingScroll(): void {
    const panel = document.getElementById('gc-panel');
    const scrollTop = panel?.querySelector('main')?.scrollTop ?? 0;
    renderPanel();
    const main = panel?.querySelector<HTMLElement>('main');
    if (main) main.scrollTop = scrollTop;
  }

  function renderTab() {
    if (activeTab === 'features') return renderFeatures();
    if (activeTab === 'teams') return renderTeams();
    if (activeTab === 'petFood') return renderPetFoodTab();
    if (activeTab === 'calculators') return renderCalculators();
    if (activeTab === 'keybinds') return renderKeybinds();
    if (activeTab === 'abilities') return renderAbilities();
    if (activeTab === 'abilityLog') return renderAbilityLog();
    if (activeTab === 'rooms') return renderRooms();
    if (activeTab === 'shops') return renderShops();
    if (activeTab === 'silence') return renderSilence();
    if (activeTab === 'journal') return renderJournal();
    return '';
  }

  function renderFeatures() {
    const rows = [
      ['dragMove', 'Plant drag move', 'Hold, drag and release a plant - consumes planter pots'],
      ['keepPlanterPotSelected', 'Keep Planter Pot selected', 'Do not switch to the picked-up plant after using a Planter Pot'],
      ['turtleTimer', 'Crop and egg estimates', 'Values and pet-adjusted timing'],
      ['petFood', 'Pet food panel', 'Draggable feed buttons for your active pets - foods are chosen in the Pet Food tab'],
      ['instantHarvest', 'Instant harvest key', 'Spacebar harvest for mature Gold or Rainbow crops'],
      ['backgroundMode', 'Run in background', 'Keep the game active when its tab is not visible'],
      ['autoRefreshGameUpdates', 'Refresh for game updates', 'Reload five seconds after the game reports an expired version'],
    ];
    return `<p class="gc-note">Optional tools can be changed here. Plant drag, Planter Pot selection, estimates, and harvest settings apply immediately. Background mode applies after a reload.</p><div class="gc-list">${rows.map(([key, title, text]) => `<label class="gc-toggle"><span><b>${title}</b><small>${text}</small></span><input type="checkbox" data-feature="${key}" ${feature(key) ? 'checked' : ''}><i></i></label>`).join('')}</div><section class="gc-card gc-launch-row"><div><h3>Garden overview</h3><p>Growth, value, mutation progress, and completion estimates for your garden.</p></div><button class="gc-primary" data-open-overview>Open overview</button></section><section class="gc-card gc-launch-row"><div><h3>Crop Cleanser helper</h3><p>Find mature crops by mutation and manually cleanse individual slots.</p></div><button class="gc-primary" data-open-crop-cleanser>Open helper</button></section><section class="gc-card gc-launch-row"><div><h3>Layout planner</h3><p>Plan plants and decor on your own tiles. Nothing is sent to the game.</p></div><button class="gc-primary" data-open-planner>Open planner</button></section><section class="gc-card gc-launch-row"><div><h3>Celestial layout</h3><p>Overlay a buff layout for your current celestial plants on either side of the farm.</p></div><button class="gc-primary" data-open-celestial-layout>Open layout</button></section><section class="gc-card gc-launch-row"><div><h3>Fishing</h3><p>Fishing minigame.</p></div><button class="gc-primary" data-open-fishing>Open fishing</button></section><p class="gc-note">Every keybind now lives on the Keybinds tab.</p>`;
  }

  function renderAbilities() {
    const active = state.slot?.data?.petSlots || [];
    const held = heldToolCount('XPPotion');
    const xpRate = teamXpPerHour(active);
    const activeCards = active.map(pet => {
      const metrics = petMetrics(pet);
      const maxText = metrics ? metrics.xpToMax > 0 ? `${formatEstimate(metrics.xpToMax / xpRate * 3600)} until max STR` : 'Max STR reached' : 'Strength estimate unavailable';
      const potionsToMax = metrics?.xpToMax ? Math.ceil(metrics.xpToMax / XP_PER_POTION) : 0;
      const potionText = potionsToMax > 0 ? `${potionsToMax.toLocaleString()} XP potion${potionsToMax === 1 ? '' : 's'} to max` : '';
      // The button only appears when a potion is actually held, so it can never send a doomed request.
      const potionRow = potionText
        ? held > 0
          ? `<button class="gc-pet-potions" data-xp-potion="${escapeHtml(pet.id)}" title="Spend one XP Potion on this pet. ${held} held.">${escapeHtml(potionText)}<i>Use one</i></button>`
          : `<div class="gc-pet-potions">${escapeHtml(potionText)}</div>`
        : '';
      return `<article class="gc-card gc-pet-card"><div class="gc-pet-head">${petSprite(pet)}<div><h3>${escapeHtml(pet.name || PET_CATALOG[pet.petSpecies]?.name || humanize(pet.petSpecies))}</h3><p>${escapeHtml(humanize(pet.petSpecies))}</p>${abilityChips(pet.abilities || [])}</div>${hungerDisplay(pet)}</div><div class="gc-pet-strength"><span>${metrics ? `STR <b>${metrics.strength}</b> / ${metrics.maxStrength}` : 'STR unavailable'}</span><strong>${escapeHtml(maxText)}</strong></div>${potionRow}</article>`;
    }).join('');
    const abilityRows = combinedAbilityRows(active);
    return `<section class="gc-card gc-team-summary"><b>${active.length} active pet${active.length === 1 ? '' : 's'}</b><span>${Math.round(xpRate).toLocaleString()} XP/hour per pet</span></section><section class="gc-active-pets">${activeCards || '<p class="gc-empty">Waiting for active pet data.</p>'}</section><div class="gc-section-label">Combined abilities</div><section class="gc-stack">${abilityRows || '<p class="gc-empty">No active pet abilities found.</p>'}</section>`;
  }

  function renderSilence() {
    const selected = new Set(config.silencedAbilities || []);
    return `<p class="gc-note">Selected abilities keep their rewards but hide the game popup and sound. Pet history is still recorded.</p><div class="gc-row"><button data-silence-finders>Select finders</button><button data-silence-clear>Clear all</button></div><input class="gc-search" data-silence-search placeholder="Search abilities"><div class="gc-check-grid gc-filter-list">${TRACKED_ABILITY_CATALOG.map(ability => `<label class="gc-check" data-filter-text="${escapeHtml(`${ABILITY_DETAILS[ability]?.name || humanize(ability)} ${ability}`.toLowerCase())}"><input type="checkbox" data-silence="${escapeHtml(ability)}" ${selected.has(ability) ? 'checked' : ''}><span><b>${escapeHtml(ABILITY_DETAILS[ability]?.name || humanize(ability))}</b><small>${escapeHtml(ability)}</small></span></label>`).join('')}</div>`;
  }

  function bindTabEvents(main: HTMLElement): void {
    main.querySelectorAll<HTMLInputElement>('[data-feature]').forEach(input => input.onchange = () => { config[input.dataset.feature!] = input.checked; saveConfig(); updateLunarTimer(); renderPetFood(); });
    main.querySelector('[data-open-planner]')?.addEventListener('click', () => { closePanel(); page.__gardenCompanionTogglePlanner?.(); });
    main.querySelector('[data-open-celestial-layout]')?.addEventListener('click', () => { closePanel(); page.__gardenCompanionToggleCelestialLayout?.(); });
    main.querySelector('[data-open-crop-cleanser]')?.addEventListener('click', () => { closePanel(); page.__gardenCompanionToggleCropCleanser?.(); });
    main.querySelectorAll<HTMLButtonElement>('[data-xp-potion]').forEach(button => button.onclick = () => {
      try {
        useXpPotion(button.dataset.xpPotion!);
        button.disabled = true;
        toast('XP potion requested.', 'success');
      } catch (error) { toast((error as Error).message, 'error'); }
    });
    main.querySelector('[data-open-overview]')?.addEventListener('click', () => page.__gardenCompanionToggleOverview?.());
    main.querySelector('[data-open-fishing]')?.addEventListener('click', () => { closePanel(); page.__gardenCompanionToggleFishing?.(); });
    main.querySelectorAll<HTMLInputElement>('[data-silence]').forEach(input => input.onchange = () => { const set = new Set(config.silencedAbilities || []); input.checked ? set.add(input.dataset.silence!) : set.delete(input.dataset.silence!); config.silencedAbilities = [...set].sort(); saveConfig(); });
    main.querySelector('[data-silence-clear]')?.addEventListener('click', () => { config.silencedAbilities = []; saveConfig(); renderPanel(); });
    main.querySelector('[data-silence-finders]')?.addEventListener('click', () => { config.silencedAbilities = TRACKED_ABILITY_CATALOG.filter(ability => ability.includes('Finder')); saveConfig(); renderPanel(); });
    bindListSearch(main.querySelector('[data-silence-search]'));
    bindCalculatorEvents(main);
    bindPetTeamEvents(main);
    bindPetFoodEvents(main);
    bindAbilityLogEvents(main);
    bindShopEvents(main);
    bindJournalEvents(main);
    bindRoomEvents(main);
    bindKeybindEvents(main);
  }

  function mount() {
    const style = document.createElement('style');
    style.textContent = __GARDEN_COMPANION_CSS__;
    document.head.appendChild(style);
    const lunar = document.createElement('div');
    lunar.id = 'gc-lunar';
    lunar.innerHTML = '<div class="gc-lunar-head"><div class="gc-lunar-title"><i class="gc-lunar-mark"></i><span>Next lunar event</span></div><div id="gc-lunar-head-actions"><button data-minimise aria-label="Minimise the lunar timer" title="Minimise"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12"/></svg></button><button data-options aria-label="Open Garden Companion options" title="Open Garden Companion"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z"/><path d="M19.1 13.5c.1-.5.1-1 0-1.5l2-1.5-2-3.4-2.4 1a8 8 0 0 0-1.3-.8L15 4.8h-4l-.4 2.5c-.5.2-.9.5-1.3.8l-2.4-1-2 3.4 2 1.5a7 7 0 0 0 0 1.5l-2 1.5 2 3.4 2.4-1c.4.3.8.6 1.3.8l.4 2.5h4l.4-2.5c.5-.2.9-.5 1.3-.8l2.4 1 2-3.4-2-1.5Z"/></svg></button></div></div><div class="gc-lunar-countdown"><strong>--</strong></div><div class="gc-health"><span id="gc-ws-health" data-status="connecting"><i></i><b>Connecting</b></span><button id="gc-update-health" data-status="checking">Checking update</button></div>';
    lunar.querySelector<HTMLButtonElement>('[data-options]')!.onclick = togglePanel;
    lunar.querySelector<HTMLButtonElement>('[data-minimise]')!.onclick = () => setLunarMinimised(true);
    lunar.querySelector<HTMLButtonElement>('#gc-update-health')!.onclick = handleUpdateClick;
    document.body.appendChild(lunar);
    makeDraggable(lunar, LUNAR_POSITION_KEY);
    const lunarMini = document.createElement('button');
    lunarMini.id = 'gc-lunar-mini';
    lunarMini.hidden = true;
    lunarMini.setAttribute('aria-label', 'Restore the lunar timer');
    lunarMini.innerHTML = '<i class="gc-lunar-mark"></i>';
    lunarMini.onclick = () => setLunarMinimised(false);
    document.body.appendChild(lunarMini);
    page.__gardenCompanionPetSpritesReady = () => {
      const panel = document.getElementById('gc-panel');
      if (panel && !panel.hidden && ['teams', 'abilities', 'shops', 'petFood', 'calculators'].includes(activeTab)) renderPanel();
      resetPetFoodSignature();
      renderPetFood();
    };
    // Reacting to the write rather than the next tick, so entering cinematic mode is not a second
    // of the timer sitting in the shot.
    page.__gardenCompanionOnCinematicChange?.(updateLunarTimer);
    updateLunarTimer();
    watchSocketHealth();
    checkForUpdate();
    setInterval(updateLunarTimer, 1000);
    setInterval(watchSocketHealth, 1000);
    setInterval(checkForUpdate, 30 * 60 * 1000);
    watchForGameUpdateDialog();
    renderTurtleOverlay();
    setInterval(renderTurtleOverlay, 250);
    renderPetFood();
    setInterval(positionPetFood, 250);
    page.addEventListener('pointerup', () => requestAnimationFrame(positionPetFood), true);
  }

  installGameModalAccess();
  subscribeToState();
  installAtomHooks();
  installInstantHarvest();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
