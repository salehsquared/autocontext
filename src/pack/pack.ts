import { existsSync } from "node:fs";
import { posix } from "node:path";
import { loadCorpus, type ScopeDoc } from "./corpus.js";
import { buildBM25, ZONE_WEIGHTS } from "./bm25.js";
import { computeGraphProximity } from "./graph-proximity.js";
import { manifestPath, toFileId } from "../index/paths.js";
import { tokenize } from "./tokenize.js";
import { openReadOnlyIndex } from "../index/access.js";
import { AUTOCONTEXT_VERSION } from "../version.js";

/** ~4 chars per token heuristic — same scale used across the bench harness. */
function estimateTokens(s: string): number {
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}
import type { ContextFile } from "../core/schema.js";
import type { Pack, PackOptions, PackScope } from "./types.js";

const DEFAULT_WEIGHTS = { alpha: 0.55, beta: 0.35, gamma: 0.1 };
const DEFAULT_BUDGET = 4000;

const ROOT_RESERVE_MAX = 200;
const TIER1_FRACTION = 0.85;
const MIN_K = 3;
const MAX_K = 20;

export async function buildPack(opts: PackOptions): Promise<Pack> {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const budget = opts.budget ?? DEFAULT_BUDGET;

  const corpus = await loadCorpus(opts.projectRoot);
  const corpusByScope = new Map(corpus.map((d) => [d.scope, d]));
  const bm25 = buildBM25(corpus);

  const seed = resolveSeed(opts, corpus);

  // BM25 ranking over the tokenized query.
  const queryTokens = seed.queryText ? tokenize(seed.queryText, "summary") : [];
  const bm25Results = queryTokens.length > 0 ? bm25.scores(queryTokens) : [];
  const bm25Max = Math.max(...bm25Results.map((r) => r.score), 0);
  const bm25Min = Math.min(...bm25Results.map((r) => r.score), 0);

  // Graph proximity via the T1 index (optional — skip when missing).
  const proximityMap = await computeProximityIfAvailable(opts.projectRoot, seed.graphDirs);

  // Composite score per scope.
  type Scored = { scope: string; bm25: number; hops: number | null; proximity: number; mustInclude: boolean; total: number };
  const scored: Scored[] = [];
  for (const doc of corpus) {
    const rawBm25 = bm25Results.find((r) => r.scope === doc.scope)?.score ?? 0;
    const bm25Norm =
      bm25Max > 0 && bm25Max - bm25Min > 1e-9
        ? (rawBm25 - bm25Min) / (bm25Max - bm25Min + 1e-9)
        : 0;
    const proximity = proximityMap.get(doc.scope) ?? 0;
    const hops = proximity > 0 ? Math.round(1 / proximity) - 1 : null;
    const mustInclude = seed.mustIncludeScopes.has(doc.scope);
    const total =
      weights.alpha * bm25Norm + weights.beta * proximity + (mustInclude ? 0.05 : 0);
    scored.push({ scope: doc.scope, bm25: bm25Norm, hops, proximity, mustInclude, total });
  }
  scored.sort((a, b) => {
    if (a.mustInclude !== b.mustInclude) return a.mustInclude ? -1 : 1;
    if (Math.abs(b.total - a.total) > 1e-9) return b.total - a.total;
    return a.scope.localeCompare(b.scope);
  });

  // Root summary reserve.
  const rootDoc =
    corpusByScope.get(".") ?? corpus.find((d) => d.scope === "." || d.scope === "");
  const root = rootDoc
    ? {
        scope: rootDoc.scope,
        summary: truncateSentence(rootDoc.context.summary, ROOT_RESERVE_MAX),
      }
    : null;
  const rootTokens = root ? estimateTokens(root.summary) : 0;

  // Tier-1 assembly: greedy admit scopes in score order.
  const tier1Budget = Math.max(0, Math.floor((budget - rootTokens) * TIER1_FRACTION));
  let spent = 0;
  const admitted: PackScope[] = [];
  const warnings: string[] = [];
  const eligible = scored.filter((s) => s.total > 0 || s.mustInclude);

  for (const s of eligible) {
    if (admitted.length >= MAX_K) break;
    const doc = corpusByScope.get(s.scope);
    if (!doc) continue;
    if (doc.scope === root?.scope) continue;
    const rendered = renderScopeCompact(doc.context);
    const tokens = estimateTokens(rendered);
    if (admitted.length < MIN_K) {
      admitted.push({
        scope: s.scope,
        score: s.total,
        hops: s.hops,
        rendered,
        mustInclude: s.mustInclude,
        context: doc.context,
        tokens,
      });
      spent += tokens;
      continue;
    }
    if (spent + tokens > tier1Budget) continue;
    admitted.push({
      scope: s.scope,
      score: s.total,
      hops: s.hops,
      rendered,
      mustInclude: s.mustInclude,
      context: doc.context,
      tokens,
    });
    spent += tokens;
  }

  const usedTokens = rootTokens + spent;
  const truncated = usedTokens > budget;
  if (truncated) {
    warnings.push(
      `pack exceeded budget (${usedTokens}/${budget}) — root summary + top-${MIN_K} scopes always retained`,
    );
  }

  return {
    seed: { kind: seed.kind, value: seed.displayValue },
    budget,
    used_tokens: usedTokens,
    root,
    scopes: admitted,
    warnings,
    metadata: {
      autocontext_version: AUTOCONTEXT_VERSION,
      n_scopes_considered: corpus.length,
      truncated,
    },
  };
}

