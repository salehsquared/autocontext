import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { computeImpact, type ImpactReport, type ImpactSeed } from "../impact/impact.js";
import { manifestPath, toFileId } from "../index/paths.js";
import { openReadOnlyIndex } from "../index/access.js";
import { dim, errorMsg, heading, successMsg, warnMsg } from "../utils/display.js";

export interface ImpactCommandOptions {
  path?: string;
  /** JSON output instead of markdown. Defaults to JSON on non-TTY stdout. */
  json?: boolean;
  maxDepth?: number;
  max?: number;
}

/**
 * `context impact <target>` — who depends on this?
 *
 * Target is either a file path (`src/core/math.ts`) or a file-and-symbol
 * (`src/core/math.ts#add`). v1 does not implement `--diff`; that comes with
 * T8's git utilities. See src/impact/README.md for the precision boundary.
 */
export async function impactCommand(
  target: string | undefined,
  options: ImpactCommandOptions = {},
): Promise<void> {
  const rootPath = resolve(options.path ?? ".");

  if (!target) {
    console.error(errorMsg("Usage: context impact <path>[#symbol]"));
    process.exitCode = 1;
    return;
  }

  if (!existsSync(manifestPath(rootPath))) {
    console.error(
      errorMsg(
        "No code index found. Run `context index` first (or `context init`).",
      ),
    );
    process.exitCode = 3;
    return;
  }

  const parsed = parseTarget(rootPath, target);
  if (!parsed) {
    console.error(
      errorMsg(
        `Target not found: ${target}. Must be a file under ${rootPath} (optionally "path#symbol").`,
      ),
    );
    process.exitCode = 4;
    return;
  }

  const access = await openReadOnlyIndex(rootPath);
  if (access.state !== "ready") {
    const msg = access.state === "stale"
      ? "Code index is stale. Run `context index --rebuild` (or `context index` if only sources changed)."
      : "No code index found. Run `context index` first (or `context init`).";
    console.error(errorMsg(msg));
    process.exitCode = 3;
    return;
  }
  const store = access.store;
  let report: ImpactReport;
  try {
    const seed: ImpactSeed = parsed;
    report = await computeImpact(store, [seed], {
      maxDepth: options.maxDepth,
      maxResults: options.max,
    });
  } finally {
    await store.close();
  }

  if (report.seeds.length === 0) {
    console.error(errorMsg("Empty seed set after resolution."));
    process.exitCode = 2;
    return;
  }

  const emitJson = options.json ?? !process.stdout.isTTY;
  if (emitJson) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  printMarkdown(report);
}

function parseTarget(rootPath: string, target: string): ImpactSeed | null {
  const [fileRaw, symbol] = target.split("#", 2);
  if (!fileRaw) return null;
  const abs = isAbsolute(fileRaw) ? fileRaw : resolve(rootPath, fileRaw);
  if (!existsSync(abs)) return null;
  const rel = relative(rootPath, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return {
    file: toFileId(rel),
    symbol: symbol && symbol.length > 0 ? symbol : undefined,
    reason: symbol ? "symbol" : "file",
  };
}

function printMarkdown(report: ImpactReport): void {
  console.log(heading("\ncontext impact\n"));
  for (const seed of report.seeds) {
    console.log(
      `  seed: ${seed.file}${seed.symbol ? `#${seed.symbol}` : ""} (${seed.reason})`,
    );
  }
  console.log("");

  if (report.affected.length === 0) {
    console.log(successMsg("No dependent files found within the reference graph."));
  } else {
    console.log(
      heading(
        `Affected directories (${report.affected_scopes.length}):\n`,
      ),
    );
    for (const s of report.affected_scopes) {
      console.log(
        `  ${s.scope}  ${dim(`(${s.file_count} file${s.file_count === 1 ? "" : "s"}, min ${s.min_hops} hop${s.min_hops === 1 ? "" : "s"})`)}`,
      );
    }
    console.log("");
    console.log(heading(`Affected files (${report.affected.length}):`));
    for (const a of report.affected) {
      console.log(`  ${a.file}  ${dim(`(${a.hops} hop${a.hops === 1 ? "" : "s"})`)}`);
    }
    console.log("");
  }

  if (report.stopped.some((s) => s !== "natural")) {
    console.log(
      warnMsg(
        `Walk stopped early: ${report.stopped.filter((s) => s !== "natural").join(", ")}`,
      ),
    );
  }

  console.log(dim(`\n  ${report.caveat}\n`));
}
