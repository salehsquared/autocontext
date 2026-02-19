#!/usr/bin/env node

/**
 * Generate JSON Schema files from Zod schemas.
 * Uses Zod 4's native toJSONSchema() — no extra dependencies needed.
 * Runs after tsc, imports from compiled dist/.
 */

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toJSONSchema } from "zod";
import { contextSchema, configSchema } from "../dist/core/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

const contextJsonSchema = toJSONSchema(contextSchema, { target: "draft-2020-12" });
contextJsonSchema.$id = "https://autocontext.dev/schema/v1/context.json";
contextJsonSchema.title = ".context.yaml";
contextJsonSchema.description = "Schema for autocontext directory-level context files (v1)";

const configJsonSchema = toJSONSchema(configSchema, { target: "draft-2020-12" });
configJsonSchema.$id = "https://autocontext.dev/schema/v1/config.json";
configJsonSchema.title = ".context.config.yaml";
configJsonSchema.description = "Schema for autocontext project configuration files (v1)";

writeFileSync(
  resolve(root, ".context.schema.json"),
  JSON.stringify(contextJsonSchema, null, 2) + "\n",
);

writeFileSync(
  resolve(root, ".context.config.schema.json"),
  JSON.stringify(configJsonSchema, null, 2) + "\n",
);

console.log("Generated .context.schema.json and .context.config.schema.json");
