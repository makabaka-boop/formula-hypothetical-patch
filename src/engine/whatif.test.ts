import { describe, expect, it } from 'vitest';
import { SheetEngine } from './engine';
import { exportSnapshot } from './snapshot';
import type { WhatIfChange, WhatIfPreview } from './whatif';

function make(cells: Record<string, string>): SheetEngine {
  const e = new SheetEngine();
  e.loadGrid(cells);
  return e;
}

function val(e: SheetEngine, addr: string): string | null {
  return e.getSnapshot().states.get(addr)?.value?.toExactString() ?? null;
}

function err(e: SheetEngine, addr: string) {
  return e.getSnapshot().states.get(addr)?.error ?? null;
}

/** 预演成功则取出 preview，失败则直接让测试失败 */
function previewOf(e: SheetEngine, candidates: { addr: string; raw: string }[]): WhatIfPreview {
  const r = e.previewWhatIf(candidates);
  if (!r.ok) throw new Error(`预演被意外拒绝：${r.errors.join('；')}`);
  return r.preview;
}

function changeOf(p: WhatIfPreview, addr: string): WhatIfChange | null {
  return p.changes.find((c) => c.addr === addr) ?? null;
}

/** 一格结果的可读摘要，用于跨预演比较 */
function outcomeText(st: WhatIfChange['before']): string {
  if (!st) return '(空)';
  if (st.error) {
    const path = st.error.cycle ?? st.error.path;
    return `${st.error.type}:${st.error.source}:${path.join('>')}`;
  }
  return st.value!.toExactString();
}

describe('假设修改：候选校验（整组拒绝，不写入任何结果）', () => {
  it('0 格、超过 3 格、地址重复、地址越界都整组拒绝', () => {
    const e = make({ A1: '1' });
    const rev = e.getSnapshot().revision;

    const r0 = e.previewWhatIf([]);
    expect(r0.ok).toBe(false);

    const r4 = e.previewWhatIf([
      { addr: 'A1', raw: '1' },
      { addr: 'A2', raw: '2' },
      { addr: 'A3', raw: '3' },
      { addr: 'A4', raw: '4' },
    ]);
    expect(r4.ok).toBe(false);

    const rDup = e.previewWhatIf([
      { addr: 'A1', raw: '1' },
      { addr: 'A1', raw: '2' },
    ]);
    expect(rDup.ok).toBe(false);
    if (!rDup.ok) expect(rDup.errors.join('')).toContain('重复');

    const rOut = e.previewWhatIf([{ addr: 'U1', raw: '1' }]);
    expect(rOut.ok).toBe(false);
    if (!rOut.ok) expect(rOut.errors.join('')).toContain('超出');

    // 整组拒绝不写入任何结果：修订号与数据都不变
    expect(e.getSnapshot().revision).toBe(rev);
    expect(val(e, 'A1')).toBe('1');
  });

  it('公式语法错误不拒绝，遵循现有语义在候选结果中显示 #ERR!', () => {
    const e = make({ B1: '=A1+1' });
    const p = previewOf(e, [{ addr: 'A1', raw: '=1+' }]);
    const chA = changeOf(p, 'A1')!;
    expect(chA.after!.error!.type).toBe('parse');
    // 错误沿引用链传播到下游
    const chB = changeOf(p, 'B1')!;
    expect(chB.after!.error!.type).toBe('parse');
    expect(chB.after!.error!.source).toBe('A1');
    // 采纳后与单格编辑语义一致
    expect(e.confirmWhatIf(p).ok).toBe(true);
    expect(err(e, 'A1')!.type).toBe('parse');
    expect(err(e, 'B1')!.source).toBe('A1');
    expect(e.getRaw('A1')).toBe('=1+');
  });
});

