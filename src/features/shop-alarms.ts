import type { ShopItem } from '../types.js';
import { alertMuteButton, armAlarmAudio, setAlarmSilenced, showAlarmBanner, stopAlarm, updateAlarmDetail } from '../alarms.js';
import { config, feature, saveConfig } from '../config.js';
import { onRoomConnectionInterrupted } from '../connection-state.js';
import { EXCLUDED_TOOL_ALERTS, ITEM_KEYS, SEASONAL_SHOP_ITEMS, SHOP_NAMES, SHOP_TABS, TOOL_LIMITS } from '../constants.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { bindListSearch } from '../list-search.js';
import { page } from '../page.js';
import { panelActions } from '../panel-actions.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { escapeHtml, humanize } from '../utils.js';

/** Watches shop stock and raises an alarm when an item the player selected comes back in stock. */

export interface AvailableShopItem {
  shop: string;
  id: string;
  item: ShopItem;
  remaining: number;
}

const INITIAL_SHOP_SETTLE_MS = 500;
/**
 * A reconnect dribbles the world back in over a second or so, and an empty shop list part-way
 * through looks exactly like every watched item selling out and restocking at once. Wait for stock
 * to hold still for longer than the initial load does before trusting it again.
 */
const RECONNECT_SETTLE_MS = 2500;

export function itemId(item: ShopItem | undefined): string {
  for (const key of ITEM_KEYS) if (item?.[key]) return String(item[key]);
  return '';
}

const SHOP_ITEM_TYPES: Record<string, string> = { seed: 'Seed', egg: 'Egg', decor: 'Decor', tool: 'Tool' };

function itemType(item: ShopItem, shop: string): string {
  if (item?.itemType) return item.itemType;
  return SHOP_ITEM_TYPES[shop] || (item?.eggId ? 'Egg' : item?.decorId ? 'Decor' : item?.toolId ? 'Tool' : 'Seed');
}

export function itemPayload(item: ShopItem, shop: string): Record<string, string> {
  const payload: Record<string, string> = { itemType: itemType(item, shop) };
  for (const key of ITEM_KEYS) if (item?.[key]) payload[key] = item[key];
  return payload;
}

/**
 * How many of an item were bought this restock. A shop's purchase entry outlives its restock (it is
 * only rewritten by the next purchase), so its counts apply only while its restockId matches the
 * shop's current one - the same lookup the game client does. Builds without restockId just read it.
 */
export function purchasedCount(shop: string, id: string): number {
  const entry = state.slot?.data?.shopPurchases?.[shop];
  if (!entry) return 0;
  const shopData = state.game?.shops?.[shop];
  if (shopData && 'restockId' in shopData && (shopData.restockId == null || entry.restockId !== shopData.restockId)) return 0;
  return Number(entry.purchases?.[id] || 0);
}

/**
 * The world does not arrive in one piece. `state.game.shops` lands before `state.slot`, which is
 * only picked once the Welcome frame has named the player - and purchases live on the slot. Read in
 * that window every item looks untouched and fully in stock, including the ones already bought out,
 * and the settle timer happily agrees because the half-built picture holds still. So no snapshot is
 * trusted, baselined or alarmed on until both halves are in hand.
 */
export function shopStateReady(): boolean {
  if (!state.playerId) return false;
  // Inventory stands in for the slot being fully delivered rather than a stub: every field on the
  // payload is optional, so `data` existing proves nothing about `shopPurchases` having arrived,
  // and a slot carrying its inventory has carried its purchases with it.
  if (!Array.isArray(state.slot?.data?.inventory?.items)) return false;
  const shops = state.game?.shops;
  if (!shops) return false;
  return Object.values(shops).some(shop => Array.isArray((shop as { inventory?: unknown })?.inventory));
}

export function availableShopItems(): AvailableShopItem[] {
  const output: AvailableShopItem[] = [];
  for (const [shop, data] of Object.entries(state.game?.shops || {})) {
    for (const item of Array.isArray(data?.inventory) ? data.inventory : []) {
      const id = itemId(item);
      const remaining = Math.max(0, Number(item.initialStock || 0) - purchasedCount(shop, id));
      if (id && remaining > 0 && !(shop === 'tool' && EXCLUDED_TOOL_ALERTS.has(id))) output.push({ shop, id, item, remaining });
    }
  }
  return output;
}

