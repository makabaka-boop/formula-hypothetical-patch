import { inBounds, type Addr } from './cells';
import { Fraction, ZeroDivision } from './fraction';
import {
  collectRefs,
  parseCellInput,
  ParseError,
  type Expr,
  type ParsedCell,
} from './parser';
import { affectedSet, cyclePathsForScc, tarjan, topoOrder } from './graph';
import {
  sameOutcome,
  validateWhatIfCandidates,
  type WhatIfCandidate,
  type WhatIfChange,
  type WhatIfPreview,
  type WhatIfResult,
} from './whatif';

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

  /* ---------------------------- 假设修改（预演） ---------------------------- */

  /**
   * 1～3 格“假设修改”预演。
   * 把整组候选同时落到当前快照的一份副本上，从零构造最终依赖图
   * （新生/消失的环、除零与传播路径都与候选顺序无关），
   * 全程不写入正式网格；结果只列出发生变化的格。
   * 地址重复或越界整组拒绝；公式语法错误遵循现有语义显示 #ERR!。
   */
  previewWhatIf(candidates: WhatIfCandidate[]): WhatIfResult {
    const errors = validateWhatIfCandidates(candidates);
    if (errors.length > 0) return { ok: false, errors };

    // 同一份当前快照 + 整组修改一次性生效（不是按输入顺序逐次提交）
    const hypothetical = new Map(this.raw);
    for (const c of candidates) {
      if (c.raw.trim() === '') hypothetical.delete(c.addr);
      else hypothetical.set(c.addr, c.raw);
    }
    // 全量重算：不沿用旧状态，保证看到的是最终依赖图而非中间结论
    const after = computeStates(hypothetical, new Map(), null);

    const changes: WhatIfChange[] = [];
    const keys = new Set<Addr>([...this.states.keys(), ...after.keys()]);
    for (const addr of [...keys].sort()) {
      const before = this.states.get(addr) ?? null;
      const next = after.get(addr) ?? null;
      if (!sameOutcome(before, next)) {
        changes.push({ addr, before, after: next });
      }
    }
    return {
      ok: true,
      preview: {
        baseRevision: this.revision,
        candidates: candidates.map((c) => ({ addr: c.addr, raw: c.raw })),
        changes,
      },
    };
  }

  /**
   * 采纳预演：仅当正式网格仍停留在预演依据的修订版本时，
   * 才把整组修改一次性提交（单次重算、修订号只 +1）；
   * 否则提示过期并保留正式数据。
   */
  confirmWhatIf(preview: WhatIfPreview): EditResult {
    if (preview.baseRevision !== this.revision) {
      return {
        ok: false,
        errors: [
          `预演已过期：正式网格已从 r${preview.baseRevision} 前进到 r${this.revision}，未采纳任何修改`,
        ],
      };
    }
    const changed = new Set<Addr>();
    for (const c of preview.candidates) {
      if (c.raw.trim() === '') this.raw.delete(c.addr);
      else this.raw.set(c.addr, c.raw);
      changed.add(c.addr);
    }
    this.recompute(changed);
    this.revision++;
    return { ok: true };
  }

  /* ------------------------------ 重算核心 ------------------------------ */

  private recompute(changed: Set<Addr> | null): void {
    this.states = computeStates(this.raw, this.states, changed);
  }
}

/**
 * 由一份原始输入映射算出全部单元状态。
 * changed 为 null 表示全量重算；否则只重算受影响集合，
 * 未受影响的格沿用 prevStates 中的同一结果对象。
 */
function computeStates(
  raw: Map<Addr, string>,
  prevStates: Map<Addr, CellState>,
  changed: Set<Addr> | null,
): Map<Addr, CellState> {
    // 1) 解析全部非空输入
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

    // 2) 环检测
    const { sccs, cyclic } = tarjan(deps);

    // 3) 受影响集合：编辑格 + 新依赖图上的全部传递下游；
    //    若编辑格原本在环中，旧环成员全部重算（防止边删除导致的遗漏）。
    let affected: Set<Addr>;
    if (changed === null) {
      affected = new Set(parsed.keys());
    } else {
      affected = affectedSet([...changed], deps);
      const oldCyclic = [...prevStates.values()].filter(
        (s) => s.error?.type === 'cycle',
      );
      if (oldCyclic.some((s) => changed.has(s.key))) {
        oldCyclic.forEach((s) => affected.add(s.key));
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
        const p = parsed.get(key);
        next.set(key, {
          key,
          raw: raw.get(key) ?? '',
          kind: kindOf(raw, key, p),
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
      if (!affected.has(key) && prevStates.has(key)) {
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

function kindOf(
  raw: Map<Addr, string>,
  key: Addr,
  p: ParsedCell | undefined,
): 'number' | 'formula' {
  if (p) return p.kind === 'formula' ? 'formula' : 'number';
  return raw.get(key)?.startsWith('=') ? 'formula' : 'number';
}