describe('假设修改：预演基于最终依赖图', () => {
  it('跨三格成环：整组同时生效，正式网格在采纳前不动', () => {
    const e = make({ D1: '7' });
    const rev = e.getSnapshot().revision;
    const p = previewOf(e, [
      { addr: 'A1', raw: '=B1' },
      { addr: 'B1', raw: '=C1' },
      { addr: 'C1', raw: '=A1' },
    ]);

    // 三格都标出从自身出发的实际环
    for (const a of ['A1', 'B1', 'C1']) {
      const ch = changeOf(p, a)!;
      expect(ch.before).toBeNull();
      expect(ch.after!.error!.type).toBe('cycle');
      const cyc = ch.after!.error!.cycle!;
      expect(cyc[0]).toBe(a);
      expect(cyc[cyc.length - 1]).toBe(a);
    }
    // 无关格不出现在变化列表
    expect(changeOf(p, 'D1')).toBeNull();
    expect(p.changes.length).toBe(3);

    // 预演不写入正式网格
    expect(e.getSnapshot().revision).toBe(rev);
    expect(e.getSnapshot().states.has('A1')).toBe(false);

    // 采纳后一次性生效，修订号只 +1
    expect(e.confirmWhatIf(p).ok).toBe(true);
    expect(e.getSnapshot().revision).toBe(rev + 1);
    expect(err(e, 'A1')!.type).toBe('cycle');
    expect(err(e, 'B1')!.type).toBe('cycle');
    expect(err(e, 'C1')!.type).toBe('cycle');
    expect(val(e, 'D1')).toBe('7');
  });

  it('断环：环上格与下游一起恢复精确值', () => {
    const e = make({ A1: '=B1+1', B1: '=A1+1', C1: '=A1+10' });
    expect(err(e, 'A1')!.type).toBe('cycle');
    const p = previewOf(e, [{ addr: 'B1', raw: '1' }]);

    expect(p.changes.length).toBe(3);
    expect(changeOf(p, 'A1')!.before!.error!.type).toBe('cycle');
    expect(changeOf(p, 'A1')!.after!.value!.toExactString()).toBe('2');
    expect(changeOf(p, 'B1')!.after!.value!.toExactString()).toBe('1');
    expect(changeOf(p, 'C1')!.after!.value!.toExactString()).toBe('12');

    // 采纳前正式网格仍是环
    expect(err(e, 'A1')!.type).toBe('cycle');
    expect(e.confirmWhatIf(p).ok).toBe(true);
    expect(val(e, 'A1')).toBe('2');
    expect(val(e, 'C1')).toBe('12');
    expect(err(e, 'A1')).toBeNull();
  });

  it('除零的新生与消失', () => {
    const e = make({ A1: '2', B1: '=1/A1', C1: '=B1+1' });
    // 新生除零并向下游传播
    const p1 = previewOf(e, [{ addr: 'A1', raw: '0' }]);
    expect(changeOf(p1, 'B1')!.before!.value!.toExactString()).toBe('1/2');
    expect(changeOf(p1, 'B1')!.after!.error!.type).toBe('divzero');
    expect(changeOf(p1, 'C1')!.after!.error!.path).toEqual(['B1', 'C1']);
    // 反向预演：除零消失
    const e2 = make({ A1: '0', B1: '=1/A1', C1: '=B1+1' });
    const p2 = previewOf(e2, [{ addr: 'A1', raw: '4' }]);
    expect(changeOf(p2, 'B1')!.before!.error!.type).toBe('divzero');
    expect(changeOf(p2, 'B1')!.after!.value!.toExactString()).toBe('1/4');
    expect(changeOf(p2, 'C1')!.after!.value!.toExactString()).toBe('5/4');
  });

  it('错误来源路径变化（类型不变也会被列出）', () => {
    const e = make({ S1: '=1/0', T1: '=1/0', C1: '=S1+T1' });
    expect(err(e, 'C1')!.source).toBe('S1');
    const p = previewOf(e, [{ addr: 'C1', raw: '=T1+S1' }]);

    const ch = changeOf(p, 'C1')!;
    expect(ch.before!.error!.source).toBe('S1');
    expect(ch.before!.error!.path).toEqual(['S1', 'C1']);
    expect(ch.after!.error!.type).toBe('divzero');
    expect(ch.after!.error!.source).toBe('T1');
    expect(ch.after!.error!.path).toEqual(['T1', 'C1']);
    // 除零源本身不变，只有 C1 列入变化
    expect(p.changes.length).toBe(1);
  });

  it('顺序无关：不按输入顺序逐次提交，看不到中间结论', () => {
    // B1 当前是除零；若按输入顺序逐格提交，A1 会先算出 #DIV/0! 再被修复。
    // 预演基于最终依赖图，A1 直接看到 B1=5。
    const e1 = make({ B1: '=1/0' });
    const e2 = make({ B1: '=1/0' });
    const p1 = previewOf(e1, [
      { addr: 'A1', raw: '=B1+1' },
      { addr: 'B1', raw: '=2+3' },
    ]);
    const p2 = previewOf(e2, [
      { addr: 'B1', raw: '=2+3' },
      { addr: 'A1', raw: '=B1+1' },
    ]);

    const a1 = changeOf(p1, 'A1')!;
    expect(a1.after!.error).toBeNull();
    expect(a1.after!.value!.toExactString()).toBe('6');
    expect(changeOf(p1, 'B1')!.after!.value!.toExactString()).toBe('5');

    // 两种候选顺序得到完全相同的预演变化
    const digest = (p: WhatIfPreview) =>
      p.changes.map((c) => `${c.addr}:${outcomeText(c.before)}->${outcomeText(c.after)}`);
    expect(digest(p1)).toEqual(digest(p2));

    // 确认后两个引擎落到同一份结果
    expect(e1.confirmWhatIf(p1).ok).toBe(true);
    expect(e2.confirmWhatIf(p2).ok).toBe(true);
    expect(val(e1, 'A1')).toBe('6');
    expect(val(e2, 'A1')).toBe('6');
    expect(val(e1, 'B1')).toBe('5');
  });

  it('只列出结果变化的格：改文本但结果相同则不列出', () => {
    const e = make({ A1: '5', B1: '=A1+1' });
    const p = previewOf(e, [{ addr: 'A1', raw: '=10/2' }]);
    expect(p.changes.length).toBe(0);
  });

  it('空白输入表示清空该格，下游按 0 重算', () => {
    const e = make({ A1: '5', B1: '=A1+1' });
    const p = previewOf(e, [{ addr: 'A1', raw: '  ' }]);
    expect(changeOf(p, 'A1')!.before!.value!.toExactString()).toBe('5');
    expect(changeOf(p, 'A1')!.after).toBeNull();
    expect(changeOf(p, 'B1')!.after!.value!.toExactString()).toBe('1');

    expect(e.confirmWhatIf(p).ok).toBe(true);
    expect(e.getSnapshot().states.has('A1')).toBe(false);
    expect(val(e, 'B1')).toBe('1');
  });
});

