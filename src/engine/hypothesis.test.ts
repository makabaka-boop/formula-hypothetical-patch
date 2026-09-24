import { describe, expect, it } from 'vitest';
import { SheetEngine, type HypothesisPreview } from './engine';
import { exportSnapshot } from './snapshot';

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

function changedKeys(p: HypothesisPreview): string[] {
  return p.changes.map((c) => c.key);
}

describe('假设修改预演：跨三格成环', () => {
  it('A1->B1->C1->A1 三格同时成环，整组一次预演（非逐格中间态）', () => {
    const e = make({ A1: '1', B1: '2', C1: '3', D1: '=A1+100' });
    const p = e.previewHypothesis([
      { addr: 'A1', raw: '=B1' },
      { addr: 'B1', raw: '=C1' },
      { addr: 'C1', raw: '=A1' },
    ]);
    expect(p.ok).toBe(true);
    expect(changedKeys(p)).toEqual(
      expect.arrayContaining(['A1', 'B1', 'C1', 'D1']),
    );
    for (const k of ['A1', 'B1', 'C1']) {
      const st = p.states.get(k)!;
      expect(st.error?.type).toBe('cycle');
      expect(st.error?.cycle![0]).toBe(k);
      expect(st.error?.cycle![st.error!.cycle!.length - 1]).toBe(k);
      expect(st.value).toBeNull();
    }
    // 环下游同样不显示旧值，来源为环中格
    const d1 = p.states.get('D1')!;
    expect(d1.error?.type).toBe('cycle');
    expect(d1.value).toBeNull();
    expect(d1.error?.path[0]).toBe('A1');
    expect(d1.error?.path[d1.error!.path.length - 1]).toBe('D1');
  });

  it('预演绝不写入正式网格', () => {
    const e = make({ A1: '1', B1: '2', C1: '3' });
    const revBefore = e.getSnapshot().revision;
    e.previewHypothesis([
      { addr: 'A1', raw: '=B1' },
      { addr: 'B1', raw: '=C1' },
      { addr: 'C1', raw: '=A1' },
    ]);
    expect(e.getSnapshot().revision).toBe(revBefore);
    expect(val(e, 'A1')).toBe('1');
    expect(err(e, 'A1')).toBeNull();
  });
});

describe('假设修改预演：断环', () => {
  it('三格环中改掉一格即整环恢复，环与下游错误全部消失', () => {
    const e = make({
      A1: '=B1',
      B1: '=C1',
      C1: '=A1',
      D1: '=A1+10',
    });
    expect(err(e, 'A1')!.type).toBe('cycle');
    expect(err(e, 'D1')!.type).toBe('cycle');

    const p = e.previewHypothesis([
      { addr: 'B1', raw: '=C1+0' }, // 仍引用 C1，但 C1->A1->B1 不再闭合？先确认断边
      { addr: 'C1', raw: '5' },
    ]);
    expect(p.ok).toBe(true);
    expect(p.states.get('C1')!.value!.toExactString()).toBe('5');
    expect(p.states.get('B1')!.value!.toExactString()).toBe('5');
    expect(p.states.get('A1')!.value!.toExactString()).toBe('5');
    expect(p.states.get('D1')!.value!.toExactString()).toBe('15');
    for (const k of ['A1', 'B1', 'C1', 'D1']) {
      expect(p.states.get(k)!.error).toBeNull();
    }
    const keys = changedKeys(p);
    expect(keys).toEqual(expect.arrayContaining(['A1', 'B1', 'C1', 'D1']));
    // 正式网格仍是环
    expect(err(e, 'A1')!.type).toBe('cycle');
  });
});

