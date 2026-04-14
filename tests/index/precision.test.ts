import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { measurePrecision } from "../../src/index/precision.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = join(repoRoot, "tests/fixtures/index-precision");

describe("TS/JS import-bound reference precision (T1-B)", () => {
  it("meets the \u22650.95 precision / \u22650.70 recall target on the TS fixture", async () => {
    const report = await measurePrecision(join(fixtures, "typescript"));
    // Print the breakdown so regressions are easy to diagnose.
    if (report.totals.precision < 0.95 || report.totals.recall < 0.7) {
      // eslint-disable-next-line no-console
      console.error(
        "Precision report:\n" + JSON.stringify(report, null, 2),
      );
    }
    expect(report.totals.precision).toBeGreaterThanOrEqual(0.95);
    expect(report.totals.recall).toBeGreaterThanOrEqual(0.7);
  });
});
