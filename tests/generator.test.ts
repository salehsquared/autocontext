import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateStaticContext, buildSmartSummary, extractOneSignature, type SummarySource } from "../src/generator/static.js";
import { generateLLMContext } from "../src/generator/llm.js";
import { contextSchema, SCHEMA_VERSION, DEFAULT_MAINTENANCE, FULL_MAINTENANCE } from "../src/core/schema.js";
import type { ContextFile } from "../src/core/schema.js";
import type { LLMProvider } from "../src/providers/index.js";
import {
  createTmpDir,
  cleanupTmpDir,
  createFile,
  makeScanResult,
  makeValidContext,
} from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

// --- Static generator tests ---

describe("generateStaticContext", () => {
  it("generates valid ContextFile for directory with .ts files", async () => {
    await createFile(tmpDir, "index.ts", 'export const x = 1;');
    await createFile(tmpDir, "utils.ts", 'export function help() {}');

    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["index.ts", "utils.ts"] });
    const { context: result } = await generateStaticContext(scan, new Map());

    expect(contextSchema.safeParse(result).success).toBe(true);
  });

  it("populates required fields correctly (lean)", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["index.ts"] });
    const { context: result } = await generateStaticContext(scan, new Map());

    expect(result.version).toBe(SCHEMA_VERSION);
    expect(result.last_updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(result.scope).toBe("src");
    expect(result.maintenance).toBe(DEFAULT_MAINTENANCE);
    expect(result.files).toBeUndefined();
  });

  it("populates required fields correctly (full)", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["index.ts"] });
    const { context: result } = await generateStaticContext(scan, new Map(), { mode: "full" });

    expect(result.version).toBe(SCHEMA_VERSION);
    expect(result.maintenance).toBe(FULL_MAINTENANCE);
    expect(result.files).toBeDefined();
    expect(result.files).toHaveLength(1);
  });

  it("preserves user-authored decisions / constraints / rules from existing context", async () => {
    await createFile(tmpDir, "index.ts", "export const x = 1;");
    const scan = makeScanResult(tmpDir, { relativePath: ".", files: ["index.ts"] });
    const existing = {
      version: SCHEMA_VERSION,
      last_updated: "2026-04-14T00:00:00Z",
      fingerprint: "aabbccdd",
      scope: ".",
      summary: "preserved",
      maintenance: "Keep updated",
      decisions: [{ what: "Pinned choice", why: "Preserve across regen" }],
      constraints: ["Hand-written constraint survives static regen."],
      rules: [
        {
          kind: "max_file_lines" as const,
          value: 500,
        },
      ],
    };
    const childContexts = new Map([[tmpDir, existing]]);
    const { context: result } = await generateStaticContext(scan, childContexts);

    expect(result.decisions).toEqual(existing.decisions);
    expect(result.constraints).toEqual(existing.constraints);
    expect(result.rules).toEqual(existing.rules);
  });

  it("lean mode omits files, interfaces, dependencies.external", async () => {
    const exports = Array.from({ length: 5 }, (_, i) => `export function fn${i}() {}`).join("\n");
    await createFile(tmpDir, "mod.ts", exports);

    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["mod.ts"] });
    const { context: result } = await generateStaticContext(scan, new Map());

    expect(result.files).toBeUndefined();
    expect(result.interfaces).toBeUndefined();
    expect(contextSchema.safeParse(result).success).toBe(true);
  });

  it("lean mode still includes subdirectories and internal deps", async () => {
    await createFile(tmpDir, "index.ts", 'import { helper } from "./utils.js";\nexport const x = helper();');
    await createFile(tmpDir, "package.json", JSON.stringify({ name: "test", dependencies: { chalk: "^5" } }));
    const childPath = join(tmpDir, "core");
    await mkdir(childPath);
    const childScan = makeScanResult(childPath, { relativePath: "src/core", files: ["a.ts"] });
    const scan = makeScanResult(tmpDir, { relativePath: ".", files: ["index.ts", "package.json"], children: [childScan] });

    const childCtx = makeValidContext({ summary: "Core modules" });
    const childContexts = new Map<string, ContextFile>([[childPath, childCtx]]);

    const { context: result } = await generateStaticContext(scan, childContexts);

    expect(result.subdirectories).toBeDefined();
    expect(result.dependencies?.internal).toBeDefined();
    expect(result.dependencies?.external).toBeUndefined();
  });

  it("lists all files with purposes (full mode)", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await createFile(tmpDir, "package.json", '{"name":"test"}');

    const scan = makeScanResult(tmpDir, { relativePath: ".", files: ["index.ts", "package.json"] });
    const { context: result } = await generateStaticContext(scan, new Map(), { mode: "full" });

    expect(result.files).toHaveLength(2);
    const pkgFile = result.files!.find((f) => f.name === "package.json");
    expect(pkgFile?.purpose).toBe("Node.js project configuration and dependencies");
  });

  it("detects known file purposes (full mode)", async () => {
    await createFile(tmpDir, "Dockerfile", "FROM node:18");
    await createFile(tmpDir, "tsconfig.json", "{}");
    await createFile(tmpDir, "README.md", "# Hello");

    const scan = makeScanResult(tmpDir, {
      relativePath: ".",
      files: ["Dockerfile", "README.md", "tsconfig.json"],
    });
    const { context: result } = await generateStaticContext(scan, new Map(), { mode: "full" });

    expect(result.files!.find((f) => f.name === "Dockerfile")?.purpose).toBe("Container build configuration");
    expect(result.files!.find((f) => f.name === "tsconfig.json")?.purpose).toBe("TypeScript compiler configuration");
    expect(result.files!.find((f) => f.name === "README.md")?.purpose).toBe("Project documentation");
  });

  it("detects TypeScript exports as file purpose (full mode)", async () => {
    await createFile(tmpDir, "mod.ts", "export function hello() {}\nexport const world = 1;");

    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["mod.ts"] });
    const { context: result } = await generateStaticContext(scan, new Map(), { mode: "full" });

    const mod = result.files!.find((f) => f.name === "mod.ts");
    expect(mod?.purpose).toContain("Exports:");
    expect(mod?.purpose).toContain("hello");
  });

  it("detects Python exports (full mode)", async () => {
    await createFile(tmpDir, "module.py", "def greet():\n    pass\n\nclass Handler:\n    pass\n");

    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["module.py"] });
    const { context: result } = await generateStaticContext(scan, new Map(), { mode: "full" });

    const mod = result.files!.find((f) => f.name === "module.py");
    expect(mod?.purpose).toContain("greet");
    expect(mod?.purpose).toContain("Handler");
  });

  it("detects Go exported functions (full mode)", async () => {
    await createFile(tmpDir, "main.go", "func HandleRequest() {}\nfunc internal() {}");

    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["main.go"] });
    const { context: result } = await generateStaticContext(scan, new Map(), { mode: "full" });

    const mod = result.files!.find((f) => f.name === "main.go");
    expect(mod?.purpose).toContain("HandleRequest");
  });

  it("includes subdirectory summaries from child contexts", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const childPath = join(tmpDir, "core");
    await mkdir(childPath);

    const childScan = makeScanResult(childPath, { relativePath: "src/core", files: ["schema.ts"] });
    const scan = makeScanResult(tmpDir, {
      relativePath: "src",
      files: ["index.ts"],
      children: [childScan],
    });

    const childCtx = makeValidContext({ summary: "Core modules and schemas" });
    const childContexts = new Map<string, ContextFile>([[childPath, childCtx]]);

    const { context: result } = await generateStaticContext(scan, childContexts);
    expect(result.subdirectories).toBeDefined();
    expect(result.subdirectories![0].summary).toBe("Core modules and schemas");
  });

  it("uses fallback summary when child context not available", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const childPath = join(tmpDir, "core");
    await mkdir(childPath);

    const childScan = makeScanResult(childPath, { relativePath: "src/core", files: ["a.ts", "b.ts"] });
    const scan = makeScanResult(tmpDir, {
      relativePath: "src",
      files: ["index.ts"],
      children: [childScan],
    });

    const { context: result } = await generateStaticContext(scan, new Map());
    expect(result.subdirectories![0].summary).toContain("2 source files");
  });

  it("includes project metadata at root", async () => {
    await createFile(tmpDir, "package.json", JSON.stringify({
      name: "myapp",
      description: "A test app",
    }));

    const scan = makeScanResult(tmpDir, { relativePath: ".", files: ["package.json"] });
    const { context: result } = await generateStaticContext(scan, new Map());

    expect(result.project).toBeDefined();
    expect(result.project!.name).toBe("myapp");
    expect(result.project!.description).toBe("A test app");
  });

  it("omits project metadata for non-root directories", async () => {
    await createFile(tmpDir, "index.ts", "code");

    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["index.ts"] });
    const { context: result } = await generateStaticContext(scan, new Map());

    expect(result.project).toBeUndefined();
  });

  it("includes structure field at root when children exist", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const childPath = join(tmpDir, "src");
    await mkdir(childPath);
    const childScan = makeScanResult(childPath, { relativePath: "src", files: ["app.ts"] });

    const scan = makeScanResult(tmpDir, { relativePath: ".", files: ["index.ts"], children: [childScan] });
    const { context: result } = await generateStaticContext(scan, new Map());

    expect(result.structure).toBeDefined();
    expect(result.structure!.length).toBeGreaterThan(0);
  });

  it("caps exports at 25 and includes interfaces in full mode", async () => {
    // Create a file with 30 exports to exceed the cap of 25
    const exportFns = Array.from({ length: 30 }, (_, i) => `export function fn${i}() {}`).join("\n");
    await createFile(tmpDir, "big.ts", exportFns);

    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["big.ts"] });
    const { context: result } = await generateStaticContext(scan, new Map(), { mode: "full" });

    expect(result.exports).toBeDefined();
    expect(result.exports!.length).toBeLessThanOrEqual(25);
    // full mode includes interfaces alongside exports
    expect(result.interfaces).toBeDefined();
  });
});

