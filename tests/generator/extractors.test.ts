import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTmpDir, cleanupTmpDir, createFile, createNestedFile, makeScanResult } from "../helpers.js";
import { extractEnvironment } from "../../src/generator/extractors/environment.js";
import { extractTesting } from "../../src/generator/extractors/testing.js";
import { extractTodos } from "../../src/generator/extractors/todos.js";
import { extractConfig } from "../../src/generator/extractors/config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("extractEnvironment", () => {
  it("captures process.env refs and .env.example keys", async () => {
    await createFile(
      tmpDir,
      "config.ts",
      `const db = process.env.DATABASE_URL;
       const key = process.env["API_KEY"];
       const pub = import.meta.env.VITE_API;`,
    );
    await createFile(
      tmpDir,
      ".env.example",
      `# DB URL\nDATABASE_URL=\nSTRIPE_KEY=\n`,
    );
    const out = await extractEnvironment(
      makeScanResult(tmpDir, { files: ["config.ts"] }),
    );
    expect(out).toEqual(["API_KEY", "DATABASE_URL", "STRIPE_KEY", "VITE_API"]);
  });

  it("skips test files + respects comment stripping + casing filter", async () => {
    await createFile(tmpDir, "app.test.ts", `process.env.CI;`);
    await createFile(
      tmpDir,
      "casing.ts",
      `/* process.env.SHOULD_NOT_MATCH */\nprocess.env.shouldNotMatch;`,
    );
    const out = await extractEnvironment(
      makeScanResult(tmpDir, { files: ["app.test.ts", "casing.ts"] }),
    );
    expect(out).toEqual([]);
  });

  it("handles python and go patterns", async () => {
    await createFile(tmpDir, "settings.py", `os.getenv("REDIS_URL")\nos.environ["DB_HOST"]`);
    await createFile(tmpDir, "main.go", `os.Getenv("PORT")`);
    const out = await extractEnvironment(
      makeScanResult(tmpDir, { files: ["settings.py", "main.go"] }),
    );
    expect(out).toEqual(["DB_HOST", "PORT", "REDIS_URL"]);
  });
});

