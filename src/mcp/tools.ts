import { resolve, join, relative, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readContext, UnsupportedVersionError } from "../core/writer.js";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { checkFreshness, computeFingerprint, legacyState } from "../core/fingerprint.js";
import { CONTEXT_FILENAME } from "../core/schema.js";
import type { ContextFile } from "../core/schema.js";
import type { FreshnessState, LegacyFreshnessState } from "../core/fingerprint.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { loadConfig } from "../utils/config.js";
import { filterByMinTokens } from "../utils/tokens.js";
import { aggregateEvidence, type AggregateEvidenceResult } from "../core/health.js";

// Fields an LLM can request via the filter parameter
const FILTERABLE_FIELDS = [
  "summary", "files", "interfaces", "decisions", "constraints",
  "dependencies", "current_state", "subdirectories", "environment",
  "testing", "todos", "data_models", "events", "config",
  "project", "structure", "maintenance", "exports", "imports", "internals",
] as const;

// Metadata fields always included in filtered output
const METADATA_FIELDS = ["version", "scope", "fingerprint", "last_updated"] as const;

/**
 * Resolve scope to an absolute path and validate it stays within root.
 * Returns null if path traversal is detected.
 */
function resolveAndValidate(root: string, scope: string): string | null {
  const rootResolved = resolve(root);
  const normalizedScope = scope.replace(/\\/g, "/");
  const target = normalizedScope === "." ? rootResolved : resolve(rootResolved, normalizedScope);
  if (target === rootResolved) return target;
  const rel = relative(rootResolved, target);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return target;
}

/**
 * Check whether a .context.yaml file exists on disk (regardless of validity).
 */
async function contextFileExists(dirPath: string): Promise<boolean> {
  try {
    await stat(join(dirPath, CONTEXT_FILENAME));
    return true;
  } catch {
    return false;
  }
}

// --- Handler interfaces ---

export interface QueryContextInput {
  scope: string;
  filter?: string[];
  path?: string;
}

export interface QueryContextResult {
  found: boolean;
  scope: string;
  context?: Record<string, unknown>;
  error?: string;
}

export interface CheckFreshnessInput {
  scope: string;
  path?: string;
}

export interface CheckFreshnessResult {
  scope: string;
  /** Legacy 3-state projection. New consumers opt into the 4-state enum via
   *  the T2 `explain_staleness` tool. */
  state: LegacyFreshnessState;
  fingerprint?: {
    stored: string;
    computed: string;
  };
  last_updated?: string;
  error?: string;
}

export interface ListContextsInput {
  path?: string;
}

export interface ContextEntry {
  scope: string;
  /** Legacy 3-state projection. Expanded 4-state info lives on the T2
   *  `explain_staleness` tool. */
  state: LegacyFreshnessState;
  has_context: boolean;
  last_updated?: string;
  summary?: string;
}

export interface ListContextsResult {
  root: string;
  total_directories: number;
  skipped_directories: number;
  tracked: number;
  entries: ContextEntry[];
  error?: string;
}

// --- Handlers ---

export async function handleQueryContext(
  input: QueryContextInput,
  defaultRoot: string,
): Promise<QueryContextResult> {
  const rootPath = resolve(input.path ?? defaultRoot);
  const targetDir = resolveAndValidate(rootPath, input.scope);

  if (!targetDir) {
    return { found: false, scope: input.scope, error: "Invalid scope: path traversal detected" };
  }

  const fileExists = await contextFileExists(targetDir);
  if (!fileExists) {
    return {
      found: false,
      scope: input.scope,
      error: `No .context.yaml found at scope "${input.scope}". This scope may be below the min_tokens threshold; use list_contexts to see eligible scopes.`,
    };
  }

  let context;
  try {
    context = await readContext(targetDir);
  } catch (err) {
    if (err instanceof UnsupportedVersionError) {
      return { found: false, scope: input.scope, error: err.message };
    }
    throw err;
  }
  if (!context) {
    return { found: false, scope: input.scope, error: `Invalid or corrupt .context.yaml at scope "${input.scope}"` };
  }

  // No filter — return everything
  if (!input.filter || input.filter.length === 0) {
    return { found: true, scope: input.scope, context: context as unknown as Record<string, unknown> };
  }

  // Filter: always include metadata, plus requested filterable fields
  const validFilters = input.filter.filter(
    (f) => (FILTERABLE_FIELDS as readonly string[]).includes(f),
  );

  const filtered: Record<string, unknown> = {};
  for (const key of METADATA_FIELDS) {
    filtered[key] = (context as unknown as Record<string, unknown>)[key];
  }
  for (const key of validFilters) {
    const value = (context as unknown as Record<string, unknown>)[key];
    if (value !== undefined) {
      filtered[key] = value;
    }
  }

  return { found: true, scope: input.scope, context: filtered };
}

