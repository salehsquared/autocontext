import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify, parse } from "yaml";
import { contextSchema, configSchema, CONTEXT_FILENAME, CONFIG_FILENAME, SCHEMA_VERSION } from "./schema.js";
import type { ContextFile, ConfigFile } from "./schema.js";

/**
 * Thrown when a .context.yaml has a version higher than this CLI supports.
 * Propagates through readContext() — never swallowed into null.
 */
export class UnsupportedVersionError extends Error {
  constructor(public found: number, public supported: number) {
    super(`Unsupported schema version ${found} (this CLI supports version ${supported}). Update autocontext or downgrade the file.`);
    this.name = "UnsupportedVersionError";
  }
}

/**
 * Write a ContextFile to disk as .context.yaml
 */
export async function writeContext(dirPath: string, data: ContextFile): Promise<void> {
  // Validate before writing
  contextSchema.parse(data);

  const yamlContent = stringify(data, {
    lineWidth: 120,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });

  await writeFile(join(dirPath, CONTEXT_FILENAME), yamlContent, "utf-8");
}

/**
 * Read and parse a .context.yaml from disk
 */
export async function readContext(dirPath: string): Promise<ContextFile | null> {
  try {
    const content = await readFile(join(dirPath, CONTEXT_FILENAME), "utf-8");
    const parsed = parse(content);
    if (parsed && typeof parsed.version === "number" && parsed.version > SCHEMA_VERSION) {
      throw new UnsupportedVersionError(parsed.version, SCHEMA_VERSION);
    }
    return contextSchema.parse(parsed);
  } catch (err) {
    if (err instanceof UnsupportedVersionError) throw err;
    return null;
  }
}

/**
 * Write config file to disk
 */
export async function writeConfig(rootPath: string, data: ConfigFile): Promise<void> {
  configSchema.parse(data);

  const yamlContent = stringify(data, {
    lineWidth: 120,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });

  await writeFile(join(rootPath, CONFIG_FILENAME), yamlContent, "utf-8");
}

/**
 * Read config file from disk
 */
export async function readConfig(rootPath: string): Promise<ConfigFile | null> {
  try {
    const content = await readFile(join(rootPath, CONFIG_FILENAME), "utf-8");
    const parsed = parse(content);
    return configSchema.parse(parsed);
  } catch {
    return null;
  }
}
