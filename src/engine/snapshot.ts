import { inBounds, type Addr } from './cells';
import type { Snapshot } from './engine';
import { parseCellInput } from './parser';

/**
 * 导出文件格式（即“当前计算快照”）：
 * 网格数据与 UI 表格共享同一个 Snapshot，导出只是把它序列化。
 */
export interface SnapshotFile {
  format: 'onsite-sheet';
  version: 1;
  exportedAt: string;
  revision: number;
  cells: ExportedCell[];
}

interface ExportedCell {
  addr: Addr;
  raw: string;
  value: { n: string; d: string } | null;
  display: string | null;
  error:
    | {
        type: 'parse' | 'cycle' | 'divzero';
        message: string;
        source: Addr;
        path: Addr[];
        cycle?: Addr[];
      }
    | null;
}

/** 把当前计算快照序列化为 JSON 字符串 */
export function exportSnapshot(snap: Snapshot, now: Date = new Date()): string {
  const cells: ExportedCell[] = [];
  for (const addr of [...snap.raw.keys()].sort()) {
    const st = snap.states.get(addr);
    cells.push({
      addr,
      raw: snap.raw.get(addr) ?? '',
      value: st?.value ? st.value.toJSON() : null,
      display: st?.value ? st.value.toDisplayString() : null,
      error: st?.error
        ? {
            type: st.error.type,
            message: st.error.message,
            source: st.error.source,
            path: st.error.path,
            cycle: st.error.cycle,
          }
        : null,
    });
  }
  const file: SnapshotFile = {
    format: 'onsite-sheet',
    version: 1,
    exportedAt: now.toISOString(),
    revision: snap.revision,
    cells,
  };
  return JSON.stringify(file, null, 2);
}

export interface ImportResult {
  ok: boolean;
  /** 校验通过时得到的原始输入映射（地址 -> 文本） */
  cells?: Record<Addr, string>;
  /** 拒绝原因（非法导入时） */
  errors: string[];
}

/**
 * 校验一份导入文本。
 * 整份要么全部合法并接受，要么拒绝、保留上次有效表。
 * 规则：
 *  - 必须是本工作台导出的 JSON 快照（format/version 匹配）
 *  - cells 必须是数组；每项必须有合法地址（A1..T20，不重复）和字符串 raw
 *  - 每个 raw 必须能通过解析器（空 / 整数 / 合法公式）
 * 运行期的环或除零不是导入错误——导入后照常参与计算并标出。
 */
export function validateImport(text: string): ImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['不是合法的 JSON 文件'] };
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, errors: ['文件顶层必须是对象'] };
  }
  const obj = data as Record<string, unknown>;
  if (obj.format !== 'onsite-sheet') {
    return { ok: false, errors: ['缺少 format: "onsite-sheet"，不是本工作台的导出文件'] };
  }
  if (obj.version !== 1) {
    return { ok: false, errors: [`不支持的版本：${String(obj.version)}`] };
  }
  if (!Array.isArray(obj.cells)) {
    return { ok: false, errors: ['cells 必须是数组'] };
  }

  const errors: string[] = [];
  const cells: Record<string, string> = {};
  const seen = new Set<string>();

  obj.cells.forEach((entry, i) => {
    const where = `cells[${i}]`;
    if (typeof entry !== 'object' || entry === null) {
      errors.push(`${where}：必须是对象`);
      return;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.addr !== 'string' || !inBounds(e.addr)) {
      errors.push(`${where}：地址非法（应为 A1..T20），实际为 ${JSON.stringify(e.addr)}`);
      return;
    }
    if (seen.has(e.addr)) {
      errors.push(`${where}：地址 ${e.addr} 重复`);
      return;
    }
    seen.add(e.addr);
    if (typeof e.raw !== 'string') {
      errors.push(`${where} (${e.addr})：raw 必须是字符串`);
      return;
    }
    try {
      parseCellInput(e.raw);
    } catch (err) {
      errors.push(`${e.addr}：${(err as Error).message}`);
      return;
    }
    if (e.raw.trim() !== '') cells[e.addr] = e.raw;
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, cells, errors: [] };
}
