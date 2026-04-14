import type { ContextFile } from "../core/schema.js";

export interface PackOptions {
  projectRoot: string;
  /** User seed. Exactly one of query/file/symbol. */
  query?: string;
  file?: string;
  symbol?: string;
  /** Target token budget. Default 4000. */
  budget?: number;
  /** Ranking weights — defaults frozen unless a test tweaks them. */
  weights?: { alpha: number; beta: number; gamma: number };
}

export interface PackScope {
  scope: string;
  score: number;
  hops: number | null;
  /** Compacted YAML-shaped projection used in markdown rendering. */
  rendered: string;
  /** Whether this scope was kept as `mustInclude`. */
  mustInclude: boolean;
  /** Full parsed context — handy for JSON output. */
  context: ContextFile;
  /** Estimated tokens of `rendered`. */
  tokens: number;
}

export interface Pack {
  seed: {
    kind: "query" | "file" | "symbol";
    value: string;
  };
  budget: number;
  used_tokens: number;
  root: { scope: string; summary: string } | null;
  scopes: PackScope[];
  warnings: string[];
  /** Deterministic cache key inputs (for T7-style cache wrapping later). */
  metadata: {
    autocontext_version: string;
    n_scopes_considered: number;
    truncated: boolean;
  };
}
