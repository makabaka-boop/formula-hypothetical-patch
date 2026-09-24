import { inBounds, normalizeRef, type Addr } from './cells';
import { Fraction, ZeroDivision } from './fraction';
import {
  collectRefs,
  parseCellInput,
  ParseError,
  type Expr,
  type ParsedCell,
} from './parser';
import { affectedSet, cyclePathsForScc, tarjan, topoOrder } from './graph';

/* ------------------------------- 错误类型 ------------------------------- */

export type ErrorType = 'parse' | 'cycle' | 'divzero';

export interface CellError {
  type: ErrorType;
  /** 给质检员看的中文说明 */
  message: string;
  /** 错误起源格 */
  source: Addr;
  /** 从起源到当前格的完整引用路径（含两端） */
  path: Addr[];
  /** 仅循环引用：从当前格自身出发回到自身的实际环路径 */
  cycle?: Addr[];
}

/* ------------------------------- 单元快照 ------------------------------- */

export interface CellState {
  key: Addr;
  /** 原始输入文本（非空格才存在状态） */
  raw: string;
  kind: 'number' | 'formula';
  /** 直接依赖（去重） */
  deps: Addr[];
  /** 精确分数值；出错时为 null */
  value: Fraction | null;
  error: CellError | null;
}

export interface Snapshot {
  /** 原始输入 */
  raw: Map<Addr, string>;
  /** 当前计算结果（只含非空格），与 raw 同步生成、不可变 */
  states: Map<Addr, CellState>;
  /** 修订号：每次成功编辑/导入递增 */
  revision: number;
}

/* ----------------------------- 求值内部控制 ----------------------------- */

/** 求值中遇到依赖格的错误，携带应传播到当前格的错误 */
class EvalAbort extends Error {
  constructor(readonly cellError: CellError) {
    super('abort');
  }
}

export interface EditResult {
  ok: boolean;
  errors?: string[];
}

/* ------------------------- 纯函数：解析一份原始输入 ------------------------- */

interface ParsedAll {
  parsed: Map<Addr, ParsedCell>;
  parseErrors: Map<Addr, ParseError>;
  /** 依赖边：key -> 它引用到的格（解析失败的格为无边） */
  deps: Map<Addr, Addr[]>;
}

/** 解析一份完整的原始输入映射（正式网格与假设预演共用，保证语义一致） */
function parseAll(raw: Map<Addr, string>): ParsedAll {
  const parsed = new Map<Addr, ParsedCell>();
  const parseErrors = new Map<Addr, ParseError>();
  const deps = new Map<Addr, Addr[]>();
  for (const [key, text] of raw) {
    try {
      const p = parseCellInput(text);
      parsed.set(key, p);
      deps.set(key, p.kind === 'formula' ? collectRefs(p.expr) : []);
    } catch (e) {
      parseErrors.set(key, e as ParseError);
      deps.set(key, []);
    }
  }
  return { parsed, parseErrors, deps };
}

function kindOf(
  key: Addr,
  raw: Map<Addr, string>,
  p: ParsedCell | undefined,
): 'number' | 'formula' {
  if (p) return p.kind === 'formula' ? 'formula' : 'number';
  return raw.get(key)?.startsWith('=') ? 'formula' : 'number';
}

/* ---------------------- 纯函数：对一份 raw 构造最终依赖图并求值 ---------------------- */

/**
 * 依据给定 raw 构造最终依赖图（不是逐格中间态），完成 Tarjan 环检测、
 * 拓扑求值与错误传播，返回每格状态。
 *
 * - changed === null：全量重算（导入 / 假设预演）。
 * - changed 为集合：仅重算受影响集合，其余沿用 prevStates（单格增量编辑）；
 *   若被改格原在环中，旧环成员也全部重算，防止边删除导致遗漏。
 */
