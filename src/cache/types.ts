/** Incremented whenever the on-disk envelope shape changes. */
export const CACHE_VERSION = 1;

export interface CacheKeyInputs {
  cache_version: number;
  schema_version: number;
  prompt_template_ver: number;
  provider: string;
  model: string;
  mode: "lean" | "full";
  system_prompt_sha: string;
  user_prompt_sha: string;
  input_fingerprint: string;
  scope: string;
}

export interface CacheEnvelope {
  /** 64-char sha256 hex. */
  key: string;
  /** ISO 8601 time the entry was first written. */
  created_at: string;
  /** Non-secret subset of CacheKeyInputs, kept for debugging `context cache stats`. */
  meta: {
    cache_version: number;
    schema_version: number;
    prompt_template_ver: number;
    provider: string;
    model: string;
    mode: "lean" | "full";
    scope: string;
    input_fingerprint: string;
  };
  /** Raw provider response (the yaml string before markdown stripping). */
  response: string;
}

export interface CacheStats {
  enabled: boolean;
  version: number;
  path: string;
  entry_count: number;
  total_bytes: number;
}
