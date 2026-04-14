import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadConfig } from "../utils/config.js";
import type { VerifyKind } from "../core/schema.js";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { filterByMinTokens } from "../utils/tokens.js";
import { runVerify, VERIFY_KINDS, type VerifyRunReport } from "../verify/orchestrator.js";
import { errorMsg, successMsg, warnMsg, dim } from "../utils/display.js";
import { getVerifyCommand } from "../utils/config.js";

export interface VerifyCommandOptions {
  path?: string;
  scope?: string;
  only?: string;
  timeout?: string;
  merge?: boolean;
  strict?: boolean;
  dryRun?: boolean;
  yes?: boolean;
  json?: boolean;
}

const FIRST_RUN_MARKER = ".autocontext/verify.first-run";

export async function verifyCommand(options: VerifyCommandOptions): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  const config = await loadConfig(rootPath);
  const jsonMode = options.json === true;

  if (!config?.verify) {
    const msg = [
      "No `verify:` block in .context.config.yaml.",
      "Add commands for the tools you want to run, for example:",
      "",
      "verify:",
      "  test: \"npm test --silent -- --reporter=json --outputFile=test-results.json\"",
      "  typecheck: \"npx tsc --noEmit\"",
      "  lint: \"npx eslint . --format json --output-file=.eslint-results.json\"",
      "",
      "See docs/verify.md for the full list of supported parsers.",
    ].join("\n");
    if (jsonMode) process.stdout.write(JSON.stringify({ error: "verify_not_configured", message: msg }) + "\n");
    else console.log(errorMsg(msg));
    process.exit(2);
  }

  // --only parsing
  const onlyKinds = parseOnly(options.only);
  if (onlyKinds && onlyKinds.size > 0) {
    for (const k of onlyKinds) {
      if (!config.verify[k]) {
        const msg = `verify.${k} is not configured`;
        if (jsonMode) process.stdout.write(JSON.stringify({ error: "kind_not_configured", kind: k, message: msg }) + "\n");
        else console.log(errorMsg(msg));
        process.exit(2);
      }
    }
  }

  // Resolve scopes
  const scopeOpt = options.scope;
  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const allDirs = flattenBottomUp(scanResult);
  const { dirs } = await filterByMinTokens(allDirs, config.min_tokens);
  const scopes = scopeOpt
    ? dirs
        .filter((d) => d.relativePath === scopeOpt || d.relativePath.startsWith(`${scopeOpt}/`))
        .map((d) => ({ relative: d.relativePath, absolute: d.path }))
    : [{ relative: ".", absolute: rootPath }];

  if (scopes.length === 0) {
    if (jsonMode) process.stdout.write(JSON.stringify({ error: "no_scopes_match", scope: scopeOpt }) + "\n");
    else console.log(warnMsg(`No tracked scopes match ${scopeOpt}.`));
    process.exit(2);
  }

  // First-run prompt (skipped in json/dry-run/yes)
  const markerPath = join(rootPath, FIRST_RUN_MARKER);
  if (!existsSync(markerPath) && !options.yes && !options.dryRun) {
    if (!process.stdout.isTTY) {
      const msg = "verify: non-interactive environment detected; pass --yes to acknowledge the first-run prompt.";
      if (jsonMode) process.stdout.write(JSON.stringify({ error: "tty_required", message: msg }) + "\n");
      else console.log(errorMsg(msg));
      process.exit(2);
    }
    printPlan(config, scopes, onlyKinds);
    console.log("");
    const answer = await promptYesNo("verify runs commands configured in .context.config.yaml. Proceed? [y/N]: ");
    if (!answer) {
      console.log(dim("verify: declined."));
      process.exit(3);
    }
    await mkdir(dirname(markerPath), { recursive: true });
    await writeFile(markerPath, `${new Date().toISOString()}\n`);
  }

  const timeoutSecondsOverride = options.timeout ? parseInt(options.timeout, 10) : undefined;

  if (options.dryRun) {
    if (!jsonMode) printPlan(config, scopes, onlyKinds);
  }

  const report = await runVerify({
    projectRoot: rootPath,
    scopes,
    config,
    onlyKinds,
    timeoutSecondsOverride,
    merge: options.merge === true,
    dryRun: options.dryRun === true,
  });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    printHuman(report);
  }

  process.exit(computeExitCode(report, options.strict === true, options.dryRun === true));
}

