import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parse } from "yaml";
import { scanProject, flattenBottomUp, type ScanResult } from "../core/scanner.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { loadConfig } from "../utils/config.js";
import { filterByMinTokens } from "../utils/tokens.js";
import { contextSchema, CONTEXT_FILENAME, type ContextFile } from "../core/schema.js";
import type { IndexStore } from "../index/store.js";
import { openReadOnlyIndex } from "../index/access.js";
import { evaluators } from "./evaluators/index.js";
import type { Rule, RuleKind } from "./rules.js";
import type { EvalContext, Violation } from "./types.js";
import { normalizeScope } from "./scope.js";

const MAX_VIOLATIONS = 500;

export type IndexState = "ready" | "missing" | "stale";

export interface PolicyRunResult {
  ok: boolean;
  scope: string;
  rules_evaluated: number;
  rules_passed: number;
  violations: Violation[];
  index_state: IndexState;
  truncated: boolean;
  contexts_scanned: number;
}

export interface RunPoliciesOptions {
  projectRoot: string;
  /** Limit to a subtree (project-relative POSIX path). Default: entire project. */
  scope?: string;
  /** Only evaluate rules of these kinds. Default: all kinds. */
  ruleKinds?: RuleKind[];
  /** Caps violations array. Default 500. */
  maxViolations?: number;
}

export async function runPolicies(
  options: RunPoliciesOptions,
): Promise<PolicyRunResult> {
  const projectRoot = options.projectRoot;
  const resolvedScope = options.scope ? normalizeScope(options.scope) : ".";
  const ruleKindFilter = options.ruleKinds ? new Set(options.ruleKinds) : null;
  const cap = options.maxViolations ?? MAX_VIOLATIONS;

  // Load contexts (every valid .context.yaml in the scanned tree).
  const { contexts, sourceFiles } = await loadContextsAndFiles(projectRoot);

  // Filter to the requested scope subtree.
  const inScope = (dir: string): boolean =>
    resolvedScope === "." ||
    dir === resolvedScope ||
    dir.startsWith(`${resolvedScope}/`);

  const scopedContexts = new Map<string, ContextFile>();
  for (const [dir, ctx] of contexts) {
    if (inScope(dir)) scopedContexts.set(dir, ctx);
  }

  const access = await openReadOnlyIndex(projectRoot);
  if (access.state !== "ready") {
    return {
      ok: false,
      scope: resolvedScope,
      rules_evaluated: 0,
      rules_passed: 0,
      violations: [],
      index_state: access.state,
      truncated: false,
      contexts_scanned: scopedContexts.size,
    };
  }
  const store: IndexStore = access.store;
  const indexState: IndexState = "ready";

  try {
    const lineCache = new Map<string, number>();
    const fileLineCount = async (file: string): Promise<number> => {
      const cached = lineCache.get(file);
      if (cached !== undefined) return cached;
      const content = await readFile(join(projectRoot, file), "utf-8");
      const lines = content.length === 0 ? 0 : content.split("\n").length;
      lineCache.set(file, lines);
      return lines;
    };

    const evalCtx: EvalContext = {
      projectRoot,
      index: store,
      contexts: scopedContexts,
      sourceFiles,
      fileLineCount,
    };

    // Run evaluators in rule-declaration order, per context, in scope-sorted order.
    const scopesSorted = [...scopedContexts.keys()].sort();
    const allViolations: Violation[] = [];
    let rulesEvaluated = 0;
    let rulesPassed = 0;

    for (const scope of scopesSorted) {
      const ctx = scopedContexts.get(scope)!;
      if (!ctx.rules || ctx.rules.length === 0) continue;
      for (let i = 0; i < ctx.rules.length; i++) {
        const rule = ctx.rules[i] as Rule;
        if (ruleKindFilter && !ruleKindFilter.has(rule.kind)) continue;
        rulesEvaluated++;
        const produced = await evaluators[rule.kind]({
          rule,
          ruleScope: scope,
          ruleIndex: i,
          ctx: evalCtx,
        });
        if (produced.length === 0) {
          rulesPassed++;
          continue;
        }
        allViolations.push(...produced);
      }
    }

    const truncated = allViolations.length > cap;
    const violations = truncated ? allViolations.slice(0, cap) : allViolations;

    return {
      ok: violations.length === 0 && !truncated,
      scope: resolvedScope,
      rules_evaluated: rulesEvaluated,
      rules_passed: rulesPassed,
      violations,
      index_state: indexState,
      truncated,
      contexts_scanned: scopedContexts.size,
    };
  } finally {
    await store.close();
  }
}

async function loadContextsAndFiles(
  projectRoot: string,
): Promise<{ contexts: Map<string, ContextFile>; sourceFiles: string[] }> {
  const config = await loadConfig(projectRoot);
  const scanOptions = await loadScanOptions(projectRoot);
  const scanResult = await scanProject(projectRoot, scanOptions);
  const allDirs = flattenBottomUp(scanResult);
  const { dirs } = await filterByMinTokens(allDirs, config?.min_tokens);

  const contexts = new Map<string, ContextFile>();
  for (const dir of dirs) {
    const filePath = join(dir.path, CONTEXT_FILENAME);
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed = parse(content);
      const result = contextSchema.safeParse(parsed);
      if (result.success) {
        contexts.set(dir.relativePath, result.data);
      }
    } catch {
      // Missing/invalid contexts are skipped; strict validation is the caller's concern.
    }
  }

  const sourceFiles = collectAllFiles(scanResult, projectRoot);
  return { contexts, sourceFiles };
}

function collectAllFiles(root: ScanResult, projectRoot: string): string[] {
  const out: string[] = [];
  const visit = (node: ScanResult) => {
    for (const file of node.files) {
      const abs = join(node.path, file);
      const rel = relative(projectRoot, abs).split(sep).join("/");
      out.push(rel);
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  out.sort();
  return out;
}
