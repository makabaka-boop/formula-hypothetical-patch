import type { Addr } from './cells';

/** 依赖边：key -> deps[key]（求值时引用到的格） */
export type Deps = Map<Addr, Addr[]>;

/* ------------------------- Tarjan 强连通分量（迭代版） ------------------------- */

interface TarjanResult {
  sccs: Addr[][]; // 每个强连通分量
  sccOf: Map<Addr, number>;
  cyclic: Set<Addr>; // 属于真正依赖环的格（SCC 大小>1 或自环）
}

export function tarjan(deps: Deps): TarjanResult {
  let indexCounter = 0;
  const index = new Map<Addr, number>();
  const low = new Map<Addr, number>();
  const onStack = new Set<Addr>();
  const stack: Addr[] = [];
  const sccs: Addr[][] = [];
  const sccOf = new Map<Addr, number>();

  for (const start of deps.keys()) {
    if (index.has(start)) continue;

    // 迭代 DFS：[节点, 下一条边序号]
    const work: { v: Addr; edge: number }[] = [{ v: start, edge: 0 }];
    index.set(start, indexCounter);
    low.set(start, indexCounter);
    indexCounter++;
    stack.push(start);
    onStack.add(start);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      const neighbors = deps.get(frame.v) ?? [];
      if (frame.edge < neighbors.length) {
        const w = neighbors[frame.edge++];
        if (!index.has(w)) {
          index.set(w, indexCounter);
          low.set(w, indexCounter);
          indexCounter++;
          stack.push(w);
          onStack.add(w);
          work.push({ v: w, edge: 0 });
        } else if (onStack.has(w)) {
          low.set(frame.v, Math.min(low.get(frame.v)!, index.get(w)!));
        }
      } else {
        if (low.get(frame.v) === index.get(frame.v)) {
          const comp: Addr[] = [];
          for (;;) {
            const w = stack.pop()!;
            onStack.delete(w);
            comp.push(w);
            sccOf.set(w, sccs.length);
            if (w === frame.v) break;
          }
          sccs.push(comp);
        }
        work.pop();
        if (work.length > 0) {
          const parent = work[work.length - 1].v;
          low.set(parent, Math.min(low.get(parent)!, low.get(frame.v)!));
        }
      }
    }
  }

  const cyclic = new Set<Addr>();
  sccs.forEach((comp) => {
    if (comp.length > 1) {
      comp.forEach((v) => cyclic.add(v));
    } else {
      const v = comp[0];
      if ((deps.get(v) ?? []).includes(v)) cyclic.add(v);
    }
  });

  return { sccs, sccOf, cyclic };
}

/**
 * 从某个环内节点出发，沿依赖边找到一条回到自身的实际环。
 * 自环直接返回 [v, v]；否则 BFS 找到第一个“有边直接回到 v”的节点 w，
 * 环为 v -> ... -> w -> v。
 */
export function findRing(v: Addr, deps: Deps): Addr[] {
  const neighbors = deps.get(v) ?? [];
  if (neighbors.includes(v)) return [v, v];

  const prev = new Map<Addr, Addr>();
  const queue: Addr[] = [];
  for (const w of neighbors) {
    if (!prev.has(w)) {
      prev.set(w, v);
      queue.push(w);
    }
  }

  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const outs = deps.get(cur) ?? [];
    if (cur !== v && outs.includes(v)) {
      // 还原 v -> ... -> cur
      const path: Addr[] = [];
      let p: Addr = cur;
      while (p !== v) {
        path.push(p);
        p = prev.get(p)!;
      }
      path.reverse();
      return [v, ...path, v];
    }
    for (const w of outs) {
      if (w !== v && !prev.has(w)) {
        prev.set(w, cur);
        queue.push(w);
      }
    }
  }
  return [v, v]; // v 确认在环内，理论上不可达
}

/**
 * 为环内每个成员生成“从自身出发的实际环路径”。
 * 先取一条代表环，环上成员按自身旋转；非环 SCC 成员不需要（用环标记即可）。
 */
export function cyclePathsForScc(
  members: Addr[],
  deps: Deps,
): Map<Addr, Addr[]> {
  const result = new Map<Addr, Addr[]>();
  if (members.length === 1) {
    result.set(members[0], [members[0], members[0]]);
    return result;
  }
  // 确定性：从字典序最小的成员找代表环
  const start = [...members].sort()[0];
  const baseRing = findRing(start, deps);

  for (const m of members) {
    const idx = baseRing.indexOf(m);
    if (idx >= 0) {
      // 从 m 开始走完一圈回到 m
      result.set(m, [...baseRing.slice(idx), ...baseRing.slice(1, idx + 1)]);
    } else {
      // m 与环同属一个 SCC 但不在这条简单环上：单独搜一条
      result.set(m, findRing(m, deps));
    }
  }
  return result;
}

/* ------------------------------ 拓扑序（Kahn） ------------------------------ */

/**
 * 对非环节点求拓扑序：边 key -> dep。
 * 先算无依赖（含空引用）的节点。环内节点已被排除，不会卡住。
 */
export function topoOrder(nodes: Addr[], deps: Deps, cyclic: Set<Addr>): Addr[] {
  const inSet = new Set(nodes);
  const indeg = new Map<Addr, number>();
  const dependents = new Map<Addr, Addr[]>(); // dep -> 依赖它的节点

  for (const v of nodes) indeg.set(v, 0);
  for (const v of nodes) {
    for (const dep of deps.get(v) ?? []) {
      if (cyclic.has(dep) || !inSet.has(dep)) continue;
      indeg.set(v, (indeg.get(v) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(v);
      dependents.set(dep, list);
    }
  }

  // 字典序入队，保证结果确定
  const ready = nodes.filter((v) => (indeg.get(v) ?? 0) === 0).sort();
  const order: Addr[] = [];
  while (ready.length > 0) {
    const v = ready.shift()!;
    order.push(v);
    for (const w of (dependents.get(v) ?? []).slice().sort()) {
      const d = (indeg.get(w) ?? 0) - 1;
      indeg.set(w, d);
      if (d === 0) {
        // 保持整体字典序倾向：插入后排序（节点最多 400，代价可忽略）
        ready.push(w);
        ready.sort();
      }
    }
  }
  return order;
}

/* ------------------------------ 受影响集合 ------------------------------ */

/** changed + 其在反向依赖图上的全部传递下游（dependentsOf 由调用方提供） */
export function affectedSet(
  changed: Addr[],
  allDeps: Deps,
): Set<Addr> {
  const affected = new Set<Addr>(changed);
  // 反向边
  const dependents = new Map<Addr, Addr[]>();
  for (const [v, ds] of allDeps) {
    for (const d of ds) {
      const list = dependents.get(d) ?? [];
      list.push(v);
      dependents.set(d, list);
    }
  }
  const queue = [...changed];
  while (queue.length > 0) {
    const v = queue.shift()!;
    for (const w of dependents.get(v) ?? []) {
      if (!affected.has(w)) {
        affected.add(w);
        queue.push(w);
      }
    }
  }
  return affected;
}
