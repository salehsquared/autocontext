import { createHash } from "node:crypto";
import type { CacheKeyInputs } from "./types.js";

/** Canonicalize by sorting keys, then sha256-hex the result. */
export function computeCacheKey(inputs: CacheKeyInputs): string {
  const keys = Object.keys(inputs).sort();
  const pairs = keys.map((k) => [k, inputs[k as keyof CacheKeyInputs]] as const);
  const canonical = JSON.stringify(Object.fromEntries(pairs));
  return createHash("sha256").update(canonical).digest("hex");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}