function parseOnly(raw: string | undefined): Set<VerifyKind> | undefined {
  if (!raw) return undefined;
  const valid = new Set<VerifyKind>(VERIFY_KINDS);
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean) as VerifyKind[];
  const invalid = parts.filter((p) => !valid.has(p));
  if (invalid.length > 0) {
    console.log(errorMsg(`--only: unknown kind(s): ${invalid.join(", ")}. Valid: ${VERIFY_KINDS.join(", ")}`));
    process.exit(2);
  }
  return new Set(parts);
}

function printPlan(
  config: NonNullable<Awaited<ReturnType<typeof loadConfig>>>,
  scopes: Array<{ relative: string; absolute: string }>,
  onlyKinds: Set<VerifyKind> | undefined,
): void {
  console.log(dim("verify plan:"));
  for (const scope of scopes) {
    console.log(dim(`  scope ${scope.relative === "." ? "(root)" : scope.relative}`));
    for (const kind of VERIFY_KINDS) {
      if (onlyKinds && !onlyKinds.has(kind)) continue;
      const cmd = getVerifyCommand(config, kind, scope.relative);
      if (!cmd) continue;
      const str = typeof cmd === "string" ? cmd : cmd.command;
      console.log(`    ${kind.padEnd(9)} ${str}`);
    }
  }
}

async function promptYesNo(question: string): Promise<boolean> {
  process.stdout.write(question);
  return await new Promise<boolean>((resolveP) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf-8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      const ans = data.toString().trim().toLowerCase();
      resolveP(ans === "y" || ans === "yes");
    });
  });
}

function printHuman(report: VerifyRunReport): void {
  for (const scope of report.scopes) {
    const label = scope.scope === "." ? "(root)" : scope.scope;
    const head = scope.status === "ok"
      ? successMsg(`${label}`)
      : scope.status === "no_context"
        ? warnMsg(`${label} (no .context.yaml)`)
        : errorMsg(`${label} — ${scope.status}`);
    console.log(head);
    for (const run of scope.ran) {
      const tag = (run.exit_code ?? 0) === 0 && !run.timed_out ? "\u2713" : "\u2717";
      const dur = `${run.duration_ms}ms`;
      const extras = [
        run.parsed_to.test_status,
        run.parsed_to.typecheck,
        run.parsed_to.lint_status,
        run.parsed_to.coverage_percent !== undefined ? `${run.parsed_to.coverage_percent}%` : undefined,
      ].filter(Boolean).join(" · ");
      console.log(`    ${tag} ${run.kind.padEnd(9)} ${dim(dur)} ${extras}`);
      for (const w of run.parser_warnings) console.log(dim(`        ${w}`));
    }
    for (const s of scope.skipped.filter((x) => x.reason === "filtered_out")) {
      console.log(dim(`    - ${s.kind} (filtered)`));
    }
  }
  console.log("");
  console.log(dim(
    `totals: ${report.totals.passing} passing, ${report.totals.failing} failing, ` +
    `${report.totals.clean} clean, ${report.totals.errors} errors, ${report.totals.unknown} unknown`,
  ));
}

function computeExitCode(report: VerifyRunReport, strict: boolean, dryRun: boolean): number {
  if (dryRun) return 0;
  let partial = false;
  let failed = false;
  let hasUnknown = false;
  for (const scope of report.scopes) {
    if (scope.status === "failed" || scope.status === "partial") {
      if (scope.status === "failed") failed = true;
      else partial = true;
    }
    for (const run of scope.ran) {
      const ev = run.parsed_to;
      if (ev.test_status === "unknown" || ev.typecheck === "unknown" || ev.lint_status === "unknown") {
        hasUnknown = true;
      }
    }
  }
  if (failed || partial) return 1;
  if (strict && hasUnknown) return 1;
  return 0;
}
