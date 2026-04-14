import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { AUTOCONTEXT_DIR } from "../index/paths.js";
import { CACHE_VERSION, type CacheEnvelope, type CacheStats } from "./types.js";

const LLM_DIR = "llm-cache";

export function cacheRoot(projectRoot: string): string {
  return join(projectRoot, AUTOCONTEXT_DIR, LLM_DIR);
}

function shardPath(projectRoot: string, key: string): string {
  return join(cacheRoot(projectRoot), key.slice(0, 2), `${key}.json`);
}

function versionFile(projectRoot: string): string {
  return join(cacheRoot(projectRoot), "CACHE_VERSION");
}

/** Ensure the cache directory exists and matches the current CACHE_VERSION.
 *  A mismatch wipes the cache wholesale — preferable to keeping stale
 *  envelopes. Idempotent. */
async function ensureCacheRoot(projectRoot: string): Promise<void> {
  const root = cacheRoot(projectRoot);
  await mkdir(root, { recursive: true });
  const vPath = versionFile(projectRoot);
  try {
    const raw = await readFile(vPath, "utf8");
    if (Number.parseInt(raw.trim(), 10) === CACHE_VERSION) return;
  } catch {
    // not present or unreadable — fall through to wipe-and-write.
  }
  // Wipe contents (but keep the root so concurrent writers don't trip).
  try {
    const entries = await readdir(root);
    await Promise.all(
      entries
        .filter((n) => n !== "CACHE_VERSION")
        .map((n) => rm(join(root, n), { recursive: true, force: true })),
    );
  } catch {
    /* fresh — nothing to wipe */
  }
  await writeFile(vPath, `${CACHE_VERSION}\n`);
}

/**
 * Look up a cached provider response by key. Returns `null` on any miss
 * (unreadable / malformed / missing).
 */
export async function cacheGet(
  projectRoot: string,
  key: string,
): Promise<CacheEnvelope | null> {
  await ensureCacheRoot(projectRoot);
  const path = shardPath(projectRoot, key);
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    const env = JSON.parse(raw) as CacheEnvelope;
    if (env.key !== key) return null;
    if (env.meta.cache_version !== CACHE_VERSION) return null;
    return env;
  } catch {
    return null;
  }
}

export async function cachePut(
  projectRoot: string,
  envelope: CacheEnvelope,
): Promise<void> {
  await ensureCacheRoot(projectRoot);
  const dest = shardPath(projectRoot, envelope.key);
  await mkdir(join(dest, ".."), { recursive: true });
  const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(envelope, null, 2));
  const { rename } = await import("node:fs/promises");
  await rename(tmp, dest);
}

export async function cacheClear(projectRoot: string): Promise<number> {
  const root = cacheRoot(projectRoot);
  if (!existsSync(root)) return 0;
  const entries = await readdir(root);
  let removed = 0;
  for (const name of entries) {
    if (name === "CACHE_VERSION") continue;
    const full = join(root, name);
    try {
      const s = await stat(full);
      if (s.isDirectory()) {
        const children = await readdir(full);
        removed += children.filter((c) => c.endsWith(".json")).length;
      }
    } catch {
      /* ignore */
    }
    await rm(full, { recursive: true, force: true });
  }
  await mkdir(root, { recursive: true });
  await writeFile(versionFile(projectRoot), `${CACHE_VERSION}\n`);
  return removed;
}

export async function cacheStats(projectRoot: string): Promise<CacheStats> {
  const root = cacheRoot(projectRoot);
  const result: CacheStats = {
    enabled: isCacheEnabled(),
    version: CACHE_VERSION,
    path: root,
    entry_count: 0,
    total_bytes: 0,
  };
  if (!existsSync(root)) return result;
  const shards = await readdir(root, { withFileTypes: true });
  for (const shard of shards) {
    if (!shard.isDirectory()) continue;
    const full = join(root, shard.name);
    const files = await readdir(full);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      result.entry_count++;
      try {
        const s = await stat(join(full, f));
        result.total_bytes += s.size;
      } catch {
        /* ignore */
      }
    }
  }
  return result;
}

/** True unless `AUTOCONTEXT_CACHE` is explicitly `0` / `false` / `off`. */
export function isCacheEnabled(): boolean {
  const v = process.env.AUTOCONTEXT_CACHE;
  if (v === undefined) return true;
  const lowered = v.toLowerCase();
  if (lowered === "0" || lowered === "false" || lowered === "off") return false;
  return true;
}
