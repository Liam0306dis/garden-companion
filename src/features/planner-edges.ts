/**
 * The Layout planner's edge geometry, kept apart from the planner itself so it can be tested
 * without a game scene.
 */

export type Side = 'up' | 'right' | 'down' | 'left';

/**
 * The edge on one side of a garden-relative tile: `h` edges run along a tile's top, `v` edges down
 * its left. Garden-relative means counted from the top-left corner of the box around the garden's
 * dirt and boardwalk tiles, which is how the game keys them too.
 */
export function edgeKey(x: number, y: number, side: Side): string {
  switch (side) {
    case 'up': return `h:${x}:${y}`;
    case 'down': return `h:${x}:${y + 1}`;
    case 'left': return `v:${x}:${y}`;
    case 'right': return `v:${x + 1}:${y}`;
  }
}

/**
 * The edge a point (in world tiles) is pointing at: the nearest side of the tile it is in, if it is
 * within `reach` of it (a fraction of a tile) and `holds` says that edge has what is wanted. Nearer
 * sides are tried first, so at a corner the closer of the two lines wins - and if that one holds
 * nothing, the other still can. `origin` is the world tile the garden's box starts at. The tile does
 * not have to belong to the garden: an edge on its outer border is reachable from outside, where the
 * edge's art hangs.
 */
export function nearestEdge(
  point: { x: number; y: number },
  origin: { x: number; y: number },
  reach: number,
  holds: (key: string) => boolean,
): string | null {
  const tileX = Math.floor(point.x);
  const tileY = Math.floor(point.y);
  const fx = point.x - tileX;
  const fy = point.y - tileY;
  const sides: Array<[Side, number]> = [['up', fy], ['down', 1 - fy], ['left', fx], ['right', 1 - fx]];
  sides.sort((a, b) => a[1] - b[1]);
  for (const [side, distance] of sides) {
    if (distance > reach) break;
    const key = edgeKey(tileX - origin.x, tileY - origin.y, side);
    if (holds(key)) return key;
  }
  return null;
}
