import treeGridData from "@/data/tree-grid.sample.json";
import type { LatLngLiteral, TreeGridCell, TreeGridData } from "@/lib/types";
import { distanceMeters } from "@/lib/utils";

let cachedLookup: Map<string, TreeGridCell> | null = null;

export function getTreeGrid(): TreeGridData {
  return treeGridData as unknown as TreeGridData;
}

export function buildCellLookup(grid = getTreeGrid()): Map<string, TreeGridCell> {
  if (!cachedLookup) {
    cachedLookup = new Map(grid.cells.map((cell) => [cell.key, cell]));
  }

  return cachedLookup;
}

export function getGridKey(point: LatLngLiteral, grid = getTreeGrid()): string {
  const latIndex = Math.floor((point.lat - grid.origin.lat) / grid.latStep);
  const lngIndex = Math.floor((point.lng - grid.origin.lng) / grid.lngStep);
  return `${latIndex}:${lngIndex}`;
}

export function lookupTreeCell(point: LatLngLiteral, grid = getTreeGrid()): TreeGridCell | null {
  return buildCellLookup(grid).get(getGridKey(point, grid)) ?? null;
}

/**
 * Returns all cells whose centers fall within `radiusMeters` of `point`.
 * With a fine-resolution grid (e.g. ~20 m cells) this captures every tree
 * that a pedestrian at that point could realistically be exposed to.
 */
export function lookupTreeCellsInRadius(
  point: LatLngLiteral,
  radiusMeters: number,
  grid = getTreeGrid(),
): TreeGridCell[] {
  const lookup = buildCellLookup(grid);
  const latIndex = Math.floor((point.lat - grid.origin.lat) / grid.latStep);
  const lngIndex = Math.floor((point.lng - grid.origin.lng) / grid.lngStep);

  // How many cell steps to scan in each axis (~111 km/deg lat, ~84 km/deg lng at NYC)
  const latRange = Math.ceil(radiusMeters / (grid.latStep * 111_000)) + 1;
  const lngRange = Math.ceil(radiusMeters / (grid.lngStep * 84_000)) + 1;

  // The primary cell (the one that contains the point) is always included —
  // the pedestrian is literally inside it, regardless of distance to its center.
  const primaryKey = `${latIndex}:${lngIndex}`;
  const results: TreeGridCell[] = [];

  for (let dlat = -latRange; dlat <= latRange; dlat++) {
    for (let dlng = -lngRange; dlng <= lngRange; dlng++) {
      const key = `${latIndex + dlat}:${lngIndex + dlng}`;
      const cell = lookup.get(key);
      if (!cell) continue;
      if (key === primaryKey || distanceMeters(point, cell.center) <= radiusMeters) {
        results.push(cell);
      }
    }
  }

  return results;
}
