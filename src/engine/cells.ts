export const COLS = 20; // A..T
export const ROWS = 20; // 1..20

/** 形如 A1 / T20 的单元格地址（大写、无前导零） */
export type Addr = string;

/** 把列索引（0 起）转成字母：0 -> A，19 -> T */
export function colToLetter(col: number): string {
  return String.fromCharCode(65 + col);
}

/** 列字母转索引：A -> 0，T -> 19；非法返回 -1 */
export function letterToCol(letter: string): number {
  const code = letter.charCodeAt(0);
  if (code < 65 || code > 64 + COLS) return -1;
  return code - 65;
}

/** 规范化引用：小写转大写；非法（超出 A1..T20 或格式错误）返回 null */
export function normalizeRef(text: string): Addr | null {
  const m = /^([A-Ta-t])(0?[1-9]|1[0-9]|20)$/.exec(text);
  if (!m) return null;
  return m[1].toUpperCase() + String(parseInt(m[2], 10));
}

/** (col, row 0 起) -> 地址；越界返回 null */
export function keyOf(col: number, row: number): Addr | null {
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return null;
  return colToLetter(col) + (row + 1);
}

/** 地址 -> (col, row 0 起)；非法返回 null */
export function parseAddr(addr: string): { col: number; row: number } | null {
  const m = /^([A-T])([1-9]|1[0-9]|20)$/.exec(addr);
  if (!m) return null;
  return { col: m[1].charCodeAt(0) - 65, row: parseInt(m[2], 10) - 1 };
}

/** 当前网格是否包含某地址 */
export function inBounds(addr: Addr): boolean {
  return parseAddr(addr) !== null;
}
