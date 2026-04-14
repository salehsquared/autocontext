import { resolve, join } from "node:path";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parse } from "yaml";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { checkFreshness, legacyState } from "../core/fingerprint.js";
import { contextSchema, CONTEXT_FILENAME, type ContextFile } from "../core/schema.js";
import { loadConfig, resolveApiKey, getDefaultApiKeyEnv } from "../utils/config.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { filterByMinTokens } from "../utils/tokens.js";
import { successMsg, warnMsg, errorMsg } from "../utils/display.js";
import { readAgentsMd } from "../core/markdown-writer.js";
import { AGENTS_SECTION_START } from "../generator/markdown.js";
import { hasAutocontextEntry } from "../core/gitignore.js";
import { manifestPath } from "../index/paths.js";
import { INDEX_VERSION } from "../index/version.js";
import type { IndexManifest } from "../index/types.js";

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
      if (legacyState(state) === "stale") staleCount++;
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

  // 6. .gitignore check for .autocontext/
  const gitignorePath = join(rootPath, ".gitignore");
  if (existsSync(gitignorePath)) {
    const giContent = await readFile(gitignorePath, "utf8");
    if (hasAutocontextEntry(giContent)) {
      checks.push({
        name: "gitignore",
        status: "pass",
        message: ".autocontext/ is gitignored",
      });
    } else {
      checks.push({
        name: "gitignore",
        status: "warn",
        message: ".autocontext/ is not in .gitignore",
        fix: "context init",
      });
    }
  } else {
    checks.push({
      name: "gitignore",
      status: "warn",
      message: "No .gitignore found (repo may not be a git project)",
    });
  }

  // 7. Index check — manifest present & at current INDEX_VERSION
  const mPath = manifestPath(rootPath);
  if (existsSync(mPath)) {
    try {
      const raw = await readFile(mPath, "utf8");
      const manifest = JSON.parse(raw) as IndexManifest;
      if (manifest.index_version === INDEX_VERSION) {
        checks.push({
          name: "index",
          status: "pass",
          message: `.autocontext/index/ at version ${manifest.index_version} (${manifest.file_count} files)`,
        });
      } else {
        checks.push({
          name: "index",
          status: "warn",
          message: `index version ${manifest.index_version} differs from tool version ${INDEX_VERSION}`,
          fix: "context index --rebuild",
        });
      }
    } catch {
      checks.push({
        name: "index",
        status: "warn",
        message: "index manifest is unreadable",
        fix: "context index --rebuild",
      });
    }
  } else {
    checks.push({
      name: "index",
      status: "warn",
      message: "No code index found",
      fix: "context index",
    });
  }

  // 8. AGENTS.md check
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

  // verify: security advisory — warn when configured but first-run marker is absent
  if (config?.verify) {
    const markerExists = existsSync(join(rootPath, ".autocontext/verify.first-run"));
    if (!markerExists) {
      checks.push({
        name: "verify_config",
        status: "warn",
        message: "verify: is configured but has never been run on this checkout",
        fix: "Review commands in .context.config.yaml, then run `context verify --dry-run`",
      });
    } else {
      checks.push({
        name: "verify_config",
        status: "pass",
        message: "verify: is configured and has been acknowledged",
      });
    }
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
