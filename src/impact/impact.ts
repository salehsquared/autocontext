import { posix } from "node:path";
import type { IndexStore } from "../index/store.js";
import type { FileId, IndexSymbol } from "../index/types.js";

/**
 * Change-impact BFS over the T1 reverse-reference graph.
 *
 * Seed set is a list of `{file, symbol?}` pairs. For each seed:
 *   - if a symbol is given, reverse-walk references to that specific symbol;
 *   - otherwise, reverse-walk references to every exported symbol in the file.
 *
 * The walk follows references + imports back to importers; each newly
 * discovered file's exports are enqueued for the next hop, bounded by
 * `maxDepth` (default 3) and `maxResults` (default 100). Output is
 * deterministic (sorted by hops then path).
 *
 * Precision boundary: T1-B guarantees import-bound references only. Impact is
 * therefore recall-imperfect — it's the right tool to *narrow* a review, not
 * to *prove* absence of effect. The caveat string is repeated in every
 * report's `caveat` field.
 */

export interface ImpactSeed {
  file: FileId;
  /** Specific symbol name (post-alias); omit for file-wide. */
  symbol?: string;
  /** Why the seed was added — file/symbol/diff. Default "file". */
  reason?: "file" | "symbol" | "diff";
}

export interface ImpactEdge {
  from: FileId;
  to: FileId;
  kind: "reference" | "import";
}

export interface ImpactAffected {
  file: FileId;
  /** Distance from the closest seed in hops. 0 = seed itself. */
  hops: number;
  /** The chain of edges that first reached this file. */
  via: ImpactEdge[];
  /** Directory path (POSIX, no trailing slash; `.` for repo root). */
  context_scope: string;
}

export interface ImpactAffectedScope {
  scope: string;
  min_hops: number;
  file_count: number;
}

export interface ImpactReport {
  seeds: Array<{ file: FileId; symbol?: string; reason: "file" | "symbol" | "diff" }>;
  affected: ImpactAffected[];
  affected_scopes: ImpactAffectedScope[];
  stopped: Array<"max_depth" | "max_results" | "natural">;
  caveat: string;
}

export const IMPACT_CAVEAT =
  "Reference-based impact. Only import-bound references are tracked (precision \u2265 0.95, recall \u2265 0.70 for TS/JS; lower elsewhere). Polymorphic dispatch, dynamic imports, and unbound identifier uses are NOT walked. Use this to narrow scope, not to prove absence of effect.";

export interface ImpactOptions {
  maxDepth?: number;
  maxResults?: number;
}

export async function computeImpact(
  store: IndexStore,
  seeds: ImpactSeed[],
  opts: ImpactOptions = {},
): Promise<ImpactReport> {
  const maxDepth = opts.maxDepth ?? 3;
  const maxResults = opts.maxResults ?? 100;

  const seedList = seeds.map((s) => ({
    file: s.file,
    symbol: s.symbol,
    reason: s.reason ?? (s.symbol ? "symbol" : "file"),
  }));

  const seen = new Map<FileId, ImpactAffected>();
  for (const s of seedList) {
    if (!seen.has(s.file)) {
      seen.set(s.file, {
        file: s.file,
        hops: 0,
        via: [],
        context_scope: scopeOf(s.file),
      });
    }
  }

  const stopped = new Set<"max_depth" | "max_results" | "natural">();

  // Frontier lives as an array of {file, viaChain}; process by hops.
  let frontier: Array<{ file: FileId; via: ImpactEdge[] }> = seedList.map((s) => ({
    file: s.file,
    via: [],
  }));
  let currentHops = 0;

  while (frontier.length > 0) {
    if (currentHops >= maxDepth) {
      stopped.add("max_depth");
      break;
    }
    const next: Array<{ file: FileId; via: ImpactEdge[] }> = [];

    // Build per-seed-file symbol lists once per hop so we don't hit the store
    // repeatedly for the same file.
    for (const entry of frontier) {
      const symbolFilter = currentHops === 0
        ? seedList.find((s) => s.file === entry.file)?.symbol
        : undefined;
      const symbols = await collectSymbols(store, entry.file, symbolFilter);

      // Reference edges: who uses the exported symbols of `entry.file`?
      for (const sym of symbols) {
        const refs = await store.getReferencesTo(sym.id);
        for (const r of refs) {
          if (r.file === entry.file) continue;
          if (seen.has(r.file)) continue;
          if (seen.size >= maxResults) {
            stopped.add("max_results");
            break;
          }
          const via: ImpactEdge[] = [
            ...entry.via,
            { from: entry.file, to: r.file, kind: "reference" },
          ];
          seen.set(r.file, {
            file: r.file,
            hops: currentHops + 1,
            via,
            context_scope: scopeOf(r.file),
          });
          next.push({ file: r.file, via });
        }
        if (seen.size >= maxResults) break;
      }
      if (seen.size >= maxResults) break;

      // Import edges catch side-effect imports that reference extraction missed.
      if (currentHops === 0 || symbols.length === 0) {
        const importers = await store.getImporters(entry.file);
        for (const imp of importers) {
          if (imp === entry.file || seen.has(imp)) continue;
          if (seen.size >= maxResults) {
            stopped.add("max_results");
            break;
          }
          const via: ImpactEdge[] = [
            ...entry.via,
            { from: entry.file, to: imp, kind: "import" },
          ];
          seen.set(imp, {
            file: imp,
            hops: currentHops + 1,
            via,
            context_scope: scopeOf(imp),
          });
          next.push({ file: imp, via });
        }
      }
      if (seen.size >= maxResults) break;
    }

    frontier = next;
    currentHops++;
  }

  if (frontier.length === 0 && !stopped.has("max_depth") && !stopped.has("max_results")) {
    stopped.add("natural");
  }

  // Remove the seed files themselves from `affected` — seeds are reported
  // separately. Consumers asking "who depends on X" rarely want X in the list.
  const seedFiles = new Set(seedList.map((s) => s.file));
  const affected: ImpactAffected[] = [...seen.values()]
    .filter((a) => !seedFiles.has(a.file))
    .sort((a, b) => (a.hops - b.hops) || a.file.localeCompare(b.file));

  const scopeMap = new Map<string, { min_hops: number; file_count: number }>();
  for (const a of affected) {
    const existing = scopeMap.get(a.context_scope);
    if (existing) {
      existing.min_hops = Math.min(existing.min_hops, a.hops);
      existing.file_count++;
    } else {
      scopeMap.set(a.context_scope, { min_hops: a.hops, file_count: 1 });
    }
  }
  const affected_scopes: ImpactAffectedScope[] = [...scopeMap.entries()]
    .map(([scope, v]) => ({ scope, ...v }))
    .sort((a, b) => (a.min_hops - b.min_hops) || a.scope.localeCompare(b.scope));

  return {
    seeds: seedList,
    affected,
    affected_scopes,
    stopped: [...stopped],
    caveat: IMPACT_CAVEAT,
  };
}

async function collectSymbols(
  store: IndexStore,
  file: FileId,
  symbolFilter: string | undefined,
): Promise<IndexSymbol[]> {
  const all = await store.getFileSymbols(file);
  if (symbolFilter) {
    return all.filter((s) => s.name === symbolFilter);
  }
  return all.filter((s) => s.exported);
}

function scopeOf(file: FileId): string {
  const d = posix.dirname(file);
  return d === "" ? "." : d;
}