// --- LLM generator tests ---

function createMockProvider(yamlResponse: string): LLMProvider {
  return {
    generate: vi.fn().mockResolvedValue(yamlResponse),
  };
}

describe("generateLLMContext", () => {
  it("strips markdown yaml fences from LLM response", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const provider = createMockProvider("```yaml\nsummary: Fenced test\n```");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map());
    expect(result.summary).toBe("Fenced test");
  });

  it("strips ```yml fences too", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const provider = createMockProvider("```yml\nsummary: YML fenced\n```");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map());
    expect(result.summary).toBe("YML fenced");
  });

  it("handles response without fences", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const provider = createMockProvider("summary: No fences");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map());
    expect(result.summary).toBe("No fences");
  });

  it("merges LLM output with required system fields (lean)", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const provider = createMockProvider("summary: LLM summary");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map());

    expect(result.version).toBe(SCHEMA_VERSION);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(result.maintenance).toBe(DEFAULT_MAINTENANCE);
    expect(result.scope).toBe("src");
    expect(result.files).toBeUndefined();
  });

  it("merges LLM output with required system fields (full)", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const provider = createMockProvider("summary: LLM summary\nfiles:\n  - name: a.ts\n    purpose: From LLM");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map(), { mode: "full" });

    expect(result.version).toBe(SCHEMA_VERSION);
    expect(result.maintenance).toBe(FULL_MAINTENANCE);
    expect(result.files).toBeDefined();
    expect(result.files).toHaveLength(1);
  });

  it("validates output against schema (lean)", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const provider = createMockProvider("summary: Valid output");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map());
    expect(contextSchema.safeParse(result).success).toBe(true);
    expect(result.files).toBeUndefined();
  });

  it("validates output against schema (full)", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const provider = createMockProvider("summary: Valid output\nfiles:\n  - name: a.ts\n    purpose: Code");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map(), { mode: "full" });
    expect(contextSchema.safeParse(result).success).toBe(true);
    expect(result.files).toHaveLength(1);
  });

  it("falls back to minimal context on validation failure (full)", async () => {
    await createFile(tmpDir, "a.ts", "code");
    // Return invalid files structure
    const provider = createMockProvider("summary: Bad output\nfiles:\n  - bad_field: oops");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map(), { mode: "full" });

    // Should still produce valid context
    expect(contextSchema.safeParse(result).success).toBe(true);
    // Fallback should use scanResult files
    expect(result.files![0].name).toBe("a.ts");
    expect(result.files![0].purpose).toBe("Source file");
  });

  it("lean fallback omits files", async () => {
    await createFile(tmpDir, "a.ts", "code");
    // Return something that triggers validation failure
    const provider = createMockProvider("summary: Bad\nfiles:\n  - bad_field: oops");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map());

    expect(contextSchema.safeParse(result).success).toBe(true);
    expect(result.files).toBeUndefined();
  });

  it("subdirectories come from scanner, not LLM output", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const childPath = join(tmpDir, "core");
    await mkdir(childPath);

    const provider = createMockProvider("summary: Test\nsubdirectories:\n  - name: wrong/\n    summary: LLM guess");
    const childScan = makeScanResult(childPath, { relativePath: "src/core", files: ["b.ts"] });
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"], children: [childScan] });

    const childCtx = makeValidContext({ summary: "Real core summary" });
    const childContexts = new Map<string, ContextFile>([[childPath, childCtx]]);

    const result = await generateLLMContext(provider, scan, childContexts);

    expect(result.subdirectories).toBeDefined();
    expect(result.subdirectories![0].name).toBe("core/");
    expect(result.subdirectories![0].summary).toBe("Real core summary");
  });

  it("passes lean system prompt by default", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const provider = createMockProvider("summary: Test");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    await generateLLMContext(provider, scan, new Map());

    expect(provider.generate).toHaveBeenCalledOnce();
    const [systemPrompt, userPrompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemPrompt).toContain("lean");
    expect(userPrompt).toContain("src");
  });

  it("passes full system prompt in full mode", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const provider = createMockProvider("summary: Test\nfiles:\n  - name: a.ts\n    purpose: Code");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    await generateLLMContext(provider, scan, new Map(), { mode: "full" });

    expect(provider.generate).toHaveBeenCalledOnce();
    const [systemPrompt] = (provider.generate as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(systemPrompt).toContain("files[].purpose");
  });

  it("merges optional LLM fields when present (full)", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const yaml = `summary: Test
files:
  - name: a.ts
    purpose: Code
interfaces:
  - name: hello()
    description: Greets
decisions:
  - what: Use YAML
    why: Token efficient
constraints:
  - Must be valid YAML`;
    const provider = createMockProvider(yaml);
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map(), { mode: "full" });

    expect(result.interfaces).toHaveLength(1);
    expect(result.decisions).toHaveLength(1);
    expect(result.constraints).toHaveLength(1);
  });

  it("lean mode merges decisions/constraints but not interfaces/current_state", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const yaml = `summary: Test
interfaces:
  - name: hello()
    description: Greets
decisions:
  - what: Use YAML
    why: Token efficient
constraints:
  - Must be valid YAML
current_state:
  working:
    - Everything`;
    const provider = createMockProvider(yaml);
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map());

    expect(result.decisions).toHaveLength(1);
    expect(result.constraints).toHaveLength(1);
    expect(result.interfaces).toBeUndefined();
    expect(result.current_state).toBeUndefined();
    expect(result.files).toBeUndefined();
  });

  it("populates evidence when evidence option is true at root", async () => {
    await createFile(tmpDir, "a.ts", "code");
    await writeFile(
      join(tmpDir, "test-results.json"),
      JSON.stringify({ success: true, numTotalTests: 42 }),
    );
    const provider = createMockProvider("summary: Root project");
    const scan = makeScanResult(tmpDir, { relativePath: ".", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map(), { evidence: true });

    expect(result.evidence).toBeDefined();
    expect(result.evidence!.test_status).toBe("passing");
    expect(result.evidence!.test_count).toBe(42);
    expect(result.derived_fields).toContain("evidence");
  });

  it("omits evidence when evidence option is false", async () => {
    await createFile(tmpDir, "a.ts", "code");
    await writeFile(
      join(tmpDir, "test-results.json"),
      JSON.stringify({ success: true, numTotalTests: 10 }),
    );
    const provider = createMockProvider("summary: Test");
    const scan = makeScanResult(tmpDir, { relativePath: ".", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map());

    expect(result.evidence).toBeUndefined();
  });

  it("includes evidence for non-root when option is true", async () => {
    await createFile(tmpDir, "a.ts", "code");
    await writeFile(
      join(tmpDir, "test-results.json"),
      JSON.stringify({ success: true, numTotalTests: 10 }),
    );
    const provider = createMockProvider("summary: Sub dir");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map(), { evidence: true });

    expect(result.evidence).toBeDefined();
    expect(result.evidence!.test_status).toBe("passing");
    expect(result.evidence!.test_count).toBe(10);
    expect(result.derived_fields).toContain("evidence");
  });

  it("fallback at root includes project and structure (full)", async () => {
    await createFile(tmpDir, "a.ts", "code");
    const childPath = join(tmpDir, "core");
    await mkdir(childPath);

    // Return invalid files structure to trigger fallback
    const provider = createMockProvider("summary: Root project\nfiles:\n  - bad_field: oops");
    const childScan = makeScanResult(childPath, { relativePath: "core", files: ["b.ts"] });
    const scan = makeScanResult(tmpDir, { relativePath: ".", files: ["a.ts"], children: [childScan] });

    const childCtx = makeValidContext({ summary: "Core modules" });
    const childContexts = new Map<string, ContextFile>([[childPath, childCtx]]);

    const result = await generateLLMContext(provider, scan, childContexts, { mode: "full" });

    // Fallback should still be valid
    expect(contextSchema.safeParse(result).success).toBe(true);
    // Root fallback must include project and structure
    expect(result.project).toBeDefined();
    expect(result.project!.name).toBeTruthy();
    expect(result.structure).toBeDefined();
    expect(result.structure!.length).toBeGreaterThan(0);
    expect(result.structure![0].summary).toBe("Core modules");
    // Full fallback includes files
    expect(result.files).toBeDefined();
  });

  it("fallback at non-root omits project and structure", async () => {
    await createFile(tmpDir, "a.ts", "code");
    // Return something that triggers validation failure
    const provider = createMockProvider("summary: Sub dir\nfiles:\n  - bad_field: oops");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["a.ts"] });

    const result = await generateLLMContext(provider, scan, new Map());

    expect(contextSchema.safeParse(result).success).toBe(true);
    expect(result.project).toBeUndefined();
    expect(result.structure).toBeUndefined();
  });
});

