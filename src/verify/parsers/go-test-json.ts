import type { Parser, ParserResult } from "./types.js";
import type { Evidence } from "../../core/schema.js";

const MAX_FAILING = 50;

export const goTestJsonParser: Parser = (input): ParserResult => {
  const warnings: string[] = [];
  const evidence: Partial<Evidence> = { test_tool: "go-test" };
  const raw = input.artifactText ?? input.spawn.stdout;
  if (!raw || !raw.trim()) {
    warnings.push("no go-test NDJSON output captured");
    evidence.test_status = "unknown";
    return { evidence, warnings };
  }

  const status = new Map<string, "pass" | "fail" | "skip">();
  let parseErrors = 0;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      parseErrors++;
      continue;
    }
    const action = event.Action;
    const pkg = typeof event.Package === "string" ? event.Package : "";
    const test = typeof event.Test === "string" ? event.Test : "";
    if (!pkg || !test) continue;
    if (action === "pass" || action === "fail" || action === "skip") {
      status.set(`${pkg}.${test}`, action);
    }
  }
  if (parseErrors > 0) warnings.push(`${parseErrors} non-JSON go-test output line(s)`);

  const nonSkip = [...status.entries()].filter(([, v]) => v !== "skip");
  const failing = nonSkip.filter(([, v]) => v === "fail").map(([k]) => k);
  evidence.test_count = nonSkip.length;
  evidence.test_status = nonSkip.length === 0 ? "unknown" : failing.length === 0 ? "passing" : "failing";
  if (failing.length > 0) {
    failing.sort();
    evidence.failing_tests = failing.slice(0, MAX_FAILING);
  }
  return { evidence, warnings };
};
