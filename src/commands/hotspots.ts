import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { isGitRepo, logForPath, showFileAtRev } from "../core/git.js";
import { dim, errorMsg, heading } from "../utils/display.js";

export interface HotspotsCommandOptions {
  path?: string;
  max?: number;
  json?: boolean;
  /** When true, fall back to raw commit count even if semantic_fingerprint
   *  data is available. Helps compare against pre-T2 repos. */
  rawCount?: boolean;
}

interface HotspotRow {
  scope: string;
  commit_count: number;
  /** Only populated when using the semantic-fingerprint metric. */
  semantic_changes?: number;
  last_touched_sha: string;
  last_touched_at: number;
}

/**
 * `context hotspots` — rank tracked scopes by churn of their `.context.yaml`.
 * Preferred metric (when available): number of commits where
 * `semantic_fingerprint` actually changed. Fallback: raw commit count.
 */
export async function hotspotsCommand(options: HotspotsCommandOptions = {}): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  if (!isGitRepo(rootPath)) {
    console.error(errorMsg("Not a git repository."));
    process.exitCode = 1;
    return;
  }

  const { lsTreeFiles } = await import("../core/git.js");
  const currentYamls = lsTreeFiles(rootPath, "HEAD", (p: string) =>
    p.endsWith(".context.yaml"),
  );

  const rows: HotspotRow[] = [];
  for (const yamlPath of currentYamls) {
    const commits = logForPath(rootPath, yamlPath, { follow: true, max: 1000 });
    if (commits.length === 0) continue;
    const scope = yamlPath.replace(/\/\.context\.yaml$/, "") || ".";
    const row: HotspotRow = {
      scope,
      commit_count: commits.length,
      last_touched_sha: commits[0].sha,
      last_touched_at: commits[0].timestamp,
    };
    if (!options.rawCount) {
      row.semantic_changes = countSemanticChanges(rootPath, yamlPath, commits);
    }
    rows.push(row);
  }

  rows.sort((a, b) => {
    const aMetric = a.semantic_changes ?? a.commit_count;
    const bMetric = b.semantic_changes ?? b.commit_count;
    if (bMetric !== aMetric) return bMetric - aMetric;
    return a.scope.localeCompare(b.scope);
  });
  const capped = rows.slice(0, options.max ?? 20);

  if (options.json) {
    process.stdout.write(JSON.stringify({ hotspots: capped }, null, 2) + "\n");
    return;
  }

  console.log(heading(`\nchurn hotspots\n`));
  if (capped.length === 0) {
    console.log(dim("  No .context.yaml files in git history."));
    return;
  }
  for (const r of capped) {
    const date = new Date(r.last_touched_at * 1000).toISOString().slice(0, 10);
    const metricLabel = r.semantic_changes !== undefined
      ? `sem:${r.semantic_changes} / total:${r.commit_count}`
      : `commits:${r.commit_count}`;
    console.log(
      `  ${r.scope}  ${dim(metricLabel)}  ${dim(`last ${date} (${r.last_touched_sha.slice(0, 10)})`)}`,
    );
  }
  console.log("");
}

function countSemanticChanges(
  repoPath: string,
  yamlPath: string,
  commits: Array<{ sha: string }>,
): number {
  let lastFp: string | null = null;
  let changes = 0;
  // Walk oldest → newest to detect transitions.
  for (let i = commits.length - 1; i >= 0; i--) {
    const content = showFileAtRev(repoPath, commits[i].sha, yamlPath);
    if (content === null) continue;
    let fp: string | null = null;
    try {
      const parsed = parseYaml(content);
      if (parsed && typeof parsed === "object" && "semantic_fingerprint" in parsed) {
        const v = (parsed as Record<string, unknown>).semantic_fingerprint;
        if (typeof v === "string") fp = v;
      }
    } catch {
      /* ignore parse errors */
    }
    if (lastFp !== null && fp !== null && fp !== lastFp) changes++;
    if (fp !== null) lastFp = fp;
  }
  return changes;
}
