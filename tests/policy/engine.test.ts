import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanupTmpDir, createTmpDir, createNestedFile, makeValidContext } from "../helpers.js";
import { writeContext, writeConfig } from "../../src/core/writer.js";
import { runPolicies } from "../../src/policy/engine.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("runPolicies", () => {
  it("reports stale when the index manifest exists but requires rebuild", async () => {
    await writeConfig(tmpDir, { provider: "openai", min_tokens: 0 });
    await createNestedFile(tmpDir, "src/index.ts", "export const x = 1;\n");
    await writeContext(tmpDir, makeValidContext({ scope: ".", summary: "root" }));
    await mkdir(join(tmpDir, ".autocontext/index"), { recursive: true });
    await writeFile(
      join(tmpDir, ".autocontext/index/manifest.json"),
      JSON.stringify({ index_version: 999, project_root: tmpDir, grammar_hashes: {} }),
      "utf-8",
    );

    const result = await runPolicies({ projectRoot: tmpDir });

    expect(result.ok).toBe(false);
    expect(result.index_state).toBe("stale");
  });
});
