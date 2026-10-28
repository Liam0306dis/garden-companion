/**
 * Every tool id the companion knows to draw or list. Kept in a module of its own, free of the baked
 * catalogs, because the sprite loader runs as a separate page bundle and importing constants would
 * drag every catalog in with it.
 *
 * The Shards are the Rain and Amber shops' tools. The potions, capsules, Camera and Shovel are never
 * sold in a shop the alarms watch, but they sit in the inventory and Tool Shack, which the Auto
 * Storage tab lists.
 */
export const TOOL_IDS = [
  'PlanterPot', 'WateringCan', 'CropCleanser', 'XPPotion', 'ReplenishPotion', 'ChilledPotion', 'FrozenPotion',
  'RainWardShard', 'SnowWardShard', 'ThunderWardShard', 'HungerShard', 'XPShard', 'StrengthShard', 'CarvingKnife',
  'GoldPotion', 'RainbowPotion', 'WetPotion', 'AmberlitPotion', 'DawnlitPotion', 'DawnCapsule', 'AmberCapsule', 'Camera', 'Shovel',
];
