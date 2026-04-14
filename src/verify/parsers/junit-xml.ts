import type { Parser, ParserResult } from "./types.js";
import type { Evidence } from "../../core/schema.js";

const MAX_FAILING = 50;

/**
 * Lightweight JUnit XML parser. We do not pull in a DOM library — the schema
 * we care about is tiny (top-level aggregates + <testcase><failure|error/>).
 * Regex matching is bounded by the 5 MiB output cap upstream.
 */
export const junitXmlParser: Parser = (input): ParserResult => {
  const warnings: string[] = [];
  const raw = input.artifactText;
  const evidence: Partial<Evidence> = { test_tool: "junit" };
  if (!raw) {
    warnings.push("junit-xml parser requires an artifact file");
    evidence.test_status = "unknown";
    return { evidence, warnings };
  }

  const tests = sumAttr(raw, /<testsuite[^>]*\btests="(\d+)"/g);
  const failures = sumAttr(raw, /<testsuite[^>]*\bfailures="(\d+)"/g);
  const errors = sumAttr(raw, /<testsuite[^>]*\berrors="(\d+)"/g);
  if (tests === null) {
    warnings.push("no <testsuite> with tests=N attribute found");
    evidence.test_status = "unknown";
    return { evidence, warnings };
  }
  evidence.test_count = tests;
  evidence.test_status = (failures ?? 0) + (errors ?? 0) === 0 ? "passing" : "failing";

  if (evidence.test_status === "failing") {
    const failing: string[] = [];
    const testcaseRe = /<testcase\s+([^>]*?)\s*(?:\/>|>([\s\S]*?)<\/testcase>)/g;
    let m: RegExpExecArray | null;
    while ((m = testcaseRe.exec(raw)) !== null) {
      const attrs = m[1] ?? "";
      const body = m[2] ?? "";
      if (!/<failure|<error/i.test(body)) continue;
      const classname = attrs.match(/\bclassname="([^"]*)"/)?.[1] ?? "";
      const name = attrs.match(/\bname="([^"]*)"/)?.[1] ?? "";
      const label = classname ? `${classname}.${name}` : name;
      if (label) failing.push(label);
      if (failing.length >= MAX_FAILING * 2) break;
    }
    if (failing.length > 0) {
      failing.sort();
      evidence.failing_tests = failing.slice(0, MAX_FAILING);
    }
  }

  return { evidence, warnings };
};

function sumAttr(xml: string, re: RegExp): number | null {
  let seen = false;
  let total = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    seen = true;
    total += parseInt(m[1], 10);
  }
  return seen ? total : null;
}