// --- Static generator golden-shape test ---

describe("generateStaticContext golden shape", () => {
  it("produces stable field set for a typical directory (full mode)", async () => {
    await createFile(tmpDir, "index.ts", "export function main() {}");
    await createFile(tmpDir, "utils.ts", "export const helper = 1;");
    await createFile(tmpDir, "package.json", JSON.stringify({ name: "test-project", description: "A test" }));

    const childPath = join(tmpDir, "lib");
    await mkdir(childPath);
    const childScan = makeScanResult(childPath, { relativePath: "lib", files: ["mod.ts"] });

    const scan = makeScanResult(tmpDir, {
      relativePath: ".",
      files: ["index.ts", "utils.ts", "package.json"],
      children: [childScan],
    });

    const { context: result } = await generateStaticContext(scan, new Map(), { mode: "full" });

    // Required fields always present
    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("last_updated");
    expect(result).toHaveProperty("fingerprint");
    expect(result).toHaveProperty("scope");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("maintenance");
    expect(result).toHaveProperty("derived_fields");

    // Root-level fields present at root
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("structure");
    expect(result).toHaveProperty("subdirectories");

    // Files match input
    const fileNames = result.files!.map((f) => f.name).sort();
    expect(fileNames).toEqual(["index.ts", "package.json", "utils.ts"]);

    // Every file has a purpose
    for (const f of result.files!) {
      expect(typeof f.purpose).toBe("string");
      expect(f.purpose.length).toBeGreaterThan(0);
    }

    // derived_fields declares what was machine-generated
    expect(result.derived_fields).toContain("version");
    expect(result.derived_fields).toContain("files");
    expect(result.derived_fields).toContain("project");

    // Schema validation passes
    expect(contextSchema.safeParse(result).success).toBe(true);
  });

  it("lean mode golden shape — no files, interfaces, or external deps", async () => {
    await createFile(tmpDir, "index.ts", "export function main() {}");
    await createFile(tmpDir, "package.json", JSON.stringify({ name: "test-project", description: "A test" }));

    const childPath = join(tmpDir, "lib");
    await mkdir(childPath);
    const childScan = makeScanResult(childPath, { relativePath: "lib", files: ["mod.ts"] });

    const scan = makeScanResult(tmpDir, {
      relativePath: ".",
      files: ["index.ts", "package.json"],
      children: [childScan],
    });

    const { context: result } = await generateStaticContext(scan, new Map());

    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("maintenance");
    expect(result).not.toHaveProperty("files");
    expect(result).not.toHaveProperty("interfaces");
    expect(result).toHaveProperty("project");
    expect(result).toHaveProperty("structure");
    expect(result).toHaveProperty("subdirectories");
    expect(result.derived_fields).not.toContain("files");
    expect(result.derived_fields).not.toContain("interfaces");

    expect(contextSchema.safeParse(result).success).toBe(true);
  });

  it("non-root shape omits project and structure", async () => {
    await createFile(tmpDir, "mod.ts", "export const x = 1;");
    const scan = makeScanResult(tmpDir, { relativePath: "src/lib", files: ["mod.ts"] });

    const { context: result } = await generateStaticContext(scan, new Map(), { mode: "full" });

    expect(result).toHaveProperty("version");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("files");
    expect(result).not.toHaveProperty("project");
    expect(result).not.toHaveProperty("structure");

    expect(contextSchema.safeParse(result).success).toBe(true);
  });
});

