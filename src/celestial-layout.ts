export type CelestialGoal = 'amber' | 'dawn' | 'both';
export type CelestialSpecies = 'MoonCelestial' | 'DawnCelestial' | 'Dawnbreaker' | 'Starweaver';

export interface CelestialLayoutCell {
  species: CelestialSpecies | null;
  amber: boolean;
  dawn: boolean;
  met: boolean;
}

export interface CelestialLayoutResult {
  cells: CelestialLayoutCell[];
  required: number;
  met: number;
  error: string;
}

interface WorkingCell {
  species: CelestialSpecies | null;
  type: 'moon' | 'dawn' | 'other' | 'empty';
}

interface Inspection {
  score: number;
  required: number;
  met: number;
  coverage: Array<{ amber: boolean; dawn: boolean }>;
}

function cellType(species: CelestialSpecies | null): WorkingCell['type'] {
  if (species === 'MoonCelestial') return 'moon';
  if (species === 'DawnCelestial') return 'dawn';
  return species ? 'other' : 'empty';
}

function seededRandom(seedText: string): () => number {
  let seed = 2166136261;
  for (const character of seedText) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619);
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let index = items.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [items[index], items[other]] = [items[other], items[index]];
  }
  return items;
}

function inspect(cells: WorkingCell[], rows: number, columns: number, goal: CelestialGoal, blocked: readonly boolean[], includeCoverage = false): Inspection {
  const coverage = includeCoverage
    ? Array.from({ length: cells.length }, () => ({ amber: false, dawn: false }))
    : [];
  let required = 0;
  let met = 0;
  let score = 0;
  let minRow = rows;
  let maxRow = -1;
  let minColumn = columns;
  let maxColumn = -1;
  let distanceFromCenter = 0;
  const centerRow = (rows - 1) / 2;
  const centerColumn = (columns - 1) / 2;
  for (let index = 0; index < cells.length; index++) {
    if (cells[index].type === 'empty') continue;
    const row = Math.floor(index / columns);
    const column = index % columns;
    let amber = false;
    let dawn = false;
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
        if (rowOffset === 0 && columnOffset === 0) continue;
        const neighbourRow = row + rowOffset;
        const neighbourColumn = column + columnOffset;
        if (neighbourRow < 0 || neighbourRow >= rows || neighbourColumn < 0 || neighbourColumn >= columns) continue;
        const neighbour = cells[neighbourRow * columns + neighbourColumn];
        if (neighbour.type === 'moon') amber = true;
        if (neighbour.type === 'dawn') dawn = true;
      }
    }
    if (includeCoverage) coverage[index] = { amber, dawn };
    const hasRequiredBuffs = (goal === 'dawn' || goal === 'both' ? dawn : true)
      && (goal === 'amber' || goal === 'both' ? amber : true);
    required++;
    if (hasRequiredBuffs) met++;
    score += hasRequiredBuffs ? 30 : -1_000_000;
    if (blocked[index]) score -= 10_000;
    if (amber && dawn) score += 0.2;
    distanceFromCenter += Math.abs(row - centerRow) + Math.abs(column - centerColumn);
    minRow = Math.min(minRow, row);
    maxRow = Math.max(maxRow, row);
    minColumn = Math.min(minColumn, column);
    maxColumn = Math.max(maxColumn, column);
  }
  if (required) {
    const occupiedArea = (maxRow - minRow + 1) * (maxColumn - minColumn + 1);
    const emptyInside = occupiedArea - required;
    const layoutCenterOffset = Math.abs((minRow + maxRow) / 2 - centerRow)
      + Math.abs((minColumn + maxColumn) / 2 - centerColumn);
    score -= occupiedArea * 1.5;
    score -= emptyInside * 2;
    score -= layoutCenterOffset * 8;
    score -= distanceFromCenter * 0.08;
  }
  return { score, required, met, coverage };
}

function initialLayout(species: CelestialSpecies[], rows: number, columns: number, random: () => number, blocked: readonly boolean[]): WorkingCell[] {
  const positions = Array.from({ length: rows * columns }, (_, index) => index).sort((left, right) => {
    if (Boolean(blocked[left]) !== Boolean(blocked[right])) return blocked[left] ? 1 : -1;
    const leftRow = Math.floor(left / columns);
    const leftColumn = left % columns;
    const rightRow = Math.floor(right / columns);
    const rightColumn = right % columns;
    const leftDistance = Math.max(Math.abs(leftRow - (rows - 1) / 2), Math.abs(leftColumn - (columns - 1) / 2));
    const rightDistance = Math.max(Math.abs(rightRow - (rows - 1) / 2), Math.abs(rightColumn - (columns - 1) / 2));
    return leftDistance - rightDistance || left - right;
  });
  const shuffled = shuffle([...species], random);
  const cells: WorkingCell[] = Array.from({ length: rows * columns }, () => ({ species: null, type: 'empty' }));
  shuffled.forEach((plant, index) => { cells[positions[index]] = { species: plant, type: cellType(plant) }; });
  return cells;
}

