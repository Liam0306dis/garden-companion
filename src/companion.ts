import type { FullState, GameState, PlayerSlot, RoomState } from './types.js';
import { config, feature, pruneStaleConfig, saveConfig } from './config.js';
import { ABILITY_DETAILS, KOFI_URL, TRACKED_ABILITY_CATALOG } from './constants.js';
import { bindCalculatorEvents, calculatorsSignature, renderCalculators } from './features/calculators.js';
import { installAlarms } from './alarms.js';
import { getSequencerDiagnostics, noteGameSocket, noteOutgoingCommand, noteServerFrame, parseOutgoingFrame, renumberOutgoingCommand, seedCommandSequence } from './game-connection.js';
import { installCropEstimates, syncCropEstimates } from './features/crop-estimates.js';
import { bindPetFoodEvents, positionPetFood, renderPetFood, renderPetFoodTab, resetPetFoodSignature } from './features/pet-food.js';
import {
  abilityLogUiState,
  bindAbilityLogEvents,
  renderAbilityLog,
  setAbilityFilterInteracting,
  setAbilityFilterMenuOpen,
} from './features/ability-log.js';
import { processAutoStore } from './features/auto-store.js';
import { noteWeatherChange } from './features/weather-timer.js';
import { forecastTrace } from './weather-forecast.js';
import { bindWeatherAlarmEvents, processWeatherAlarms, renderWeatherAlarms, weatherAlarmSignature } from './features/weather-alarms.js';
import { bindCropProtectionEvents, blockOutgoingHarvest, refuseCommand, renderCropProtection } from './features/crop-protection.js';
import { bindJournalEvents, journalSignature, renderJournal } from './features/journal.js';
import { bindEggLuckEvents, eggLuckSignature, renderEggLuck } from './features/egg-luck.js';
import { processActivityLog } from './activity-log.js';
import { bindRoomEvents, renderRooms } from './features/rooms.js';
import { installAtomHooks, installGameModalAccess } from './game-atoms.js';
import { bindKeybindEvents, cancelKeybindCapture, claimKeybind, initKeybinds, isTyping, renderKeybinds } from './keybinds.js';
import { bindListSearch } from './list-search.js';
import { page } from './page.js';
import { setPanelActions } from './panel-actions.js';
import { retryUntil } from './retry.js';
import { installPixiCapture } from './pixi.js';
import { processPetHunger, renderAbilities } from './features/active-pets.js';
import { installInstantHarvest } from './features/instant-harvest.js';
import { mountLunarTimer, updateLunarTimer, watchSocketHealth } from './features/lunar-timer.js';
import { allPets, heldProduce, onSpritesReady, refreshHungerDisplay, useXpPotion } from './pets.js';
import {
  closeTeamPicker,
  bindPetTeamEvents,
  refreshCompletedTeamDelete,
  refreshCompletedTeamMove,
  refreshCompletedTeamSave,
  refreshTeamActiveMarkers,
  renderTeams,
  teamsSignature,
} from './features/pet-teams.js';
import { bindShopEvents, processShops, renderShops } from './features/shop-alarms.js';
import { toast } from './toast.js';
import { notifyStateChange, state } from './state.js';
import { escapeHtml, humanize, scriptVersion } from './utils.js';

