import { resolve } from "node:path";
import {
  cacheClear,
  cacheStats,
  isCacheEnabled,
} from "../cache/cache-store.js";
import { dim, heading, successMsg } from "../utils/display.js";

export interface CacheCommandOptions {
  path?: string;
  json?: boolean;
}

export async function cacheStatsCommand(options: CacheCommandOptions = {}): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  const stats = await cacheStats(rootPath);
  if (options.json) {
    process.stdout.write(JSON.stringify(stats, null, 2) + "\n");
    return;
  }
  console.log(heading("\nautocontext LLM cache\n"));
  console.log(`  enabled:     ${stats.enabled ? "yes" : "no (AUTOCONTEXT_CACHE=0)"}`);
  console.log(`  version:     ${stats.version}`);
  console.log(`  path:        ${stats.path}`);
  console.log(`  entries:     ${stats.entry_count}`);
  console.log(
    `  disk usage:  ${dim(formatBytes(stats.total_bytes))}`,
  );
  console.log("");
}

export async function cacheClearCommand(options: CacheCommandOptions = {}): Promise<void> {
  const rootPath = resolve(options.path ?? ".");
  const removed = await cacheClear(rootPath);
  console.log(
    successMsg(
      `Cleared LLM cache (${removed} entr${removed === 1 ? "y" : "ies"} removed)`,
    ),
  );
}

export function cacheRuntimeStatus(): { enabled: boolean } {
  return { enabled: isCacheEnabled() };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