function singleBuffLayout(
  species: CelestialSpecies[],
  rows: number,
  columns: number,
  goal: 'amber' | 'dawn',
  blocked: readonly boolean[],
): WorkingCell[] | null {
  const sourceSpecies: CelestialSpecies = goal === 'amber' ? 'MoonCelestial' : 'DawnCelestial';
  const sourceCount = species.filter(name => name === sourceSpecies).length;
  if (sourceCount < 2) return null;
  const capacity = rows * columns;
  const centerRow = (rows - 1) / 2;
  const centerColumn = (columns - 1) / 2;
  const neighbours = (index: number): number[] => {
    const row = Math.floor(index / columns);
    const column = index % columns;
    const found: number[] = [];
    for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
      for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
        if (!rowOffset && !columnOffset) continue;
        const nextRow = row + rowOffset;
        const nextColumn = column + columnOffset;
        if (nextRow >= 0 && nextRow < rows && nextColumn >= 0 && nextColumn < columns) found.push(nextRow * columns + nextColumn);
      }
    }
    return found;
  };
  const pairs: Array<{ sources: [number, number]; covered: number[] }> = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const first = row * columns + column;
      for (const second of [column + 1 < columns ? first + 1 : -1, row + 1 < rows ? first + columns : -1]) {
        if (second < 0) continue;
        pairs.push({ sources: [first, second], covered: [...new Set([...neighbours(first), ...neighbours(second)])] });
      }
    }
  }

  const selectedSources = new Set<number>();
  const covered = new Set<number>();
  while (covered.size < species.length && selectedSources.size + 2 <= sourceCount) {
    let best: typeof pairs[number] | null = null;
    let bestScore = -Infinity;
    for (const pair of pairs) {
      if (selectedSources.has(pair.sources[0]) || selectedSources.has(pair.sources[1])) continue;
      const newlyCovered = pair.covered.filter(index => !covered.has(index));
      const emptyGain = newlyCovered.filter(index => !blocked[index]).length;
      const pairCenterDistance = pair.sources.reduce((total, index) => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        return total + Math.abs(row - centerRow) + Math.abs(column - centerColumn);
      }, 0);
      const score = newlyCovered.length * 100_000 + emptyGain * 1_000 - pairCenterDistance;
      if (score > bestScore) { best = pair; bestScore = score; }
    }
    if (!best) break;
    best.sources.forEach(index => selectedSources.add(index));
    best.covered.forEach(index => covered.add(index));
  }
  if (covered.size < species.length || selectedSources.size > sourceCount) return null;

  const selectable = [...covered].filter(index => !selectedSources.has(index)).sort((left, right) => {
    if (Boolean(blocked[left]) !== Boolean(blocked[right])) return blocked[left] ? 1 : -1;
    const leftDistance = Math.abs(Math.floor(left / columns) - centerRow) + Math.abs(left % columns - centerColumn);
    const rightDistance = Math.abs(Math.floor(right / columns) - centerRow) + Math.abs(right % columns - centerColumn);
    return leftDistance - rightDistance || left - right;
  });
  while (selectedSources.size < sourceCount) {
    const next = selectable.shift();
    if (next === undefined) return null;
    selectedSources.add(next);
  }
  const cells: WorkingCell[] = Array.from({ length: capacity }, () => ({ species: null, type: 'empty' }));
  selectedSources.forEach(index => { cells[index] = { species: sourceSpecies, type: cellType(sourceSpecies) }; });
  const otherSpecies = species.filter(name => name !== sourceSpecies);
  const remainingPositions = [...covered].filter(index => !selectedSources.has(index)).sort((left, right) => {
    if (Boolean(blocked[left]) !== Boolean(blocked[right])) return blocked[left] ? 1 : -1;
    return left - right;
  });
  otherSpecies.forEach((name, index) => {
    const position = remainingPositions[index];
    if (position !== undefined) cells[position] = { species: name, type: cellType(name) };
  });
  return cells;
}