describe('假设修改：确认与过期', () => {
  it('确认时正式网格已被单格编辑修改：提示过期并保留正式数据', () => {
    const e = make({ A1: '1' });
    const p = previewOf(e, [{ addr: 'A1', raw: '2' }]);
    e.setCell('B1', '9'); // 正式网格前进了
    const c = e.confirmWhatIf(p);
    expect(c.ok).toBe(false);
    expect(c.errors!.join('')).toContain('过期');
    expect(val(e, 'A1')).toBe('1'); // 正式数据保留
    expect(val(e, 'B1')).toBe('9');
  });

  it('确认前导入新网格：预演过期且不会被写入', () => {
    const e = make({ A1: '1' });
    const p = previewOf(e, [
      { addr: 'A1', raw: '2' },
      { addr: 'B1', raw: '=A1*10' },
    ]);
    e.loadGrid({ C1: '5' });
    expect(e.confirmWhatIf(p).ok).toBe(false);
    expect(e.getSnapshot().states.has('A1')).toBe(false);
    expect(e.getSnapshot().states.has('B1')).toBe(false);
    expect(val(e, 'C1')).toBe('5');
  });

  it('导出只反映已采纳网格：预演未确认前导出不包含候选内容', () => {
    const e = make({ A1: '1' });
    const p = previewOf(e, [{ addr: 'A1', raw: '=6*7' }]);
    let json = exportSnapshot(e.getSnapshot());
    expect(json).toContain('"raw": "1"');
    expect(json).not.toContain('=6*7');

    expect(e.confirmWhatIf(p).ok).toBe(true);
    json = exportSnapshot(e.getSnapshot());
    expect(json).toContain('"raw": "=6*7"');
    expect(json).toContain('"display": "42"');
  });
});
