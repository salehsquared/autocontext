import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { cp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { parse } from "yaml";
import { initCommand } from "../../src/commands/init.js";
import { contextSchema, CONTEXT_FILENAME } from "../../src/core/schema.js";
import { saveConfig } from "../../src/utils/config.js";
import { createTmpDir, cleanupTmpDir } from "../helpers.js";
import { AGENTS_FILENAME } from "../../src/core/markdown-writer.js";
import { AGENTS_SECTION_START, AGENTS_SECTION_END } from "../../src/generator/markdown.js";

let tmpDir: string;
let logs: string[];

beforeEach(async () => {
  tmpDir = await createTmpDir();
  // Disable token threshold for tests (tiny fixture files would be filtered out)
  await saveConfig(tmpDir, { provider: "anthropic", min_tokens: 0 });
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(tmpDir);
});

const fixturesDir = join(import.meta.dirname, "../fixtures");

async function copyFixture(name: string): Promise<void> {
  await cp(join(fixturesDir, name), tmpDir, { recursive: true });
  await stripContextFiles(tmpDir);
}

async function stripContextFiles(dirPath: string): Promise<void> {
  const entries = await readdir(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await stripContextFiles(fullPath);
      continue;
    }

    if (entry.isFile() && entry.name === CONTEXT_FILENAME) {
      await rm(fullPath, { force: true });
    }
  }
}

async function readContextYaml(dirPath: string) {
  const content = await readFile(join(dirPath, CONTEXT_FILENAME), "utf-8");
  return parse(content);
}

describe("initCommand (--no-llm)", () => {
  it("creates .context.yaml at root", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const parsed = await readContextYaml(tmpDir);
    const result = contextSchema.safeParse(parsed);
    expect(result.success).toBe(true);
  });

  it("creates .context.yaml in subdirectories", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const rootStat = await stat(join(tmpDir, CONTEXT_FILENAME));
    expect(rootStat.isFile()).toBe(true);

    const srcStat = await stat(join(tmpDir, "src", CONTEXT_FILENAME));
    expect(srcStat.isFile()).toBe(true);
  });

  it("generated context has valid fingerprint", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const parsed = await readContextYaml(tmpDir);
    expect(parsed.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("scope is set correctly per directory", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const rootContext = await readContextYaml(tmpDir);
    expect(rootContext.scope).toBe(".");

    const srcContext = await readContextYaml(join(tmpDir, "src"));
    expect(srcContext.scope).toBe("src");
  });

  it("lean mode omits files from generated context", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const srcContext = await readContextYaml(join(tmpDir, "src"));
    expect(srcContext.files).toBeUndefined();
    expect(srcContext.summary).toBeDefined();
  });

  it("full mode includes files list", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir, full: true });

    const srcContext = await readContextYaml(join(tmpDir, "src"));
    const fileNames = srcContext.files.map((f: { name: string }) => f.name);
    expect(fileNames).toContain("index.ts");
    expect(fileNames).toContain("utils.ts");
  });

  it("handles empty project gracefully", async () => {
    // Empty project still gets root in scan results (scanner always returns root).
    // Init should complete without error and create a context file.
    await copyFixture("empty-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("Done.");
  });

  it("reports completion count", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const output = logs.join("\n");
    expect(output).toMatch(/Done\. \d+ \.context\.yaml files created/);
  });
});

describe("initCommand respects scan-options from config", () => {
  it("ignore config excludes directories from scanning", async () => {
    await copyFixture("simple-project");
    await saveConfig(tmpDir, { provider: "anthropic", ignore: ["src"], min_tokens: 0 });

    await initCommand({ noLlm: true, path: tmpDir });

    // Root should have context
    const rootStat = await stat(join(tmpDir, CONTEXT_FILENAME));
    expect(rootStat.isFile()).toBe(true);

    // src/ should NOT have context because it's ignored
    await expect(stat(join(tmpDir, "src", CONTEXT_FILENAME))).rejects.toThrow();
  });

  it("max_depth config limits scanning depth", async () => {
    await copyFixture("monorepo");
    // max_depth: 1 means root (depth 0) + one level of children (depth 1).
    // monorepo's deeper dirs (packages/api/src, packages/shared/src) should be excluded.
    await saveConfig(tmpDir, { provider: "anthropic", max_depth: 1, min_tokens: 0 });

    await initCommand({ noLlm: true, path: tmpDir });

    // Deep directories should NOT get context files
    await expect(
      stat(join(tmpDir, "packages", "api", "src", CONTEXT_FILENAME)),
    ).rejects.toThrow();
    await expect(
      stat(join(tmpDir, "packages", "shared", "src", CONTEXT_FILENAME)),
    ).rejects.toThrow();
  });
});

