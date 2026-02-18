import { resolve } from "node:path";
import { aggregateEvidence } from "../core/health.js";
import { heading, dim } from "../utils/display.js";

export async function healthCommand(options: { path?: string; json?: boolean }): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  const result = await aggregateEvidence(rootPath);

  if (options.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    if (result.error) process.exitCode = 1;
    return;
  }

  if (result.error) {
    console.error(`  ${result.error}`);
    process.exitCode = 1;
    return;
  }

  console.log("");
  console.log(heading("  Code Health"));
  console.log("");

  if (result.scopes_with_evidence === 0) {
    console.log("  No evidence found. Run `context init --evidence` or `context regen --all --evidence`.");
    console.log("");
    return;
  }

  const { tests, typecheck, lint, coverage } = result.health;

  // Tests
  const testParts = [
    `${tests.passing} passing`,
    `${tests.failing} failing`,
    `${tests.unknown} unknown`,
  ].join(" \u00b7 ");
  const testTotal = tests.total_test_count > 0 ? ` (${tests.total_test_count} total tests)` : "";
  console.log(`  Tests:       ${testParts}${testTotal}`);

  if (tests.failing_scopes.length > 0) {
    console.log(`  Failing:     ${tests.failing_scopes.join(", ")}`);
  }

  // Typecheck
  const tcParts = [
    `${typecheck.clean} clean`,
    `${typecheck.errors} errors`,
    `${typecheck.unknown} unknown`,
  ].join(" \u00b7 ");
  console.log(`  Typecheck:   ${tcParts}`);

  // Lint
  const lintParts = [
    `${lint.clean} clean`,
    `${lint.errors} errors`,
    `${lint.unknown} unknown`,
  ].join(" \u00b7 ");
  console.log(`  Lint:        ${lintParts}`);

  // Coverage
  if (coverage.scopes_reported > 0) {
    console.log(
      `  Coverage:    ${coverage.average_percent}% avg (${coverage.min_percent}% \u2013 ${coverage.max_percent}%) across ${coverage.scopes_reported} scopes`,
    );
  } else {
    console.log(dim("  Coverage:    no scopes report coverage"));
  }

  console.log("");
  console.log(`  ${result.scopes_with_evidence} of ${result.total_scopes} scopes report evidence`);
  console.log("");
}
