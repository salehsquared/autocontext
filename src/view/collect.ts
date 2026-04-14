import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { loadConfig } from "../utils/config.js";
import { filterByMinTokens } from "../utils/tokens.js";
import { readContext } from "../core/writer.js";
import { checkFreshness, legacyState } from "../core/fingerprint.js";
import { CONTEXT_FILENAME } from "../core/schema.js";
import { openReadOnlyIndex } from "../index/access.js";
import type { IndexStore } from "../index/store.js";
import type { ViewData, ViewFreshness, ViewScope, ViewViolation } from "./types.js";

const POLICY_RESULTS_PATH = ".autocontext/policy-results.json";

export interface CollectOptions {
  projectRoot: string;
  autocontextVersion: string;
  generatedAt?: string;
  /** Test seam — force graph availability on/off. */
  indexPresent?: boolean;
}

export async function collectViewData(opts: CollectOptions): Promise<ViewData> {
  const rootPath = opts.projectRoot;
  const config = await loadConfig(rootPath);
  const scanOpts = await loadScanOptions(rootPath);
  const scanResult = await scanProject(rootPath, scanOpts);
  const allDirs = flattenBottomUp(scanResult);
  const { dirs } = await filterByMinTokens(allDirs, config?.min_tokens);

  const forceIndexPresent = opts.indexPresent;
  let hasSemanticStaleness = false;
  let dirEdges: ViewData["dir_edges"] = [];

  // Load policy results if present.
  const policyResults = await loadPolicyResults(rootPath);
  const hasPolicy = policyResults !== null;
  const violationsByScope = new Map<string, ViewViolation[]>();
  if (policyResults) {
    for (const v of policyResults) {
      const key = v.file ?? v.scope ?? ".";
      const list = violationsByScope.get(key) ?? [];
      list.push({
        rule_kind: v.rule_kind,
        message: v.message,
        file: v.file,
        line: v.line,
      });
      violationsByScope.set(key, list);
    }
  }

  // Optionally open the index for semantic-staleness + dir edges.
  let indexStore: IndexStore | null = null;
  let hasUsableIndex = false;
  if (forceIndexPresent !== false) {
    const access = await openReadOnlyIndex(rootPath);
    if (access.state === "ready") {
      indexStore = access.store;
      hasUsableIndex = true;
      const edges = await indexStore.getDirEdges();
      dirEdges = edges
        .map((e) => ({ source: e.from_dir, target: e.to_dir, weight: e.weight }))
        .sort((a, b) => {
          if (a.source !== b.source) return a.source < b.source ? -1 : 1;
          return a.target < b.target ? -1 : a.target > b.target ? 1 : 0;
        });
      hasSemanticStaleness = true;
    }
  }

  try {
    const scopes: ViewScope[] = [];
    for (const dir of dirs) {
      const filePath = join(dir.path, CONTEXT_FILENAME);
      let rawYaml = "";
      try {
        rawYaml = await readFile(filePath, "utf-8");
      } catch {
        // fall through
      }
      let context;
      try {
        context = await readContext(dir.path);
      } catch {
        context = null;
      }

      let freshness: ViewFreshness = "missing";
      if (context) {
        try {
          const fresh = await checkFreshness(dir.path, context.fingerprint, [], indexStore ? {
            storedSemanticFingerprint: context.semantic_fingerprint,
            index: indexStore,
            projectRoot: rootPath,
          } : undefined);
          if (fresh.state === "fresh" || fresh.state === "missing") {
            freshness = fresh.state;
          } else if (fresh.state === "cosmetic_stale") {
            freshness = hasSemanticStaleness ? "cosmetic_stale" : "stale";
          } else if (fresh.state === "semantic_stale") {
            freshness = hasSemanticStaleness ? "semantic_stale" : "stale";
          } else {
            freshness = legacyState(fresh.state) as ViewFreshness;
          }
        } catch {
          freshness = "stale";
        }
      }

      const violations: ViewViolation[] = [];
      // File-level violations against files inside this scope get attributed here.
      const scopeKey = dir.relativePath;
      if (hasPolicy) {
        const list = violationsByScope.get(scopeKey);
        if (list) violations.push(...list);
        // Also sweep file-keyed violations whose file lives under this scope.
        for (const [key, vs] of violationsByScope.entries()) {
          if (key === scopeKey) continue;
          if (key === "." || key === "/") continue;
          if (scopeKey === ".") {
            if (!key.includes("/")) violations.push(...vs);
          } else if (key === scopeKey || key.startsWith(`${scopeKey}/`)) {
            violations.push(...vs);
          }
        }
      }

      scopes.push({
        scope: scopeKey,
        summary: context?.summary ?? "",
        freshness,
        decisions: (context?.decisions ?? []).map((d) => ({
          what: d.what,
          why: d.why,
          tradeoff: d.tradeoff,
        })),
        constraints: context?.constraints ?? [],
        subdirectories: (context?.subdirectories ?? []).map((s) => ({
          name: s.name,
          summary: s.summary,
          freshness: "missing" as ViewFreshness, // filled below by scope lookup
        })),
        exports: exportsFromContext(context),
        evidence: context?.evidence,
        violations,
        raw_yaml: rawYaml,
        file_count: dir.files.length,
        last_updated: context?.last_updated,
      });
    }

    // Second pass: annotate subdirectory freshness by cross-referencing the
    // scope list (each subdirectory name maps to scopeKey = parent + name).
    const byScope = new Map(scopes.map((s) => [s.scope, s]));
    for (const s of scopes) {
      for (const sub of s.subdirectories) {
        const childKey = s.scope === "." ? stripTrailingSlash(sub.name) : `${s.scope}/${stripTrailingSlash(sub.name)}`;
        const match = byScope.get(childKey);
        if (match) sub.freshness = match.freshness;
      }
    }

    const totals = {
      fresh: 0,
      stale: 0,
      semantic_stale: 0,
      cosmetic_stale: 0,
      missing: 0,
      violations: 0,
    };
    for (const s of scopes) {
      if (s.freshness === "fresh") totals.fresh++;
      else if (s.freshness === "semantic_stale") totals.semantic_stale++;
      else if (s.freshness === "cosmetic_stale") totals.cosmetic_stale++;
      else if (s.freshness === "missing") totals.missing++;
      else totals.stale++;
      totals.violations += s.violations.length;
    }

    const projectName = config?.provider
      ? await readProjectNameFromRoot(rootPath)
      : await readProjectNameFromRoot(rootPath);

    return {
      project: {
        name: projectName,
        root: rootPath,
        generated_at: opts.generatedAt ?? new Date().toISOString(),
        autocontext_version: opts.autocontextVersion,
      },
      scopes: scopes.sort((a, b) => a.scope.localeCompare(b.scope)),
      dir_edges: dirEdges,
      has_index: hasUsableIndex,
      has_policy: hasPolicy,
      has_semantic_staleness: hasSemanticStaleness,
      totals,
    };
  } finally {
    if (indexStore) await indexStore.close();
  }
}

