import { feature } from '../config.js';
import { TOOL_LIMITS } from '../constants.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { toolIsHeld } from '../pets.js';
import { state } from '../state.js';

/**
 * Seeds into the Seed Silo, decor into the Decor Shed, tools into the Tool Shack, and only where the
 * storage already holds a stack of the same thing. Filing something the storage has never held is a decision about how you
 * want your storage laid out; topping up a stack that is already there is not, which is why the
 * rule is drawn here.
 *
 * The silo keys its contents by species and the shed by decor id - neither carries an item id - so
 * those are what MoveItem is given, matching what the game sends when you drag one across.
 */

/** Items in a storage or the inventory. The shared Pet type does not describe seeds or decor. */
interface StoredItem {
  itemType?: string;
  species?: string;
  decorId?: string;
  toolId?: string;
  quantity?: number;
  /** Seconds left on a running crystal/shard. Absent or zero once it has burned out. */
  remainingActiveSeconds?: number;
}

interface StoreRule {
  storageId: string;
  itemType: string;
  key: (item: StoredItem) => string;
  enabled: () => boolean;
}

const RULES: StoreRule[] = [
  { storageId: 'SeedSilo', itemType: 'Seed', key: item => item.species ?? '', enabled: () => feature('autoStoreSeeds') },
  { storageId: 'DecorShed', itemType: 'Decor', key: item => item.decorId ?? '', enabled: () => feature('autoStoreDecor') },
  { storageId: 'ToolShack', itemType: 'Tool', key: item => item.toolId ?? '', enabled: () => feature('autoStoreTools') },
];

/**
 * A tool the script is about to use, or one in the player's hand, stays where it is.
 *
 * Tools are the only kind here that the script itself takes back out of storage, so they are the
 * only kind that can be filed away mid-use - a Planter Pot fetched for a drag, stored again before
 * the PotPlant lands, and the drag fails. The hold covers the fetch and the use together; the
 * selection covers the pot the keeper leaves in hand between drags, which no hold spans.
 *
 * Deliberately not a reserve. Keeping one of each tool loose would free none of the slots the Tool
 * Shack exists to free, which is the whole point of storing them.
 */
function isBusy(rule: StoreRule, key: string): boolean {
  if ((pauses.get(rule.itemType) ?? 0) > 0) return true;
  if (rule.itemType !== 'Tool') return false;
  return toolIsHeld(key) || state.selectedItemId === key;
}

/**
 * Item kinds whose filing is paused, counted so two operations pausing the same kind cannot resume
 * each other early.
 *
 * Deliberately in memory and never written to the config. A caller that switched the saved setting
 * off and back on would leave it off for good if two such callers overlapped, if anything saved
 * the config in between, or if the page reloaded mid-operation - a pause here just ends with the
 * page.
 */
const pauses = new Map<string, number>();

/** Stops auto-store filing the given item kinds until the returned release is called. */
export function pauseAutoStore(...itemTypes: Array<'Seed' | 'Decor' | 'Tool'>): () => void {
  for (const type of itemTypes) pauses.set(type, (pauses.get(type) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const type of itemTypes) pauses.set(type, Math.max(0, (pauses.get(type) ?? 0) - 1));
  };
}

/**
 * A crystal or shard still counting down runs on a timer, and the server refuses to file a running
 * one - MoveItem comes back "rejected". A rejection does not change the inventory, so nothing
 * marks it as dealt with, and every later patch that shifts the signature re-queues it, one rejected
 * command after another. A spent one (no time left) files away like any other tool, so only a running
 * one is held back. Keyed off the item's own timer rather than its name, since the ids do not all say
 * "crystal" (a Strength Crystal's shard is `StrengthShard`).
 */
function isTimedTool(item: StoredItem): boolean {
  return Number(item.remainingActiveSeconds) > 0;
}

/** As isTimedTool, but found by tool id - the drain recheck holds the key, not the item. */
function toolHasTimer(key: string): boolean {
  const item = inventoryItems().find(entry => entry.itemType === 'Tool' && entry.toolId === key);
  return Boolean(item) && isTimedTool(item!);
}

/** Patches arrive continuously, so the work is coalesced rather than run against every one. */
const DEBOUNCE_MS = 1_000;
/**
 * A move is only visible once the server echoes it back, so a key just sent is left alone for a
 * while. Without this the next few patches would still show the item in the inventory and it would
 * be sent again several times over.
 */
const RESEND_GRACE_MS = 5_000;

/** Moves leave one at a time rather than as a burst when a whole inventory becomes eligible. */
const SEND_INTERVAL_MS = 200;

let flushTimer = 0;
let drainTimer = 0;
const queue: Array<{ rule: StoreRule; key: string; pending: string }> = [];
/** Keys already waiting to go out. The grace below only starts once a move has actually been sent,
 *  so a long queue would otherwise outlive it and let the same key be queued a second time. */
const queued = new Set<string>();
const sentAt = new Map<string, number>();
/**
 * What the inventory looked like the last time anything was queued. Patches arrive whatever the
 * player is doing, so without this an item the server will not accept - a full silo, a refusal we
 * cannot see - would be sent again every few seconds for as long as the tab stayed open. A move
 * that lands changes the inventory, which is what lets the next one through.
 */
let lastQueuedSignature = '';

