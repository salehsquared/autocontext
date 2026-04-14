import { readConfig, writeConfig } from "../core/writer.js";
import type { ConfigFile, VerifyCommand, VerifyKind } from "../core/schema.js";

/**
 * Load project config, returning null if none exists.
 */
export async function loadConfig(rootPath: string): Promise<ConfigFile | null> {
  return readConfig(rootPath);
}

/**
 * Save project config.
 */
export async function saveConfig(rootPath: string, config: ConfigFile): Promise<void> {
  await writeConfig(rootPath, config);
}

/**
 * Resolve the API key from environment variables.
 */
export function resolveApiKey(config: ConfigFile): string | undefined {
  const envVar = config.api_key_env ?? getDefaultApiKeyEnv(config.provider);
  return process.env[envVar];
}

export function getDefaultApiKeyEnv(provider: string): string {
  switch (provider) {
    case "anthropic": return "ANTHROPIC_API_KEY";
    case "openai": return "OPENAI_API_KEY";
    case "google": return "GOOGLE_API_KEY";
    case "ollama": return "OLLAMA_HOST";
    default: return "";
  }
}

/**
 * Resolve the verify command for a given kind in a given scope.
 *
 * Precedence (most-specific wins):
 *   1. scope_overrides[A][kind] for every ancestor A of `scope` (deepest first)
 *   2. verify[kind] (root)
 *
 * Returns undefined when the kind isn't configured at any level.
 */
export function getVerifyCommand(
  config: ConfigFile | null,
  kind: VerifyKind,
  scope: string,
): VerifyCommand | undefined {
  if (!config?.verify) return undefined;
  const overrides = config.verify.scope_overrides ?? {};

  // Ancestors deepest-first: "src/cli/sub" → ["src/cli/sub", "src/cli", "src"]
  const ancestors: string[] = [];
  if (scope !== "." && scope !== "") {
    const parts = scope.split("/");
    for (let i = parts.length; i > 0; i--) {
      ancestors.push(parts.slice(0, i).join("/"));
    }
  }
  for (const a of ancestors) {
    const override = overrides[a]?.[kind];
    if (override !== undefined) return override;
  }
  return config.verify[kind];
}