export async function handleCheckFreshness(
  input: CheckFreshnessInput,
  defaultRoot: string,
): Promise<CheckFreshnessResult> {
  const rootPath = resolve(input.path ?? defaultRoot);
  const targetDir = resolveAndValidate(rootPath, input.scope);

  if (!targetDir) {
    return { scope: input.scope, state: "missing", error: "Invalid scope: path traversal detected" };
  }

  const fileExists = await contextFileExists(targetDir);
  if (!fileExists) {
    return {
      scope: input.scope,
      state: "missing",
      error: `No .context.yaml found at scope "${input.scope}". This scope may be below the min_tokens threshold; use list_contexts to see eligible scopes.`,
    };
  }

  let context;
  try {
    context = await readContext(targetDir);
  } catch (err) {
    if (err instanceof UnsupportedVersionError) {
      return { scope: input.scope, state: "missing", error: err.message };
    }
    throw err;
  }
  if (!context) {
    return { scope: input.scope, state: "missing", error: `Invalid or corrupt .context.yaml at scope "${input.scope}"` };
  }

  const { state, computed } = await checkFreshness(targetDir, context.fingerprint);

  return {
    scope: input.scope,
    state: legacyState(state),
    fingerprint: {
      stored: context.fingerprint,
      computed,
    },
    last_updated: context.last_updated,
  };
}

export async function handleListContexts(
  input: ListContextsInput,
  defaultRoot: string,
): Promise<ListContextsResult> {
  const rootPath = resolve(input.path ?? defaultRoot);

  try {
    const config = await loadConfig(rootPath);
    const scanOptions = await loadScanOptions(rootPath);
    const scanResult = await scanProject(rootPath, scanOptions);
    const allDirs = flattenBottomUp(scanResult);
    const { dirs, skipped } = await filterByMinTokens(allDirs, config?.min_tokens);

    const entries: ContextEntry[] = [];
    let tracked = 0;

    for (const dir of dirs) {
      let context;
      try {
        context = await readContext(dir.path);
      } catch (err) {
        if (err instanceof UnsupportedVersionError) {
          context = null;
        } else {
          throw err;
        }
      }
      const scope = dir.relativePath;

      if (context) {
        tracked++;
        const { state } = await checkFreshness(dir.path, context.fingerprint);
        entries.push({
          scope,
          state: legacyState(state),
          has_context: true,
          last_updated: context.last_updated,
          summary: context.summary,
        });
      } else {
        entries.push({
          scope,
          state: "missing",
          has_context: false,
        });
      }
    }

    // Sort by scope for deterministic output
    entries.sort((a, b) => a.scope.localeCompare(b.scope));

    return {
      root: rootPath,
      total_directories: dirs.length,
      skipped_directories: skipped,
      tracked,
      entries,
    };
  } catch {
    return {
      root: rootPath,
      total_directories: 0,
      skipped_directories: 0,
      tracked: 0,
      entries: [],
      error: `Failed to scan project at "${rootPath}"`,
    };
  }
}

export async function handleAggregateEvidence(
  input: { path?: string },
  defaultRoot: string,
): Promise<AggregateEvidenceResult> {
  const rootPath = resolve(input.path ?? defaultRoot);
  return aggregateEvidence(rootPath);
}

// --- MCP tool registration ---

export interface ExplainStalenessInput {
  scope: string;
  path?: string;
}

export interface ExplainStalenessResult {
  scope: string;
  state: FreshnessState;
  legacy_state: LegacyFreshnessState;
  fingerprints: {
    directory: { stored: string; computed: string } | null;
    semantic: { stored: string | null; computed: string | null };
  };
  caveat: string;
  error?: string;
}