function buildStates(
  raw: Map<Addr, string>,
  changed: Set<Addr> | null,
  prevStates: Map<Addr, CellState>,
): Map<Addr, CellState> {
  // 1) 解析全部非空输入
  const { parsed, parseErrors, deps } = parseAll(raw);

  // 2) 环检测
  const { sccs, cyclic } = tarjan(deps);

  // 3) 受影响集合
  let affected: Set<Addr> | null;
  if (changed === null) {
    affected = null; // 全量重算
  } else {
    affected = affectedSet([...changed], deps);
    const oldCyclic = [...prevStates.values()].filter(
      (s) => s.error?.type === 'cycle',
    );
    if (oldCyclic.some((s) => changed.has(s.key))) {
      oldCyclic.forEach((s) => affected!.add(s.key));
    }
  }

  const next = new Map<Addr, CellState>();

  // 4) 环成员：一律标记循环引用，携带从自身出发的实际环路径
  for (const comp of sccs) {
    const isCyclicComp =
      comp.length > 1 || deps.get(comp[0])?.includes(comp[0]);
    if (!isCyclicComp) continue;
    const paths = cyclePathsForScc(comp, deps);
    for (const key of comp) {
      next.set(key, {
        key,
        raw: raw.get(key) ?? '',
        kind: kindOf(key, raw, parsed.get(key)),
        deps: deps.get(key) ?? [],
        value: null,
        error: {
          type: 'cycle',
          message: '循环引用',
          source: key,
          path: paths.get(key) ?? [key, key],
          cycle: paths.get(key) ?? [key, key],
        },
      });
    }
  }

  // 5) 非环节点拓扑序；不受影响者沿用旧结果（原始输入未变即仍有效）
  const nonCyclic = [...parsed.keys()].filter((k) => !cyclic.has(k));
  // 解析失败的格也需要状态
  for (const k of parseErrors.keys()) {
    if (!nonCyclic.includes(k) && !cyclic.has(k)) nonCyclic.push(k);
  }
  const order = topoOrder(nonCyclic, deps, cyclic);

  const evalExpr = (expr: Expr, owner: Addr): Fraction => {
    const evalRef = (addr: Addr): Fraction => {
      const st = next.get(addr);
      if (!st) return Fraction.ZERO; // 空格按 0 参与运算
      if (st.error) {
        // 错误沿引用链向下游传播：
        // 环格的路径是其自身环路径，传播时折叠为“来源格 -> 当前格”
        const base = cyclic.has(st.key) ? [st.error.source] : st.error.path;
        throw new EvalAbort({
          type: st.error.type,
          message: st.error.message,
          source: st.error.source,
          path: [...base, owner],
          // cycle 字段只保留在环内格自身上
        });
      }
      return st.value!;
    };
    switch (expr.kind) {
      case 'int':
        return new Fraction(expr.value);
      case 'ref':
        return evalRef(expr.addr);
      case 'unary':
        return evalExpr(expr.operand, owner).negate();
      case 'binary': {
        const l = evalExpr(expr.left, owner);
        const r = evalExpr(expr.right, owner);
        switch (expr.op) {
          case '+':
            return l.add(r);
          case '-':
            return l.sub(r);
          case '*':
            return l.mul(r);
          case '/':
            return l.div(r); // 分母为 0 抛 ZeroDivision
        }
      }
    }
  };

  for (const key of order) {
    if (cyclic.has(key)) continue;
    if (affected !== null && !affected.has(key) && prevStates.has(key)) {
      next.set(key, prevStates.get(key)!);
      continue;
    }

    const perr = parseErrors.get(key);
    if (perr) {
      next.set(key, {
        key,
        raw: raw.get(key) ?? '',
        kind: raw.get(key)?.startsWith('=') ? 'formula' : 'number',
        deps: [],
        value: null,
        error: {
          type: 'parse',
          message: `解析错误：${perr.message}`,
          source: key,
          path: [key],
        },
      });
      continue;
    }

    const p = parsed.get(key)!;
    if (p.kind === 'empty') continue; // 空格不产生状态，理论不可达
    try {
      const value = evalExpr(p.expr, key);
      next.set(key, {
        key,
        raw: raw.get(key) ?? '',
        kind: p.kind === 'formula' ? 'formula' : 'number',
        deps: deps.get(key) ?? [],
        value,
        error: null,
      });
    } catch (e) {
      let error: CellError;
      if (e instanceof EvalAbort) {
        error = e.cellError;
      } else if (e instanceof ZeroDivision) {
        error = {
          type: 'divzero',
          message: '除以零',
          source: key,
          path: [key],
        };
      } else {
        throw e;
      }
      next.set(key, {
        key,
        raw: raw.get(key) ?? '',
        kind: p.kind === 'formula' ? 'formula' : 'number',
        deps: deps.get(key) ?? [],
        value: null,
        error,
      });
    }
  }

  return next;
}

