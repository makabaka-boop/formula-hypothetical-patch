import { describe, expect, it } from 'vitest';
import { SheetEngine, type Snapshot } from './engine';
import { exportSnapshot, validateImport } from './snapshot';

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

describe('运算优先级与负号（端到端）', () => {
  it('2+3*4 = 14', () => {
    const e = make({ A1: '=2+3*4' });
    expect(val(e, 'A1')).toBe('14');
  });
  it('(2+3)*4 = 20', () => {
    const e = make({ A1: '=(2+3)*4' });
    expect(val(e, 'A1')).toBe('20');
  });
  it('-2*3 = -6，--7 = 7', () => {
    const e = make({ A1: '=-2*3', A2: '=--7' });
    expect(val(e, 'A1')).toBe('-6');
    expect(val(e, 'A2')).toBe('7');
  });
  it('分数运算不丢精度：1/3+1/6 = 1/2', () => {
    const e = make({ A1: '=1/3+1/6' });
    expect(val(e, 'A1')).toBe('1/2');
  });
  it('引用其他格：A1=2, B1=3, C1=A1*B1+4 = 10', () => {
    const e = make({ A1: '2', B1: '3', C1: '=A1*B1+4' });
    expect(val(e, 'C1')).toBe('10');
  });
  it('空格按 0 参与运算', () => {
    const e = make({ A1: '=B1+5' });
    expect(val(e, 'A1')).toBe('5');
  });
});

describe('循环引用：标出实际环', () => {
  it('两格互引：两格都标 cycle 且给出实际环路径', () => {
    const e = make({ A1: '=B1+1', B1: '=A1+1' });
    const ea = err(e, 'A1')!;
    const eb = err(e, 'B1')!;
    expect(ea.type).toBe('cycle');
    expect(eb.type).toBe('cycle');
    expect(ea.cycle).toContain('A1');
    expect(ea.cycle).toContain('B1');
    // 路径首尾都是该格自身
    expect(ea.cycle![0]).toBe('A1');
    expect(ea.cycle![ea.cycle!.length - 1]).toBe('A1');
    expect(eb.cycle![0]).toBe('B1');
    expect(eb.cycle![eb.cycle!.length - 1]).toBe('B1');
    expect(val(e, 'A1')).toBeNull();
    expect(val(e, 'B1')).toBeNull();
  });

  it('自环', () => {
    const e = make({ A1: '=A1' });
    expect(err(e, 'A1')!.type).toBe('cycle');
    expect(err(e, 'A1')!.cycle).toEqual(['A1', 'A1']);
  });

  it('三格环 A1->B1->C1->A1', () => {
    const e = make({ A1: '=B1', B1: '=C1', C1: '=A1' });
    const c = err(e, 'A1')!.cycle!;
    expect(c[0]).toBe('A1');
    expect(c[c.length - 1]).toBe('A1');
    expect(new Set(c).size).toBe(3);
  });

  it('环的下游格标出错误且不显示旧数值', () => {
    const e = make({ A1: '=B1', B1: '=A1', C1: '=A1+1', D1: '=C1*2' });
    const ec = err(e, 'C1')!;
    const ed = err(e, 'D1')!;
    expect(ec.type).toBe('cycle');
    expect(ec.source).toBe('A1');
    expect(ec.path[0]).toBe('A1');
    expect(ec.path[ec.path.length - 1]).toBe('C1');
    expect(ed.path).toEqual(['A1', 'C1', 'D1']);
    expect(val(e, 'C1')).toBeNull();
    expect(val(e, 'D1')).toBeNull();
  });
});

describe('除零：错误及下游传播', () => {
  it('直接除零', () => {
    const e = make({ A1: '=1/0' });
    const er = err(e, 'A1')!;
    expect(er.type).toBe('divzero');
    expect(er.source).toBe('A1');
    expect(er.path).toEqual(['A1']);
  });
  it('引用空分母格导致除零', () => {
    const e = make({ A1: '=1/B1' });
    expect(err(e, 'A1')!.type).toBe('divzero');
  });
  it('下游标出来源与路径：B1=1/0, C1=B1+1, D1=C1*2', () => {
    const e = make({ B1: '=1/0', C1: '=B1+1', D1: '=C1*2' });
    expect(err(e, 'C1')!.type).toBe('divzero');
    expect(err(e, 'C1')!.source).toBe('B1');
    expect(err(e, 'C1')!.path).toEqual(['B1', 'C1']);
    expect(err(e, 'D1')!.path).toEqual(['B1', 'C1', 'D1']);
    expect(val(e, 'D1')).toBeNull();
  });
  it('不相关格不受影响', () => {
    const e = make({ A1: '=1/0', B1: '=2+3', C1: '=B1*2' });
    expect(val(e, 'B1')).toBe('5');
    expect(val(e, 'C1')).toBe('10');
  });
});

describe('下游传播与增量重算', () => {
  it('编辑一格后受影响的链全部更新', () => {
    const e = make({ A1: '1', B1: '=A1+1', C1: '=B1*10' });
    expect(val(e, 'C1')).toBe('20');
    e.setCell('A1', '5');
    expect(val(e, 'B1')).toBe('6');
    expect(val(e, 'C1')).toBe('60');
  });

  it('清空一格后下游立即变为按 0 计算，绝不显示旧值', () => {
    const e = make({ A1: '10', B1: '=A1+1' });
    expect(val(e, 'B1')).toBe('11');
    e.setCell('A1', '');
    expect(e.getSnapshot().states.has('A1')).toBe(false);
    expect(val(e, 'B1')).toBe('1');
  });

  it('编辑不相关格不改变其他状态对象', () => {
    const e = make({ A1: '=1+1', B1: '=2+2' });
    const before = e.getSnapshot().states.get('A1');
    e.setCell('B1', '5');
    expect(e.getSnapshot().states.get('A1')).toBe(before);
  });
});

