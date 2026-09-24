import type { Addr } from '../engine/cells';
import type { CellState, Snapshot } from '../engine/engine';

interface InspectorProps {
  addr: Addr;
  snap: Snapshot;
  onJump: (addr: Addr) => void;
}

function RefChip({ addr, onJump, cls }: { addr: Addr; onJump: (a: Addr) => void; cls?: string }) {
  return (
    <button
      type="button"
      className={`ref-chip${cls ? ` ${cls}` : ''}`}
      onClick={() => onJump(addr)}
      title={`跳转到 ${addr}`}
    >
      {addr}
    </button>
  );
}

function PathChain({
  path,
  source,
  cycleSet,
  onJump,
}: {
  path: Addr[];
  source: Addr;
  cycleSet?: Set<Addr>;
  onJump: (a: Addr) => void;
}) {
  return (
    <div className="path-chain">
      {path.map((a, i) => (
        <span key={`${a}-${i}`} style={{ display: 'contents' }}>
          {i > 0 && <span className="arrow">→</span>}
          <RefChip
            addr={a}
            onJump={onJump}
            cls={
              a === source
                ? 'source'
                : cycleSet?.has(a)
                  ? 'cycle-node'
                  : undefined
            }
          />
        </span>
      ))}
    </div>
  );
}

export function Inspector({ addr, snap, onJump }: InspectorProps) {
  const st: CellState | undefined = snap.states.get(addr);
  const raw = snap.raw.get(addr) ?? '';

  return (
    <div className="inspector">
      <h2>单元格 <span className="mono" style={{ fontSize: 14 }}>{addr}</span></h2>

      <h3>输入 / 公式</h3>
      {raw ? <div className="mono">{raw}</div> : <div className="empty-note">（空单元格）</div>}

      {st && (
        <>
          <h3>直接依赖 ({st.deps.length})</h3>
          {st.deps.length === 0 ? (
            <div className="empty-note">无引用其他格</div>
          ) : (
            <div className="path-chain">
              {st.deps.map((d) => (
                <RefChip key={d} addr={d} onJump={onJump} />
              ))}
            </div>
          )}

          <h3>计算结果</h3>
          {st.error ? (
            <div className={`error-box ${st.error.type}`}>
              {st.error.type === 'parse' && '⛔ 解析错误（非法输入）'}
              {st.error.type === 'cycle' && '🔁 循环引用'}
              {st.error.type === 'divzero' && '∅ 除以零'}
              <div style={{ fontWeight: 400, marginTop: 4 }}>{st.error.message}</div>

              <h3 style={{ color: 'inherit', marginTop: 10 }}>
                {st.error.type === 'cycle' ? '实际环路径（首尾为自身）' : '错误来源与传播路径'}
              </h3>
              <PathChain
                path={st.error.cycle ?? st.error.path}
                source={st.error.source}
                cycleSet={st.error.cycle ? new Set(st.error.cycle) : undefined}
                onJump={onJump}
              />
              {st.error.type !== 'cycle' && st.error.path.length > 1 && (
                <div className="empty-note" style={{ marginTop: 6 }}>
                  来源 <b>{st.error.source}</b>，经 {st.error.path.length - 1} 跳引用传播到 {addr}
                </div>
              )}
            </div>
          ) : (
            <>
              <div>
                <span className="value-ok">{st.value!.toExactString()}</span>
                {!st.value!.isInteger() && (
                  <span className="value-display">= {st.value!.toDisplayString()}</span>
                )}
              </div>
              <div className="empty-note" style={{ marginTop: 6 }}>
                {st.kind === 'formula'
                  ? '公式已按约分后的 BigInt 分数精确求值'
                  : '整数直接作为精确值'}
              </div>
            </>
          )}
        </>
      )}

      {!st && (
        <>
          <h3>计算结果</h3>
          <div className="empty-note">空格在公式中按 0 参与运算。</div>
        </>
      )}

      <div className="legend">
        <div className="row">
          <span className="swatch" style={{ background: '#fee2e2' }} />
          错误来源格（解析失败 / 除零）
        </div>
        <div className="row">
          <span className="swatch" style={{ background: '#fef2f2' }} />
          错误下游格（不显示旧值）
        </div>
        <div className="row">
          <span className="swatch" style={{ background: '#fffbeb', borderColor: '#f59e0b' }} />
          循环引用环上的格
        </div>
        <div className="row" style={{ marginTop: 6 }}>
          快捷键：双击或 Enter 编辑 · Esc 取消 · 方向键移动 · Delete 清空
        </div>
      </div>
    </div>
  );
}
