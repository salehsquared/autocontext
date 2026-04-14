import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTmpDir, cleanupTmpDir } from "../helpers.js";
import {
  cacheClear,
  cacheGet,
  cachePut,
  cacheStats,
  cacheRoot,
  isCacheEnabled,
} from "../../src/cache/cache-store.js";
import { computeCacheKey, sha256Hex } from "../../src/cache/key.js";
import { CACHE_VERSION, type CacheEnvelope } from "../../src/cache/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

function makeEnvelope(key: string, response: string): CacheEnvelope {
  return {
    key,
    created_at: "2026-04-13T00:00:00.000Z",
    meta: {
      cache_version: CACHE_VERSION,
      schema_version: 1,
      prompt_template_ver: 1,
      provider: "anthropic",
      model: "claude-3-5-haiku-latest",
      mode: "lean",
      scope: "src/core",
      input_fingerprint: "abc12345",
    },
    response,
  };
}

describe("computeCacheKey", () => {
  it("is deterministic over key ordering", () => {
    const a = computeCacheKey({
      cache_version: 1,
      schema_version: 1,
      prompt_template_ver: 1,
      provider: "openai",
      model: "gpt-4o-mini",
      mode: "lean",
      system_prompt_sha: "a".repeat(64),
      user_prompt_sha: "b".repeat(64),
      input_fingerprint: "abc12345",
      scope: "src",
    });
    const b = computeCacheKey({
      scope: "src",
      input_fingerprint: "abc12345",
      user_prompt_sha: "b".repeat(64),
      system_prompt_sha: "a".repeat(64),
      mode: "lean",
      model: "gpt-4o-mini",
      provider: "openai",
      prompt_template_ver: 1,
      schema_version: 1,
      cache_version: 1,
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when any input differs", () => {
    const base = {
      cache_version: 1,
      schema_version: 1,
      prompt_template_ver: 1,
      provider: "anthropic" as const,
      model: "claude-3-5-haiku-latest",
      mode: "lean" as const,
      system_prompt_sha: sha256Hex("sys"),
      user_prompt_sha: sha256Hex("user"),
      input_fingerprint: "aaaa1111",
      scope: "src",
    };
    const aKey = computeCacheKey(base);
    const bKey = computeCacheKey({ ...base, model: "claude-3-5-sonnet-latest" });
    expect(aKey).not.toBe(bKey);
  });
});

describe("cacheGet / cachePut", () => {
  it("round-trips an envelope", async () => {
    const key = "a".repeat(64);
    const env = makeEnvelope(key, "summary: hi");
    await cachePut(tmpDir, env);
    const hit = await cacheGet(tmpDir, key);
    expect(hit).not.toBeNull();
    expect(hit?.response).toBe("summary: hi");
    expect(hit?.meta.provider).toBe("anthropic");
  });

  it("returns null for a missing key", async () => {
    const hit = await cacheGet(tmpDir, "f".repeat(64));
    expect(hit).toBeNull();
  });

  it("returns null when the stored envelope's CACHE_VERSION is stale", async () => {
    const key = "b".repeat(64);
    const env = makeEnvelope(key, "x");
    await cachePut(tmpDir, env);
    // Corrupt the stored envelope to simulate a version drift.
    const { writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const path = join(cacheRoot(tmpDir), key.slice(0, 2), `${key}.json`);
    const stored = JSON.parse(
      await (await import("node:fs/promises")).readFile(path, "utf8"),
    );
    stored.meta.cache_version = 0;
    await writeFile(path, JSON.stringify(stored));
    expect(await cacheGet(tmpDir, key)).toBeNull();
  });
});

describe("cacheStats / cacheClear", () => {
  it("counts entries and clears the cache", async () => {
    await cachePut(tmpDir, makeEnvelope("1".repeat(64), "a"));
    await cachePut(tmpDir, makeEnvelope("2".repeat(64), "b"));
    let stats = await cacheStats(tmpDir);
    expect(stats.entry_count).toBe(2);
    expect(stats.total_bytes).toBeGreaterThan(0);

    const removed = await cacheClear(tmpDir);
    expect(removed).toBe(2);
    stats = await cacheStats(tmpDir);
    expect(stats.entry_count).toBe(0);
  });
});

describe("isCacheEnabled", () => {
  const orig = process.env.AUTOCONTEXT_CACHE;
  afterEach(() => {
    process.env.AUTOCONTEXT_CACHE = orig;
  });
  it("defaults to enabled", () => {
    delete process.env.AUTOCONTEXT_CACHE;
    expect(isCacheEnabled()).toBe(true);
  });
  it("honors 0 / false / off as disabled", () => {
    process.env.AUTOCONTEXT_CACHE = "0";
    expect(isCacheEnabled()).toBe(false);
    process.env.AUTOCONTEXT_CACHE = "false";
    expect(isCacheEnabled()).toBe(false);
    process.env.AUTOCONTEXT_CACHE = "off";
    expect(isCacheEnabled()).toBe(false);
  });
  it("treats any other value as enabled", () => {
    process.env.AUTOCONTEXT_CACHE = "1";
    expect(isCacheEnabled()).toBe(true);
  });
});
