import type { Parser, ParserResult } from "./types.js";
import type { Evidence } from "../../core/schema.js";

export const eslintJsonParser: Parser = (input): ParserResult => {
  const warnings: string[] = [];
  const evidence: Partial<Evidence> = { lint_tool: "eslint" };
  const raw = input.artifactText ?? input.spawn.stdout;
  if (!raw || !raw.trim()) {
    warnings.push("no eslint JSON output captured");
    evidence.lint_status = "unknown";
    return { evidence, warnings };
  }
  let data: unknown;
  try {
    const start = raw.indexOf("[");
    const end = raw.lastIndexOf("]");
    if (start < 0 || end < 0) throw new Error("no JSON array present");
    data = JSON.parse(raw.slice(start, end + 1));
  } catch (err) {
    warnings.push(`eslint JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
    evidence.lint_status = "unknown";
    return { evidence, warnings };
  }
  if (!Array.isArray(data)) {
    warnings.push("eslint output was not an array");
    evidence.lint_status = "unknown";
    return { evidence, warnings };
  }
  let errorCount = 0;
  for (const entry of data as Array<Record<string, unknown>>) {
    const n = entry?.errorCount;
    if (typeof n === "number") errorCount += n;
  }
  evidence.lint_status = errorCount === 0 ? "clean" : "errors";
  return { evidence, warnings };
};
