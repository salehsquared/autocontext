/**
 * T6 navigation handlers: find_definition / find_references /
 * find_related / search_context. Read-only, index-backed. Capped at 10 KB
 * per response after serialization — agents narrow via scope/limit when they
 * hit truncation.
 */

import { resolve, relative, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import { manifestPath } from "../index/paths.js";
import { openIndex } from "../index/store.js";
import type { IndexStore } from "../index/store.js";
import type { IndexSymbol, Reference } from "../index/types.js";
import { loadCorpus } from "../pack/corpus.js";
import { buildBM25 } from "../pack/bm25.js";
import { tokenize, type Zone } from "../pack/tokenize.js";

const RESPONSE_CEILING_BYTES = 10_240;
const HARD_CAP = 50;
export const REFERENCES_CAVEAT =
  "References are tracked only when the identifier is bound by a static import statement in the same file. Free identifiers, member-access chains, and dynamic imports are not indexed. A zero result is not proof of zero callers.";

export type ErrorCode =
  | "INDEX_MISSING"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "PATH_TRAVERSAL"
  | "INTERNAL";

export interface ErrorEnvelope {
  code: ErrorCode;
  message: string;
  remediation?: string;
}

function indexMissingError(): ErrorEnvelope {
  return {
    code: "INDEX_MISSING",
    message: "Code index not found at .autocontext/index/.",
    remediation: "Run `context index` in the project root, then retry.",
  };
}

function pathTraversalError(kind: string): ErrorEnvelope {
  return {
    code: "PATH_TRAVERSAL",
    message: `Invalid ${kind}: path traversal detected`,
  };
}

/** Returns the normalized POSIX path if safe, or null. */
function safeRelPath(root: string, target: string): string | null {
  const normalized = target.replace(/\\/g, "/");
  const abs = isAbsolute(normalized) ? normalized : resolve(root, normalized);
  const rel = relative(root, abs).split(/[\\/]/).join("/");
  if (rel === "") return ".";
  if (rel.startsWith("..")) return null;
  if (isAbsolute(rel)) return null;
  return rel;
}

function truncateToCeiling<T>(
  items: T[],
  buildEnvelope: (slice: T[], truncated: boolean) => object,
): { slice: T[]; truncated: boolean } {
  // Binary-search the longest slice that fits under the serialized ceiling.
  let lo = 0;
  let hi = items.length;
  if (hi === 0) return { slice: [], truncated: false };
  if (JSON.stringify(buildEnvelope(items, false)).length <= RESPONSE_CEILING_BYTES) {
    return { slice: items, truncated: false };
  }
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    const size = JSON.stringify(buildEnvelope(items.slice(0, mid), true)).length;
    if (size <= RESPONSE_CEILING_BYTES) lo = mid;
    else hi = mid - 1;
  }
  return { slice: items.slice(0, lo), truncated: true };
}

async function withIndex<T>(
  rootPath: string,
  fn: (store: IndexStore) => Promise<T>,
): Promise<T | { ok: false; error: ErrorEnvelope }> {
  if (!existsSync(manifestPath(rootPath))) {
    return { ok: false, error: indexMissingError() };
  }
  const store = await openIndex(rootPath, { readOnly: true, autoRebuild: false });
  try {
    return await fn(store);
  } finally {
    await store.close();
  }
}

// --- find_definition ---

export interface FindDefinitionInput {
  symbol: string;
  scope?: { file?: string; dir?: string };
  limit?: number;
  path?: string;
}

export interface FindDefinitionResultItem {
  symbol_id: string;
  file: string;
  name: string;
  kind: string;
  exported: boolean;
  span: { startLine: number; endLine: number };
  signature?: string;
  lang: string;
}

export interface FindDefinitionResult {
  ok: boolean;
  symbol: string;
  results: FindDefinitionResultItem[];
  truncated: boolean;
  total_matched: number;
  error?: ErrorEnvelope;
}

