import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { parse } from "yaml";
import { scanProject, flattenBottomUp, type ScanResult } from "../core/scanner.js";
import { contextSchema, CONTEXT_FILENAME, type ContextFile } from "../core/schema.js";
import { successMsg, errorMsg, warnMsg, dim } from "../utils/display.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { loadConfig } from "../utils/config.js";
import { filterByMinTokens } from "../utils/tokens.js";
import { detectExportsWithFallback } from "../generator/static.js";
import { detectInternalDeps } from "../generator/dependencies.js";

interface StrictFinding {
  severity: "warning" | "info";
  message: string;
}

async function crossReference(dir: ScanResult, context: ContextFile): Promise<StrictFinding[]> {
  const findings: StrictFinding[] = [];

  // 1. Files vs filesystem (only when files are declared)
  if (context.files && context.files.length > 0) {
    const declaredFiles = new Set(context.files.map((f) => f.name));
    const actualFiles = new Set(dir.files);

    for (const name of declaredFiles) {
      if (!actualFiles.has(name)) {
        findings.push({ severity: "warning", message: `phantom file: ${name} (listed but not on disk)` });
      }
    }
    for (const name of actualFiles) {
      if (!declaredFiles.has(name)) {
        findings.push({ severity: "info", message: `unlisted file: ${name} (on disk but not in context)` });
      }
    }
  } else {
    findings.push({ severity: "info", message: "file cross-reference skipped (lean context — no files field)" });
  }

  // 2. Interfaces vs exports
  if (context.interfaces && context.interfaces.length > 0) {
    const actualExports = new Set<string>();
    for (const filename of dir.files) {
      const ext = extname(filename).toLowerCase();
      if (![".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs"].includes(ext)) continue;
      try {
        const content = await readFile(join(dir.path, filename), "utf-8");
        const exports = await detectExportsWithFallback(content, ext);
        for (const exp of exports) actualExports.add(exp);
      } catch { /* skip unreadable files */ }
    }

    for (const iface of context.interfaces) {
      // Extract identifier: pure name or function signature "verifyToken(...)".
      // Skip names like "POST /login" where identifier is followed by space+path.
      const identMatch = iface.name.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\s*\(|$)/);
      if (!identMatch) continue; // Skip non-identifier names (endpoints, CLI commands, etc.)
      const identName = identMatch[1];
      if (!actualExports.has(identName)) {
        findings.push({ severity: "warning", message: `phantom interface: ${iface.name} (declared but not found in code)` });
      }
    }
  }

  // 3. Dependencies vs imports
  if (context.dependencies?.internal && context.dependencies.internal.length > 0) {
    const detected = await detectInternalDeps(dir);
    const declaredSet = new Set(context.dependencies.internal);
    const detectedSet = new Set(detected);

    for (const dep of declaredSet) {
      if (!detectedSet.has(dep)) {
        findings.push({ severity: "info", message: `declared internal dep not found in imports: ${dep}` });
      }
    }
    for (const dep of detectedSet) {
      if (!declaredSet.has(dep)) {
        findings.push({ severity: "info", message: `undeclared internal dep found in imports: ${dep}` });
      }
    }
  }

  // 4. Import bindings vs dependencies.internal
  // Skip entries whose only symbol is (side-effect) — detectInternalDeps intentionally
  // does not capture side-effect imports (import "./path"), so these would always mismatch.
  if (context.imports && context.imports.length > 0 && context.dependencies?.internal) {
    const internalDepSet = new Set(context.dependencies.internal);
    for (const imp of context.imports) {
      const isSideEffectOnly = imp.symbols.length === 1 && imp.symbols[0] === "(side-effect)";
      if (isSideEffectOnly) continue;
      if (!internalDepSet.has(imp.path)) {
        findings.push({ severity: "info", message: `import binding path not in dependencies.internal: ${imp.path}` });
      }
    }
  }

  return findings;
}