/**
 * Whether the player already holds as many of this tool as the game allows (99 for the capped
 * ones), in which case an alarm would only be noise. Only tools carry a cap, as in the game's own
 * check.
 *
 * Held means the inventory and the Tool Shack together. The game's own limit is per stack - it
 * would still sell into an inventory of 40 beside a shack of 60 - but 99 between the two is already
 * as many as either could ever hold, which is the point past which a restock is not news. It also
 * keeps auto-store from hiding a full stack: tools filed into the shack still count.
 *
 * Any shop, not just the Tool shop: the Snow shop sells Chilled and Frozen Potions among its seeds
 * and decor. The cap list only holds tool ids, so an item is judged by its id, unless the shop's own
 * entry says it is some other kind of item.
 */
export function atInventoryCap(id: string, item?: ShopItem): boolean {
  return capRoom(id, item) <= 0;
}

type HeldTool = { itemType?: string; toolId?: string; quantity?: number };

/** The first stack of this tool in a list, the way the game finds it. */
function toolStack(items: unknown, id: string): number {
  if (!Array.isArray(items)) return 0;
  const stack = (items as HeldTool[]).find(entry => entry?.itemType === 'Tool' && entry.toolId === id);
  return Number(stack?.quantity || 0);
}

/**
 * How many more of this item to buy before inventory and Tool Shack together reach the cap -
 * Infinity for anything uncapped. Never more than the inventory itself can take, since that is where
 * a purchase lands; with the shack counted in, that bound always holds anyway.
 */
function capRoom(id: string, item?: ShopItem): number {
  const limit = TOOL_LIMITS[id];
  if (!limit) return Infinity;
  if (item && !item.toolId && item.itemType && item.itemType !== 'Tool') return Infinity;
  const inventory = state.slot?.data?.inventory;
  const shack = (inventory?.storages ?? []).find(entry => entry?.decorId === 'ToolShack');
  const held = toolStack(inventory?.items, id) + toolStack(shack?.items, id);
  return Math.max(0, limit - held);
}

/**
 * An alarm already up for an item the player has since filled to its cap - bought elsewhere, or
 * pulled out of storage - has nothing left to offer, so it is taken down rather than left ringing.
 * Only watched items can have an alarm, so only those are checked.
 */
function stopCappedAlarms(available: AvailableShopItem[]): void {
  for (const row of available) {
    if (config.shopAlerts[`${row.shop}:${row.id}`] && atInventoryCap(row.id, row.item)) stopAlarm(`shop:${row.shop}:${row.id}`);
  }
}

const restockClocks = new Map<string, number>();
let initialShopTimer = 0;
let pendingInitialSignature = '';

/**
 * Each shop counts down to its next restock, so the countdown jumping back up is the cycle turning
 * over. Stock alone cannot tell us: an item that never sells out looks identical either side of a
 * restock, and one the player bought from looks like a restock every purchase.
 */
function restockedShops(): Set<string> {
  const restocked = new Set<string>();
  for (const [shop, data] of Object.entries(state.game?.shops || {})) {
    const seconds = Number((data as { secondsUntilRestock?: number })?.secondsUntilRestock);
    if (!Number.isFinite(seconds)) continue;
    const previous = restockClocks.get(shop);
    if (previous !== undefined && seconds > previous) restocked.add(shop);
    restockClocks.set(shop, seconds);
  }
  return restocked;
}

function shopSignature(available: AvailableShopItem[]): string {
  return available.map(row => `${row.shop}:${row.id}:${row.remaining}`).sort().join('|');
}

function applyShopSnapshot(available: AvailableShopItem[], signature: string, restocked: Set<string>): void {
  if (signature === state.lastShopSignature && !restocked.size) {
    state.initializedShops = true;
    return;
  }
  const old = new Set(state.lastShopSignature.split('|').map(value => value.split(':').slice(0, 2).join(':')));
  const availableKeys = new Set(available.map(row => `${row.shop}:${row.id}`));
  if (state.initializedShops) for (const key of old) if (key && !availableKeys.has(key)) stopAlarm(`shop:${key}`);
  for (const row of available) updateAlarmDetail(`shop:${row.shop}:${row.id}`, `${row.remaining} remaining`);
  state.lastShopSignature = signature;
  for (const row of available) {
    const key = `${row.shop}:${row.id}`;
    if (!config.shopAlerts[key] || atInventoryCap(row.id, row.item)) continue;
    if (!state.initializedShops || !old.has(key) || restocked.has(row.shop)) showShopAlarm(row);
  }
  state.initializedShops = true;
}

function settleInitialShops(signature: string): void {
  if (signature !== pendingInitialSignature && initialShopTimer) window.clearTimeout(initialShopTimer);
  if (signature === pendingInitialSignature && initialShopTimer) return;
  pendingInitialSignature = signature;
  initialShopTimer = window.setTimeout(() => {
    initialShopTimer = 0;
    if (!feature('shopAlarms') || state.initializedShops) return;
    // The slot can still go away between arming this and it firing; dropping the pending signature
    // leaves the next update to arm it again rather than baselining half a world.
    if (!shopStateReady()) { pendingInitialSignature = ''; return; }
    const available = availableShopItems();
    const latestSignature = shopSignature(available);
    if (latestSignature !== pendingInitialSignature) {
      settleInitialShops(latestSignature);
      return;
    }
    applyShopSnapshot(available, latestSignature, new Set());
  }, INITIAL_SHOP_SETTLE_MS);
}