export async function handleFindDefinition(
  input: FindDefinitionInput,
  defaultRoot: string,
): Promise<FindDefinitionResult> {
  const rootPath = resolve(input.path ?? defaultRoot);
  const limit = Math.min(Math.max(1, input.limit ?? 25), HARD_CAP);
  const base = { ok: true, symbol: input.symbol, results: [] as FindDefinitionResultItem[], truncated: false, total_matched: 0 };

  const scopeDir = input.scope?.dir;
  const scopeFile = input.scope?.file;
  if (scopeDir !== undefined && safeRelPath(rootPath, scopeDir) === null) {
    return { ...base, ok: false, error: pathTraversalError("scope.dir") };
  }
  if (scopeFile !== undefined && safeRelPath(rootPath, scopeFile) === null) {
    return { ...base, ok: false, error: pathTraversalError("scope.file") };
  }

  const result = await withIndex(rootPath, async (store) => {
    const all = await store.findSymbolsByName(input.symbol);
    const normDir = scopeDir ? safeRelPath(rootPath, scopeDir) : null;
    const normFile = scopeFile ? safeRelPath(rootPath, scopeFile) : null;
    const filtered = all.filter((sym: IndexSymbol) => {
      if (normFile && sym.file !== normFile) return false;
      if (normDir && normDir !== "." && sym.file !== normDir && !sym.file.startsWith(`${normDir}/`)) return false;
      return true;
    });
    filtered.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.span.startLine - b.span.startLine;
    });
    return filtered;
  });
  if ("error" in result) return { ...base, ok: false, error: result.error };

  const mapped: FindDefinitionResultItem[] = result.map((s) => ({
    symbol_id: s.id,
    file: s.file,
    name: s.name,
    kind: s.kind,
    exported: s.exported,
    span: { startLine: s.span.startLine, endLine: s.span.endLine },
    signature: s.signature,
    lang: s.lang,
  }));
  const capped = mapped.slice(0, limit);
  const { slice, truncated } = truncateToCeiling(capped, (items, t) => ({
    ok: true,
    symbol: input.symbol,
    results: items,
    truncated: t,
    total_matched: mapped.length,
  }));

  return {
    ok: true,
    symbol: input.symbol,
    results: slice,
    truncated: truncated || mapped.length > limit,
    total_matched: mapped.length,
  };
}

// --- find_references ---

export interface FindReferencesInput {
  symbol?: string;
  symbol_id?: string;
  scope?: { file?: string; dir?: string };
  limit?: number;
  path?: string;
}

export interface FindReferencesTarget {
  symbol_id: string;
  file: string;
  name: string;
  kind: string;
  signature?: string;
}

export interface FindReferencesEntry {
  symbol_id: string;
  file: string;
  span: { startLine: number; endLine: number };
  via_import: { from: string; raw: string };
  kind: "identifier_use";
}

export interface FindReferencesResult {
  ok: boolean;
  targets: FindReferencesTarget[];
  references: FindReferencesEntry[];
  truncated: boolean;
  total_matched: number;
  reference_kind: "import_bound";
  caveat: string;
  error?: ErrorEnvelope;
}