export async function handleExplainStaleness(
  input: ExplainStalenessInput,
  defaultRoot: string,
): Promise<ExplainStalenessResult> {
  const { existsSync } = await import("node:fs");
  const { manifestPath } = await import("../index/paths.js");
  const rootPath = resolve(input.path ?? defaultRoot);
  const targetDir = resolveAndValidate(rootPath, input.scope);
  const baseCaveat =
    "Staleness classification uses import-bound references only (precision \u2265 0.95, recall \u2265 0.70 for TS/JS; lower elsewhere).";

  if (!targetDir) {
    return {
      scope: input.scope,
      state: "missing",
      legacy_state: "missing",
      fingerprints: { directory: null, semantic: { stored: null, computed: null } },
      caveat: baseCaveat,
      error: "Invalid scope: path traversal detected",
    };
  }

  let context;
  try {
    context = await readContext(targetDir);
  } catch (err) {
    if (err instanceof UnsupportedVersionError) {
      return {
        scope: input.scope,
        state: "missing",
        legacy_state: "missing",
        fingerprints: { directory: null, semantic: { stored: null, computed: null } },
        caveat: baseCaveat,
        error: err.message,
      };
    }
    throw err;
  }
  if (!context) {
    return {
      scope: input.scope,
      state: "missing",
      legacy_state: "missing",
      fingerprints: { directory: null, semantic: { stored: null, computed: null } },
      caveat: baseCaveat,
    };
  }

  if (!existsSync(manifestPath(rootPath))) {
    // No index — fall back to directory-fingerprint-only classification.
    const { state, computed } = await checkFreshness(targetDir, context.fingerprint);
    return {
      scope: input.scope,
      state,
      legacy_state: legacyState(state),
      fingerprints: {
        directory: { stored: context.fingerprint, computed },
        semantic: { stored: context.semantic_fingerprint ?? null, computed: null },
      },
      caveat: baseCaveat,
      error: "INDEX_MISSING",
    };
  }

  const { openIndex } = await import("../index/store.js");
  const { extractPolicyFacts } = await import("../core/semantic-fingerprint.js");
  const store = await openIndex(rootPath, { readOnly: true, autoRebuild: false });
  try {
    const { state, computed, computedSemantic } = await checkFreshness(
      targetDir,
      context.fingerprint,
      [],
      {
        storedSemanticFingerprint: context.semantic_fingerprint,
        index: store,
        contextFacts: extractPolicyFacts(context),
        projectRoot: rootPath,
      },
    );
    return {
      scope: input.scope,
      state,
      legacy_state: legacyState(state),
      fingerprints: {
        directory: { stored: context.fingerprint, computed },
        semantic: {
          stored: context.semantic_fingerprint ?? null,
          computed: computedSemantic ?? null,
        },
      },
      caveat: baseCaveat,
    };
  } finally {
    await store.close();
  }
}