/**
 * After a reconnect the shops are re-adopted rather than re-diffed. Nothing that was already on
 * the shelf before the drop is news to the player, so the settled snapshot becomes the new
 * baseline silently and only changes after that raise an alarm. Going through the initial-load
 * path instead would alarm for everything in stock, which is the behaviour being fixed.
 */
let resettling = false;
let resettleTimer = 0;
let resettleSignature = '';

function beginResettle(): void {
  if (resettleTimer) window.clearTimeout(resettleTimer);
  if (initialShopTimer) window.clearTimeout(initialShopTimer);
  resettleTimer = 0;
  initialShopTimer = 0;
  pendingInitialSignature = '';
  resettleSignature = '';
  resettling = true;
  // The clocks ran on without us, so a jump across the gap is not a restock we can attribute.
  restockClocks.clear();
}

function settleAfterReconnect(signature: string): void {
  if (signature === resettleSignature && resettleTimer) return;
  if (resettleTimer) window.clearTimeout(resettleTimer);
  resettleSignature = signature;
  resettleTimer = window.setTimeout(() => {
    resettleTimer = 0;
    if (!shopStateReady()) { resettleSignature = ''; return; }
    const available = availableShopItems();
    const settled = shopSignature(available);
    if (settled !== resettleSignature) {
      settleAfterReconnect(settled);
      return;
    }
    resettling = false;
    // An item that sold out while we were away should not keep ringing for stock it no longer has.
    const before = new Set(state.lastShopSignature.split('|').map(value => value.split(':').slice(0, 2).join(':')));
    const availableKeys = new Set(available.map(row => `${row.shop}:${row.id}`));
    if (state.initializedShops) for (const key of before) if (key && !availableKeys.has(key)) stopAlarm(`shop:${key}`);
    state.lastShopSignature = settled;
    // Seed the clocks from the settled snapshot so the next real restock is the first one seen.
    restockedShops();
    state.initializedShops = true;
    for (const row of available) updateAlarmDetail(`shop:${row.shop}:${row.id}`, `${row.remaining} remaining`);
  }, RECONNECT_SETTLE_MS);
}

onRoomConnectionInterrupted(beginResettle);

export function processShops(): void {
  if (!feature('shopAlarms')) return;
  // Ahead of everything else, so a partial world is never diffed, baselined or settled against.
  if (!shopStateReady()) return;
  if (resettling) {
    settleAfterReconnect(shopSignature(availableShopItems()));
    return;
  }
  // Read the clocks first: a restock that changes nothing about stock still has to be noticed.
  const restocked = restockedShops();
  const available = availableShopItems();
  const signature = shopSignature(available);
  if (!state.initializedShops) {
    settleInitialShops(signature);
    return;
  }
  applyShopSnapshot(available, signature, restocked);
  stopCappedAlarms(available);
}

function showShopAlarm(row: AvailableShopItem): void {
  const owner = `shop:${row.shop}:${row.id}`;
  showAlarmBanner({
    owner,
    silent: Boolean(config.shopAlertsMuted[`${row.shop}:${row.id}`]),
    label: `SHOP ALARM | ${SHOP_NAMES[row.shop] || humanize(row.shop)}`,
    title: `${humanize(row.id)} is available`,
    detail: `${row.remaining} remaining`,
    actionLabel: 'Buy all',
    onAction: async button => {
      button.disabled = true;
      button.textContent = 'Buying...';
      const live = availableShopItems().find(item => item.shop === row.shop && item.id === row.id);
      if (!live) { toast('This item is no longer available.', 'error'); stopAlarm(owner); return; }
      // A capped tool is only bought up to its cap: the server refuses every purchase past it.
      const count = Math.min(live.remaining, capRoom(live.id, live.item));
      if (!count) { toast(`You already hold the most ${humanize(live.id)} the game allows.`, 'error'); stopAlarm(owner); return; }
      // One purchase for the whole amount, as the game's own Buy All sends since v1291. viewMode (the
      // shop's list/grid setting) is required or the server rejects it; quantity is omitted for one.
      // A throw leaves the alarm up so it can be retried once the connection is back.
      sendQuinoaCommand({
        type: 'PurchaseShopItem', shop: live.shop, viewMode: 'list', item: itemPayload(live.item, live.shop),
        ...(count === 1 ? {} : { quantity: count }),
      });
      toast(`Requested ${count} ${humanize(live.id)}${count < live.remaining ? ' - that fills it to the cap' : ''}.`, 'success');
      stopAlarm(owner);
    },
  });
}

