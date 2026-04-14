import type { Evidence } from "../core/schema.js";

export type ViewFreshness =
  | "fresh"
  | "cosmetic_stale"
  | "semantic_stale"
  | "stale"
  | "missing";

export interface ViewViolation {
  rule_kind: string;
  message: string;
  file?: string;
  line?: number;
}

export interface ViewScope {
  scope: string;
  summary: string;
  freshness: ViewFreshness;
  decisions: Array<{ what: string; why: string; tradeoff?: string }>;
  constraints: string[];
  subdirectories: Array<{ name: string; summary: string; freshness: ViewFreshness }>;
  exports: Array<{ name: string; kind?: string; signature?: string }>;
  evidence?: Evidence;
  violations: ViewViolation[];
  raw_yaml: string;
  file_count: number;
  last_updated?: string;
}

export interface ViewData {
  project: {
    name: string;
    root: string;
    generated_at: string;
    autocontext_version: string;
  };
  scopes: ViewScope[];
  dir_edges: Array<{ source: string; target: string; weight: number }>;
  has_index: boolean;
  has_policy: boolean;
  has_semantic_staleness: boolean;
  totals: {
    fresh: number;
    stale: number;
    semantic_stale: number;
    cosmetic_stale: number;
    missing: number;
    violations: number;
  };
}

export interface RenderOptions {
  includeGraph: boolean;
  includeSource: boolean;
}
