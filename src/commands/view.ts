import { resolve, isAbsolute, join, dirname } from "node:path";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { collectViewData } from "../view/collect.js";
import { renderHtml } from "../view/render.js";
import { successMsg, warnMsg, errorMsg, dim } from "../utils/display.js";

const DEFAULT_OUT = "context-report.html";
const HARD_CAP_BYTES = 2 * 1024 * 1024;

export interface ViewCommandOptions {
  path?: string;
  out?: string;
  open?: boolean;
  noGraph?: boolean;
  noSource?: boolean;
}

export async function viewCommand(options: ViewCommandOptions): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  try {
    const rootStat = await stat(rootPath);
    if (!rootStat.isDirectory()) {
      console.log(errorMsg(`path is not a directory: ${rootPath}`));
      process.exit(1);
    }
  } catch {
    console.log(errorMsg(`path not found: ${rootPath}`));
    process.exit(1);
  }

  const outRel = options.out ?? DEFAULT_OUT;
  const outPath = isAbsolute(outRel) ? outRel : resolve(rootPath, outRel);
  const outDir = dirname(outPath);
  try {
    if (!existsSync(outDir)) {
      // Allow creating exactly one missing level (e.g. .autocontext/).
      const parent = dirname(outDir);
      if (!existsSync(parent)) {
        console.log(errorMsg(`out directory parent does not exist: ${outDir}`));
        process.exit(2);
      }
      await mkdir(outDir, { recursive: false });
    }
  } catch (err) {
    console.log(errorMsg(`failed to prepare out directory: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(2);
  }

  const autocontextVersion = await readOwnVersion();
  const data = await collectViewData({
    projectRoot: rootPath,
    autocontextVersion,
    generatedAt: process.env.FROZEN_TIME ?? undefined,
  });
  const html = renderHtml(data, {
    includeGraph: !options.noGraph,
    includeSource: !options.noSource,
  });
  if (html.length > HARD_CAP_BYTES) {
    console.log(errorMsg(
      `generated report is ${Math.round(html.length / 1024)} KB (> ${HARD_CAP_BYTES / 1024} KB cap). ` +
      `Pass --no-source or --no-graph to shrink it.`,
    ));
    process.exit(2);
  }
  try {
    await writeFile(outPath, html, "utf-8");
  } catch (err) {
    console.log(errorMsg(`failed to write ${outPath}: ${err instanceof Error ? err.message : String(err)}`));
    process.exit(2);
  }

  const sizeKb = Math.round(html.length / 1024);
  console.log(successMsg(`wrote ${outPath} (${sizeKb} KB · ${data.scopes.length} scope${data.scopes.length === 1 ? "" : "s"})`));
  if (!data.has_index) console.log(dim("  graph disabled (no .autocontext/index/)."));
  if (!data.has_policy) console.log(dim("  policy chips neutral (no .autocontext/policy-results.json)."));

  if (options.open) {
    if (process.env.CI) {
      console.log(dim(`  --open suppressed by CI env. Open ${outPath} manually.`));
    } else {
      await openInBrowser(outPath);
    }
  }

  process.exit(0);
}

async function readOwnVersion(): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    // Resolve our package.json — navigate up from dist/commands/view.js to the package root.
    const { fileURLToPath } = await import("node:url");
    const thisDir = dirname(fileURLToPath(import.meta.url));
    for (const candidate of [
      join(thisDir, "../../package.json"),
      join(thisDir, "../package.json"),
      join(thisDir, "package.json"),
    ]) {
      if (existsSync(candidate)) {
        const pkg = JSON.parse(await readFile(candidate, "utf-8"));
        if (typeof pkg.version === "string") return pkg.version;
      }
    }
  } catch {
    // fall through
  }
  return "unknown";
}

async function openInBrowser(path: string): Promise<void> {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    const child = spawn(cmd, [path], { stdio: "ignore", detached: true });
    child.unref();
  } catch (err) {
    console.log(warnMsg(`could not open file automatically: ${err instanceof Error ? err.message : String(err)}`));
  }
}
