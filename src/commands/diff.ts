import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  GitError,
  isGitRepo,
  lsTreeFiles,
  revParse,
  showFileAtRev,
} from "../core/git.js";
import { dim, errorMsg, heading, successMsg } from "../utils/display.js";

export interface DiffCommandOptions {
  path?: string;
  scope?: string;
  json?: boolean;
}

interface ScopeDiff {
  scope: string;
  present_in_a: boolean;
  present_in_b: boolean;
  changes: Array<{
    field: string;
    before?: unknown;
    after?: unknown;
    kind: "added" | "removed" | "modified";
  }>;
}

const FIELDS_OF_INTEREST = [
  "summary",
  "decisions",
  "constraints",
  "exports",
  "dependencies",
  "imports",
  "internals",
  "environment",
  "testing",
  "data_models",
  "events",
  "config",
  "rules",
  "semantic_fingerprint",
] as const;

/**
 * `context diff <revA>..<revB>` — compare the `.context.yaml` corpus between
 * two git revisions. We only report meaningful fields (see FIELDS_OF_INTEREST);
 * volatile fields like `last_updated` / `fingerprint` are ignored.
 */
export async function diffCommand(
  range: string | undefined,
  options: DiffCommandOptions = {},
): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  if (!isGitRepo(rootPath)) {
    console.error(errorMsg("Not a git repository."));
    process.exitCode = 1;
    return;
  }
  if (!range || !range.includes("..")) {
    console.error(errorMsg('Usage: context diff <revA>..<revB>'));
    process.exitCode = 1;
    return;
  }
  const [revARaw, revBRaw] = range.split("..", 2);
  let revA: string;
  let revB: string;
  try {
    revA = revParse(rootPath, revARaw);
    revB = revParse(rootPath, revBRaw);
  } catch (err) {
    if (err instanceof GitError) {
      console.error(errorMsg(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const filter = options.scope
    ? (() => {
        const exact = `${options.scope!.replace(/\/+$/, "")}/.context.yaml`;
        return (p: string) => p === exact;
      })()
    : (p: string) => p.endsWith(".context.yaml");
  const pathsA = new Set(lsTreeFiles(rootPath, revA, filter));
  const pathsB = new Set(lsTreeFiles(rootPath, revB, filter));
  const every = new Set([...pathsA, ...pathsB]);

  const diffs: ScopeDiff[] = [];
  for (const path of [...every].sort()) {
    const beforeRaw = pathsA.has(path) ? showFileAtRev(rootPath, revA, path) : null;
    const afterRaw = pathsB.has(path) ? showFileAtRev(rootPath, revB, path) : null;
    const scope = path.replace(/\/\.context\.yaml$/, "") || ".";
    const before = safeParse(beforeRaw);
    const after = safeParse(afterRaw);
    const changes = computeChanges(before, after);
    if (changes.length === 0 && !!beforeRaw === !!afterRaw) continue;
    diffs.push({
      scope,
      present_in_a: beforeRaw !== null,
      present_in_b: afterRaw !== null,
      changes,
    });
  }

  if (options.json) {
    process.stdout.write(JSON.stringify({ revA, revB, diffs }, null, 2) + "\n");
    return;
  }

  console.log(heading(`\ncontext diff ${revA.slice(0, 10)}..${revB.slice(0, 10)}\n`));
  if (diffs.length === 0) {
    console.log(successMsg("No meaningful context changes between these revisions."));
    return;
  }
  for (const d of diffs) {
    console.log(dim(`\n  ${d.scope}`));
    if (!d.present_in_a) console.log(`    ${successMsg("added")}`);
    if (!d.present_in_b) console.log(`    ${errorMsg("removed")}`);
    for (const c of d.changes) {
      console.log(`    ${kindMarker(c.kind)} ${c.field}`);
    }
  }
  console.log("");
}

function safeParse(raw: string | null): Record<string, unknown> | null {
  if (raw === null) return null;
  try {
    const parsed = parseYaml(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function computeChanges(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): ScopeDiff["changes"] {
  const out: ScopeDiff["changes"] = [];
  for (const field of FIELDS_OF_INTEREST) {
    const a = before?.[field];
    const b = after?.[field];
    if (a === undefined && b === undefined) continue;
    if (a === undefined) {
      out.push({ field, after: b, kind: "added" });
      continue;
    }
    if (b === undefined) {
      out.push({ field, before: a, kind: "removed" });
      continue;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push({ field, before: a, after: b, kind: "modified" });
    }
  }
  return out;
}

function kindMarker(k: ScopeDiff["changes"][number]["kind"]): string {
  if (k === "added") return "+";
  if (k === "removed") return "-";
  return "~";
}