export async function validateCommand(options: {
  path?: string;
  strict?: boolean;
  policy?: boolean;
  json?: boolean;
}): Promise<void> {
  const rootPath = resolve(options.path ?? ".");

  const config = await loadConfig(rootPath);
  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const allDirs = flattenBottomUp(scanResult);
  const { dirs } = await filterByMinTokens(allDirs, config?.min_tokens);

  const jsonMode = options.json === true;
  const schemaFindings: Array<{ scope: string; severity: string; message: string }> = [];
  let valid = 0;
  let invalid = 0;
  let missing = 0;
  let strictWarnings = 0;
  let strictInfo = 0;
  let leanSkipped = 0;

  for (const dir of dirs) {
    const filePath = join(dir.path, CONTEXT_FILENAME);
    const label = dir.relativePath === "." ? "(root)" : dir.relativePath;

    try {
      const content = await readFile(filePath, "utf-8");
      const parsed = parse(content);
      const result = contextSchema.safeParse(parsed);

      if (result.success) {
        if (dir.relativePath === "." && (!result.data.project || !result.data.structure)) {
          if (!jsonMode) console.log(warnMsg(`${label}: root .context.yaml should include 'project' and 'structure' fields`));
          schemaFindings.push({ scope: dir.relativePath, severity: "warning", message: "root .context.yaml should include 'project' and 'structure' fields" });
        }
        if (!jsonMode) console.log(successMsg(`${label}`));
        valid++;

        if (options.strict) {
          const findings = await crossReference(dir, result.data);
          for (const finding of findings) {
            if (finding.message.includes("lean context")) {
              leanSkipped++;
              continue;
            }
            if (finding.severity === "warning") {
              if (!jsonMode) console.log(warnMsg(`  strict: ${finding.message}`));
              strictWarnings++;
            } else {
              if (!jsonMode) console.log(dim(`    strict: ${finding.message}`));
              strictInfo++;
            }
            schemaFindings.push({ scope: dir.relativePath, severity: finding.severity, message: finding.message });
          }
        }
      } else {
        if (!jsonMode) console.log(errorMsg(`${label}`));
        for (const issue of result.error.issues) {
          const msg = `${issue.path.join(".")}: ${issue.message}`;
          if (!jsonMode) console.log(`       ${msg}`);
          schemaFindings.push({ scope: dir.relativePath, severity: "error", message: msg });
        }
        invalid++;
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        missing++;
      } else {
        const msg = err instanceof Error ? err.message : "parse error";
        if (!jsonMode) console.log(errorMsg(`${label}: ${msg}`));
        schemaFindings.push({ scope: dir.relativePath, severity: "error", message: msg });
        invalid++;
      }
    }
  }

  if (!jsonMode) console.log(`\n${valid} valid, ${invalid} invalid, ${missing} missing.`);

  if (!jsonMode && options.strict && (strictWarnings > 0 || strictInfo > 0 || leanSkipped > 0)) {
    const parts: string[] = [];
    if (strictWarnings > 0 || strictInfo > 0) {
      parts.push(`${strictWarnings} warning${strictWarnings !== 1 ? "s" : ""}, ${strictInfo} info`);
    }
    if (leanSkipped > 0) {
      parts.push(`${leanSkipped} lean context${leanSkipped !== 1 ? "s" : ""} (file cross-ref skipped)`);
    }
    console.log(dim(`strict: ${parts.join("; ")} across ${dirs.length} director${dirs.length !== 1 ? "ies" : "y"}`));
  }

  if (!jsonMode) console.log("");

  let policyExit = 0;
  let policyPayload: unknown = null;
  if (options.policy) {
    const { runPolicies } = await import("../policy/engine.js");
    const run = await runPolicies({ projectRoot: rootPath });
    if (run.index_state !== "ready") {
      if (jsonMode) {
        process.stdout.write(JSON.stringify({
          summary: { rules_evaluated: 0, rules_passed: 0, violations: 0, scopes: run.contexts_scanned, schema_invalid: invalid, schema_missing: missing },
          error: run.index_state === "stale" ? "index_stale" : "index_missing",
          message: "policy: index is missing or stale — run `context index` first.",
          violations: [],
          schema_findings: options.strict ? schemaFindings : [],
        }, null, 2) + "\n");
      } else {
        console.log(errorMsg("policy: index is missing or stale — run `context index` first."));
      }
      process.exit(2);
    }
    policyPayload = run;
    if (run.rules_evaluated === 0) {
      if (!jsonMode) console.log("policy: no rules defined in any .context.yaml — nothing to evaluate.");
    } else if (!jsonMode) {
      printPolicyHuman(run, options.strict === true);
    }
    if (run.violations.length > 0) policyExit = 1;
  }

  if (jsonMode) {
    const policyRun = policyPayload as Awaited<ReturnType<typeof import("../policy/engine.js").runPolicies>> | null;
    process.stdout.write(JSON.stringify({
      summary: {
        rules_evaluated: policyRun?.rules_evaluated ?? 0,
        rules_passed: policyRun?.rules_passed ?? 0,
        violations: policyRun?.violations.length ?? 0,
        scopes: policyRun?.contexts_scanned ?? 0,
        schema_invalid: invalid,
        schema_missing: missing,
        truncated: policyRun?.truncated ?? false,
      },
      violations: policyRun?.violations ?? [],
      schema_findings: options.strict ? schemaFindings : [],
    }, null, 2) + "\n");
  }

  if (invalid > 0 || policyExit === 1) {
    process.exit(1);
  }
}

function printPolicyHuman(run: Awaited<ReturnType<typeof import("../policy/engine.js").runPolicies>>, verbose: boolean): void {
  console.log("policy:");
  const byScope = new Map<string, typeof run.violations>();
  for (const v of run.violations) {
    const list = byScope.get(v.scope) ?? [];
    list.push(v);
    byScope.set(v.scope, list);
  }
  const scopesSorted = [...byScope.keys()].sort();
  for (const scope of scopesSorted) {
    const label = scope === "." ? "(root)" : scope;
    console.log(`  ${label}`);
    for (const v of byScope.get(scope)!) {
      console.log(`    ${errorMsg("\u2717")} ${v.message}`);
    }
  }
  const suffix = verbose
    ? ` (${run.rules_evaluated} rule${run.rules_evaluated === 1 ? "" : "s"} evaluated, ${run.rules_passed} passed)`
    : "";
  const scopeCount = byScope.size;
  console.log(`\npolicy: ${run.violations.length} violation${run.violations.length === 1 ? "" : "s"} across ${scopeCount} scope${scopeCount === 1 ? "" : "s"}${suffix}.`);
  if (run.truncated) console.log(warnMsg("policy: output truncated at 500 violations"));
  console.log("");
}