export function showSelectedShopAlarm(key: string): void {
  const row = availableShopItems().find(item => `${item.shop}:${item.id}` === key);
  if (row && !atInventoryCap(row.id, row.item)) showShopAlarm(row);
}

let shopAlarmTab = 'seed';

export function setShopAlarmTab(tab: string): void {
  if (tab) shopAlarmTab = tab;
}

/** Turning an alarm on checks current stock, so a selection made while stocked fires straight away. */
export function toggleShopAlert(key: string, enabled: boolean): void {
  if (enabled) config.shopAlerts[key] = true;
  else delete config.shopAlerts[key];
  if (enabled) {
    armAlarmAudio();
    showSelectedShopAlarm(key);
  } else stopAlarm(`shop:${key}`);
}

/** Mutes or unmutes just this item's alarm sound, live if it is already ringing. */
export function toggleShopAlertMuted(key: string, muted: boolean): void {
  if (muted) config.shopAlertsMuted[key] = true;
  else delete config.shopAlertsMuted[key];
  setAlarmSilenced(`shop:${key}`, muted);
}

export function renderShops(): string {
  const shops = state.game?.shops || {};
  const liveItems = new Map<string, ShopItem>();
  for (const item of shops[shopAlarmTab]?.inventory || []) {
    const id = itemId(item);
    if (id) liveItems.set(id, item);
  }
  const itemIds = [...new Set([...(SEASONAL_SHOP_ITEMS[shopAlarmTab] || []), ...liveItems.keys()])].filter(id => shopAlarmTab !== 'tool' || !EXCLUDED_TOOL_ALERTS.has(id));
  const available = new Set(availableShopItems().filter(row => row.shop === shopAlarmTab).map(row => row.id));
  const rows = itemIds.map(id => {
    const key = `${shopAlarmTab}:${id}`;
    const sprite = page.__gardenCompanionShopSprites?.[id];
    return `<label class="gc-check" data-filter-text="${escapeHtml(humanize(id).toLowerCase())}"><input type="checkbox" data-shop-alert="${escapeHtml(key)}" ${config.shopAlerts[key] ? 'checked' : ''}><span class="gc-shop-sprite">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}</span><span><b>${escapeHtml(humanize(id))}</b><small>${atInventoryCap(id, liveItems.get(id)) ? `Holding ${TOOL_LIMITS[id]} - no alarm` : available.has(id) ? 'Available now' : `${SHOP_NAMES[shopAlarmTab] || humanize(shopAlarmTab)} shop`}</small></span>${alertMuteButton(`data-shop-mute="${escapeHtml(key)}"`, Boolean(config.shopAlertsMuted[key]))}</label>`;
  });
  const tabs = SHOP_TABS.map(([id, label]) => `<button data-shop-tab="${id}" class="${shopAlarmTab === id ? 'active' : ''}">${label}</button>`).join('');
  return `<p class="gc-note">An alarm appears when a selected item becomes available. Buy all only runs after you click it.</p><div class="gc-shop-tabs">${tabs}</div><input class="gc-search" data-shop-search placeholder="Search ${escapeHtml(SHOP_NAMES[shopAlarmTab] || humanize(shopAlarmTab))} shop"><div class="gc-check-grid gc-filter-list">${rows.join('') || '<p class="gc-empty">Waiting for shop data.</p>'}</div>`;
}

export function bindShopEvents(main: HTMLElement): void {
  main.querySelectorAll('[data-shop-alert]').forEach(element => (element as HTMLInputElement).onchange = () => {
    const input = element as HTMLInputElement;
    toggleShopAlert(input.dataset.shopAlert!, input.checked);
    saveConfig();
  });
  main.querySelectorAll<HTMLButtonElement>('[data-shop-mute]').forEach(button => button.onclick = event => {
    // Inside the row's label, so the click must be kept from toggling the alert checkbox as well.
    event.preventDefault();
    event.stopPropagation();
    const muted = button.dataset.muted !== 'true';
    toggleShopAlertMuted(button.dataset.shopMute!, muted);
    button.dataset.muted = String(muted);
    button.innerHTML = muted ? '&#128263;' : '&#128266;';
    saveConfig();
  });
  main.querySelectorAll<HTMLButtonElement>('[data-shop-tab]').forEach(button => button.onclick = () => { setShopAlarmTab(button.dataset.shopTab || ''); panelActions.renderPanel(); });
  bindListSearch(main.querySelector('[data-shop-search]'));
}
