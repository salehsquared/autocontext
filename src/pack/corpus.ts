import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ContextFile } from "../core/schema.js";
import { CONTEXT_FILENAME, contextSchema } from "../core/schema.js";
import { scanProject, flattenBottomUp } from "../core/scanner.js";
import { loadScanOptions } from "../utils/scan-options.js";
import { tokenize, type Zone } from "./tokenize.js";

export interface ScopeDoc {
  scope: string;
  /** Absolute path to the directory containing the .context.yaml. */
  dirPath: string;
  context: ContextFile;
  zones: Record<Zone, string[]>;
}

export async function loadCorpus(projectRoot: string): Promise<ScopeDoc[]> {
  const scanOptions = await loadScanOptions(projectRoot);
  const scan = await scanProject(projectRoot, scanOptions);
  const dirs = flattenBottomUp(scan);

  const out: ScopeDoc[] = [];
  for (const d of dirs) {
    const yamlPath = join(d.path, CONTEXT_FILENAME);
    let raw: string;
    try {
      raw = await readFile(yamlPath, "utf8");
    } catch {
      continue;
    }
    let parsed;
    try {
      parsed = parseYaml(raw);
    } catch {
      continue;
    }
    const result = contextSchema.safeParse(parsed);
    if (!result.success) continue;
    const ctx = result.data;
    out.push({
      scope: ctx.scope,
      dirPath: d.path,
      context: ctx,
      zones: buildZones(ctx),
    });
  }
  return out.sort((a, b) => a.scope.localeCompare(b.scope));
}

function buildZones(ctx: ContextFile): Record<Zone, string[]> {
  const summaryText = [ctx.summary, ctx.project?.description].filter(Boolean).join(" ");
  const decisionsText = (ctx.decisions ?? [])
    .map((d) => [d.what, d.why, d.tradeoff ?? ""].join(" "))
    .join(" ");
  const constraintsText = [
    ...(ctx.constraints ?? []),
    ...((ctx.interfaces ?? []).map((i) => i.description)),
  ].join(" ");
  const symbolsText = [
    ...(ctx.exports ?? []),
    ...((ctx.internals ?? []).map((i) => i.name)),
    ...((ctx.interfaces ?? []).map((i) => i.name)),
    ...(ctx.data_models ?? []),
    ...(ctx.events ?? []),
    ...((ctx.files ?? []).map((f) => f.name)),
    ...((ctx.subdirectories ?? []).map((s) => s.name)),
  ].join(" ");
  const facetsText = [
    ...(ctx.environment ?? []),
    ...(ctx.testing ?? []),
    ...(ctx.config ?? []),
    ...(ctx.todos ?? []),
  ].join(" ");
  const stateText = [
    ...(ctx.current_state?.working ?? []),
    ...(ctx.current_state?.broken ?? []),
    ...(ctx.current_state?.in_progress ?? []),
  ].join(" ");
  const pathText = ctx.scope.replace(/[\/.]/g, " ");

  return {
    summary: tokenize(summaryText, "summary"),
    decisions: tokenize(decisionsText, "decisions"),
    constraints: tokenize(constraintsText, "constraints"),
    symbols: tokenize(symbolsText, "symbols"),
    facets: tokenize(facetsText, "facets"),
    state: tokenize(stateText, "state"),
    path: tokenize(pathText, "path"),
  };
}
