import { inBounds, type Addr } from './cells';
import type { CellState } from './engine';

/** 一次假设修改允许的候选格数上限 */
export const MAX_WHATIF_CELLS = 3;

/** 一格候选修改：唯一格地址 + 原始输入（空白表示清空该格） */
export interface WhatIfCandidate {
  addr: Addr;
  raw: string;
}

/** 预演中一格的前后对照（空格一侧为 null） */
export interface WhatIfChange {
  addr: Addr;
  before: CellState | null;
  after: CellState | null;
}

export interface WhatIfPreview {
  /** 预演所依据的正式网格修订号；确认时必须仍匹配，否则视为过期 */
  baseRevision: number;
  candidates: WhatIfCandidate[];
  /** 仅列出精确值 / 错误类型 / 来源路径发生变化的格（按地址排序） */
  changes: WhatIfChange[];
}

export type WhatIfResult =
  | { ok: true; preview: WhatIfPreview }
  | { ok: false; errors: string[] };

/**
 * 校验候选组：1～3 格、地址在 A1..T20 内且不重复。
 * 任何一项不合法即整组拒绝（返回全部原因），不写入任何结果。
 * 公式语法错误不在此拒绝——它遵循现有表格语义，在候选结果中标为 #ERR!。
 */
export function validateWhatIfCandidates(
  candidates: WhatIfCandidate[],
): string[] {
  const errors: string[] = [];
  if (candidates.length === 0) {
    errors.push('至少需要 1 格候选修改');
    return errors;
  }
  if (candidates.length > MAX_WHATIF_CELLS) {
    errors.push(
      `一次最多 ${MAX_WHATIF_CELLS} 格假设修改，实际给出 ${candidates.length} 格`,
    );
  }
  const seen = new Set<Addr>();
  candidates.forEach((c, i) => {
    const where = `候选 ${i + 1}`;
    if (typeof c.addr !== 'string' || !inBounds(c.addr)) {
      errors.push(`${where}：地址 ${JSON.stringify(c.addr)} 超出 A1..T20，整组拒绝`);
      return;
    }
    if (seen.has(c.addr)) {
      errors.push(`${where}：地址 ${c.addr} 重复，整组拒绝`);
      return;
    }
    seen.add(c.addr);
    if (typeof c.raw !== 'string') {
      errors.push(`${where}（${c.addr}）：raw 必须是字符串`);
    }
  });
  return errors;
}

function samePath(a: Addr[] | undefined, b: Addr[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * 两格结果是否一致：精确分数值、错误类型、错误来源与传播/环路径全部相同。
 * 原始输入文本本身不参与比较（改了文本但结果相同的格不列入预演变化）。
 */
export function sameOutcome(
  a: CellState | null,
  b: CellState | null,
): boolean {
  if (a === null || b === null) return a === b;
  const av = a.value;
  const bv = b.value;
  if (av === null || bv === null) {
    if (av !== bv) return false;
  } else if (av.numer !== bv.numer || av.den !== bv.den) {
    return false;
  }
  const ae = a.error;
  const be = b.error;
  if (ae === null || be === null) return ae === be;
  return (
    ae.type === be.type &&
    ae.source === be.source &&
    samePath(ae.path, be.path) &&
    samePath(ae.cycle, be.cycle)
  );
}