function resultFrom(cells: WorkingCell[], inspection: Inspection, goal: CelestialGoal): CelestialLayoutResult {
  return {
    cells: cells.map((cell, index) => ({
      species: cell.species,
      amber: inspection.coverage[index].amber,
      dawn: inspection.coverage[index].dawn,
      met: cell.type === 'empty' || (goal === 'dawn' || goal === 'both' ? inspection.coverage[index].dawn : true)
        && (goal === 'amber' || goal === 'both' ? inspection.coverage[index].amber : true),
    })),
    required: inspection.required,
    met: inspection.met,
    error: inspection.met === inspection.required ? '' : `${inspection.required - inspection.met} plant slots could not receive the selected buffs.`,
  };
}

export function generateCelestialLayout(
  species: CelestialSpecies[],
  rows: number,
  columns: number,
  goal: CelestialGoal,
  blocked: readonly boolean[] = [],
): CelestialLayoutResult {
  const capacity = rows * columns;
  if (!species.length) return { cells: [], required: 0, met: 0, error: 'No celestial plants are currently planted.' };
  if (species.length > capacity) return { cells: [], required: species.length, met: 0, error: `The selected side has ${capacity} slots, but ${species.length} celestial plants are planted.` };
  const moonCount = species.filter(name => name === 'MoonCelestial').length;
  const dawnCount = species.filter(name => name === 'DawnCelestial').length;
  if ((goal === 'amber' || goal === 'both') && moonCount < 2) {
    return { cells: [], required: species.length, met: 0, error: 'At least two Moonbinders are needed because a plant cannot grant Amberbound to itself.' };
  }
  if ((goal === 'dawn' || goal === 'both') && dawnCount < 2) {
    return { cells: [], required: species.length, met: 0, error: 'At least two Dawnbinders are needed because a plant cannot grant Dawnbound to itself.' };
  }

  if (goal === 'amber' || goal === 'dawn') {
    const constructed = singleBuffLayout(species, rows, columns, goal, blocked);
    if (constructed) {
      const inspection = inspect(constructed, rows, columns, goal, blocked, true);
      if (inspection.met === inspection.required) return resultFrom(constructed, inspection, goal);
    }
  }

  const random = seededRandom(`${rows}x${columns}:${goal}:${[...species].sort().join(',')}:${blocked.map(value => value ? 1 : 0).join('')}`);
  const amberCapacity = moonCount * 8;
  const dawnCapacity = dawnCount * 8;
  const provablyImpossible = (goal === 'amber' || goal === 'both' ? species.length > amberCapacity : false)
    || (goal === 'dawn' || goal === 'both' ? species.length > dawnCapacity : false);
  const restarts = provablyImpossible ? 2 : 8;
  const steps = provablyImpossible ? 300 : 900;
  const deadline = performance.now() + 120;
  let best: WorkingCell[] | null = null;
  let bestInspection: Inspection | null = null;
  for (let restart = 0; restart < restarts; restart++) {
    const current = initialLayout(species, rows, columns, random, blocked);
    let currentInspection = inspect(current, rows, columns, goal, blocked);
    for (let step = 0; step < steps && currentInspection.met !== currentInspection.required; step++) {
      if ((step & 31) === 0 && performance.now() >= deadline) break;
      const first = Math.floor(random() * current.length);
      let second = Math.floor(random() * current.length);
      for (let attempt = 0; attempt < 8 && current[first].type === current[second].type; attempt++) {
        second = Math.floor(random() * current.length);
      }
      if (first === second || current[first].type === current[second].type) continue;
      [current[first], current[second]] = [current[second], current[first]];
      const candidate = inspect(current, rows, columns, goal, blocked);
      const temperature = Math.max(0.05, 1.1 * (1 - step / steps));
      if (candidate.score >= currentInspection.score || random() < Math.exp((candidate.score - currentInspection.score) / temperature)) {
        currentInspection = candidate;
      } else {
        [current[first], current[second]] = [current[second], current[first]];
      }
    }
    if (!bestInspection || currentInspection.score > bestInspection.score) {
      best = current.map(cell => ({ ...cell }));
      bestInspection = currentInspection;
    }
    if (bestInspection.met === bestInspection.required || performance.now() >= deadline) break;
  }

  const finalCells = best ?? initialLayout(species, rows, columns, random, blocked);
  const result = inspect(finalCells, rows, columns, goal, blocked, true);
  return resultFrom(finalCells, result, goal);
}