function exportsFromContext(
  context: Awaited<ReturnType<typeof readContext>>,
): ViewScope["exports"] {
  if (!context) return [];
  const list: ViewScope["exports"] = [];
  if (context.exports) {
    for (const exp of context.exports) {
      list.push({ name: exp });
    }
  }
  if (context.interfaces) {
    for (const iface of context.interfaces) {
      list.push({ name: iface.name, signature: iface.description });
    }
  }
  return list;
}

interface StoredPolicyViolation {
  rule_kind: string;
  scope: string;
  message: string;
  file?: string;
  line?: number;
}

async function loadPolicyResults(rootPath: string): Promise<StoredPolicyViolation[] | null> {
  const path = join(rootPath, POLICY_RESULTS_PATH);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.violations)) return parsed.violations;
    return null;
  } catch {
    return null;
  }
}

async function readProjectNameFromRoot(rootPath: string): Promise<string> {
  try {
    const raw = await readFile(join(rootPath, "package.json"), "utf-8");
    const pkg = JSON.parse(raw);
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name;
  } catch {
    // fall through
  }
  try {
    const rawYaml = await readFile(join(rootPath, CONTEXT_FILENAME), "utf-8");
    const doc = parseYaml(rawYaml) as Record<string, unknown> | null;
    if (doc && typeof doc.project === "object" && doc.project) {
      const name = (doc.project as Record<string, unknown>).name;
      if (typeof name === "string" && name.trim()) return name;
    }
  } catch {
    // fall through
  }
  return rootPath.split("/").pop() ?? "project";
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}