// --- Signature extraction tests ---

describe("extractOneSignature", () => {
  it("extracts TypeScript function signature with params and return type", () => {
    const content = "export function greet(name: string): string { return name; }";
    const sig = extractOneSignature(content, "greet", ".ts");
    expect(sig).toContain("greet");
    expect(sig).toContain("name: string");
    expect(sig).toContain(": string");
    expect(sig).not.toContain("export");
  });

  it("extracts async function signature", () => {
    const content = "export async function fetchData(url: string): Promise<Response> { return fetch(url); }";
    const sig = extractOneSignature(content, "fetchData", ".ts");
    expect(sig).toContain("async function fetchData");
    expect(sig).toContain("url: string");
  });

  it("extracts class declaration", () => {
    const content = "export class MyService { }";
    const sig = extractOneSignature(content, "MyService", ".ts");
    expect(sig).toBe("class MyService");
  });

  it("extracts type alias", () => {
    const content = "export type Config = { key: string; }";
    const sig = extractOneSignature(content, "Config", ".ts");
    expect(sig).toBe("type Config");
  });

  it("extracts interface", () => {
    const content = "export interface Options { verbose: boolean; }";
    const sig = extractOneSignature(content, "Options", ".ts");
    expect(sig).toBe("interface Options");
  });

  it("extracts const with type annotation", () => {
    const content = "export const VERSION: string = '1.0';";
    const sig = extractOneSignature(content, "VERSION", ".ts");
    expect(sig).toBe("VERSION: string");
  });

  it("falls back to name when no pattern matches", () => {
    const content = "export { something as renamed };";
    const sig = extractOneSignature(content, "renamed", ".ts");
    expect(sig).toBe("renamed");
  });

  it("extracts Python def signature with type annotations", () => {
    const content = "def greet(name: str) -> str:\n    return name";
    const sig = extractOneSignature(content, "greet", ".py");
    expect(sig).toContain("def greet");
    expect(sig).toContain("name: str");
    expect(sig).toContain("-> str");
  });

  it("extracts Python class", () => {
    const content = "class Handler:\n    pass";
    const sig = extractOneSignature(content, "Handler", ".py");
    expect(sig).toBe("class Handler");
  });

  it("extracts Go exported function signature", () => {
    const content = "func HandleRequest(w http.ResponseWriter, r *http.Request) error {\n}";
    const sig = extractOneSignature(content, "HandleRequest", ".go");
    expect(sig).toContain("HandleRequest");
    expect(sig).toContain("http.ResponseWriter");
  });

  it("extracts Rust pub fn signature", () => {
    const content = "pub fn process(input: &str) -> Result<String, Error> {\n}";
    const sig = extractOneSignature(content, "process", ".rs");
    expect(sig).toContain("fn process");
    expect(sig).toContain("-> Result<String, Error>");
    expect(sig).not.toContain("pub");
  });
});

