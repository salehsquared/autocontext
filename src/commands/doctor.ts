import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { checkFreshness } from "../core/fingerprint.js";
import { contextSchema, CONTEXT_FILENAME, type ContextFile } from "../core/schema.js";
import { loadConfig, resolveApiKey, getDefaultApiKeyEnv } from "../utils/config.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { filterByMinTokens } from "../utils/tokens.js";
import { successMsg, warnMsg, errorMsg } from "../utils/display.js";
import { readAgentsMd } from "../core/markdown-writer.js";
import { AGENTS_SECTION_START } from "../generator/markdown.js";

interface CheckResult {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  fix?: string;
}

/** Read and parse a .context.yaml, distinguishing missing from invalid. */
async function readRawContext(dirPath: string): Promise<{ ctx: ContextFile } | { error: "missing" } | { error: "invalid" }> {
  try {
    const content = await readFile(join(dirPath, CONTEXT_FILENAME), "utf-8");
    const parsed = parse(content);
    const result = contextSchema.safeParse(parsed);
    if (result.success) return { ctx: result.data };
    return { error: "invalid" };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { error: "missing" };
    return { error: "invalid" };
  }
}

export async function doctorCommand(options: { path?: string; json?: boolean }): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  const checks: CheckResult[] = [];

  // 1. Config check
  const config = await loadConfig(rootPath);
  if (config) {
    checks.push({
      name: "config",
      status: "pass",
      message: `${config.provider} provider configured`,
    });
  } else {
    checks.push({
      name: "config",
      status: "warn",
      message: "No config file found",
      fix: "context config --provider anthropic",
    });
  }

  // 2. API key check (only if config exists)
  if (config) {
    if (config.provider === "ollama") {
      checks.push({
        name: "api_key",
        status: "pass",
        message: "Ollama (local) — no API key needed",
      });
    } else {
      const envVar = config.api_key_env ?? getDefaultApiKeyEnv(config.provider);
      const keyValue = resolveApiKey(config);
      if (keyValue) {
        checks.push({
          name: "api_key",
          status: "pass",
          message: `${envVar} is set`,
        });
      } else {
        checks.push({
          name: "api_key",
          status: "fail",
          message: `${envVar} not set`,
          fix: `export ${envVar}=your-key-here`,
        });
      }
    }
  }

  // Read all context files once (raw), distinguishing missing/invalid/valid
  const scanOptions = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOptions);
  const allDirs = flattenBottomUp(scanResult);
  const { dirs } = await filterByMinTokens(allDirs, config?.min_tokens);

  const dirResults = await Promise.all(dirs.map(async (dir) => ({
    dir,
    result: await readRawContext(dir.path),
  })));

  // 3. Coverage check
  let tracked = 0;
  for (const { result } of dirResults) {
    if ("ctx" in result) tracked++;
  }

  if (tracked === dirs.length) {
    checks.push({
      name: "coverage",
      status: "pass",
      message: `${tracked}/${dirs.length} directories tracked`,
    });
  } else {
    checks.push({
      name: "coverage",
      status: "warn",
      message: `${tracked}/${dirs.length} directories tracked (${dirs.length - tracked} missing)`,
      fix: "context init",
    });
  }

  // 4. Staleness check
  let staleCount = 0;
  for (const { dir, result } of dirResults) {
    if ("ctx" in result) {
      const { state } = await checkFreshness(dir.path, result.ctx.fingerprint);
      if (state === "stale") staleCount++;
    }
  }

  if (staleCount === 0) {
    checks.push({
      name: "staleness",
      status: "pass",
      message: "All tracked contexts are fresh",
    });
  } else {
    checks.push({
      name: "staleness",
      status: "warn",
      message: `${staleCount} director${staleCount > 1 ? "ies" : "y"} stale`,
      fix: "context regen --stale",
    });
  }

  // 5. Validation check — counts files that exist on disk but fail schema
  let validationErrors = 0;
  for (const { result } of dirResults) {
    if ("error" in result && result.error === "invalid") validationErrors++;
  }

  if (validationErrors === 0) {
    checks.push({
      name: "validation",
      status: "pass",
      message: "All files pass schema validation",
    });
  } else {
    checks.push({
      name: "validation",
      status: "warn",
      message: `${validationErrors} file${validationErrors > 1 ? "s have" : " has"} schema errors`,
      fix: "context validate",
    });
  }

  // 6. AGENTS.md check
  const agentsMd = await readAgentsMd(rootPath);
  if (agentsMd !== null) {
    if (agentsMd.includes(AGENTS_SECTION_START)) {
      checks.push({
        name: "agents_md",
        status: "pass",
        message: "AGENTS.md present with autocontext section",
      });
    } else {
      checks.push({
        name: "agents_md",
        status: "warn",
        message: "AGENTS.md exists but missing autocontext section",
        fix: "context regen --all",
      });
    }
  } else {
    checks.push({
      name: "agents_md",
      status: "warn",
      message: "No AGENTS.md found",
      fix: "context init",
    });
  }

  // Compute summary
  const summary = { pass: 0, warn: 0, fail: 0 };
  for (const check of checks) {
    summary[check.status]++;
  }

  // Set exit code on failure
  if (summary.fail > 0) {
    process.exitCode = 1;
  }

  // Output
  if (options.json) {
    // Sort checks by name for deterministic output
    checks.sort((a, b) => a.name.localeCompare(b.name));
    process.stdout.write(JSON.stringify({ checks, summary }, null, 2) + "\n");
    return;
  }

  // Human-readable output
  console.log("\ncontext doctor\n");

  for (const check of checks) {
    if (check.status === "pass") {
      console.log(successMsg(`${check.name}: ${check.message}`));
    } else if (check.status === "warn") {
      console.log(warnMsg(`${check.name}: ${check.message}`));
      if (check.fix) console.log(`    → ${check.fix}`);
    } else {
      console.log(errorMsg(`${check.name}: ${check.message}`));
      if (check.fix) console.log(`    → ${check.fix}`);
    }
  }

  console.log(`\n  ${summary.pass} passed, ${summary.warn} warning${summary.warn !== 1 ? "s" : ""}, ${summary.fail} error${summary.fail !== 1 ? "s" : ""}\n`);
}
