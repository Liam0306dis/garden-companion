import { feature } from '../config.js';
import { sendQuinoaCommand } from '../game-connection.js';
import { state } from '../state.js';

/**
 * Seeds into the Seed Silo, decor into the Decor Shed, and only where the storage already holds a
 * stack of the same thing. Filing something the storage has never held is a decision about how you
 * want your storage laid out; topping up a stack that is already there is not, which is why the
 * rule is drawn here.
 *
 * The silo keys its contents by species and the shed by decor id - neither carries an item id - so
 * those are what PutItemInStorage is given, matching what the game sends when you drag one across.
 */

/** Items in a storage or the inventory. The shared Pet type does not describe seeds or decor. */
interface StoredItem {
  itemType?: string;
  species?: string;
  decorId?: string;
  quantity?: number;
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
];

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

function storedKeys(rule: StoreRule): Set<string> {
  const storage = (state.slot?.data?.inventory?.storages ?? []).find(entry => entry.decorId === rule.storageId);
  const items = (storage?.items ?? []) as unknown as StoredItem[];
  const keys = new Set<string>();
  for (const item of items) {
    const key = rule.key(item);
    if (key) keys.add(key);
  }
  return keys;
}

/** Everything that decides what would be sent, so an unchanged inventory can be left alone. */
function inventorySignature(): string {
  return inventoryItems()
    .filter(item => RULES.some(rule => rule.itemType === item.itemType))
    .map(item => `${item.itemType}:${item.species ?? item.decorId ?? ''}:${item.quantity ?? ''}`)
    .join('|');
}

function flush(): void {
  const now = Date.now();
  for (const [key, at] of sentAt) if (now - at > RESEND_GRACE_MS) sentAt.delete(key);
  const signature = inventorySignature();
  if (signature === lastQueuedSignature) return;
  let queuedAny = false;
  for (const rule of RULES) {
    if (!rule.enabled()) continue;
    const stored = storedKeys(rule);
    if (!stored.size) continue;
    for (const item of inventoryItems()) {
      if (item.itemType !== rule.itemType) continue;
      const key = rule.key(item);
      if (!key || !stored.has(key)) continue;
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
  if (next.rule.enabled()) {
    // Marked only once it is away, so the grace covers waiting for the echo rather than the wait
    // in the queue behind everything else.
    try {
      sendQuinoaCommand({ type: 'PutItemInStorage', itemId: next.key, storageId: next.rule.storageId });
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
