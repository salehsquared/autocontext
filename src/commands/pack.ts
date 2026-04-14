import { resolve } from "node:path";
import { writeFile } from "node:fs/promises";
import { buildPack } from "../pack/pack.js";
import { formatPackJson, formatPackMarkdown } from "../pack/format.js";
import { errorMsg } from "../utils/display.js";

export interface PackCommandOptions {
  path?: string;
  query?: string;
  file?: string;
  symbol?: string;
  budget?: number;
  format?: "md" | "json";
  out?: string;
}

export async function packCommand(options: PackCommandOptions = {}): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  const pack = await buildPack({
    projectRoot: rootPath,
    query: options.query,
    file: options.file,
    symbol: options.symbol,
    budget: options.budget,
  });
  const format =
    options.format ?? (options.out ? "md" : process.stdout.isTTY ? "md" : "json");
  const rendered = format === "json" ? formatPackJson(pack) : formatPackMarkdown(pack);

  if (options.out) {
    try {
      await writeFile(options.out, rendered);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(errorMsg(`failed to write ${options.out}: ${msg}`));
      process.exitCode = 1;
      return;
    }
    return;
  }
  process.stdout.write(rendered + "\n");
}
