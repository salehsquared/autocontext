import type { Parser, ParserResult } from "./types.js";
import type { Evidence } from "../../core/schema.js";

const MAX_FAILING = 50;

export const vitestJsonParser: Parser = (input): ParserResult => {
  const warnings: string[] = [];
  const raw = input.artifactText ?? input.spawn.stdout;
  const data = tryParse(raw, warnings);
  const evidence: Partial<Evidence> = { test_tool: "vitest" };
  if (data) applyTestJson(data, evidence);
  else evidence.test_status = "unknown";
  return { evidence, warnings };
};

export const jestJsonParser: Parser = (input): ParserResult => {
  const warnings: string[] = [];
  const raw = input.artifactText ?? input.spawn.stdout;
  const data = tryParse(raw, warnings);
  const evidence: Partial<Evidence> = { test_tool: "jest" };
  if (data) applyTestJson(data, evidence);
  else evidence.test_status = "unknown";
  return { evidence, warnings };
};

function tryParse(raw: string, warnings: string[]): Record<string, unknown> | null {
  if (!raw || !raw.trim()) {
    warnings.push("no JSON output captured");
    return null;
  }
  // Some runners emit progress text before the JSON object. Strip up to the
  // first '{' to maximize resilience.
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < 0) {
    warnings.push("output did not contain a JSON object");
    return null;
  }
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch (err) {
    warnings.push(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function applyTestJson(data: Record<string, unknown>, evidence: Partial<Evidence>): void {
  if (typeof data.success === "boolean") {
    evidence.test_status = data.success ? "passing" : "failing";
    if (typeof data.numTotalTests === "number") evidence.test_count = data.numTotalTests;
    if (!data.success && Array.isArray(data.testResults)) {
      const failing: string[] = [];
      for (const suite of data.testResults as Array<Record<string, unknown>>) {
        if (suite.status === "failed" && typeof suite.name === "string") failing.push(suite.name);
      }
      if (failing.length > 0) {
        failing.sort();
        evidence.failing_tests = failing.slice(0, MAX_FAILING);
      }
    }
    return;
  }
  if (typeof data.numPassedTests === "number" && typeof data.numFailedTests === "number") {
    const failed = data.numFailedTests as number;
    evidence.test_status = failed === 0 ? "passing" : "failing";
    evidence.test_count = (data.numPassedTests as number) + failed;
    return;
  }
  evidence.test_status = "unknown";
}