describe("extractTodos", () => {
  it("captures TODO / FIXME markers with author + body", async () => {
    await createFile(
      tmpDir,
      "app.ts",
      `// TODO(alice): wire up retries
line 2
// FIXME: leaky abstraction here
/* TODO: refactor this block */`,
    );
    const out = await extractTodos(
      makeScanResult(tmpDir, { relativePath: "src", files: ["app.ts"] }),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toMatch(/^src\/app\.ts:1 TODO\(alice\): wire up retries$/);
    expect(out[1]).toMatch(/^src\/app\.ts:3 FIXME: leaky abstraction here$/);
    expect(out[2]).toMatch(/^src\/app\.ts:4 TODO: refactor this block/);
  });

  it("ignores markers inside string literals", async () => {
    await createFile(
      tmpDir,
      "noise.ts",
      `const s = "TODO: do not capture";
const r = 'FIXME: ignore';`,
    );
    const out = await extractTodos(
      makeScanResult(tmpDir, { files: ["noise.ts"] }),
    );
    expect(out).toEqual([]);
  });

  it("ignores identifiers like TODOList / FIXMEUP", async () => {
    await createFile(
      tmpDir,
      "ids.ts",
      `type TODOList = string[];
export const FIXMEUP = 1;`,
    );
    const out = await extractTodos(
      makeScanResult(tmpDir, { files: ["ids.ts"] }),
    );
    expect(out).toEqual([]);
  });

  it("caps at 10 entries and appends a tail summary", async () => {
    const lines = Array.from({ length: 15 }, (_, i) => `// TODO: item ${i + 1}`).join("\n");
    await createFile(tmpDir, "many.ts", lines);
    const out = await extractTodos(
      makeScanResult(tmpDir, { files: ["many.ts"] }),
    );
    expect(out).toHaveLength(11);
    expect(out[10]).toMatch(/^\u2026 \+5 more TODOs$/);
  });
});

describe("extractConfig", () => {
  it("probes presence and extracts cheap facts for tsconfig/.nvmrc/.python-version", async () => {
    await createFile(
      tmpDir,
      "tsconfig.json",
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    await createFile(tmpDir, ".nvmrc", "20.11.0\n");
    await createFile(tmpDir, ".python-version", "3.12\n");
    await createFile(tmpDir, "Dockerfile", "FROM node:20");
    await createFile(tmpDir, "pnpm-lock.yaml", "#");
    const out = await extractConfig(
      makeScanResult(tmpDir, { files: ["tsconfig.json", ".nvmrc", ".python-version", "Dockerfile", "pnpm-lock.yaml"] }),
    );
    expect(out).toContain("tsconfig.json (strict: true)");
    expect(out).toContain(".nvmrc (node: 20.11.0)");
    expect(out).toContain(".python-version (python: 3.12)");
    expect(out).toContain("Dockerfile");
    expect(out).toContain("Lockfile: pnpm-lock.yaml");
  });

  it("degrades gracefully on malformed tsconfig", async () => {
    await createFile(tmpDir, "tsconfig.json", "{ this is not json");
    const out = await extractConfig(
      makeScanResult(tmpDir, { files: ["tsconfig.json"] }),
    );
    expect(out).toContain("tsconfig.json");
  });
});

describe("extractTesting", () => {
  it("reads package.json scripts + framework + config files", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: { test: "vitest", "test:e2e": "playwright test" },
        devDependencies: { vitest: "^1.0.0", "@playwright/test": "^1.0.0" },
      }),
    );
    await createFile(tmpDir, "vitest.config.ts", "export default {}");
    const out = await extractTesting(
      makeScanResult(tmpDir, { files: ["package.json", "vitest.config.ts"] }),
    );
    expect(out).toContain("Framework: vitest");
    expect(out).toContain("Framework: playwright");
    expect(out).toContain("Command: npm test");
    expect(out).toContain("Command: npm run test:e2e");
    expect(out).toContain("Config: vitest.config.ts");
  });

  it("covers python pytest via pyproject.toml header", async () => {
    await writeFile(
      join(tmpDir, "pyproject.toml"),
      `[tool.pytest.ini_options]\ntestpaths = ["tests"]`,
    );
    const out = await extractTesting(
      makeScanResult(tmpDir, { files: ["pyproject.toml"] }),
    );
    expect(out).toContain("Framework: pytest");
    expect(out).toContain("Config: pyproject.toml [tool.pytest]");
  });

  it("detects go test convention from _test.go files", async () => {
    await createFile(tmpDir, "foo_test.go", "package foo\nfunc TestFoo() {}");
    await writeFile(join(tmpDir, "go.mod"), "module foo\n");
    const out = await extractTesting(
      makeScanResult(tmpDir, { files: ["foo_test.go", "go.mod"] }),
    );
    expect(out).toContain("Runner: go test ./...");
    expect(out).toContain("Conventions: *_test.go colocated");
  });

  it("returns empty for a directory with no test signals", async () => {
    await createFile(tmpDir, "index.ts", "export const x = 1;");
    const out = await extractTesting(
      makeScanResult(tmpDir, { files: ["index.ts"] }),
    );
    expect(out).toEqual([]);
  });
});

describe("extractors integration shape", () => {
  it("all four extractors return arrays (never null)", async () => {
    await createNestedFile(tmpDir, "src/index.ts", "export const x = 1;");
    const scan = makeScanResult(tmpDir, { files: [], children: [] });
    expect(Array.isArray(await extractEnvironment(scan))).toBe(true);
    expect(Array.isArray(await extractTesting(scan))).toBe(true);
    expect(Array.isArray(await extractTodos(scan))).toBe(true);
    expect(Array.isArray(await extractConfig(scan))).toBe(true);
  });
});