/* --------------------------- 假设修改（1～3 格） --------------------------- */

export interface HypothesisEntry {
  /** 唯一格地址（规范化前的输入亦可，a1 视为 A1） */
  addr: Addr;
  /** 原始输入：空 / 整数 / 公式；语法错误不是候选非法，结果显示 #ERR! */
  raw: string;
}

/** 一格的最终结果（空格用 kind/value/error 全空表示） */
export interface CellOutcome {
  key: Addr;
  kind: 'number' | 'formula' | null;
  value: Fraction | null;
  error: CellError | null;
}

/** 精确值、错误类型或来源路径发生变化的格 */
export interface CellChange {
  key: Addr;
  before: CellOutcome;
  after: CellOutcome;
}

export interface HypothesisPreview {
  ok: boolean;
  /** 候选非法（地址重复 / 越界 / 数量不符）时整组拒绝的原因 */
  errors?: string[];
  /** 预演所依据的正式网格修订号 */
  baseRevision: number;
  /** 规范化后的候选（拒绝时为空） */
  candidates: HypothesisEntry[];
  /** 仅含精确值 / 错误类型 / 来源路径发生变化的格，按地址排序 */
  changes: CellChange[];
  /** 预演后的完整结果（仅预演使用，绝不写入正式网格） */
  states: Map<Addr, CellState>;
  /** 预演后的原始输入 */
  raw: Map<Addr, string>;
}

function outcomeOf(key: Addr, states: Map<Addr, CellState>): CellOutcome {
  const st = states.get(key);
  if (!st) return { key, kind: null, value: null, error: null };
  return { key, kind: st.kind, value: st.value, error: st.error };
}

