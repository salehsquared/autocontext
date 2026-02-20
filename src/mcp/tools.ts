import { resolve, join, relative, isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readContext, UnsupportedVersionError } from "../core/writer.js";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { checkFreshness, computeFingerprint } from "../core/fingerprint.js";
import { CONTEXT_FILENAME } from "../core/schema.js";
import type { ContextFile } from "../core/schema.js";
import type { FreshnessState } from "../core/fingerprint.js";
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
  state: FreshnessState;
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
  state: FreshnessState;
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
      return { scope: input.scope, state: "missing" as FreshnessState, error: err.message };
    }
    throw err;
  }
  if (!context) {
    return { scope: input.scope, state: "missing", error: `Invalid or corrupt .context.yaml at scope "${input.scope}"` };
  }

  const { state, computed } = await checkFreshness(targetDir, context.fingerprint);

  return {
    scope: input.scope,
    state,
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
          state,
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