export function registerTools(server: McpServer, defaultRoot: string): void {
  server.registerTool(
    "query_context",
    {
      title: "Query Context",
      description:
        "Retrieve .context.yaml content for a directory scope. " +
        "Returns structured documentation including summary, files, interfaces, " +
        "decisions, and more. Use filter to request only specific fields.",
      inputSchema: {
        scope: z.string().describe(
          'Relative path from project root, e.g. "src/core" or "." for root',
        ),
        filter: z.array(z.string()).optional().describe(
          "Optional list of fields to include: summary, files, interfaces, decisions, " +
          "constraints, dependencies, current_state, subdirectories, environment, " +
          "testing, todos, data_models, events, config, project, structure, maintenance, " +
          "exports, imports, internals. " +
          "Metadata fields (version, scope, fingerprint, last_updated) are always included.",
        ),
        path: z.string().optional().describe(
          "Project root path override. Defaults to the server's configured root.",
        ),
      },
    },
    async (input) => {
      const result = await handleQueryContext(input, defaultRoot);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: !result.found,
      };
    },
  );

  server.registerTool(
    "check_freshness",
    {
      title: "Check Freshness",
      description:
        "Check if a .context.yaml file is current. Returns fresh/stale/missing " +
        "with fingerprint details. Use this to verify context reliability before " +
        "relying on it.",
      inputSchema: {
        scope: z.string().describe(
          'Relative path from project root, e.g. "src/core" or "." for root',
        ),
        path: z.string().optional().describe(
          "Project root path override. Defaults to the server's configured root.",
        ),
      },
    },
    async (input) => {
      const result = await handleCheckFreshness(input, defaultRoot);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    },
  );

  server.registerTool(
    "list_contexts",
    {
      title: "List Contexts",
      description:
        "List all tracked directories with their staleness status. " +
        "Returns a summary of all directories that should have .context.yaml " +
        "files, showing which are fresh, stale, or missing.",
      inputSchema: {
        path: z.string().optional().describe(
          "Project root path override. Defaults to the server's configured root.",
        ),
      },
    },
    async (input) => {
      const result = await handleListContexts(input, defaultRoot);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    },
  );

  server.registerTool(
    "build_context_pack",
    {
      title: "Build Context Pack",
      description:
        "Assemble a token-budgeted Markdown or JSON pack for an agent. " +
        "Seeds: --query (free text), --file (path), --symbol (exported name). " +
        "Retrieval: BM25F over the .context.yaml corpus plus directory-level " +
        "graph proximity when the code index is available.",
      inputSchema: {
        query: z.string().optional().describe("Free-text query seed"),
        file: z.string().optional().describe("File path seed (POSIX-relative to project root)"),
        symbol: z.string().optional().describe("Exported symbol name seed"),
        budget: z.number().int().positive().optional().describe("Token budget (default 4000)"),
        format: z.enum(["md", "json"]).optional().describe("Output format (default md)"),
        path: z.string().optional().describe("Project root path override"),
      },
    },
    async (input) => {
      const { buildPack } = await import("../pack/pack.js");
      const { formatPackJson, formatPackMarkdown } = await import("../pack/format.js");
      const pack = await buildPack({
        projectRoot: resolve(input.path ?? defaultRoot),
        query: input.query,
        file: input.file,
        symbol: input.symbol,
        budget: input.budget,
      });
      const text = input.format === "json" ? formatPackJson(pack) : formatPackMarkdown(pack);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.registerTool(
    "explain_staleness",
    {
      title: "Explain Staleness",
      description:
        "Classify a scope's freshness using the 4-state enum " +
        "(fresh | cosmetic_stale | semantic_stale | missing). Returns both " +
        "fingerprints and a minimal change delta so agents can tell whether " +
        "the API surface actually moved. Requires the local code index; " +
        "returns error INDEX_MISSING otherwise.",
      inputSchema: {
        scope: z.string().describe(
          'Relative path from project root, e.g. "src/core" or "." for root',
        ),
        path: z.string().optional().describe(
          "Project root path override. Defaults to the server's configured root.",
        ),
      },
    },
    async (input) => {
      const result = await handleExplainStaleness(input, defaultRoot);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    },
  );

  server.registerTool(
    "check_policies",
    {
      title: "Check Policies",
      description:
        "Evaluate typed policy rules (forbid_import, require_import, require_export, " +
        "max_file_lines, require_test_file, dependency_boundary, evidence_requires) " +
        "against the local code index. Returns violations keyed by rule kind and scope. " +
        "Requires the index — returns {ok: false, index_state: \"missing\"} otherwise.",
      inputSchema: {
        scope: z.string().optional().describe(
          "Project-relative POSIX directory to limit evaluation to. Default: whole project.",
        ),
        rule_kinds: z
          .array(
            z.enum([
              "forbid_import",
              "require_import",
              "require_export",
              "max_file_lines",
              "require_test_file",
              "dependency_boundary",
              "evidence_requires",
            ]),
          )
          .optional()
          .describe("Filter to only these rule kinds. Default: all kinds."),
        path: z.string().optional().describe("Project root path override."),
      },
    },
    async (input) => {
      const { runPolicies } = await import("../policy/engine.js");
      const projectRoot = resolve(input.path ?? defaultRoot);
      const run = await runPolicies({
        projectRoot,
        scope: input.scope,
        ruleKinds: input.rule_kinds,
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(run, null, 2) }],
        isError: !run.ok,
      };
    },
  );

  server.registerTool(
    "aggregate_evidence",
    {
      title: "Aggregate Evidence",
      description:
        "Aggregate code health evidence across all tracked scopes. " +
        "Returns per-scope evidence and a project-wide health summary including " +
        "test status, typecheck, lint, and coverage metrics. " +
        "Note: total_test_count is a raw sum and may double-count nested scopes.",
      inputSchema: {
        path: z.string().optional().describe(
          "Project root path override. Defaults to the server's configured root.",
        ),
      },
    },
    async (input) => {
      const result = await handleAggregateEvidence(input, defaultRoot);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        isError: !!result.error,
      };
    },
  );
}
