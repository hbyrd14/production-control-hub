/** Fixed control-surface geometry: 8 columns × 4 rows = 32 keys (XL-class layout). */
export const GRID_COLUMNS = 8;
export const GRID_ROWS = 4;
export const KEY_COUNT = GRID_COLUMNS * GRID_ROWS;

export function keyIndex(row: number, column: number): number {
  return row * GRID_COLUMNS + column;
}

export function keyPosition(index: number): { row: number; column: number } {
  return { row: Math.floor(index / GRID_COLUMNS), column: index % GRID_COLUMNS };
}

export function isValidKeyIndex(index: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < KEY_COUNT;
}