describe('假设修改预演：错误路径变化', () => {
  it('修复除零：错误类型/来源路径消失，仅列出真正变化的格', () => {
    const e = make({
      A1: '0',
      B1: '=1/A1',
      C1: '=B1+2',
      Z1: '=9+9',
    });
    expect(err(e, 'C1')!.type).toBe('divzero');
    expect(err(e, 'C1')!.source).toBe('B1');
    expect(err(e, 'C1')!.path).toEqual(['B1', 'C1']);
    const p = e.previewHypothesis([
      { addr: 'A1', raw: '4' },
      { addr: 'B1', raw: '=1/A1' },
    ]);
    expect(p.ok).toBe(true);
    expect(p.states.get('B1')!.value!.toExactString()).toBe('1/4');
    expect(p.states.get('C1')!.value!.toExactString()).toBe('9/4');
    expect(p.states.get('B1')!.error).toBeNull();
    // 不相关、值与错误都未变的格不出现在差异里
    expect(changedKeys(p)).not.toContain('Z1');
    // A1 由 0 变 4，精确值变化也列入
    expect(changedKeys(p)).toEqual(expect.arrayContaining(['A1', 'B1', 'C1']));
  });

  it('新生除零：下游错误来源与传播路径按最终图重算', () => {
    const e = make({ A1: '4', B1: '=1/A1', C1: '=B1+2' });
    const p = e.previewHypothesis([{ addr: 'A1', raw: '0' }]);
    expect(p.states.get('B1')!.error?.type).toBe('divzero');
    expect(p.states.get('B1')!.error?.source).toBe('B1');
    expect(p.states.get('C1')!.error?.type).toBe('divzero');
    expect(p.states.get('C1')!.error?.source).toBe('B1');
    expect(p.states.get('C1')!.error?.path).toEqual(['B1', 'C1']);
  });

  it('错误类型从除零变为解析错误时错误来源路径一并改变', () => {
    const e = make({ A1: '0', B1: '=1/A1', C1: '=B1+2' });
    const p = e.previewHypothesis([{ addr: 'B1', raw: '=1+' }]);
    expect(p.states.get('B1')!.error?.type).toBe('parse');
    expect(p.states.get('B1')!.error?.source).toBe('B1');
    expect(p.states.get('C1')!.error?.type).toBe('parse');
    expect(p.states.get('C1')!.error?.path).toEqual(['B1', 'C1']);
  });

  it('语法错误遵循现有表格语义：候选合法、结果显示 #ERR! 而非整组拒绝', () => {
    const e = make({ A1: '1', B1: '=A1+1' });
    const p = e.previewHypothesis([
      { addr: 'A1', raw: '=SUM(1)' },
      { addr: 'B1', raw: '=A1+2' },
    ]);
    expect(p.ok).toBe(true);
    expect(p.errors).toBeUndefined();
    expect(p.states.get('A1')!.error?.type).toBe('parse');
    expect(p.states.get('B1')!.error?.type).toBe('parse');
    expect(p.states.get('B1')!.error?.source).toBe('A1');
  });
});

describe('假设修改预演：顺序无关', () => {
  it('候选按任意顺序提交，差异与结果完全一致（基于同一份快照的最终图）', () => {
    const cells = { A1: '1', B1: '=A1+1', C1: '=B1*10' };
    const e1 = make(cells);
    const e2 = make(cells);
    const p1 = e1.previewHypothesis([
      { addr: 'A1', raw: '5' },
      { addr: 'C1', raw: '=B1*2' },
      { addr: 'B1', raw: '=A1+2' },
    ]);
    const p2 = e2.previewHypothesis([
      { addr: 'B1', raw: '=A1+2' },
      { addr: 'A1', raw: '5' },
      { addr: 'C1', raw: '=B1*2' },
    ]);
    expect(p1.changes.map((c) => c.key)).toEqual(p2.changes.map((c) => c.key));
    for (const k of ['A1', 'B1', 'C1']) {
      expect(p1.states.get(k)!.value?.toExactString()).toBe(
        p2.states.get(k)!.value?.toExactString(),
      );
    }
    // A1=5, B1=7, C1=14
    expect(p1.states.get('C1')!.value!.toExactString()).toBe('14');
  });

  it('逐格提交正式网格会产生不同结果，证明预演不是顺序提交：制造临时环', () => {
    // 若逐次提交 A1=B1、B1=A1 到正式网格，第一次提交后 A1 引用空 B1(=0) 得 0，
    // 第二次才成环；而整组预演直接以最终图得到两格成环。
    const e = make({ A1: '1', B1: '2' });
    const p = e.previewHypothesis([
      { addr: 'A1', raw: '=B1' },
      { addr: 'B1', raw: '=A1' },
    ]);
    expect(p.states.get('A1')!.error?.type).toBe('cycle');
    expect(p.states.get('B1')!.error?.type).toBe('cycle');
  });
});

