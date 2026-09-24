import { COLS, ROWS, colToLetter, keyOf, type Addr } from '../engine/cells';
import type { Snapshot } from '../engine/engine';
import { Cell, shellClass } from './Cell';

interface GridProps {
  snap: Snapshot;
  selected: Addr;
  editing: Addr | null;
  onSelect: (addr: Addr) => void;
  onCommit: (addr: Addr, text: string) => void;
  onBeginEdit: (addr: Addr) => void;
  onEndEdit: () => void;
  onMove: (dr: number, dc: number) => void;
}

export function Grid({
  snap,
  selected,
  editing,
  onSelect,
  onCommit,
  onBeginEdit,
  onEndEdit,
  onMove,
}: GridProps) {
  return (
    <div className="sheet-scroll">
      <table className="sheet">
        <thead>
          <tr>
            <th className="rowhead-col" />
            {Array.from({ length: COLS }, (_, c) => (
              <th key={c}>{colToLetter(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: ROWS }, (_, r) => (
            <tr key={r}>
              <td className="rowhead">{r + 1}</td>
              {Array.from({ length: COLS }, (_, c) => {
                const addr = keyOf(c, r)!;
                const st = snap.states.get(addr);
                const isEditing = editing === addr;
                return (
                  <td key={c} className={isEditing ? '' : shellClass(st)}>
                    <Cell
                      state={st}
                      selected={selected === addr && !isEditing}
                      editing={isEditing}
                      onSelect={() => onSelect(addr)}
                      onBeginEdit={() => onBeginEdit(addr)}
                      onEndEdit={onEndEdit}
                      onCommit={(text) => onCommit(addr, text)}
                      onMove={(dr, dc) => onMove(dr, dc)}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
