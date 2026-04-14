import { describe, it, expect } from "vitest";
import { vitestJsonParser, jestJsonParser } from "../../src/verify/parsers/vitest-json.js";
import { junitXmlParser } from "../../src/verify/parsers/junit-xml.js";
import { goTestJsonParser } from "../../src/verify/parsers/go-test-json.js";
import { tscParser } from "../../src/verify/parsers/tsc.js";
import { eslintJsonParser } from "../../src/verify/parsers/eslint-json.js";
import { istanbulSummaryParser, pytestCovParser } from "../../src/verify/parsers/coverage.js";
import { exitCodeParser } from "../../src/verify/parsers/exit-code.js";
import type { SpawnResult } from "../../src/verify/runner.js";

function makeSpawn(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    durationMs: 0,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

describe("vitest-json / jest-json parsers", () => {
  it("records passing + counts + test_tool", () => {
    const out = vitestJsonParser({
      spawn: makeSpawn({ stdout: '{"success":true,"numTotalTests":42,"testResults":[]}' }),
      cwd: "/t",
    });
    expect(out.evidence.test_status).toBe("passing");
    expect(out.evidence.test_count).toBe(42);
    expect(out.evidence.test_tool).toBe("vitest");
  });

  it("records failing with sorted failing_tests capped at 50", () => {
    const failing = Array.from({ length: 60 }, (_, i) => ({
      status: "failed",
      name: `suite-${String(60 - i).padStart(3, "0")}`,
    }));
    const payload = JSON.stringify({ success: false, numTotalTests: 100, testResults: failing });
    const out = vitestJsonParser({ spawn: makeSpawn({ stdout: payload }), cwd: "/t" });
    expect(out.evidence.test_status).toBe("failing");
    expect(out.evidence.failing_tests).toHaveLength(50);
    expect(out.evidence.failing_tests?.[0]).toMatch(/suite-00/);
  });

  it("strips progress noise before the JSON object", () => {
    const out = vitestJsonParser({
      spawn: makeSpawn({ stdout: 'RUNS \u2713\n{"success":true,"numTotalTests":1}\n' }),
      cwd: "/t",
    });
    expect(out.evidence.test_status).toBe("passing");
  });

  it("jest-json labels test_tool as jest", () => {
    const out = jestJsonParser({
      spawn: makeSpawn({ stdout: '{"success":true,"numTotalTests":5}' }),
      cwd: "/t",
    });
    expect(out.evidence.test_tool).toBe("jest");
  });

  it("records unknown when JSON is missing", () => {
    const out = vitestJsonParser({ spawn: makeSpawn({ stdout: "" }), cwd: "/t" });
    expect(out.evidence.test_status).toBe("unknown");
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});

describe("junit-xml parser", () => {
  it("reports passing on zero failures + errors", () => {
    const xml = `<?xml version="1.0"?>
      <testsuites>
        <testsuite tests="10" failures="0" errors="0">
          <testcase classname="A" name="t1"/>
        </testsuite>
      </testsuites>`;
    const out = junitXmlParser({ spawn: makeSpawn(), artifactText: xml, cwd: "/t" });
    expect(out.evidence.test_status).toBe("passing");
    expect(out.evidence.test_count).toBe(10);
  });

  it("extracts failing testcase classname.name pairs", () => {
    const xml = `<?xml version="1.0"?>
      <testsuite tests="3" failures="2" errors="0">
        <testcase classname="A" name="t1"/>
        <testcase classname="A" name="t2"><failure message="bad"/></testcase>
        <testcase classname="B" name="t3"><error message="oops"/></testcase>
      </testsuite>`;
    const out = junitXmlParser({ spawn: makeSpawn(), artifactText: xml, cwd: "/t" });
    expect(out.evidence.test_status).toBe("failing");
    expect(out.evidence.failing_tests).toEqual(["A.t2", "B.t3"]);
  });

  it("requires an artifact — no artifact yields unknown", () => {
    const out = junitXmlParser({ spawn: makeSpawn(), cwd: "/t" });
    expect(out.evidence.test_status).toBe("unknown");
  });
});

describe("go-test-json parser", () => {
  it("aggregates pass/fail/skip and excludes skip from test_count", () => {
    const ndjson = [
      '{"Action":"pass","Package":"p","Test":"TestA"}',
      '{"Action":"fail","Package":"p","Test":"TestB"}',
      '{"Action":"skip","Package":"p","Test":"TestC"}',
    ].join("\n");
    const out = goTestJsonParser({ spawn: makeSpawn({ stdout: ndjson }), cwd: "/t" });
    expect(out.evidence.test_count).toBe(2);
    expect(out.evidence.test_status).toBe("failing");
    expect(out.evidence.failing_tests).toEqual(["p.TestB"]);
  });

  it("handles non-JSON lines without crashing", () => {
    const ndjson = 'garbage\n{"Action":"pass","Package":"p","Test":"TestA"}\n';
    const out = goTestJsonParser({ spawn: makeSpawn({ stdout: ndjson }), cwd: "/t" });
    expect(out.evidence.test_status).toBe("passing");
    expect(out.warnings.some((w) => /non-JSON/.test(w))).toBe(true);
  });
});

describe("tsc parser", () => {
  it("exit 0 → clean", () => {
    const out = tscParser({ spawn: makeSpawn({ exitCode: 0 }), cwd: "/t" });
    expect(out.evidence.typecheck).toBe("clean");
    expect(out.evidence.typecheck_tool).toBe("tsc");
  });

  it("exit non-zero + TS error marker → errors", () => {
    const out = tscParser({
      spawn: makeSpawn({ exitCode: 1, stderr: "src/a.ts(3,4): error TS2304: Cannot find name 'X'." }),
      cwd: "/t",
    });
    expect(out.evidence.typecheck).toBe("errors");
  });

  it("exit non-zero without TS marker → unknown", () => {
    const out = tscParser({
      spawn: makeSpawn({ exitCode: 2, stderr: "invalid config" }),
      cwd: "/t",
    });
    expect(out.evidence.typecheck).toBe("unknown");
  });
});

describe("eslint-json parser", () => {
  it("zero errors → clean", () => {
    const out = eslintJsonParser({
      spawn: makeSpawn({ stdout: '[{"filePath":"a.ts","errorCount":0,"warningCount":2}]' }),
      cwd: "/t",
    });
    expect(out.evidence.lint_status).toBe("clean");
    expect(out.evidence.lint_tool).toBe("eslint");
  });

  it("non-zero errors → errors", () => {
    const out = eslintJsonParser({
      spawn: makeSpawn({ stdout: '[{"filePath":"a.ts","errorCount":3,"warningCount":0}]' }),
      cwd: "/t",
    });
    expect(out.evidence.lint_status).toBe("errors");
  });

  it("missing/invalid JSON → unknown", () => {
    const out = eslintJsonParser({ spawn: makeSpawn({ stdout: "" }), cwd: "/t" });
    expect(out.evidence.lint_status).toBe("unknown");
  });
});

describe("coverage parsers", () => {
  it("istanbul-summary reads total.lines.pct", () => {
    const payload = JSON.stringify({ total: { lines: { pct: 82.3 } } });
    const out = istanbulSummaryParser({ spawn: makeSpawn({ stdout: payload }), cwd: "/t" });
    expect(out.evidence.coverage_percent).toBe(82.3);
  });

  it("pytest-cov reads totals.percent_covered", () => {
    const payload = JSON.stringify({ totals: { percent_covered: 95.5 } });
    const out = pytestCovParser({ spawn: makeSpawn({ stdout: payload }), cwd: "/t" });
    expect(out.evidence.coverage_percent).toBe(95.5);
  });

  it("clamps out-of-range values to [0,100]", () => {
    const out = istanbulSummaryParser({
      spawn: makeSpawn({ stdout: '{"total":{"lines":{"pct":150}}}' }),
      cwd: "/t",
    });
    expect(out.evidence.coverage_percent).toBe(100);
  });
});

describe("exit-code parser", () => {
  it("warns on non-zero exit", () => {
    const out = exitCodeParser({ spawn: makeSpawn({ exitCode: 2 }), cwd: "/t" });
    expect(out.warnings.length).toBeGreaterThan(0);
  });
});