export async function handleFindReferences(
  input: FindReferencesInput,
  defaultRoot: string,
): Promise<FindReferencesResult> {
  const rootPath = resolve(input.path ?? defaultRoot);
  const limit = Math.min(Math.max(1, input.limit ?? 50), HARD_CAP);
  const base: FindReferencesResult = {
    ok: true,
    targets: [],
    references: [],
    truncated: false,
    total_matched: 0,
    reference_kind: "import_bound",
    caveat: REFERENCES_CAVEAT,
  };

  const seedCount = (input.symbol ? 1 : 0) + (input.symbol_id ? 1 : 0);
  if (seedCount !== 1) {
    return {
      ...base,
      ok: false,
      error: {
        code: "INVALID_INPUT",
        message: "Exactly one of `symbol` or `symbol_id` must be provided.",
      },
    };
  }

  const scopeDir = input.scope?.dir;
  const scopeFile = input.scope?.file;
  if (scopeDir !== undefined && safeRelPath(rootPath, scopeDir) === null) {
    return { ...base, ok: false, error: pathTraversalError("scope.dir") };
  }
  if (scopeFile !== undefined && safeRelPath(rootPath, scopeFile) === null) {
    return { ...base, ok: false, error: pathTraversalError("scope.file") };
  }

  const result = await withIndex(rootPath, async (store): Promise<{ targets: IndexSymbol[]; refs: Reference[] } | ErrorEnvelope> => {
    let targets: IndexSymbol[] = [];
    if (input.symbol_id) {
      const sym = await store.getSymbol(input.symbol_id);
      if (!sym) {
        return {
          code: "NOT_FOUND",
          message: `Symbol not found: ${input.symbol_id}`,
        };
      }
      targets = [sym];
    } else if (input.symbol) {
      targets = await store.findSymbolsByName(input.symbol);
    }
    const refSets = await Promise.all(targets.map((t) => store.getReferencesTo(t.id)));
    const seen = new Set<string>();
    const merged: Reference[] = [];
    for (const refs of refSets) {
      for (const r of refs) {
        const key = `${r.symbol_id}\u0000${r.file}\u0000${r.span.startLine}\u0000${r.span.endLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(r);
      }
    }
    const normDir = scopeDir ? safeRelPath(rootPath, scopeDir) : null;
    const normFile = scopeFile ? safeRelPath(rootPath, scopeFile) : null;
    const scoped = merged.filter((r) => {
      if (normFile && r.file !== normFile) return false;
      if (normDir && normDir !== "." && r.file !== normDir && !r.file.startsWith(`${normDir}/`)) return false;
      return true;
    });
    scoped.sort((a, b) => {
      if (a.file !== b.file) return a.file < b.file ? -1 : 1;
      return a.span.startLine - b.span.startLine;
    });
    return { targets, refs: scoped };
  });

  if ("code" in result) return { ...base, ok: false, error: result };
  if ("error" in result) return { ...base, ok: false, error: result.error };

  const targets: FindReferencesTarget[] = result.targets.map((t) => ({
    symbol_id: t.id,
    file: t.file,
    name: t.name,
    kind: t.kind,
    signature: t.signature,
  }));
  const entries: FindReferencesEntry[] = result.refs.map((r) => ({
    symbol_id: r.symbol_id,
    file: r.file,
    span: { startLine: r.span.startLine, endLine: r.span.endLine },
    via_import: { from: r.via_import.from, raw: r.via_import.raw },
    kind: "identifier_use",
  }));
  const capped = entries.slice(0, limit);
  const { slice, truncated } = truncateToCeiling(capped, (items, t) => ({
    ok: true,
    targets,
    references: items,
    truncated: t,
    total_matched: entries.length,
    reference_kind: "import_bound",
    caveat: REFERENCES_CAVEAT,
  }));

  return {
    ok: true,
    targets,
    references: slice,
    truncated: truncated || entries.length > limit,
    total_matched: entries.length,
    reference_kind: "import_bound",
    caveat: REFERENCES_CAVEAT,
  };
}

// --- find_related ---

export type RelatedKind = "importers" | "importees" | "siblings" | "dir_neighbors";
export type RelatedReason = "importer" | "importee" | "sibling" | "dir_neighbor";

export interface FindRelatedInput {
  seed: { file?: string; symbol?: string };
  kinds?: RelatedKind[];
  max_results?: number;
  path?: string;
}

export interface FindRelatedEntry {
  file: string;
  reason: RelatedReason;
  strength: number;
}

export interface FindRelatedResult {
  ok: boolean;
  seed: { kind: "file" | "symbol"; resolved_file: string; resolved_symbol_id?: string };
  related: FindRelatedEntry[];
  truncated: boolean;
  total_matched: number;
  error?: ErrorEnvelope;
}

const DEFAULT_KINDS: RelatedKind[] = ["importers", "importees", "dir_neighbors"];

export async function handleFindRelated(
  input: FindRelatedInput,
  defaultRoot: string,
): Promise<FindRelatedResult> {
  const rootPath = resolve(input.path ?? defaultRoot);
  const kinds = input.kinds && input.kinds.length > 0 ? input.kinds : DEFAULT_KINDS;
  const maxResults = Math.min(Math.max(1, input.max_results ?? 25), HARD_CAP);
  const seedFile = input.seed?.file;
  const seedSymbol = input.seed?.symbol;
  const seedKind: "file" | "symbol" = seedFile ? "file" : "symbol";
  const base: FindRelatedResult = {
    ok: true,
    seed: { kind: seedKind, resolved_file: "" },
    related: [],
    truncated: false,
    total_matched: 0,
  };
  const seeds = (seedFile ? 1 : 0) + (seedSymbol ? 1 : 0);
  if (seeds !== 1) {
    return { ...base, ok: false, error: { code: "INVALID_INPUT", message: "Exactly one of seed.file or seed.symbol must be provided." } };
  }
  if (seedFile && safeRelPath(rootPath, seedFile) === null) {
    return { ...base, ok: false, error: pathTraversalError("seed.file") };
  }

  const out = await withIndex(rootPath, async (store): Promise<{ resolvedFile: string; resolvedSymbolId?: string; related: FindRelatedEntry[] } | ErrorEnvelope> => {
    let resolvedFile: string | null = null;
    let resolvedSymbolId: string | undefined;
    if (seedFile) {
      resolvedFile = safeRelPath(rootPath, seedFile);
      if (!resolvedFile) return { code: "PATH_TRAVERSAL", message: "Invalid seed.file: path traversal detected" };
      const existing = await store.getFileSymbols(resolvedFile);
      if (existing.length === 0 && (await store.getFileImports(resolvedFile)).length === 0) {
        return { code: "NOT_FOUND", message: `File not indexed: ${resolvedFile}` };
      }
    } else if (seedSymbol) {
      const matches = await store.findSymbolsByName(seedSymbol);
      if (matches.length === 0) return { code: "NOT_FOUND", message: `Symbol not found: ${seedSymbol}` };
      matches.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
      resolvedFile = matches[0].file;
      resolvedSymbolId = matches[0].id;
    }
    if (!resolvedFile) return { code: "INVALID_INPUT", message: "Could not resolve seed" };

    const byFile = new Map<string, { reason: RelatedReason; strength: number }>();
    const seen = resolvedFile;

    if (kinds.includes("importers")) {
      const importers = await store.getImporters(seen);
      const counts = new Map<string, number>();
      for await (const edge of store.scanImports()) {
        if (edge.resolved_to === seen && importers.includes(edge.from)) {
          counts.set(edge.from, (counts.get(edge.from) ?? 0) + 1);
        }
      }
      for (const f of importers) {
        const n = counts.get(f) ?? 1;
        mergeRelated(byFile, f, "importer", n);
      }
    }
    if (kinds.includes("importees")) {
      const importees = await store.getImportees(seen);
      const counts = new Map<string, number>();
      for await (const edge of store.scanImports()) {
        if (edge.from === seen && edge.resolved_to && importees.includes(edge.resolved_to)) {
          counts.set(edge.resolved_to, (counts.get(edge.resolved_to) ?? 0) + 1);
        }
      }
      for (const f of importees) {
        const n = counts.get(f) ?? 1;
        mergeRelated(byFile, f, "importee", n);
      }
    }
    if (kinds.includes("dir_neighbors")) {
      const seedDir = seen.includes("/") ? seen.slice(0, seen.lastIndexOf("/")) : ".";
      const edges = await store.getDirEdges();
      const neighbors = new Map<string, number>();
      for (const e of edges) {
        if (e.from_dir === seedDir) {
          neighbors.set(e.to_dir, Math.max(neighbors.get(e.to_dir) ?? 0, e.weight));
        } else if (e.to_dir === seedDir) {
          neighbors.set(e.from_dir, Math.max(neighbors.get(e.from_dir) ?? 0, e.weight));
        }
      }
      for (const [dir, weight] of neighbors) {
        mergeRelated(byFile, dir, "dir_neighbor", weight);
      }
    }
    if (kinds.includes("siblings")) {
      const seedDir = seen.includes("/") ? seen.slice(0, seen.lastIndexOf("/")) : ".";
      // No direct scanner access from the store; use scanImports to discover
      // files in the same directory that appeared as import endpoints.
      const sibs = new Set<string>();
      for await (const edge of store.scanImports()) {
        for (const f of [edge.from, edge.resolved_to]) {
          if (!f || f === seen) continue;
          const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : ".";
          if (dir === seedDir) sibs.add(f);
        }
      }
      for (const f of sibs) mergeRelated(byFile, f, "sibling", 1);
    }

    const related: FindRelatedEntry[] = [...byFile.entries()].map(([file, v]) => ({
      file,
      reason: v.reason,
      strength: v.strength,
    }));
    related.sort((a, b) => {
      if (b.strength !== a.strength) return b.strength - a.strength;
      return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
    });
    return { resolvedFile, resolvedSymbolId, related };
  });

  if ("code" in out) return { ...base, ok: false, error: out };
  if ("error" in out) return { ...base, ok: false, error: out.error };

  const capped = out.related.slice(0, maxResults);
  const { slice, truncated } = truncateToCeiling(capped, (items, t) => ({
    ok: true,
    seed: { kind: seedKind, resolved_file: out.resolvedFile, resolved_symbol_id: out.resolvedSymbolId },
    related: items,
    truncated: t,
    total_matched: out.related.length,
  }));
  return {
    ok: true,
    seed: { kind: seedKind, resolved_file: out.resolvedFile, resolved_symbol_id: out.resolvedSymbolId },
    related: slice,
    truncated: truncated || out.related.length > maxResults,
    total_matched: out.related.length,
  };
}

function mergeRelated(
  byFile: Map<string, { reason: RelatedReason; strength: number }>,
  file: string,
  reason: RelatedReason,
  strength: number,
): void {
  const existing = byFile.get(file);
  if (!existing || strength > existing.strength) {
    byFile.set(file, { reason, strength });
  }
}

// --- search_context ---

const SEARCHABLE_ZONES: Zone[] = [
  "summary",
  "decisions",
  "constraints",
  "symbols",
  "state",
  "facets",
  "path",
];

export interface SearchContextInput {
  query: string;
  fields?: Zone[];
  limit?: number;
  path?: string;
}

export interface SearchContextMatch {
  zone: string;
  excerpt: string;
}

export interface SearchContextItem {
  scope: string;
  score: number;
  matches: SearchContextMatch[];
  summary?: string;
  last_updated?: string;
}

export interface SearchContextResult {
  ok: boolean;
  query: string;
  results: SearchContextItem[];
  truncated: boolean;
  total_matched: number;
  error?: ErrorEnvelope;
}

export async function handleSearchContext(
  input: SearchContextInput,
  defaultRoot: string,
): Promise<SearchContextResult> {
  const rootPath = resolve(input.path ?? defaultRoot);
  const limit = Math.min(Math.max(1, input.limit ?? 10), HARD_CAP);
  const fields = (input.fields && input.fields.length > 0 ? input.fields : SEARCHABLE_ZONES) as Zone[];

  const corpus = await loadCorpus(rootPath);
  if (corpus.length === 0) {
    return { ok: true, query: input.query, results: [], truncated: false, total_matched: 0 };
  }
  const bm25 = buildBM25(corpus);
  const queryTokens = tokenize(input.query, "summary");
  if (queryTokens.length === 0) {
    return { ok: true, query: input.query, results: [], truncated: false, total_matched: 0 };
  }

  // BM25 `scores()` uses the full zone-weighted score; restricting `fields` is
  // a soft filter here — we drop results whose only positive contribution is
  // from a non-selected zone. Approximation for v1; good enough for
  // "search only summaries" style requests.
  const ranked = bm25.scores(queryTokens).filter((r) => r.score > 0);
  const scopeToDoc = new Map(corpus.map((c) => [c.scope, c]));
  const fieldSet = new Set(fields);

  const results: SearchContextItem[] = [];
  for (const r of ranked) {
    const doc = scopeToDoc.get(r.scope);
    if (!doc) continue;
    const matches = buildExcerpts(doc, queryTokens, fieldSet);
    if (fieldSet.size < SEARCHABLE_ZONES.length && matches.length === 0) continue;
    results.push({
      scope: r.scope,
      score: Math.round(r.score * 10000) / 10000,
      matches,
      summary: doc.context.summary?.slice(0, 200),
      last_updated: doc.context.last_updated,
    });
  }

  const capped = results.slice(0, limit);
  const { slice, truncated } = truncateToCeiling(capped, (items, t) => ({
    ok: true,
    query: input.query,
    results: items,
    truncated: t,
    total_matched: results.length,
  }));

  return {
    ok: true,
    query: input.query,
    results: slice,
    truncated: truncated || results.length > limit,
    total_matched: results.length,
  };
}

function buildExcerpts(
  doc: ReturnType<typeof loadCorpus> extends Promise<Array<infer T>> ? T : never,
  queryTokens: string[],
  fieldSet: Set<Zone>,
): SearchContextMatch[] {
  const tokenSet = new Set(queryTokens);
  const out: SearchContextMatch[] = [];
  const sources: Array<[Zone, string]> = [
    ["summary", doc.context.summary ?? ""],
    ["decisions", (doc.context.decisions ?? []).map((d) => `${d.what}: ${d.why}`).join(". ")],
    ["constraints", (doc.context.constraints ?? []).join(". ")],
    ["symbols", (doc.context.exports ?? []).join(", ")],
    ["state", [
      ...(doc.context.current_state?.working ?? []),
      ...(doc.context.current_state?.broken ?? []),
      ...(doc.context.current_state?.in_progress ?? []),
    ].join(". ")],
    ["facets", [
      ...(doc.context.environment ?? []),
      ...(doc.context.testing ?? []),
      ...(doc.context.events ?? []),
    ].join(". ")],
    ["path", doc.scope],
  ];
  for (const [zone, text] of sources) {
    if (!fieldSet.has(zone)) continue;
    if (!text) continue;
    const excerpt = excerptWith(text, tokenSet);
    if (excerpt) out.push({ zone, excerpt });
    if (out.length >= 3) break;
  }
  return out;
}

function excerptWith(text: string, tokenSet: Set<string>): string | null {
  const lower = text.toLowerCase();
  let hit = -1;
  let hitToken = "";
  for (const t of tokenSet) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (hit < 0 || idx < hit)) {
      hit = idx;
      hitToken = t;
    }
  }
  if (hit < 0) return null;
  const start = Math.max(0, hit - 60);
  const end = Math.min(text.length, hit + 100);
  let excerpt = text.slice(start, end);
  if (start > 0) excerpt = `…${excerpt}`;
  if (end < text.length) excerpt = `${excerpt}…`;
  // Bold the first matched token occurrence (case-insensitive).
  const reTok = new RegExp(hitToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  excerpt = excerpt.replace(reTok, (m) => `**${m}**`);
  return excerpt.length > 160 ? `${excerpt.slice(0, 157)}…` : excerpt;
}

// --- impact (wraps T2 handler) ---

export interface ImpactInput {
  seed: string;
  kind?: "file" | "symbol" | "diff";
  max_depth?: number;
  max_results?: number;
  path?: string;
}

export interface ImpactResult {
  ok: boolean;
  seeds: unknown;
  affected: unknown;
  affected_scopes: unknown;
  stopped: unknown;
  caveat: string;
  error?: ErrorEnvelope;
}

export async function handleImpact(
  input: ImpactInput,
  defaultRoot: string,
): Promise<ImpactResult> {
  const rootPath = resolve(input.path ?? defaultRoot);
  const base: ImpactResult = {
    ok: true,
    seeds: [],
    affected: [],
    affected_scopes: [],
    stopped: [],
    caveat: "",
  };
  if (!existsSync(manifestPath(rootPath))) {
    return { ...base, ok: false, error: indexMissingError() };
  }
  const { computeImpact, IMPACT_CAVEAT } = await import("../impact/impact.js");
  const store = await openIndex(rootPath, { readOnly: true, autoRebuild: false });
  try {
    const kind = input.kind ?? "file";
    let seeds: Parameters<typeof computeImpact>[1];
    if (kind === "file") {
      const safe = safeRelPath(rootPath, input.seed);
      if (!safe) return { ...base, ok: false, error: pathTraversalError("seed") };
      seeds = [{ file: safe, reason: "file" }];
    } else if (kind === "symbol") {
      const matches = await store.findSymbolsByName(input.seed);
      if (matches.length === 0) {
        return { ...base, ok: false, error: { code: "NOT_FOUND", message: `Symbol not found: ${input.seed}` } };
      }
      seeds = matches.map((m) => ({ file: m.file, symbol: m.name, reason: "symbol" }));
    } else {
      return { ...base, ok: false, error: { code: "INVALID_INPUT", message: "kind: \"diff\" seed is not supported in v1" } };
    }
    const report = await computeImpact(store, seeds, {
      maxDepth: input.max_depth,
      maxResults: input.max_results,
    });
    return {
      ok: true,
      seeds: report.seeds,
      affected: report.affected,
      affected_scopes: report.affected_scopes,
      stopped: report.stopped,
      caveat: report.caveat ?? IMPACT_CAVEAT,
    };
  } finally {
    await store.close();
  }
}