describe('假设修改：非法候选整组拒绝', () => {
  it('地址重复整组拒绝', () => {
    const e = make({ A1: '1' });
    const p = e.previewHypothesis([
      { addr: 'A1', raw: '2' },
      { addr: 'a1', raw: '3' },
    ]);
    expect(p.ok).toBe(false);
    expect(p.errors!.join(' ')).toContain('重复');
    expect(p.changes).toEqual([]);
    expect(val(e, 'A1')).toBe('1');
  });

  it('地址越界整组拒绝', () => {
    const e = make({ A1: '1' });
    const p = e.previewHypothesis([
      { addr: 'U1', raw: '2' },
      { addr: 'A1', raw: '3' },
    ]);
    expect(p.ok).toBe(false);
    expect(p.errors!.join(' ')).toContain('A1..T20');
    expect(val(e, 'A1')).toBe('1');
  });

  it('0 个或超过 3 个候选整组拒绝', () => {
    const e = make({});
    expect(e.previewHypothesis([]).ok).toBe(false);
    const p = e.previewHypothesis([
      { addr: 'A1', raw: '1' },
      { addr: 'A2', raw: '1' },
      { addr: 'A3', raw: '1' },
      { addr: 'A4', raw: '1' },
    ]);
    expect(p.ok).toBe(false);
  });

  it('非法候选不写入、不递增修订号', () => {
    const e = make({ A1: '1' });
    const rev = e.getSnapshot().revision;
    e.previewHypothesis([
      { addr: 'A1', raw: '2' },
      { addr: 'A1', raw: '3' },
    ]);
    expect(e.getSnapshot().revision).toBe(rev);
  });
});

describe('假设修改：确认采纳与过期保护', () => {
  it('确认时一次性采纳全部修改', () => {
    const e = make({ A1: '1', B1: '=A1+1', C1: '=B1*10' });
    const p = e.previewHypothesis([
      { addr: 'A1', raw: '5' },
      { addr: 'C1', raw: '=B1*2' },
    ]);
    const r = e.commitHypothesis(p);
    expect(r.ok).toBe(true);
    expect(val(e, 'A1')).toBe('5');
    expect(val(e, 'B1')).toBe('6');
    expect(val(e, 'C1')).toBe('12');
  });

  it('预演后正式网格被其他编辑改动：确认过期，保留正式数据', () => {
    const e = make({ A1: '1', B1: '=A1+1' });
    const p = e.previewHypothesis([{ addr: 'A1', raw: '5' }]);
    // 正式网格在此期间发生修订（例如他人/另一处单格编辑）
    e.setCell('A1', '100');
    const r = e.commitHypothesis(p);
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    expect(val(e, 'A1')).toBe('100');
    expect(val(e, 'B1')).toBe('101');
  });

  it('取消不写入，正式网格保持原样', () => {
    const e = make({ A1: '1', B1: '=A1+1' });
    const rev = e.getSnapshot().revision;
    const p = e.previewHypothesis([{ addr: 'A1', raw: '5' }]);
    // 不调用 commitHypothesis 即视为取消
    expect(p.ok).toBe(true);
    expect(e.getSnapshot().revision).toBe(rev);
    expect(val(e, 'A1')).toBe('1');
    expect(val(e, 'B1')).toBe('2');
  });

  it('导入新网格使旧预演过期', () => {
    const e = make({ A1: '1', B1: '=A1+1' });
    const p = e.previewHypothesis([{ addr: 'A1', raw: '5' }]);
    e.loadGrid({ X1: '42' });
    const r = e.commitHypothesis(p);
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    expect(e.getRaw('X1')).toBe('42');
    expect(e.getSnapshot().states.has('A1')).toBe(false);
  });
});

describe('假设修改：导出只反映已采纳网格', () => {
  it('未采纳的预演不出现在导出中；采纳后才反映', () => {
    const e = make({ A1: '1', B1: '=A1+1' });
    const p = e.previewHypothesis([{ addr: 'A1', raw: '5' }]);
    const beforeJson = exportSnapshot(e.getSnapshot());
    expect(beforeJson).toContain('"raw": "1"');
    expect(beforeJson).not.toContain('"raw": "5"');

    e.commitHypothesis(p);
    const afterJson = exportSnapshot(e.getSnapshot());
    expect(afterJson).toContain('"raw": "5"');
  });
});