export function initCompanion(): void {
  pruneStaleConfig();
  setPanelActions({
    renderPanel, renderPanelPreservingScroll, refreshOpenPanel, cancelPanelRefresh,
    openPanel, togglePanel, closePanel, activeTab: () => activeTab,
  });
  installAlarms();

  page.__gardenCompanionClaimKeybind = claimKeybind;

  page.__gardenCompanionFeature = feature;
  page.__gardenCompanionConfig = () => config;
  page.__gardenCompanionForecastTrace = forecastTrace;
  // Call __gardenCompanionSequencer() in the console to see the command frontier state - whether the
  // room-connection property is feeding it, how often it healed, and the last forward jump / heal.
  page.__gardenCompanionSequencer = getSequencerDiagnostics;

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

  /**
   * Crop Protection drops a harvest on its way out. Wrapping send on the socket is the only point
   * every route into a harvest passes through - the game's button, its hotkey, and ours - and it is
   * the last moment at which nothing has happened yet.
   *
   * A dropped command is answered rather than left hanging. The game waits five seconds for a reply
   * before giving up, and the giving up is a rejection, which skips the handler that undoes the
   * optimistic harvest; a refusal delivered now settles it immediately and lets the game tidy up.
   */
  function guardOutgoingHarvests(socket: WebSocket): void {
    const originalSend = socket.send;
    socket.send = function(data: Parameters<WebSocket['send']>[0]) {
      const frame = parseOutgoingFrame(data);
      if (!frame) return originalSend.call(this, data);
      const blocked = blockOutgoingHarvest(frame);
      if (blocked) {
        if (blocked.requestId) refuseCommand(socket, blocked.requestId);
        return;
      }
      noteOutgoingCommand(frame);
      // Renumbered on the way out so one counter covers the game's commands and ours, which is the
      // only way two senders can share a sequence without ever picking the same number.
      return originalSend.call(this, renumberOutgoingCommand(frame) ? JSON.stringify(frame) : data);
    };
  }

  /**
   * Also where the Welcome frame is caught, and where outgoing harvests are guarded. Every socket
   * the game opens comes through here already, and a listener added at construction is on before
   * the connection can deliver anything, so this is the one place that cannot miss the first frame.
   */
  function installGameUpdateSocketDetector(): void {
    const OriginalWebSocket = page.WebSocket as typeof WebSocket;
    const GardenCompanionWebSocket = function(...args: ConstructorParameters<typeof WebSocket>): WebSocket {
      const socket = new OriginalWebSocket(...args);
      socket.addEventListener('close', handleGameSocketClose);
      listenForWelcome(socket);
      guardOutgoingHarvests(socket);
      // Only the room socket is worth remembering as the one to send on. Every socket the page opens
      // passes through here, so noting them all let a later one - anything at all - take the place of
      // the game connection and quietly carry our commands nowhere.
      if (String(args[0] ?? '').includes('/api/rooms/')) {
        noteGameSocket(socket);
        watchSocketHealth(socket);
      }
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

  /**
   * Our own player id, read straight off the socket. The game's Welcome frame is the only place on
   * the wire that carries it - the room state has no self id and the socket url dropped its
   * playerId parameter - and the game seeds its own playerIdAtom from exactly this. Taking it here
   * as well means the panel keeps working if that atom is ever renamed.
   *
   * Frames are plain JSON strings. Nothing is parsed unless it mentions selfPlayerId, which no
   * patch frame does, so this costs one substring scan per message and one parse per connection.
   */
  let welcomePlayerId: string | null = null;

  function readWelcome(event: Event): void {
    const data = (event as MessageEvent).data;
    // Track the server's command frontier and catch the invalid_sequence rejection that says our
    // numbering has desynced, so the sequencer resyncs to the frontier instead of freezing.
    noteServerFrame(data);
    if (typeof data !== 'string' || !data.includes('"selfPlayerId"')) return;
    try {
      const frame = JSON.parse(data) as { selfPlayerId?: unknown; executedCommandSequence?: unknown };
      if (typeof frame?.selfPlayerId === 'string' && frame.selfPlayerId) welcomePlayerId = frame.selfPlayerId;
      // The same frame seeds the command counter, exactly as the game seeds its own.
      seedCommandSequence(frame?.executedCommandSequence);
    } catch {}
  }

  function listenForWelcome(socket: WebSocket & { __gardenCompanionWelcome?: boolean }): void {
    if (socket.__gardenCompanionWelcome) return;
    socket.__gardenCompanionWelcome = true;
    socket.addEventListener('message', readWelcome);
  }

  /**
   * Sockets are caught as they are constructed, so this only has to cover one case: a socket that
   * already existed when we loaded, which happens when the script updates mid-session. Its Welcome
   * is long gone, and only the next reconnect can supply another - and that one is constructed.
   */
  function watchExistingSocket(): void {
    const socket = page.MagicCircle_RoomConnection?.currentWebSocket;
    if (!socket) return;
    listenForWelcome(socket);
    watchSocketHealth(socket);
  }

  function readPlayerId(): string | null {
    try {
      let value = new URL(page.MagicCircle_RoomConnection?.currentWebSocket?.url || '').searchParams.get('playerId');
      if (value?.startsWith('"')) value = JSON.parse(value);
      return value || null;
    } catch { return null; }
  }

  /**
   * Which user slot is ours, matched by id against the slots in the patch we were just handed. The
   * id comes from the Welcome frame, which is wire truth and outlives any atom being renamed; the
   * game's own myUserSlotIdxAtom is only consulted when we have no id at all, and a cached index is
   * never allowed to override a live match, since after a room change it can point at somebody else.
   *
   * Nothing is guessed. Every id compared here can legitimately be absent on a slot, and an absent
   * id equals an absent id, so matching on one used to select whoever happened to sit in slot zero -
   * which is why a busy lobby showed another player's pets and teams.
   */
  function pickSlot(game: GameState | null, room: RoomState | null, playerId: string | null): { slot: PlayerSlot | null; index: number | null } {
    const slots = Array.isArray(game?.userSlots) ? game.userSlots : [];
    if (playerId) {
      // A slot's own id moved from playerId to userId and carries the same value, so a build that
      // only knew the old name matched nothing and left the panel on no slot at all.
      let slot = slots.find(item => item?.userId === playerId || item?.playerId === playerId || item?.data?.playerId === playerId);
      if (!slot) {
        const databaseId = room?.players?.find(item => item?.id === playerId)?.databaseUserId;
        if (databaseId) slot = slots.find(item => item?.data?.databaseUserId === databaseId || item?.data?.userId === databaseId);
      }
      // A miss falls through to the game's own index rather than returning nothing: the next rename
      // should cost a stale slot at worst, not a panel with no data and no harvesting.
      if (slot) return { slot, index: slots.indexOf(slot) };
    }
    const own = state.userSlotIndex;
    if (typeof own === 'number' && own >= 0 && slots[own]) return { slot: slots[own], index: own };
    return { slot: null, index: null };
  }

  function subscribeToState(): boolean {
    const connection = page.MagicCircle_RoomConnection;
    if (typeof connection?.subscribeToPatches !== 'function') return false;
    connection.subscribeToPatches((_patches: unknown[], fullState: FullState) => {
      state.room = fullState?.data || null;
      state.game = fullState?.child?.data || null;
      state.playerId = welcomePlayerId || fullState?.selfPlayerId || state.room?.selfPlayerId || state.atomPlayerId || state.playerId || readPlayerId();
      const picked = pickSlot(state.game, state.room, state.playerId);
      state.slot = picked.slot;
      state.slotIndex = picked.index;
      page.__gardenCompanionState = state;
      refreshCompletedTeamSave();
      refreshCompletedTeamDelete();
      refreshCompletedTeamMove();
      processActivityLog();
      processShops();
      processPetHunger();
      processAutoStore();
      noteWeatherChange();
      processWeatherAlarms();
      renderPetFood();
      refreshTeamActiveMarkers();
      refreshOpenPanel();
      notifyStateChange('patch');
    });
    return true;
  }

  installPixiCapture();
  installCropEstimates();
  initKeybinds();

  function checkForGameUpdateDialog(): boolean {
    const dialogs = document.querySelectorAll<HTMLElement>('[role="alertdialog"], section.chakra-modal__content');
    for (const dialog of dialogs) {
      if (!dialog.textContent?.toLowerCase().includes('game update available')) continue;
      handleGameUpdateDetected('update dialog');
      return true;
    }
    return false;
  }

  /**
   * The game redraws its DOM constantly, so the observer only notes that something was added and
   * looks at most twice a second; the socket's own close code usually reports an update first. It
   * disconnects once an update is found, since there is nothing left to watch for.
   */
  function watchForGameUpdateDialog(): void {
    let scheduled = 0;
    const observer = new MutationObserver(mutations => {
      if (scheduled || !mutations.some(mutation => mutation.addedNodes.length)) return;
      scheduled = window.setTimeout(() => {
        scheduled = 0;
        if (gameUpdateDetected || checkForGameUpdateDialog()) observer.disconnect();
      }, 500);
    });
    if (checkForGameUpdateDialog()) return;
    observer.observe(document.body, { childList: true, subtree: true });
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
    // Only a focused text field (a search box, the layout-name field, a keybind capture) must hold
    // off a redraw, since redrawing would drop what is being typed. A focused button - most often
    // the tab the user just clicked to reach this pane - used to count too, which left Active Pets
    // frozen on stale strength until focus happened to leave the panel.
    const focused = document.activeElement;
    if (abilityUi.interacting || abilityUi.menuOpen || (isTyping() && focused && panel.contains(focused))) return true;
    if (panel.querySelector<HTMLDetailsElement>('[data-ability-filter]')?.open) return true;
    const abilityLog = activeTab === 'abilityLog' ? panel.querySelector<HTMLElement>('.gc-log') : null;
    if (abilityLog && (abilityLog.matches(':hover') || abilityLog.scrollTop > 0)) return true;
    // Active Pets belongs here too: hunger changes every tick, and redrawing under the pointer takes
    // the hovered element with it, so its native tooltip blinks out mid-read.
    const scrollable = ['abilities', 'teams', 'petFood', 'calculators', 'journal'].includes(activeTab) ? panel.querySelector<HTMLElement>('main') : null;
    return Boolean(scrollable?.matches(':hover'));
  }

  const LIVE_REFRESH_TABS = ['abilities', 'abilityLog', 'petFood', 'teams', 'calculators', 'journal', 'eggLuck', 'weatherAlarms'];
  let lastTabSignature = '';
  /** What the content pane was last drawn from, so an identical redraw can be skipped. */
  let lastTabHtml = '';
  let refreshPending = false;

  function tabRefreshSignature(): string {
    if (activeTab === 'teams') return teamsSignature();
    if (activeTab === 'calculators') return calculatorsSignature();
    if (activeTab === 'journal') return journalSignature();
    if (activeTab === 'eggLuck') return eggLuckSignature();
    if (activeTab === 'weatherAlarms') return weatherAlarmSignature();
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
      refreshTabContent();
    }, 1000);
  }

  // Grouped rather than one flat list of twelve: the tabs fall into obvious families, and a heading
  // per family means you look in one place instead of reading every label.
  // Third entry is the nav label where the group heading already carries a word the tab would repeat.
  // The panel title keeps the full name, which has to stand on its own.
  const TAB_GROUPS: Array<[string, Array<[string, string, string?]>]> = [
    ['Pets', [['abilities', 'Active Pets', 'Active'], ['abilityLog', 'Pet Abilities', 'Abilities'], ['teams', 'Pet Teams', 'Teams'], ['petFood', 'Pet Food', 'Food'], ['eggLuck', 'Egg Luck', 'Eggs']]],
    ['Crops', [['protection', 'Crop Protection', 'Protection'], ['journal', 'Journal']]],
    ['Alerts', [['shops', 'Shop Alarms', 'Shops'], ['weatherAlarms', 'Weather Alarms', 'Weather'], ['silence', 'Ignore Alerts', 'Ignore abilities']]],
    ['Tools', [['calculators', 'Calculators'], ['rooms', 'Rooms']]],
    ['Setup', [['keybinds', 'Keybinds'], ['features', 'Features']]],
    ['Support', [['supporter', 'Supporter']]],
  ];
  const TABS = TAB_GROUPS.flatMap(([, tabs]) => tabs);
  // Stroke icons on a 24px grid, drawn by the nav's own stroke rule so they follow the tab colour.
  const TAB_ICONS: Record<string, string> = {
    abilities: '<circle cx="6.5" cy="10" r="1.8"/><circle cx="10" cy="6" r="1.8"/><circle cx="14.5" cy="6" r="1.8"/><circle cx="18" cy="10" r="1.8"/><path d="M12 11.5c-2.6 0-5 3.2-5 5.6 0 1.6 1.3 2.4 2.7 2.4 1 0 1.5-.5 2.3-.5s1.3.5 2.3.5c1.4 0 2.7-.8 2.7-2.4 0-2.4-2.4-5.6-5-5.6Z"/>',
    abilityLog: '<circle cx="12" cy="12" r="8"/><path d="M12 7.5V12l3 2"/>',
    teams: '<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 5.3a3 3 0 0 1 0 5.4"/><path d="M17.5 14.2c1.9.7 3 2.5 3 4.8"/>',
    petFood: '<path d="M12 7.5c-1.6-1.3-5-1.5-6.4 1.4-1.3 2.8-.2 7.1 2 9.3 1.4 1.4 3.3 1.8 4.4 1.2 1.1.6 3 .2 4.4-1.2 2.2-2.2 3.3-6.5 2-9.3C17 6 13.6 6.2 12 7.5Z"/><path d="M12 7.5c0-2 .9-3.4 2.8-4"/>',
    eggLuck: '<path d="M12 3c3.6 0 6.5 5.4 6.5 10a6.5 6.5 0 0 1-13 0C5.5 8.4 8.4 3 12 3Z"/>',
    protection: '<path d="M12 3 5 6v5.5c0 4.4 3 7.8 7 9.5 4-1.7 7-5.1 7-9.5V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
    journal: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Z"/><path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19v-3"/><path d="M9 7.5h6"/>',
    shops: '<path d="M5 8h14l-1 12H6L5 8Z"/><path d="M9 10V6a3 3 0 0 1 6 0v4"/>',
    weatherAlarms: '<path d="M7 18a4 4 0 0 1-.6-8A5.5 5.5 0 0 1 17 8.6a4.5 4.5 0 0 1 .5 9.4H7Z"/>',
    silence: '<path d="M18 16H6c1-1.2 1.5-2.5 1.5-5a4.5 4.5 0 0 1 9 0c0 2.5.5 3.8 1.5 5Z"/><path d="M10 19a2 2 0 0 0 4 0"/><path d="M4 4l16 16"/>',
    calculators: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8.5 7h7"/><path d="M8.5 11.5h.01M12 11.5h.01M15.5 11.5h.01M8.5 15h.01M12 15h.01M15.5 15h.01"/>',
    rooms: '<path d="M4 11 12 4l8 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/>',
    keybinds: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7.5 14h9"/>',
    features: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    supporter: '<path d="M12 20s-7-4.3-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.7-7 10-7 10Z"/>',
  };
  const tabIcon = (id: string): string => `<svg viewBox="0 0 24 24" aria-hidden="true">${TAB_ICONS[id] ?? ''}</svg>`;
  const CHEVRON_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  const NAV_COLLAPSED_KEY = 'gardenCompanion.navCollapsed.v1';
  let collapsedNavGroups = new Set<string>();
  try { collapsedNavGroups = new Set(JSON.parse(localStorage.getItem(NAV_COLLAPSED_KEY) || '[]')); } catch {}
  function saveCollapsedNavGroups(): void {
    try { localStorage.setItem(NAV_COLLAPSED_KEY, JSON.stringify([...collapsedNavGroups])); } catch {}
  }
  // Setup and support are occasional visits rather than places you work in, so they sit in a footer
  // bar under the whole window instead of taking up nav groups of one or two tabs each.
  const FOOTER_GROUPS = new Set(['Setup', 'Support']);
  const FOOTER_LABELS: Record<string, string> = { supporter: 'Support the Tool' };
  function footerHtml(): string {
    const tabs = TAB_GROUPS.filter(([group]) => FOOTER_GROUPS.has(group)).flatMap(([, tabs]) => tabs);
    return `<footer class="gc-footer"><div>${tabs.map(([id, title, navLabel]) => `<button data-tab="${id}" class="${id === activeTab ? 'active' : ''}">${tabIcon(id)}<span>${FOOTER_LABELS[id] ?? navLabel ?? title}</span></button>`).join('')}</div>`
      + `<em class="gc-version">v${escapeHtml(scriptVersion())}</em></footer>`;
  }

  function navHtml(): string {
    return TAB_GROUPS.filter(([group]) => !FOOTER_GROUPS.has(group)).map(([group, tabs]) => {
      // Collapsing is honoured straight away even when the open tab lives here - waiting until you
      // navigate away made the click feel broken. The heading is marked instead, so a collapsed
      // group still shows which one you are inside.
      const holdsActive = tabs.some(([id]) => id === activeTab);
      const open = !collapsedNavGroups.has(group);
      return `<div class="gc-nav-group"><button class="gc-nav-head" data-nav-group="${escapeHtml(group)}" aria-expanded="${open}" data-holds-active="${holdsActive && !open}">`
        + `<span>${escapeHtml(group)}</span>${CHEVRON_ICON}</button>`
        + `<div class="gc-nav-items"${open ? '' : ' hidden'}>${tabs.map(([id, title, navLabel]) => `<button data-tab="${id}" class="${id === activeTab ? 'active' : ''}">${tabIcon(id)}<span>${navLabel ?? title}</span></button>`).join('')}</div></div>`;
    }).join('');
  }

  /**
   * The nav keeps its scroll across every redraw.
   *
   * It is the same list of the same groups whatever the content pane is showing, so nothing a
   * redraw does can make where you had scrolled to wrong - while putting it back at the top is
   * always wrong once there are enough groups to overflow. Kept here rather than at the call sites
   * so a redraw from anywhere behaves the same, the periodic refreshes included.
   */
  function renderPanel() {
    cancelKeybindCapture?.();
    const panel = document.getElementById('gc-panel');
    if (!panel) return;
    const navTop = panel.querySelector('nav')?.scrollTop ?? 0;
    const renderedTabHtml = renderTab();
    const activeGroup = TAB_GROUPS.find(([, tabs]) => tabs.some(([id]) => id === activeTab))?.[0] || '';
    panel.innerHTML = `<div class="gc-shell"><aside class="gc-side"><div class="gc-brand"><i class="gc-brand-mark">&#x1F33F;</i><div><b>Garden Companion</b></div></div><nav>${navHtml()}</nav></aside>`
      + `<section class="gc-content"><header><div><small>${escapeHtml(activeGroup)}</small><h2>${escapeHtml(TABS.find(tab => tab[0] === activeTab)?.[1] || '')}</h2></div><button data-close aria-label="Close" title="Close">${CLOSE_ICON}</button></header><main class="${activeTab === 'abilityLog' ? 'gc-ability-log-tab' : ''}">${renderedTabHtml}</main></section>${footerHtml()}</div>`;
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
    const nav = panel.querySelector<HTMLElement>('nav');
    if (nav) nav.scrollTop = navTop;
    panel.querySelectorAll<HTMLButtonElement>('[data-nav-group]').forEach(button => button.onclick = () => {
      const group = button.dataset.navGroup ?? '';
      collapsedNavGroups.has(group) ? collapsedNavGroups.delete(group) : collapsedNavGroups.add(group);
      saveCollapsedNavGroups();
      renderPanelPreservingScroll();
    });
    bindTabEvents(main);
    lastTabSignature = tabRefreshSignature();
    lastTabHtml = renderedTabHtml;
  }

  /**
   * A live refresh redraws the content pane alone, and only when what it would draw has changed.
   * Rebuilding the whole panel recreated the nav as well, so the tab under the pointer was replaced
   * every second and its hover highlight faded in again each time - a flash on every refresh.
   */
  function refreshTabContent(): void {
    const panel = document.getElementById('gc-panel');
    const main = panel?.querySelector<HTMLElement>('main');
    if (!panel || !main) { renderPanelPreservingScroll(); return; }
    const html = renderTab();
    lastTabSignature = tabRefreshSignature();
    if (html === lastTabHtml) return;
    cancelKeybindCapture();
    const scrollTop = main.scrollTop;
    main.innerHTML = html;
    lastTabHtml = html;
    bindTabEvents(main);
    main.scrollTop = scrollTop;
  }

  /**
   * Keeps the content pane where it was as well. The nav is handled by renderPanel itself, since it
   * should hold its place however the redraw was reached; this is for the redraws that leave the
   * content the same too, where losing your place in a long list reads as the window resetting.
   */
  function renderPanelPreservingScroll(): void {
    const panel = document.getElementById('gc-panel');
    const mainTop = panel?.querySelector('main')?.scrollTop ?? 0;
    renderPanel();
    const main = panel?.querySelector<HTMLElement>('main');
    if (main) main.scrollTop = mainTop;
  }

  function renderTab() {
    if (activeTab === 'supporter') return renderSupporter();
    if (activeTab === 'features') return renderFeatures();
    if (activeTab === 'teams') return renderTeams();
    if (activeTab === 'petFood') return renderPetFoodTab();
    if (activeTab === 'calculators') return renderCalculators();
    if (activeTab === 'keybinds') return renderKeybinds();
    if (activeTab === 'abilities') return renderAbilities();
    if (activeTab === 'abilityLog') return renderAbilityLog();
    if (activeTab === 'rooms') return renderRooms();
    if (activeTab === 'shops') return renderShops();
    if (activeTab === 'weatherAlarms') return renderWeatherAlarms();
    if (activeTab === 'silence') return renderSilence();
    if (activeTab === 'protection') return renderCropProtection();
    if (activeTab === 'journal') return renderJournal();
    if (activeTab === 'eggLuck') return renderEggLuck();
    return '';
  }

  /**
   * Nothing here is sold and nothing is gated behind it - the link is the whole tab, kept on one of
   * its own rather than tucked under a settings list where it would read as a prompt.
   */
  function renderSupporter() {
    return `<p class="gc-note">If any of my mods or tools have saved you some time or helped improved quality of life and you feel like putting something in the tip jar, the link below is the place to do it, thank you</p>
<section class="gc-card gc-launch-row"><div><h3>Buy me a coffee</h3></div><a class="gc-primary gc-kofi" href="${escapeHtml(KOFI_URL)}" target="_blank" rel="noopener noreferrer">Open Ko-fi</a></section>
<p class="gc-note">Running v${escapeHtml(scriptVersion())}. Bugs and ideas are just as welcome as anything else.</p>`;
  }

  function renderFeatures() {
    const rows = [
      ['dragMove', 'Plant drag move', 'Hold, drag and release a plant - consumes planter pots'],
      ['keepPlanterPotSelected', 'Keep Planter Pot selected', 'Do not switch to the picked-up plant after using a Planter Pot'],
      ['cropValues', 'Crop value', 'Show the sell value when standing on a crop'],
      ['turtleTimer', 'Growth time', 'Show the time left, adjusted for your pets, when standing on a crop or egg'],
      ['petFood', 'Pet food panel', 'Draggable feed buttons for your active pets - foods are chosen in the Pet Food tab'],
      ['instantHarvest', 'Instant harvest key', 'Spacebar harvest for mature Gold or Rainbow crops - off while Crop Protection is on'],
      ['petSwapToss', 'Pokemon Mode', 'Throw a ball at each active pet and catch them before a team swap - delays it about a second'],
      ['autoStoreSeeds', 'Auto-store seeds', 'Move seeds into the Seed Silo when it already holds that species'],
      ['autoStoreDecor', 'Auto-store decor', 'Move decor into the Decor Shed when it already holds that item'],
      ['autoStoreTools', 'Auto-store tools', 'Move tools into the Tool Shack when it already holds that tool - one being used, or held, is left alone'],
      ['backgroundMode', 'Run in background', 'Keep the game active when its tab is not visible'],
      ['autoRefreshGameUpdates', 'Refresh for game updates', 'Reload five seconds after the game reports an expired version'],
    ];
    return `<p class="gc-note">Optional tools can be changed here. Plant drag, Planter Pot selection, estimates, and harvest settings apply immediately. Background mode applies after a reload.</p><div class="gc-list">${rows.map(([key, title, text]) => `<label class="gc-toggle"><span><b>${title}</b><small>${text}</small></span><input type="checkbox" data-feature="${key}" ${feature(key) ? 'checked' : ''}><i></i></label>`).join('')}</div><section class="gc-card gc-launch-row"><div><h3>Garden overview</h3><p>Growth, value, mutation progress, and completion estimates for your garden.</p></div><button class="gc-primary" data-open-overview>Open overview</button></section><section class="gc-card gc-launch-row"><div><h3>Crop Cleanser helper</h3><p>Find mature crops by mutation and manually cleanse individual slots.</p></div><button class="gc-primary" data-open-crop-cleanser>Open helper</button></section><section class="gc-card gc-launch-row"><div><h3>Layout planner</h3><p>Plan plants and decor on your own tiles. Nothing is sent to the game.</p></div><button class="gc-primary" data-open-planner>Open planner</button></section><section class="gc-card gc-launch-row"><div><h3>Celestial layout</h3><p>Overlay a buff layout for your current celestial plants on either side of the farm.</p></div><button class="gc-primary" data-open-celestial-layout>Open layout</button></section><section class="gc-card gc-launch-row"><div><h3>Fishing</h3><p>Fishing minigame.</p></div><button class="gc-primary" data-open-fishing>Open fishing</button></section><p class="gc-note">Every keybind now lives on the Keybinds tab.</p>`;
  }

  function renderSilence() {
    const selected = new Set(config.silencedAbilities || []);
    return `<label class="gc-toggle"><span><b>Hide pet level-up popups</b><small>Hides the "Level up!" and "Fully grown!" toasts.</small></span><input type="checkbox" data-feature="silenceLevelUps" ${feature('silenceLevelUps') ? 'checked' : ''}><i></i></label><p class="gc-note">Selected abilities keep their rewards but hide the game popup and sound. Pet history is still recorded.</p><div class="gc-row"><button data-silence-finders>Select finders</button><button data-silence-clear>Clear all</button></div><input class="gc-search" data-silence-search placeholder="Search abilities"><div class="gc-check-grid gc-filter-list">${TRACKED_ABILITY_CATALOG.map(ability => `<label class="gc-check" data-filter-text="${escapeHtml(`${ABILITY_DETAILS[ability]?.name || humanize(ability)} ${ability}`.toLowerCase())}"><input type="checkbox" data-silence="${escapeHtml(ability)}" ${selected.has(ability) ? 'checked' : ''}><span><b>${escapeHtml(ABILITY_DETAILS[ability]?.name || humanize(ability))}</b><small>${escapeHtml(ability)}</small></span></label>`).join('')}</div>`;
  }

  function bindTabEvents(main: HTMLElement): void {
    main.querySelectorAll<HTMLInputElement>('[data-feature]').forEach(input => input.onchange = () => {
      config[input.dataset.feature!] = input.checked;
      // Instant harvest and Crop Protection pull in opposite directions on the same crops, so
      // turning one on stands the other down rather than letting both claim the same harvest.
      if (input.dataset.feature === 'instantHarvest' && input.checked) config.cropProtection = false;
      saveConfig();
      // Checked while the team is already starving, the alarm should sound now rather than waiting
      // for the next state frame to notice.
      if (input.dataset.feature === 'petHungerAlarm') processPetHunger();
      updateLunarTimer();
      renderPetFood();
      syncCropEstimates();
    });
    main.querySelector('[data-open-planner]')?.addEventListener('click', () => { closePanel(); page.__gardenCompanionTogglePlanner?.(); });
    main.querySelector('[data-open-celestial-layout]')?.addEventListener('click', () => { closePanel(); page.__gardenCompanionToggleCelestialLayout?.(); });
    main.querySelector('[data-open-crop-cleanser]')?.addEventListener('click', () => { closePanel(); page.__gardenCompanionToggleCropCleanser?.(); });
    // Refreshed as the pointer arrives, so the tooltip that follows it carries current numbers even
    // though the tab itself is holding still underneath.
    main.querySelectorAll<HTMLElement>('[data-hunger-pet]').forEach(node => node.onpointerenter = () => refreshHungerDisplay(node));
    // Disabled only while the command is being sent, which covers the Tool Shack fetch where a
    // second press would spend two. Re-enabled the moment the send resolves rather than waiting for
    // the XP to come back and redraw the panel - that round trip is the ~5s the button used to sit
    // dead for, when using several potions in a row is exactly the point.
    main.querySelectorAll<HTMLButtonElement>('[data-xp-potion]').forEach(button => button.onclick = async () => {
      button.disabled = true;
      try {
        await useXpPotion(button.dataset.xpPotion!);
        toast('XP potion requested.', 'success');
        // The new strength lands ~1.5s later on a state patch; a forced redraw then shows it even
        // with the pointer over the card.
        setTimeout(() => { if (!document.getElementById('gc-panel')?.hidden) renderPanelPreservingScroll(); }, 1500);
      } catch (error) {
        toast((error as Error).message, 'error');
      } finally {
        button.disabled = false;
      }
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
    bindWeatherAlarmEvents(main);
    bindJournalEvents(main);
    bindEggLuckEvents(main);
    bindCropProtectionEvents(main);
    bindRoomEvents(main);
    bindKeybindEvents(main);
  }

  function mount() {
    const style = document.createElement('style');
    style.textContent = __GARDEN_COMPANION_CSS__;
    document.head.appendChild(style);
    mountLunarTimer(togglePanel);
    onSpritesReady(() => {
      const panel = document.getElementById('gc-panel');
      if (panel && !panel.hidden && ['teams', 'abilities', 'shops', 'petFood', 'calculators'].includes(activeTab)) renderPanel();
      resetPetFoodSignature();
      renderPetFood();
      // The forecast sprite is asked for from the timer itself, so this is where it arrives.
      updateLunarTimer();
    });
    watchExistingSocket();
    watchForGameUpdateDialog();
    syncCropEstimates();
    renderPetFood();
    page.addEventListener('pointerup', () => requestAnimationFrame(positionPetFood), true);
  }

  installGameModalAccess();
  retryUntil(subscribeToState, 'the room state subscription');
  installAtomHooks();
  installInstantHarvest();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
}