// --- Smart summary tests ---

describe("buildSmartSummary", () => {
  it("uses project description at root", async () => {
    const scan = makeScanResult(tmpDir, { relativePath: ".", files: ["index.ts"] });
    const { summary, source } = await buildSmartSummary(scan, true, "A CLI tool for context generation");
    expect(summary).toBe("A CLI tool for context generation");
    expect(source).toBe("project");
  });

  it("extracts summary from __init__.py docstring", async () => {
    await createFile(tmpDir, "__init__.py", '"""Authentication module for handling OAuth flows."""\n');
    const scan = makeScanResult(tmpDir, { relativePath: "auth", files: ["__init__.py"] });
    const { summary, source } = await buildSmartSummary(scan, false);
    expect(summary).toBe("Authentication module for handling OAuth flows.");
    expect(source).toBe("docstring");
  });

  it("extracts summary from index.ts JSDoc", async () => {
    await createFile(tmpDir, "index.ts", '/** Core scanner module for traversing project directories. */\nexport {};\n');
    const scan = makeScanResult(tmpDir, { relativePath: "scanner", files: ["index.ts"] });
    const { summary, source } = await buildSmartSummary(scan, false);
    expect(summary).toBe("Core scanner module for traversing project directories.");
    expect(source).toBe("docstring");
  });

  it("uses directory name heuristic", async () => {
    const scan = makeScanResult(tmpDir, { relativePath: "src/utils", files: ["a.ts"] });
    const { summary, source } = await buildSmartSummary(scan, false);
    expect(summary).toBe("Utility functions.");
    expect(source).toBe("dirname");
  });

  it("detects test directories from file patterns", async () => {
    const scan = makeScanResult(tmpDir, { relativePath: "src/foo", files: ["a.test.ts", "b.test.ts"] });
    const { summary, source } = await buildSmartSummary(scan, false);
    expect(summary).toBe("Test suite.");
    expect(source).toBe("pattern");
  });

  it("falls back to minimal label", async () => {
    const scan = makeScanResult(tmpDir, { relativePath: "src/xyz123", files: ["a.ts", "b.ts"] });
    const { summary, source } = await buildSmartSummary(scan, false);
    expect(summary).toBe("Source directory.");
    expect(source).toBe("fallback");
  });

  it("does not contain file counts or file names", async () => {
    const scan = makeScanResult(tmpDir, { relativePath: "src/xyz123", files: ["a.ts", "b.ts", "c.ts"] });
    const { summary } = await buildSmartSummary(scan, false);
    expect(summary).not.toMatch(/\d+ files/);
    expect(summary).not.toContain("a.ts");
    expect(summary).not.toContain("Generated with static analysis");
  });
});