function inventoryItems(): StoredItem[] {
  return (state.slot?.data?.inventory?.items ?? []) as unknown as StoredItem[];
}

/** What the storage holds, by key, with the size of its first stack - the one the game tops up. */
function storedStacks(rule: StoreRule): Map<string, number> {
  const storage = (state.slot?.data?.inventory?.storages ?? []).find(entry => entry.decorId === rule.storageId);
  const items = (storage?.items ?? []) as unknown as StoredItem[];
  const stacks = new Map<string, number>();
  for (const item of items) {
    const key = rule.key(item);
    if (key && !stacks.has(key)) stacks.set(key, Number(item.quantity || 0));
  }
  return stacks;
}

/**
 * Capped tools (99 for most) stack to their limit in the Tool Shack just as in the inventory. The
 * game's MoveItem moves only as many as the shack's stack has room for - 10 onto 95 moves 4 and
 * leaves 6 - and refuses the move outright once that stack is full, so 10 Watering Cans onto a
 * shack holding 99 is rejected. Only tools carry a cap, as in the game's own check.
 */
function storageFull(rule: StoreRule, key: string, stored: number): boolean {
  if (rule.itemType !== 'Tool') return false;
  const limit = (TOOL_LIMITS as Record<string, number>)[key];
  return Boolean(limit) && stored >= limit;
}

/** As storageFull, read fresh - the drain recheck holds only the key. */
function storageFullNow(rule: StoreRule, key: string): boolean {
  return storageFull(rule, key, storedStacks(rule).get(key) ?? 0);
}

/**
 * Everything that decides what would be sent, so an unchanged picture can be left alone. Not just
 * the inventory: an item skipped because its storage was full, its kind was paused or its tool was
 * busy has to be looked at again once that clears, even though the inventory itself has not moved.
 */
function flushSignature(): string {
  const inventory = inventoryItems()
    .filter(item => RULES.some(rule => rule.itemType === item.itemType))
    .map(item => `${item.itemType}:${item.species ?? item.decorId ?? item.toolId ?? ''}:${item.quantity ?? ''}`)
    .join('|');
  const storages = RULES.map(rule => [...storedStacks(rule)].map(([key, count]) => `${key}:${count}`).join(',')).join('/');
  const paused = [...pauses].filter(([, count]) => count > 0).map(([type]) => type).join(',');
  // Only tools the Shack already holds, the ones a hold is actually keeping back. Switching between
  // any other tools must not change this, or every switch would resend moves the server refused.
  const toolRule = RULES.find(rule => rule.itemType === 'Tool')!;
  const shackTools = storedStacks(toolRule);
  const busyTools = inventoryItems()
    .filter(item => item.itemType === 'Tool' && item.toolId && shackTools.has(item.toolId) && isBusy(toolRule, item.toolId))
    .map(item => item.toolId)
    .join(',');
  return `${inventory}#${storages}#${paused}#${busyTools}`;
}

function flush(): void {
  const now = Date.now();
  for (const [key, at] of sentAt) if (now - at > RESEND_GRACE_MS) sentAt.delete(key);
  const signature = flushSignature();
  if (signature === lastQueuedSignature) return;
  let queuedAny = false;
  for (const rule of RULES) {
    if (!rule.enabled()) continue;
    const stored = storedStacks(rule);
    if (!stored.size) continue;
    for (const item of inventoryItems()) {
      if (item.itemType !== rule.itemType) continue;
      const key = rule.key(item);
      if (!key || !stored.has(key) || isBusy(rule, key) || isTimedTool(item)) continue;
      if (storageFull(rule, key, stored.get(key)!)) continue;
      const pending = `${rule.storageId}:${key}`;
      if (sentAt.has(pending) || queued.has(pending)) continue;
      queued.add(pending);
      queue.push({ rule, key, pending });
      queuedAny = true;
    }
  }
  if (queuedAny) lastQueuedSignature = signature;
  drain();
}

/**
 * One move per tick. A whole inventory of eligible seeds would otherwise leave as a single burst of
 * commands in one frame, and the rule is rechecked here because the queue outlives the flush that
 * filled it: the toggle can be turned off while it is still draining.
 */
function drain(): void {
  if (drainTimer || !queue.length) return;
  const next = queue.shift()!;
  queued.delete(next.pending);
  // Rechecked here as well as at queue time: a drag can start while a move for the same tool is
  // still sitting in the queue behind everything else.
  if (next.rule.enabled() && !isBusy(next.rule, next.key) && !toolHasTimer(next.key) && !storageFullNow(next.rule, next.key)) {
    // Marked only once it is away, so the grace covers waiting for the echo rather than the wait
    // in the queue behind everything else.
    try {
      sendQuinoaCommand({ type: 'MoveItem', from: 'inventory', to: next.rule.storageId, itemId: next.key });
      sentAt.set(next.pending, Date.now());
    } catch { /* nothing was sent, so nothing to hold back */ }
  }
  if (!queue.length) return;
  drainTimer = window.setTimeout(() => { drainTimer = 0; drain(); }, SEND_INTERVAL_MS);
}

export function processAutoStore(): void {
  if (!RULES.some(rule => rule.enabled())) return;
  if (flushTimer) return;
  flushTimer = window.setTimeout(() => { flushTimer = 0; flush(); }, DEBOUNCE_MS);
}
