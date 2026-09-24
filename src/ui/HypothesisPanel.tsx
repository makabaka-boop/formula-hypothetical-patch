import { useState } from 'react';
import { normalizeRef, type Addr } from '../engine/cells';
import type { CellOutcome, HypothesisPreview } from '../engine/engine';

interface HypothesisPanelProps {
  revision: number;
  initialAddr: Addr;
  /** 基于当前正式快照预演（不会修改正式网格） */
  onPreview: (
    entries: { addr: Addr; raw: string }[],
  ) => HypothesisPreview;
  /** 一次性采纳；返回 false 表示预演已过期 */
  onCommit: (preview: HypothesisPreview) => boolean;
  onCancel: () => void;
  onJump: (addr: Addr) => void;
}

const MAX_ENTRIES = 3;

function errorCode(t: CellOutcome['error']): string {
  switch (t!.type) {
    case 'parse':
      return '#ERR!';
    case 'cycle':
      return '#CYCLE!';
    case 'divzero':
      return '#DIV/0!';
  }
}

function OutcomeView({ o }: { o: CellOutcome }) {
  if (o.error) {
    return (
      <span className={`hyp-err hyp-err-${o.error.type}`} title={o.error.message}>
        {errorCode(o.error)}
      </span>
    );
  }
  if (o.value) {
    return <span className="hyp-num">{o.value.toDisplayString()}</span>;
  }
  return <span className="hyp-empty">（空）</span>;
}

function PathView({ o }: { o: CellOutcome }) {
  if (!o.error) return null;
  const seq = o.error.cycle ?? o.error.path;
  if (seq.length <= 1) {
    return <span className="hyp-path">来源 {o.error.source}</span>;
  }
  return (
    <span className="hyp-path">
      {o.error.type === 'cycle' ? '环：' : '来源路径：'}
      {seq.join(' → ')}
    </span>
  );
}

export function HypothesisPanel({
  revision,
  initialAddr,
  onPreview,
  onCommit,
  onCancel,
  onJump,
}: HypothesisPanelProps) {
  const [rows, setRows] = useState<string[]>(() => [initialAddr, '', '']);
  const [raws, setRaws] = useState<string[]>(['', '', '']);
  const [preview, setPreview] = useState<HypothesisPreview | null>(null);
  const [rejectErrors, setRejectErrors] = useState<string[] | null>(null);

  const updateAddr = (i: number, v: string) => {
    const next = [...rows];
    next[i] = v;
    setRows(next);
    setPreview(null);
    setRejectErrors(null);
  };
  const updateRaw = (i: number, v: string) => {
    const next = [...raws];
    next[i] = v;
    setRaws(next);
    setPreview(null);
    setRejectErrors(null);
  };

  const runPreview = () => {
    const entries: { addr: string; raw: string }[] = [];
    const errs: string[] = [];
    rows.forEach((a, i) => {
      const addr = a.trim();
      const raw = raws[i];
      if (addr === '' && raw.trim() === '') return; // 整行空白：忽略
      if (addr === '') {
        errs.push(`第 ${i + 1} 行：只填了输入内容，缺少格地址`);
        return;
      }
      if (!normalizeRef(addr)) {
        errs.push(`第 ${i + 1} 行：地址 ${addr} 超出 A1..T20`);
        return;
      }
      entries.push({ addr, raw });
    });
    if (errs.length === 0 && (entries.length < 1 || entries.length > MAX_ENTRIES)) {
      errs.push('请至少填写 1 格、最多 3 格候选（地址 + 原始输入）');
    }
    if (errs.length > 0) {
      setRejectErrors(errs);
      setPreview(null);
      return;
    }
    const p = onPreview(entries);
    if (!p.ok) {
      setRejectErrors(p.errors ?? ['候选被整组拒绝']);
      setPreview(null);
      return;
    }
    setRejectErrors(null);
    setPreview(p);
  };

  const stale = preview !== null && preview.baseRevision !== revision;

  const adopt = () => {
    if (!preview) return;
    if (onCommit(preview)) {
      onCancel(); // 采纳成功，关闭工作区
    }
    // 过期时 onCommit 返回 false：保留预演，面板显示过期提示
  };

  return (
    <div className="hyp-panel">
      <div className="hyp-head">
        <h2>假设修改工作区</h2>
        <span className="hyp-sub">
          同时预演 1～3 格 · 基于正式网格 r{revision} 一次性求值，不逐格提交
        </span>
        <button className="btn hyp-close" onClick={onCancel} title="取消并关闭">
          ✕
        </button>
      </div>

      <table className="hyp-input-table">
        <thead>
          <tr>
            <th className="hyp-col-idx">#</th>
            <th className="hyp-col-addr">格地址</th>
            <th>原始输入（空 / 整数 / = 公式）</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((_, i) => (
            <tr key={i}>
              <td className="hyp-col-idx">{i + 1}</td>
              <td className="hyp-col-addr">
                <input
                  className="hyp-addr-input"
                  value={rows[i]}
                  placeholder={i === 0 ? 'A1' : ''}
                  onChange={(e) => updateAddr(i, e.target.value)}
                />
              </td>
              <td>
                <input
                  className="hyp-raw-input"
                  value={raws[i]}
                  placeholder={i === 0 ? '例如 =B1+1，留空表示清空该格' : ''}
                  onChange={(e) => updateRaw(i, e.target.value)}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="hyp-actions">
        <button className="btn primary" onClick={runPreview}>
          预演整组修改
        </button>
        {preview && (
          <button className="btn" onClick={adopt} disabled={stale}>
            一次性采纳全部
          </button>
        )}
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        {preview && (
          <span className="hyp-stat">
            {preview.changes.length} 格发生变化
            {preview.baseRevision === revision
              ? ` · 依据 r${preview.baseRevision}`
              : ''}
          </span>
        )}
      </div>

      {rejectErrors && (
        <div className="hyp-reject">
          <b>整组候选已拒绝，正式网格未改动：</b>
          {rejectErrors.map((m, i) => (
            <div key={i}>• {m}</div>
          ))}
        </div>
      )}

      {preview && stale && (
        <div className="hyp-stale">
          <b>预演已过期：</b>
          预演依据修订 r{preview.baseRevision}，正式网格已变为 r{revision}
          （发生过单格编辑或导入）。请取消后基于当前网格重新预演；正式数据保持不变。
        </div>
      )}

      {preview && !stale && (
        <div className="hyp-results">
          {preview.changes.length === 0 ? (
            <div className="hyp-nochange">整组修改不会改变任何格的精确值、错误或来源路径。</div>
          ) : (
            <table className="hyp-diff-table">
              <thead>
                <tr>
                  <th>格</th>
                  <th>修改前</th>
                  <th>预演后</th>
                  <th>错误来源 / 环路径</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => {
                  const a = c.after;
                  return (
                    <tr
                      key={c.key}
                      className={a.error ? `hyp-row-${a.error.type}` : ''}
                      onClick={() => onJump(c.key)}
                      title={`跳转到 ${c.key}`}
                    >
                      <td className="hyp-cell-key">{c.key}</td>
                      <td className="hyp-cell-out">
                        <OutcomeView o={c.before} />
                      </td>
                      <td className="hyp-cell-out">
                        <OutcomeView o={a} />
                      </td>
                      <td className="hyp-cell-path">
                        <PathView o={a} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
