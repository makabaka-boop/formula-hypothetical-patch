import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAddr, keyOf, type Addr } from '../engine/cells';
import { SheetEngine, type HypothesisPreview } from '../engine/engine';
import { exportSnapshot, validateImport } from '../engine/snapshot';
import { Grid } from './Grid';
import { Inspector } from './Inspector';
import { HypothesisPanel } from './HypothesisPanel';

const DEMO: Record<string, string> = {
  A1: '8',
  A2: '3',
  B1: '=A1+A2*2',
  B2: '=A1/A2',
  C1: '=B1-B2',
  C2: '=(A1+A2)/3',
  D1: '=1/3',
  D2: '=D1+D1+D1',
  // 制造一个环和一个除零，方便质检员核对标记：
  F1: '=F2+1',
  F2: '=F1-1',
  F3: '=F1+10',
  H1: '0',
  H2: '=9/H1',
  H3: '=H2+1',
};

export function App() {
  const engine = useMemo(() => new SheetEngine(), []);
  const [snap, setSnap] = useState(() => engine.getSnapshot());
  const [selected, setSelected] = useState<Addr>('A1');
  const [editing, setEditing] = useState<Addr | null>(null);
  const [barDraft, setBarDraft] = useState('');
  const [barEditing, setBarEditing] = useState(false);
  const [importErrors, setImportErrors] = useState<string[] | null>(null);
  const [hypOpen, setHypOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(() => {
    setSnap(engine.getSnapshot());
  }, [engine]);

  const select = useCallback(
    (addr: Addr) => {
      setSelected(addr);
      setEditing(null);
      setBarEditing(false);
      setBarDraft(engine.getRaw(addr));
    },
    [engine],
  );

  const commit = useCallback(
    (addr: Addr, text: string) => {
      engine.setCell(addr, text);
      refresh();
      setBarDraft(engine.getRaw(addr));
    },
    [engine, refresh],
  );

  const move = useCallback(
    (dr: number, dc: number) => {
      const p = parseAddr(selected);
      if (!p) return;
      const next = keyOf(p.col + dc, p.row + dr);
      if (next) select(next);
    },
    [selected, select],
  );

  // 全局键盘导航（非编辑状态）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || barEditing) return;
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      switch (e.key) {
        case 'ArrowUp':
          move(-1, 0);
          e.preventDefault();
          break;
        case 'ArrowDown':
        case 'Enter':
          move(1, 0);
          e.preventDefault();
          break;
        case 'ArrowLeft':
          move(0, -1);
          e.preventDefault();
          break;
        case 'ArrowRight':
        case 'Tab':
          move(0, 1);
          e.preventDefault();
          break;
        case 'Delete':
        case 'Backspace':
          commit(selected, '');
          e.preventDefault();
          break;
        case 'F2':
          setEditing(selected);
          e.preventDefault();
          break;
        default:
          // 直接键入字符：进入该格编辑并以该字符开始
          if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            setEditing(selected);
            // 通过自定义事件把首字符交给输入框
            queueMicrotask(() =>
              window.dispatchEvent(
                new CustomEvent('cell-initial-char', { detail: e.key }),
              ),
            );
          }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, barEditing, move, commit, selected]);

  const handleExport = () => {
    const blob = new Blob([exportSnapshot(engine.getSnapshot())], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `sheet-snapshot-r${snap.revision}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportFile = async (file: File) => {
    const text = await file.text();
    const result = validateImport(text);
    if (!result.ok) {
      // 整份拒绝，保留上次有效表
      setImportErrors(result.errors);
      return;
    }
    setImportErrors(null);
    engine.loadGrid(result.cells!);
    refresh();
    setHypOpen(false); // 导入新网格：预演工作区不沿用
    select('A1');
  };

  const loadDemo = () => {
    engine.loadGrid(DEMO);
    refresh();
    select('F1');
  };

  // 假设修改：预演只基于当前快照读引擎，绝不写正式网格
  const runPreview = (entries: { addr: Addr; raw: string }[]): HypothesisPreview =>
    engine.previewHypothesis(entries);

  const commitPreview = (p: HypothesisPreview): boolean => {
    const r = engine.commitHypothesis(p);
    if (r.ok) {
      refresh();
      setBarDraft(engine.getRaw(selected));
      return true;
    }
    // 过期：刷新状态让面板显示过期提示，正式数据原样保留
    refresh();
    return false;
  };

  return (
    <div className="app">
      <div className="toolbar">
        <h1>现场试算表</h1>
        <button className="btn" onClick={loadDemo}>
          载入演示
        </button>
        <button className="btn" onClick={handleExport}>
          导出 JSON 快照
        </button>
        <button
          className={`btn${hypOpen ? ' active' : ''}`}
          onClick={() => setHypOpen((v) => !v)}
          title="同时预演 1～3 格修改对下游与错误来源的影响"
        >
          假设修改
        </button>
        <button className="btn" onClick={() => fileRef.current?.click()}>
          导入 JSON
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          style={{ display: 'none' }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleImportFile(f);
            e.target.value = '';
          }}
        />
        <button
          className="btn"
          onClick={() => {
            engine.clearAll();
            refresh();
          }}
        >
          清空
        </button>
        <span className="spacer" />
        <span className="revision">
          快照修订 r{snap.revision} · {snap.raw.size} 个非空格
        </span>
      </div>

      {importErrors && (
        <div className="import-error">
          <b>导入被拒绝，已保留当前表格：</b>
          {'\n'}
          {importErrors.map((m, i) => (
            <div key={i}>• {m}</div>
          ))}
          <div>
            <button className="btn" onClick={() => setImportErrors(null)}>
              知道了
            </button>
          </div>
        </div>
      )}

      <div className="formula-bar">
        <span className="addr-label">{selected}</span>
        <span className="fx">fx</span>
        <input
          value={barEditing ? barDraft : snap.raw.get(selected) ?? ''}
          onChange={(e) => {
            setBarEditing(true);
            setBarDraft(e.target.value);
          }}
          onFocus={() => {
            setBarEditing(true);
            setBarDraft(engine.getRaw(selected));
          }}
          onBlur={() => {
            if (barEditing) {
              commit(selected, barDraft);
              setBarEditing(false);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit(selected, barDraft);
              (e.target as HTMLInputElement).blur();
              e.preventDefault();
            } else if (e.key === 'Escape') {
              setBarDraft(engine.getRaw(selected));
              setBarEditing(false);
              (e.target as HTMLInputElement).blur();
              e.preventDefault();
            }
          }}
          placeholder="输入整数，或 = 开头的公式（仅支持 + - * /、括号、一元负号、A1..T20 引用）"
        />
        <span className="hint">Enter 确认 · Esc 取消</span>
      </div>

      {hypOpen && (
        <HypothesisPanel
          revision={snap.revision}
          initialAddr={selected}
          onPreview={runPreview}
          onCommit={commitPreview}
          onCancel={() => setHypOpen(false)}
          onJump={(addr) => select(addr)}
        />
      )}

      <div className="main">
        <Grid
          snap={snap}
          selected={selected}
          editing={editing}
          onSelect={select}
          onCommit={commit}
          onBeginEdit={(addr) => setEditing(addr)}
          onEndEdit={() => setEditing(null)}
          onMove={move}
        />
        <Inspector addr={selected} snap={snap} onJump={select} />
      </div>
    </div>
  );
}