describe('编辑后恢复', () => {
  it('修复除零后下游恢复正确值', () => {
    const e = make({ A1: '0', B1: '=1/A1', C1: '=B1+2' });
    expect(err(e, 'B1')!.type).toBe('divzero');
    expect(err(e, 'C1')!.type).toBe('divzero');
    e.setCell('A1', '4');
    expect(val(e, 'B1')).toBe('1/4');
    expect(val(e, 'C1')).toBe('9/4');
    expect(err(e, 'B1')).toBeNull();
  });

  it('打断环后全链恢复：改 B1 不再引用 A1', () => {
    const e = make({ A1: '=B1+1', B1: '=A1+1', C1: '=A1+10' });
    expect(err(e, 'A1')!.type).toBe('cycle');
    expect(err(e, 'C1')!.type).toBe('cycle');
    e.setCell('B1', '1');
    expect(val(e, 'B1')).toBe('1');
    expect(val(e, 'A1')).toBe('2');
    expect(val(e, 'C1')).toBe('12');
    expect(err(e, 'A1')).toBeNull();
    expect(err(e, 'C1')).toBeNull();
  });

  it('把无环节点改成制造环，再改回恢复', () => {
    const e = make({ A1: '=B1', B1: '1' });
    expect(val(e, 'A1')).toBe('1');
    e.setCell('B1', '=A1');
    expect(err(e, 'A1')!.type).toBe('cycle');
    expect(err(e, 'B1')!.type).toBe('cycle');
    e.setCell('B1', '1');
    expect(val(e, 'A1')).toBe('1');
    expect(err(e, 'B1')).toBeNull();
  });
});

describe('单格编辑错误只影响该格及其下游', () => {
  it('把一格改成非法文本：该格 parse 错误，下游传播，旁枝不动', () => {
    const e = make({ A1: '2', B1: '=A1+1', C1: '=B1*3', Z1: '=9+9' });
    e.setCell('B1', '=A1+');
    expect(err(e, 'B1')!.type).toBe('parse');
    expect(err(e, 'C1')!.type).toBe('parse');
    expect(err(e, 'C1')!.source).toBe('B1');
    expect(val(e, 'C1')).toBeNull();
    expect(val(e, 'A1')).toBe('2');
    expect(val(e, 'Z1')).toBe('18');
  });

  it('非法输入仍可查看原始文本，修正后恢复', () => {
    const e = make({ A1: '=1+1' });
    e.setCell('A1', '=SUM(1)');
    expect(e.getRaw('A1')).toBe('=SUM(1)');
    expect(err(e, 'A1')!.type).toBe('parse');
    e.setCell('A1', '=1+1');
    expect(val(e, 'A1')).toBe('2');
  });
});

describe('直接依赖可见', () => {
  it('去重列出直接依赖', () => {
    const e = make({ A1: '=B1+B1*C1' });
    expect(e.getSnapshot().states.get('A1')!.deps).toEqual(['B1', 'C1']);
  });
});

describe('导入：非法则整份拒绝并保留上次有效表', () => {
  it('非 JSON 拒绝', () => {
    expect(validateImport('not json').ok).toBe(false);
  });
  it('格式标记不匹配拒绝', () => {
    expect(validateImport(JSON.stringify({ cells: [] })).ok).toBe(false);
  });
  it('地址越界、raw 非法、地址重复都拒绝', () => {
    const bad1 = JSON.stringify({
      format: 'onsite-sheet',
      version: 1,
      cells: [{ addr: 'U1', raw: '1' }],
    });
    expect(validateImport(bad1).ok).toBe(false);
    const bad2 = JSON.stringify({
      format: 'onsite-sheet',
      version: 1,
      cells: [{ addr: 'A1', raw: '=1+' }],
    });
    expect(validateImport(bad2).ok).toBe(false);
    const bad3 = JSON.stringify({
      format: 'onsite-sheet',
      version: 1,
      cells: [
        { addr: 'A1', raw: '1' },
        { addr: 'A1', raw: '2' },
      ],
    });
    expect(validateImport(bad3).ok).toBe(false);
  });

  it('拒绝导入后引擎仍保留上次有效表', () => {
    const e = make({ A1: '1', B1: '=A1+1' });
    const beforeRev = e.getSnapshot().revision;
    const result = validateImport(
      JSON.stringify({ format: 'onsite-sheet', version: 1, cells: [{ addr: 'ZZ', raw: 'x' }] }),
    );
    expect(result.ok).toBe(false);
    // 未调用 loadGrid：表不变
    expect(e.getSnapshot().revision).toBe(beforeRev);
    expect(val(e, 'B1')).toBe('2');
  });

  it('合法导出文件可重新导入且结果一致（表格与导出共享快照）', () => {
    const e = make({ A1: '2', B1: '=A1/3', C1: '=B1+1', D1: '=1/0' });
    const json = exportSnapshot(e.getSnapshot());
    const result = validateImport(json);
    expect(result.ok).toBe(true);
    const e2 = new SheetEngine();
    e2.loadGrid(result.cells!);
    const s1: Snapshot = e.getSnapshot();
    const s2: Snapshot = e2.getSnapshot();
    expect([...s1.states.keys()].sort()).toEqual([...s2.states.keys()].sort());
    for (const k of s1.states.keys()) {
      expect(s2.states.get(k)!.value?.toExactString()).toBe(
        s1.states.get(k)!.value?.toExactString(),
      );
      expect(s2.states.get(k)!.error?.type ?? null).toBe(s1.states.get(k)!.error?.type ?? null);
    }
  });
});
