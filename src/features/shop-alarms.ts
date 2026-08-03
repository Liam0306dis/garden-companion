import type { ShopItem } from '../types.js';
import { armAlarmAudio, showAlarmBanner, stopAlarm, updateAlarmDetail } from '../alarms.js';
import { config, feature, saveConfig } from '../config.js';
import { EXCLUDED_TOOL_ALERTS, ITEM_KEYS, SEASONAL_SHOP_ITEMS, SHOP_NAMES, SHOP_TABS } from '../constants.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { bindListSearch } from '../list-search.js';
import { page } from '../page.js';
import { panelActions } from '../panel-actions.js';
import { state } from '../state.js';
import { toast } from '../toast.js';
import { escapeHtml, humanize } from '../utils.js';

/** Watches shop stock and raises an alarm when an item the player selected comes back in stock. */

interface AvailableShopItem {
  shop: string;
  id: string;
  item: ShopItem;
  remaining: number;
}

const INITIAL_SHOP_SETTLE_MS = 500;

function itemId(item): string {
  for (const key of ITEM_KEYS) if (item?.[key]) return String(item[key]);
  return '';
}

function itemType(item, shop) {
  if (item?.itemType) return item.itemType;
  return { seed: 'Seed', egg: 'Egg', decor: 'Decor', tool: 'Tool' }[shop] || (item?.eggId ? 'Egg' : item?.decorId ? 'Decor' : item?.toolId ? 'Tool' : 'Seed');
}

function itemPayload(item, shop) {
  const payload = { itemType: itemType(item, shop) };
  for (const key of ITEM_KEYS) if (item?.[key]) payload[key] = item[key];
  return payload;
}

function purchasedCount(shop, id) {
  const purchases = state.slot?.data?.shopPurchases?.[shop]?.purchases || {};
  return Number(purchases[id] || 0);
}

function availableShopItems(): AvailableShopItem[] {
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
    if (!config.shopAlerts[key]) continue;
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
    const available = availableShopItems();
    const latestSignature = shopSignature(available);
    if (latestSignature !== pendingInitialSignature) {
      settleInitialShops(latestSignature);
      return;
    }
    applyShopSnapshot(available, latestSignature, new Set());
  }, INITIAL_SHOP_SETTLE_MS);
}

export function processShops(): void {
  if (!feature('shopAlarms')) return;
  // Read the clocks first: a restock that changes nothing about stock still has to be noticed.
  const restocked = restockedShops();
  const available = availableShopItems();
  const signature = shopSignature(available);
  if (!state.initializedShops) {
    settleInitialShops(signature);
    return;
  }
  applyShopSnapshot(available, signature, restocked);
}

function showShopAlarm(row: AvailableShopItem): void {
  const owner = `shop:${row.shop}:${row.id}`;
  showAlarmBanner({
    owner,
    label: `SHOP ALARM | ${SHOP_NAMES[row.shop] || humanize(row.shop)}`,
    title: `${humanize(row.id)} is available`,
    detail: `${row.remaining} remaining`,
    actionLabel: 'Buy all',
    onAction: async button => {
      button.disabled = true;
      button.textContent = 'Buying...';
      const live = availableShopItems().find(item => item.shop === row.shop && item.id === row.id);
      if (!live) { toast('This item is no longer available.', 'error'); stopAlarm(owner); return; }
      for (let index = 0; index < live.remaining; index++) {
        sendQuinoaCommand({ type: 'PurchaseShopItem', shop: live.shop, item: itemPayload(live.item, live.shop) });
        if (index + 1 < live.remaining) await new Promise(resolve => setTimeout(resolve, 180));
      }
      toast(`Requested ${live.remaining} ${humanize(live.id)}.`, 'success');
      stopAlarm(owner);
    },
  });
}

export function showSelectedShopAlarm(key: string): void {
  const row = availableShopItems().find(item => `${item.shop}:${item.id}` === key);
  if (row) showShopAlarm(row);
}

let shopAlarmTab = 'seed';

export function setShopAlarmTab(tab: string): void {
  if (tab) shopAlarmTab = tab;
}

/** Turning an alarm on checks current stock, so a selection made while stocked fires straight away. */
export function toggleShopAlert(key: string, enabled: boolean): void {
  config.shopAlerts[key] = enabled;
  if (enabled) {
    armAlarmAudio();
    showSelectedShopAlarm(key);
  } else stopAlarm(`shop:${key}`);
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
    return `<label class="gc-check" data-filter-text="${escapeHtml(humanize(id).toLowerCase())}"><input type="checkbox" data-shop-alert="${escapeHtml(key)}" ${config.shopAlerts[key] ? 'checked' : ''}><span class="gc-shop-sprite">${sprite ? `<img src="${escapeHtml(sprite)}" alt="">` : ''}</span><span><b>${escapeHtml(humanize(id))}</b><small>${available.has(id) ? 'Available now' : `${SHOP_NAMES[shopAlarmTab] || humanize(shopAlarmTab)} shop`}</small></span></label>`;
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
  main.querySelectorAll<HTMLButtonElement>('[data-shop-tab]').forEach(button => button.onclick = () => { setShopAlarmTab(button.dataset.shopTab || ''); panelActions.renderPanel(); });
  bindListSearch(main.querySelector('[data-shop-search]'));
}
