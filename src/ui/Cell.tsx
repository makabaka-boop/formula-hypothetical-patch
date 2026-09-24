import { useEffect, useRef, useState } from 'react';
import type { CellState } from '../engine/engine';

interface CellProps {
  state: CellState | undefined;
  selected: boolean;
  onSelect: () => void;
  onCommit: (text: string) => void;
  onMove: (dr: number, dc: number) => void;
  editing: boolean;
  onBeginEdit: () => void;
  onEndEdit: () => void;
}

/** 单元格错误在网格中的标记文字 */
export function errorCode(state: CellState): string {
  switch (state.error!.type) {
    case 'parse':
      return '#ERR!';
    case 'cycle':
      return '#CYCLE!';
    case 'divzero':
      return '#DIV/0!';
  }
}

/** 错误格 <td> 外壳的背景样式（由 Grid 应用） */
export function shellClass(state: CellState | undefined): string {
  if (!state?.error) return '';
  if (state.error.type === 'cycle' && state.error.cycle) return 'cell-cycle';
  return state.error.source === state.key
    ? 'cell-error-source'
    : 'cell-error-downstream';
}

export function Cell({
  state,
  selected,
  onSelect,
  onCommit,
  onMove,
  editing,
  onBeginEdit,
  onEndEdit,
}: CellProps) {
  const [draft, setDraft] = useState(state?.raw ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      setDraft(state?.raw ?? '');
      inputRef.current?.focus();
    }
  }, [editing, state]);

  // 非编辑状态下直接敲入字符：以该字符开启编辑
  useEffect(() => {
    if (!editing) return;
    const handler = (e: Event) => {
      const ch = (e as CustomEvent<string>).detail;
      setDraft(ch);
      const el = inputRef.current;
      if (el) {
        el.setSelectionRange(ch.length, ch.length);
      }
    };
    window.addEventListener('cell-initial-char', handler);
    return () => window.removeEventListener('cell-initial-char', handler);
  }, [editing]);

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="cell-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          onCommit(draft);
          onEndEdit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            onCommit(draft);
            onEndEdit();
            onMove(1, 0);
            e.preventDefault();
          } else if (e.key === 'Escape') {
            onEndEdit();
            e.preventDefault();
          } else if (e.key === 'Tab') {
            onCommit(draft);
            onEndEdit();
            onMove(0, e.shiftKey ? -1 : 1);
            e.preventDefault();
          }
          e.stopPropagation();
        }}
      />
    );
  }

  const classes = ['cell'];
  if (state && !state.error) classes.push('number'); // 结果值右对齐
  if (selected) classes.push('selected');

  let content: React.ReactNode = '';
  if (state?.error) {
    content = (
      <span className="err-mark" title={state.error.message}>
        {errorCode(state)}
      </span>
    );
  } else if (state) {
    content = state.value!.toDisplayString();
  }

  return (
    <div
      className={classes.join(' ')}
      onClick={(e) => {
        onSelect();
        e.stopPropagation();
      }}
      onDoubleClick={(e) => {
        onSelect();
        onBeginEdit();
        e.stopPropagation();
      }}
      title={state?.error ? state.error.message : state?.raw}
    >
      {content}
    </div>
  );
}