// --- Exports integration tests ---

describe("generateStaticContext exports", () => {
  it("populates exports with function signatures", async () => {
    await createFile(tmpDir, "mod.ts", "export function greet(name: string): string { return name; }\nexport const VERSION = 1;");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["mod.ts"] });
    const { context } = await generateStaticContext(scan, new Map());

    expect(context.exports).toBeDefined();
    expect(context.exports!.length).toBeGreaterThan(0);
    // Should have actual signature, not just name
    const greetSig = context.exports!.find((s) => s.includes("greet"));
    expect(greetSig).toBeDefined();
  });

  it("populates exports in both lean and full mode", async () => {
    await createFile(tmpDir, "mod.ts", "export function hello() {}");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["mod.ts"] });

    const { context: lean } = await generateStaticContext(scan, new Map());
    const { context: full } = await generateStaticContext(scan, new Map(), { mode: "full" });

    expect(lean.exports).toBeDefined();
    expect(full.exports).toBeDefined();
  });

  it("includes both exports and interfaces in full mode", async () => {
    await createFile(tmpDir, "mod.ts", "export function hello() {}\nexport function world() {}");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["mod.ts"] });
    const { context } = await generateStaticContext(scan, new Map(), { mode: "full" });

    expect(context.exports).toBeDefined();
    expect(context.interfaces).toBeDefined();
    expect(context.interfaces!.length).toBeGreaterThan(0);
  });

  it("skips non-source files for exports", async () => {
    await createFile(tmpDir, "readme.md", "# Hello");
    await createFile(tmpDir, "config.json", "{}");
    const scan = makeScanResult(tmpDir, { relativePath: "docs", files: ["readme.md", "config.json"] });
    const { context } = await generateStaticContext(scan, new Map());

    expect(context.exports).toBeUndefined();
  });

  it("includes exports in derived_fields", async () => {
    await createFile(tmpDir, "mod.ts", "export function hello() {}");
    const scan = makeScanResult(tmpDir, { relativePath: "src", files: ["mod.ts"] });
    const { context } = await generateStaticContext(scan, new Map());

    expect(context.derived_fields).toContain("exports");
  });

  it("returns summarySource from buildSmartSummary", async () => {
    await createFile(tmpDir, "mod.ts", "export const x = 1;");
    const scan = makeScanResult(tmpDir, { relativePath: "src/utils", files: ["mod.ts"] });
    const { summarySource } = await generateStaticContext(scan, new Map());

    expect(summarySource).toBe("dirname");
  });
});