describe("initCommand AGENTS.md generation", () => {
  it("creates AGENTS.md at project root by default", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const content = await readFile(join(tmpDir, AGENTS_FILENAME), "utf-8");
    expect(content).toContain(AGENTS_SECTION_START);
    expect(content).toContain(AGENTS_SECTION_END);
    expect(content).toContain(".context.yaml");
  });

  it("skips AGENTS.md with noAgents: true", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir, noAgents: true });

    await expect(stat(join(tmpDir, AGENTS_FILENAME))).rejects.toThrow();
  });

  it("appends to existing AGENTS.md without autocontext section", async () => {
    await copyFixture("simple-project");
    await writeFile(join(tmpDir, AGENTS_FILENAME), "# Custom Instructions\n\nDo things.\n", "utf-8");

    await initCommand({ noLlm: true, path: tmpDir });

    const content = await readFile(join(tmpDir, AGENTS_FILENAME), "utf-8");
    expect(content).toContain("# Custom Instructions");
    expect(content).toContain("Do things.");
    expect(content).toContain(AGENTS_SECTION_START);
  });

  it("is idempotent on re-run (no marker multiplication)", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });
    await initCommand({ noLlm: true, path: tmpDir });

    const content = await readFile(join(tmpDir, AGENTS_FILENAME), "utf-8");
    const startCount = content.split(AGENTS_SECTION_START).length - 1;
    const endCount = content.split(AGENTS_SECTION_END).length - 1;
    expect(startCount).toBe(1);
    expect(endCount).toBe(1);
  });

  it("preserves user content when updating", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    // Add user content around the markers
    const original = await readFile(join(tmpDir, AGENTS_FILENAME), "utf-8");
    const modified = "# My Header\n\nCustom notes.\n\n" + original + "\n## My Footer\n";
    await writeFile(join(tmpDir, AGENTS_FILENAME), modified, "utf-8");

    // Re-run init
    await initCommand({ noLlm: true, path: tmpDir });

    const result = await readFile(join(tmpDir, AGENTS_FILENAME), "utf-8");
    expect(result).toContain("# My Header");
    expect(result).toContain("Custom notes.");
    expect(result).toContain("## My Footer");
  });

  it("lists directory entries in AGENTS.md", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const content = await readFile(join(tmpDir, AGENTS_FILENAME), "utf-8");
    expect(content).toContain("`.` (root)");
    expect(content).toContain("`src`");
  });

  it("reports AGENTS.md creation in output", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("AGENTS.md created");
  });
});

describe("initCommand --parallel", () => {
  it("produces same contexts as sequential mode", async () => {
    await copyFixture("simple-project");
    await initCommand({ noLlm: true, path: tmpDir, noAgents: true });

    const seqRoot = parse(await readFile(join(tmpDir, CONTEXT_FILENAME), "utf-8")) as Record<string, unknown>;
    const seqSrc = parse(await readFile(join(tmpDir, "src", CONTEXT_FILENAME), "utf-8")) as Record<string, unknown>;

    // Strip context files and re-run with --parallel
    await stripContextFiles(tmpDir);
    await initCommand({ noLlm: true, path: tmpDir, noAgents: true, parallel: 4 });

    const parRoot = parse(await readFile(join(tmpDir, CONTEXT_FILENAME), "utf-8")) as Record<string, unknown>;
    const parSrc = parse(await readFile(join(tmpDir, "src", CONTEXT_FILENAME), "utf-8")) as Record<string, unknown>;

    expect(parRoot.scope).toBe(seqRoot.scope);
    expect(parRoot.summary).toBe(seqRoot.summary);
    expect(parSrc.scope).toBe(seqSrc.scope);
    expect(parSrc.summary).toBe(seqSrc.summary);
  });
});
