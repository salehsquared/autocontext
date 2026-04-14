import type { IndexStore } from "../index/store.js";
import type { DirEdge } from "../index/types.js";

const MAX_HOPS = 4;

/**
 * Compute 1 / (1 + hops) graph proximity for every directory in the project,
 * seeded from `seedDirs`. BFS over the T1 `DirEdge` graph treated as
 * undirected. Directories beyond `MAX_HOPS` get proximity 0.
 */
export async function computeGraphProximity(
  store: IndexStore,
  seedDirs: string[],
): Promise<Map<string, number>> {
  const edges = await store.getDirEdges();
  if (seedDirs.length === 0) return new Map();

  const adj = new Map<string, Set<string>>();
  const addEdge = (a: string, b: string) => {
    if (a === b) return;
    let set = adj.get(a);
    if (!set) {
      set = new Set();
      adj.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges as DirEdge[]) {
    addEdge(e.from_dir, e.to_dir);
    addEdge(e.to_dir, e.from_dir);
  }

  const hops = new Map<string, number>();
  const queue: Array<[string, number]> = seedDirs.map((d) => [d, 0]);
  for (const [d] of queue) hops.set(d, 0);

  while (queue.length > 0) {
    const [cur, h] = queue.shift()!;
    if (h >= MAX_HOPS) continue;
    const nexts = adj.get(cur);
    if (!nexts) continue;
    for (const n of nexts) {
      if (hops.has(n)) continue;
      hops.set(n, h + 1);
      queue.push([n, h + 1]);
    }
  }

  const out = new Map<string, number>();
  for (const [dir, h] of hops) {
    out.set(dir, 1 / (1 + h));
  }
  return out;
}
