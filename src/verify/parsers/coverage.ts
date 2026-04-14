import type { Parser, ParserResult } from "./types.js";
import type { Evidence } from "../../core/schema.js";

/**
 * Istanbul / v8 / c8 `coverage-summary.json` shape:
 *   { total: { lines: { pct: number }, ... } }
 */
export const istanbulSummaryParser: Parser = (input): ParserResult => {
  const warnings: string[] = [];
  const evidence: Partial<Evidence> = {};
  const raw = input.artifactText ?? input.spawn.stdout;
  const pct = readCoveragePercent(raw, warnings, ["total", "lines", "pct"]);
  if (pct !== null) evidence.coverage_percent = pct;
  return { evidence, warnings };
};

/** pytest-cov `coverage.json` → `totals.percent_covered`. */
export const pytestCovParser: Parser = (input): ParserResult => {
  const warnings: string[] = [];
  const evidence: Partial<Evidence> = {};
  const raw = input.artifactText ?? input.spawn.stdout;
  const pct = readCoveragePercent(raw, warnings, ["totals", "percent_covered"]);
  if (pct !== null) evidence.coverage_percent = pct;
  return { evidence, warnings };
};

function readCoveragePercent(
  raw: string | undefined,
  warnings: string[],
  path: string[],
): number | null {
  if (!raw || !raw.trim()) {
    warnings.push("no coverage output captured");
    return null;
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    warnings.push(`coverage JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  let cur: unknown = data;
  for (const key of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[key];
  }
  if (typeof cur !== "number" || !Number.isFinite(cur)) return null;
  return Math.max(0, Math.min(100, cur));
}
