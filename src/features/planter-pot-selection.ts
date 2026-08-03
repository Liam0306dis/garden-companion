import { page } from '../page.js';
import type { JotaiAtom } from '../types.js';

type AtomGetter = (atom: JotaiAtom) => unknown;
type AtomSetter = (atom: JotaiAtom, value: unknown) => unknown;
type AtomWrite = (get: AtomGetter, set: AtomSetter, ...args: unknown[]) => unknown;

interface InventoryItem {
  itemType?: string;
  id?: string;
  toolId?: string;
  quantity?: number;
}

interface PendingPotSelection {
  addedPlantIds: Set<string>;
  restoreItemId: string | null;
  expiresAt: number;
}

const wrappedAtoms = new WeakSet<JotaiAtom>();
let pendingSelection: PendingPotSelection | null = null;

function isEnabled(): boolean {
  return page.__gardenCompanionFeature?.('keepPlanterPotSelected') !== false;
}

function atomMap(): Map<unknown, JotaiAtom> | null {
  const cache = page.jotaiAtomCache;
  if (cache instanceof Map) return cache;
  return cache?.cache instanceof Map ? cache.cache : null;
}

function findAtom(map: Map<unknown, JotaiAtom>, debugLabel: string): JotaiAtom | null {
  for (const atom of map.values()) {
    if (atom?.debugLabel === debugLabel) return atom;
  }
  return null;
}

function planterPotCount(items: InventoryItem[]): number {
  return items.reduce((total, item) => {
    if (item?.itemType !== 'Tool' || item.toolId !== 'PlanterPot') return total;
    return total + (typeof item.quantity === 'number' ? item.quantity : 1);
  }, 0);
}

function plantIds(items: InventoryItem[]): Set<string> {
  return new Set(
    items
      .filter(item => item?.itemType === 'Plant' && typeof item.id === 'string')
      .map(item => item.id as string),
  );
}

function hasItemId(items: InventoryItem[], itemId: string): boolean {
  return items.some(item => item?.itemType === 'Tool' ? item.toolId === itemId : item?.id === itemId);
}

function installHooks(): boolean {
  const map = atomMap();
  if (!map) return false;

  const inventoryAtom = findAtom(map, 'myOptimisticInventoryItemsAtom');
  const selectedItemAtom = findAtom(map, 'mySelectedItemIdAtom');
  if (!inventoryAtom?.write || !selectedItemAtom?.write) return false;
  if (wrappedAtoms.has(inventoryAtom) || wrappedAtoms.has(selectedItemAtom)) return true;

  const originalInventoryWrite = inventoryAtom.write as AtomWrite;
  const originalSelectedItemWrite = selectedItemAtom.write as AtomWrite;

  inventoryAtom.write = function(get, set, ...args) {
    const typedGet = get as AtomGetter;
    const previousItems = typedGet(inventoryAtom);
    const nextItems = args[0];

    if (isEnabled() && Array.isArray(previousItems) && Array.isArray(nextItems)) {
      const selectedItemId = typedGet(selectedItemAtom);
      if (selectedItemId === 'PlanterPot' && planterPotCount(previousItems) - planterPotCount(nextItems) === 1) {
        const previousPlantIds = plantIds(previousItems);
        const addedPlantIds = new Set([...plantIds(nextItems)].filter(id => !previousPlantIds.has(id)));
        if (addedPlantIds.size > 0) {
          pendingSelection = {
            addedPlantIds,
            restoreItemId: hasItemId(nextItems, 'PlanterPot') ? 'PlanterPot' : null,
            expiresAt: performance.now() + 2_000,
          };
        }
      }
    }

    return originalInventoryWrite.call(this, typedGet, set as AtomSetter, ...args);
  };

  selectedItemAtom.write = function(get, set, ...args) {
    const pending = pendingSelection;
    if (!isEnabled()) pendingSelection = null;
    else if (pending && performance.now() <= pending.expiresAt) {
      pendingSelection = null;
      const nextItemId = args[0];
      if (typeof nextItemId === 'string' && pending.addedPlantIds.has(nextItemId)) {
        return originalSelectedItemWrite.call(this, get as AtomGetter, set as AtomSetter, pending.restoreItemId);
      }
    } else if (pending) pendingSelection = null;

    return originalSelectedItemWrite.call(this, get as AtomGetter, set as AtomSetter, ...args);
  };

  wrappedAtoms.add(inventoryAtom);
  wrappedAtoms.add(selectedItemAtom);
  return true;
}

export function initPlanterPotSelection(): void {
  if (installHooks()) return;
  const timer = window.setInterval(() => {
    if (installHooks()) window.clearInterval(timer);
  }, 250);
}