function sameAddrPath(a: Addr[] | undefined, b: Addr[] | undefined): boolean {
  if (!a || !b) return (a?.length ?? 0) === (b?.length ?? 0);
  if (a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** 比较两结果：只看精确值、错误类型与来源路径（与预演输出口径一致） */
function sameOutcome(a: CellOutcome, b: CellOutcome): boolean {
  if (a.error || b.error) {
    if (!a.error || !b.error) return false;
    return (
      a.error.type === b.error.type &&
      a.error.source === b.error.source &&
      sameAddrPath(a.error.path, b.error.path) &&
      sameAddrPath(a.error.cycle, b.error.cycle)
    );
  }
  if (a.value || b.value) {
    if (!a.value || !b.value) return false;
    return a.value.numer === b.value.numer && a.value.den === b.value.den;
  }
  return true;
}

export interface CommitResult {
  ok: boolean;
  /** 正式网格已不是预演所依据的修订版本 */
  stale?: boolean;
}

/* -------------------------------- 引擎 -------------------------------- */

export class SheetEngine {
  private raw = new Map<Addr, string>();
  private states = new Map<Addr, CellState>();
  private revision = 0;

  /** 当前快照（表格与导出 JSON 共享这一份） */
  getSnapshot(): Snapshot {
    return { raw: this.raw, states: this.states, revision: this.revision };
  }

  getRaw(key: Addr): string {
    return this.raw.get(key) ?? '';
  }

  /**
   * 单格编辑。非法输入不会拒绝编辑，而是让该格进入 parse 错误状态，
   * 仅影响该格及其下游；其他格结果不动。
   */
  setCell(key: Addr, text: string): EditResult {
    if (!inBounds(key)) {
      return { ok: false, errors: [`地址 ${key} 超出 A1..T20`] };
    }
    const trimmed = text;
    if (trimmed.trim() === '') {
      if (!this.raw.has(key)) return { ok: true };
      this.raw.delete(key);
    } else {
      this.raw.set(key, text);
    }
    this.recompute(new Set([key]));
    this.revision++;
    return { ok: true };
  }

  /**
   * 整份替换（导入）。调用方必须先用 validateGrid 校验；
   * 运行期错误（环/除零）允许出现，它们是导入后的计算结果。
   */
  loadGrid(cells: Record<string, string>): void {
    this.raw = new Map();
    for (const [k, v] of Object.entries(cells)) {
      if (v.trim() !== '') this.raw.set(k, v);
    }
    this.recompute(null);
    this.revision++;
  }

  clearAll(): void {
    this.raw = new Map();
    this.states = new Map();
    this.revision++;
  }

  /* ------------------------------ 假设修改 ------------------------------ */

  /**
   * 基于当前快照一次性预演 1～3 格假设修改。
   * 不逐次提交：所有候选同时施加到当前 raw 的副本上，再据此构造最终依赖图
   * 整体求值。地址重复或越界等候选问题整组拒绝；公式语法错误遵循现有表格
   * 语义，在候选结果中显示 #ERR!。本方法绝不修改正式网格。
   */
  previewHypothesis(entries: HypothesisEntry[]): HypothesisPreview {
    const rejected = (errors: string[]): HypothesisPreview => ({
      ok: false,
      errors,
      baseRevision: this.revision,
      candidates: [],
      changes: [],
      states: this.states,
      raw: this.raw,
    });

    if (!Array.isArray(entries) || entries.length < 1 || entries.length > 3) {
      return rejected(['假设修改必须包含 1～3 个候选格']);
    }

    const errors: string[] = [];
    const seen = new Set<Addr>();
    const candidates: HypothesisEntry[] = [];
    entries.forEach((e, i) => {
      const where = `第 ${i + 1} 个候选`;
      if (!e || typeof e.addr !== 'string' || typeof e.raw !== 'string') {
        errors.push(`${where}：必须同时给出格地址和原始输入`);
        return;
      }
      const norm = normalizeRef(e.addr);
      if (!norm) {
        errors.push(`${where}：地址 ${e.addr} 超出 A1..T20`);
        return;
      }
      if (seen.has(norm)) {
        errors.push(`${where}：地址 ${norm} 重复（候选地址必须唯一）`);
        return;
      }
      seen.add(norm);
      candidates.push({ addr: norm, raw: e.raw });
    });
    if (errors.length > 0) return rejected(errors);

    // 基于同一份当前快照施加全部候选（顺序无关：最后只在同一个副本上求值一次）
    const nextRaw = new Map(this.raw);
    for (const c of candidates) {
      if (c.raw.trim() === '') nextRaw.delete(c.addr);
      else nextRaw.set(c.addr, c.raw);
    }
    const nextStates = buildStates(nextRaw, null, new Map());

    // 只列出精确值、错误类型或来源路径发生变化的格
    const keys = new Set<Addr>([...this.states.keys(), ...nextStates.keys()]);
    const changes: CellChange[] = [];
    for (const key of [...keys].sort()) {
      const before = outcomeOf(key, this.states);
      const after = outcomeOf(key, nextStates);
      if (!sameOutcome(before, after)) changes.push({ key, before, after });
    }

    return {
      ok: true,
      baseRevision: this.revision,
      candidates,
      changes,
      states: nextStates,
      raw: nextRaw,
    };
  }

  /**
   * 用户确认时一次性采纳全部假设修改。
   * 只有正式网格仍是预演所依据的修订版本才采纳；否则提示过期并保留正式数据。
   */
  commitHypothesis(preview: HypothesisPreview): CommitResult {
    if (!preview.ok) return { ok: false, stale: false };
    if (this.revision !== preview.baseRevision) {
      return { ok: false, stale: true };
    }
    this.raw = new Map(preview.raw);
    this.states = new Map(preview.states);
    this.revision++;
    return { ok: true };
  }

  /* ------------------------------ 重算核心 ------------------------------ */

  private recompute(changed: Set<Addr> | null): void {
    this.states = buildStates(this.raw, changed, this.states);
  }
}
