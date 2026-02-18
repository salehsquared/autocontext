import { join } from "node:path";
import { stat } from "node:fs/promises";
import { readContext, UnsupportedVersionError } from "./writer.js";
import { scanProject, flattenBottomUp } from "./scanner.js";
import { CONTEXT_FILENAME } from "./schema.js";
import type { Evidence } from "./schema.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { loadConfig } from "../utils/config.js";
import { filterByMinTokens } from "../utils/tokens.js";

// --- Result interfaces ---

export interface HealthSummary {
  tests: {
    passing: number;
    failing: number;
    unknown: number;
    total_test_count: number;
    failing_scopes: string[];
  };
  typecheck: {
    clean: number;
    errors: number;
    unknown: number;
  };
  lint: {
    clean: number;
    errors: number;
    unknown: number;
  };
  coverage: {
    scopes_reported: number;
    average_percent: number | null;
    min_percent: number | null;
    max_percent: number | null;
  };
}

export interface EvidenceEntry {
  scope: string;
  has_evidence: boolean;
  evidence?: Evidence;
}

export interface AggregateEvidenceResult {
  root: string;
  total_scopes: number;
  scopes_with_evidence: number;
  health: HealthSummary;
  scopes: EvidenceEntry[];
  scope_errors: Array<{ scope: string; error: string }>;
  error?: string;
}

// --- Helpers ---

function emptyHealth(): HealthSummary {
  return {
    tests: { passing: 0, failing: 0, unknown: 0, total_test_count: 0, failing_scopes: [] },
    typecheck: { clean: 0, errors: 0, unknown: 0 },
    lint: { clean: 0, errors: 0, unknown: 0 },
    coverage: { scopes_reported: 0, average_percent: null, min_percent: null, max_percent: null },
  };
}

async function contextFileExists(dirPath: string): Promise<boolean> {
  try {
    await stat(join(dirPath, CONTEXT_FILENAME));
    return true;
  } catch {
    return false;
  }
}

// --- Core aggregation ---

export async function aggregateEvidence(rootPath: string): Promise<AggregateEvidenceResult> {
  const health = emptyHealth();
  const scopes: EvidenceEntry[] = [];
  const scopeErrors: Array<{ scope: string; error: string }> = [];
  const coverageValues: number[] = [];
  let scopesWithEvidence = 0;

  let dirs: Awaited<ReturnType<typeof filterByMinTokens>>["dirs"];
  try {
    const config = await loadConfig(rootPath);
    const scanOptions = await loadScanOptions(rootPath);
    const scanResult = await scanProject(rootPath, scanOptions);
    const allDirs = flattenBottomUp(scanResult);
    const filtered = await filterByMinTokens(allDirs, config?.min_tokens);
    dirs = filtered.dirs;
  } catch {
    return {
      root: rootPath,
      total_scopes: 0,
      scopes_with_evidence: 0,
      health,
      scopes: [],
      scope_errors: [],
      error: `Failed to scan project at "${rootPath}"`,
    };
  }

  for (const dir of dirs) {
    const scope = dir.relativePath;

    let context;
    try {
      context = await readContext(dir.path);
    } catch (err) {
      if (err instanceof UnsupportedVersionError) {
        scopeErrors.push({ scope, error: err.message });
        scopes.push({ scope, has_evidence: false });
        continue;
      }
      throw err;
    }

    if (context === null) {
      const exists = await contextFileExists(dir.path);
      if (exists) {
        scopeErrors.push({ scope, error: `Invalid or corrupt .context.yaml at scope "${scope}"` });
      }
      scopes.push({ scope, has_evidence: false });
      continue;
    }

    if (!context.evidence) {
      scopes.push({ scope, has_evidence: false });
      continue;
    }

    const ev = context.evidence;
    scopes.push({ scope, has_evidence: true, evidence: ev });
    scopesWithEvidence++;

    // Tests
    if (ev.test_status === "passing") health.tests.passing++;
    else if (ev.test_status === "failing") {
      health.tests.failing++;
      health.tests.failing_scopes.push(scope);
    } else if (ev.test_status === "unknown") health.tests.unknown++;
    if (ev.test_count !== undefined) health.tests.total_test_count += ev.test_count;

    // Typecheck
    if (ev.typecheck === "clean") health.typecheck.clean++;
    else if (ev.typecheck === "errors") health.typecheck.errors++;
    else if (ev.typecheck === "unknown") health.typecheck.unknown++;

    // Lint
    if (ev.lint_status === "clean") health.lint.clean++;
    else if (ev.lint_status === "errors") health.lint.errors++;
    else if (ev.lint_status === "unknown") health.lint.unknown++;

    // Coverage
    if (ev.coverage_percent !== undefined) {
      coverageValues.push(ev.coverage_percent);
    }
  }

  // Coverage aggregation
  if (coverageValues.length > 0) {
    const sum = coverageValues.reduce((a, b) => a + b, 0);
    health.coverage.scopes_reported = coverageValues.length;
    health.coverage.average_percent = Math.round((sum / coverageValues.length) * 10) / 10;
    health.coverage.min_percent = Math.min(...coverageValues);
    health.coverage.max_percent = Math.max(...coverageValues);
  }

  // Deterministic ordering
  scopes.sort((a, b) => a.scope.localeCompare(b.scope));
  health.tests.failing_scopes.sort();
  scopeErrors.sort((a, b) => a.scope.localeCompare(b.scope));

  return {
    root: rootPath,
    total_scopes: dirs.length,
    scopes_with_evidence: scopesWithEvidence,
    health,
    scopes,
    scope_errors: scopeErrors,
  };
}