interface ResolvedSeed {
  kind: "query" | "file" | "symbol";
  displayValue: string;
  queryText: string;
  graphDirs: string[];
  mustIncludeScopes: Set<string>;
}

function resolveSeed(opts: PackOptions, corpus: ScopeDoc[]): ResolvedSeed {
  if (opts.query) {
    return {
      kind: "query",
      displayValue: opts.query,
      queryText: opts.query,
      graphDirs: [],
      mustIncludeScopes: new Set(),
    };
  }
  if (opts.file) {
    const fileId = toFileId(opts.file);
    const scope = nearestScope(fileId, corpus);
    const must = scope ? new Set([scope]) : new Set<string>();
    const doc = scope ? corpus.find((d) => d.scope === scope) : undefined;
    const queryText = [
      doc?.context.summary ?? "",
      ...(doc?.context.exports ?? []),
      ...((doc?.context.internals ?? []).map((i) => i.name)),
    ].join(" ");
    return {
      kind: "file",
      displayValue: opts.file,
      queryText,
      graphDirs: scope ? [scope] : [],
      mustIncludeScopes: must,
    };
  }
  if (opts.symbol) {
    const hits: string[] = [];
    for (const doc of corpus) {
      const haystack = [
        ...(doc.context.exports ?? []),
        ...((doc.context.internals ?? []).map((i) => i.name)),
        ...((doc.context.interfaces ?? []).map((i) => i.name)),
      ];
      if (haystack.some((h) => h.includes(opts.symbol!))) hits.push(doc.scope);
    }
    return {
      kind: "symbol",
      displayValue: opts.symbol,
      queryText: opts.symbol,
      graphDirs: hits,
      mustIncludeScopes: new Set(hits),
    };
  }
  return {
    kind: "query",
    displayValue: "",
    queryText: "",
    graphDirs: [],
    mustIncludeScopes: new Set(),
  };
}

function nearestScope(fileId: string, corpus: ScopeDoc[]): string | null {
  const dir = posix.dirname(fileId);
  const dirs = new Set(corpus.map((d) => d.scope));
  let cur = dir;
  for (let i = 0; i < 32; i++) {
    if (dirs.has(cur)) return cur;
    if (dirs.has(".") && (cur === "." || cur === "")) return ".";
    const parent = posix.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return dirs.has(".") ? "." : null;
}

async function computeProximityIfAvailable(
  projectRoot: string,
  seedDirs: string[],
): Promise<Map<string, number>> {
  if (seedDirs.length === 0) return new Map();
  if (!existsSync(manifestPath(projectRoot))) return new Map();
  const access = await openReadOnlyIndex(projectRoot);
  if (access.state !== "ready") return new Map();
  const store = access.store;
  try {
    return await computeGraphProximity(store, seedDirs);
  } finally {
    await store.close();
  }
}

function truncateSentence(text: string, maxTokens: number): string {
  if (!text) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept: string[] = [];
  for (const s of sentences) {
    kept.push(s);
    if (estimateTokens(kept.join(" ")) >= maxTokens) break;
  }
  return kept.join(" ");
}

function renderScopeCompact(ctx: ContextFile): string {
  const lines: string[] = [];
  lines.push(`## ${ctx.scope}`);
  lines.push(ctx.summary);
  if (ctx.exports && ctx.exports.length > 0) {
    lines.push(`**exports:** ${ctx.exports.slice(0, 8).join(", ")}${ctx.exports.length > 8 ? `, \u2026+${ctx.exports.length - 8}` : ""}`);
  }
  if (ctx.decisions && ctx.decisions.length > 0) {
    lines.push("**decisions:**");
    for (const d of ctx.decisions.slice(0, 3)) {
      lines.push(`- ${d.what} — ${d.why}`);
    }
  }
  if (ctx.constraints && ctx.constraints.length > 0) {
    lines.push("**constraints:**");
    for (const c of ctx.constraints.slice(0, 3)) lines.push(`- ${c}`);
  }
  if (ctx.environment && ctx.environment.length > 0) {
    lines.push(`**env:** ${ctx.environment.slice(0, 6).join(", ")}`);
  }
  return lines.join("\n");
}

export const _internals = {
  renderScopeCompact,
  resolveSeed,
  truncateSentence,
  DEFAULT_WEIGHTS,
  DEFAULT_BUDGET,
  ZONE_WEIGHTS,
};
