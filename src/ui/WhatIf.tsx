import { useState } from 'react';
import type { CellState, SheetEngine } from '../engine/engine';
import { MAX_WHATIF_CELLS, type WhatIfPreview } from '../engine/whatif';

interface WhatIfPanelProps {
  engine: SheetEngine;
  /** 整组修改被采纳后通知父组件刷新快照 */
  onApplied: () => void;
}

interface Row {
  addr: string;
  raw: string;
}

const emptyRows = (): Row[] =>
  Array.from({ length: MAX_WHATIF_CELLS }, () => ({ addr: '', raw: '' }));

/** 一格结果的一行摘要：精确值，或错误标记 + 来源/环路径 */
function outcomeText(st: CellState | null): string {
  if (!st) return '（空）';
  if (st.error) {
    const mark =
      st.error.type === 'cycle'
        ? '#CYCLE!'
        : st.error.type === 'divzero'
          ? '#DIV/0!'
          : '#ERR!';
    const path = st.error.cycle ?? st.error.path;
    return `${mark} ${path.join('→')}`;
  }
  return st.value!.toExactString();
}

/**
 * 假设修改工作区：1～3 格整组预演。
 * 预演只读当前快照、不写入正式网格；确认时若正式网格已前进则提示过期。
 */
export function WhatIfPanel({ engine, onApplied }: WhatIfPanelProps) {
  const [rows, setRows] = useState<Row[]>(emptyRows);
  const [errors, setErrors] = useState<string[] | null>(null);
  const [preview, setPreview] = useState<WhatIfPreview | null>(null);
  const [stale, setStale] = useState<string | null>(null);

  const setRow = (i: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  };

  const runPreview = () => {
    // 地址为空的行视为未使用；地址统一大写后交给引擎严格校验
    const candidates = rows
      .filter((r) => r.addr.trim() !== '')
      .map((r) => ({ addr: r.addr.trim().toUpperCase(), raw: r.raw }));
    const result = engine.previewWhatIf(candidates);
    setStale(null);
    if (!result.ok) {
      setErrors(result.errors);
      setPreview(null);
      return;
    }
    setErrors(null);
    setPreview(result.preview);
  };

  const confirm = () => {
    if (!preview) return;
    const res = engine.confirmWhatIf(preview);
    if (!res.ok) {
      // 过期：正式数据保持不变，只提示
      setStale(res.errors?.join('；') ?? '预演已过期');
      return;
    }
    setPreview(null);
    setErrors(null);
    setStale(null);
    onApplied();
  };

  const cancel = () => {
    // 取消：丢弃预演结果，不写入任何内容
    setPreview(null);
    setErrors(null);
    setStale(null);
  };

  return (
    <div className="whatif-panel">
      <div className="whatif-head">
        <h2>假设修改工作区</h2>
        <span className="hint">
          1–3 格整组预演：基于当前快照构造最终依赖图，不按顺序逐格写入；留空地址的行忽略，内容为空白表示清空该格
        </span>
      </div>

      <div className="whatif-rows">
        {rows.map((row, i) => (
          <div className="whatif-row" key={i}>
            <input
              className="addr"
              value={row.addr}
              placeholder={`地址 ${i + 1}`}
              onChange={(e) => setRow(i, { addr: e.target.value })}
            />
            <input
              className="raw"
              value={row.raw}
              placeholder={
                row.addr.trim()
                  ? engine.getRaw(row.addr.trim().toUpperCase()) || '（当前为空）'
                  : '新输入（整数或 = 公式）'
              }
              onChange={(e) => setRow(i, { raw: e.target.value })}
            />
          </div>
        ))}
        <div className="whatif-actions">
          <button className="btn primary" onClick={runPreview}>
            预演
          </button>
          <button className="btn" onClick={confirm} disabled={!preview}>
            采纳全部修改
          </button>
          <button className="btn" onClick={cancel}>
            取消
          </button>
        </div>
      </div>

      {errors && (
        <div className="whatif-errors">
          <b>候选整组被拒绝，未写入任何结果：</b>
          {errors.map((m, i) => (
            <div key={i}>• {m}</div>
          ))}
        </div>
      )}

      {stale && <div className="whatif-stale">⚠ {stale}</div>}

      {preview && (
        <div className="whatif-result">
          <div className="whatif-result-head">
            预演基于修订 r{preview.baseRevision} · {preview.changes.length}{' '}
            格结果变化（未写入正式网格）
          </div>
          {preview.changes.length === 0 ? (
            <div className="empty-note">
              整组修改不改变任何格的精确值、错误类型或来源路径。
            </div>
          ) : (
            preview.changes.map((ch) => (
              <div className="whatif-change" key={ch.addr}>
                <span className="addr">{ch.addr}</span>
                <span className="before">{outcomeText(ch.before)}</span>
                <span className="arrow">→</span>
                <span className="after">{outcomeText(ch.after)}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
