import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { validateCommand } from "../../src/commands/validate.js";
import { writeContext } from "../../src/core/writer.js";
import { computeFingerprint } from "../../src/core/fingerprint.js";
import { CONTEXT_FILENAME } from "../../src/core/schema.js";
import { createTmpDir, cleanupTmpDir, createFile, makeValidContext, makeLeanContext } from "../helpers.js";

let tmpDir: string;
let logs: string[];
let exitCode: number | undefined;

beforeEach(async () => {
  tmpDir = await createTmpDir();
  logs = [];
  exitCode = undefined;
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null | undefined) => {
    exitCode = typeof code === "number" ? code : 0;
    throw new Error(`process.exit(${code})`);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(tmpDir);
});

describe("validateCommand", () => {
  it("reports valid for correct context", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    await validateCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("valid");
    expect(exitCode).toBeUndefined();
  });

  it("reports invalid for malformed YAML", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await writeFile(join(tmpDir, CONTEXT_FILENAME), "not: valid\ncontext: file\n");

    await expect(validateCommand({ path: tmpDir })).rejects.toThrow("process.exit");

    const output = logs.join("\n");
    expect(output).toContain("invalid");
  });

  it("calls process.exit(1) on failure", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await writeFile(join(tmpDir, CONTEXT_FILENAME), "garbage: true\n");

    await expect(validateCommand({ path: tmpDir })).rejects.toThrow("process.exit");
    expect(exitCode).toBe(1);
  });

  it("does not exit when all valid", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    await validateCommand({ path: tmpDir });

    expect(exitCode).toBeUndefined();
  });

  it("reports count summary", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    await validateCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toMatch(/\d+ valid, \d+ invalid, \d+ missing/);
  });

  it("shows field-level error path", async () => {
    await createFile(tmpDir, "index.ts", "code");
    // Write context missing required 'summary' field
    await writeFile(
      join(tmpDir, CONTEXT_FILENAME),
      [
        "version: 1",
        'last_updated: "2026-01-01T00:00:00.000Z"',
        "fingerprint: abc12345",
        'scope: "."',
        "files:",
        '  - name: "index.ts"',
        '    purpose: "Entry point"',
        'maintenance: "Keep updated"',
        "",
      ].join("\n"),
    );

    await expect(validateCommand({ path: tmpDir })).rejects.toThrow("process.exit");

    const output = logs.join("\n");
    expect(output).toContain("summary");
  });

  describe("--strict mode", () => {
    it("detects phantom files (listed but not on disk)", async () => {
      await createFile(tmpDir, "index.ts", "export const x = 1;");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [
          { name: "index.ts", purpose: "Entry point" },
          { name: "missing.ts", purpose: "Does not exist" },
        ],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).toContain("phantom file: missing.ts");
    });

    it("detects unlisted files (on disk but not in context)", async () => {
      await createFile(tmpDir, "index.ts", "export const x = 1;");
      await createFile(tmpDir, "extra.ts", "export const y = 2;");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).toContain("unlisted file: extra.ts");
    });

    it("detects phantom interfaces (declared but not found in exports)", async () => {
      await createFile(tmpDir, "index.ts", "export function realFunc() {}");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
        interfaces: [
          { name: "realFunc", description: "Exists" },
          { name: "ghostFunc", description: "Does not exist" },
        ],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).toContain("phantom interface: ghostFunc");
      expect(output).not.toContain("phantom interface: realFunc");
    });

    it("skips endpoint-style interface names (not code identifiers)", async () => {
      await createFile(tmpDir, "index.ts", "export function handler() {}");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
        interfaces: [
          { name: "POST /login", description: "Login endpoint" },
          { name: "GET /users", description: "List users" },
        ],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).not.toContain("phantom interface: POST /login");
      expect(output).not.toContain("phantom interface: GET /users");
    });

    it("extracts leading identifier from signature-style interface names", async () => {
      await createFile(tmpDir, "index.ts", "export function verifyToken() {}");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
        interfaces: [
          { name: "verifyToken(token): User", description: "Token verification" },
        ],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).not.toContain("phantom interface: verifyToken");
    });

    it("passes cleanly when everything matches", async () => {
      await createFile(tmpDir, "index.ts", "export function hello() {}");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
        interfaces: [{ name: "hello", description: "Greeting" }],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).not.toContain("phantom");
      expect(output).not.toContain("unlisted");
      expect(output).not.toContain("strict:");
    });

    it("does not run cross-referencing without --strict", async () => {
      await createFile(tmpDir, "index.ts", "export const x = 1;");
      await createFile(tmpDir, "extra.ts", "export const y = 2;");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
      }));

      await validateCommand({ path: tmpDir });

      const output = logs.join("\n");
      expect(output).not.toContain("unlisted");
      expect(output).not.toContain("strict");
    });

    it("does not cause exit(1) for strict findings only", async () => {
      await createFile(tmpDir, "index.ts", "export const x = 1;");
      await createFile(tmpDir, "extra.ts", "export const y = 2;");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      // Should NOT exit — strict findings are informational
      expect(exitCode).toBeUndefined();
    });

    it("prints strict summary line when findings exist", async () => {
      await createFile(tmpDir, "index.ts", "export const x = 1;");
      await createFile(tmpDir, "extra.ts", "code");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [
          { name: "index.ts", purpose: "Entry point" },
          { name: "gone.ts", purpose: "Missing" },
        ],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      // Should have summary with warning and info counts
      expect(output).toMatch(/strict: \d+ warning/);
    });

    it("flags declared internal deps not found in imports", async () => {
      await createFile(tmpDir, "index.ts", "export const x = 1;");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
        dependencies: {
          internal: ["../utils", "../nonexistent"],
        },
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).toContain("declared internal dep not found in imports: ../utils");
      expect(output).toContain("declared internal dep not found in imports: ../nonexistent");
    });

    it("flags undeclared internal deps found in imports", async () => {
      // Cross-check only runs when declared internal deps has length > 0.
      // Declare one dep that matches, leave ../utils undeclared.
      await createFile(tmpDir, "index.ts", 'import { helper } from "../utils";\nimport { foo } from "../lib";\nexport const x = 1;');
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
        dependencies: {
          internal: ["../lib"],
        },
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).toContain("undeclared internal dep found in imports: ../utils");
      expect(output).not.toContain("undeclared internal dep found in imports: ../lib");
    });

    it("passes cleanly when declared deps match actual imports", async () => {
      await createFile(tmpDir, "index.ts", 'import { helper } from "../utils";\nexport const x = 1;');
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
        dependencies: {
          internal: ["../utils"],
        },
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).not.toContain("declared internal dep not found");
      expect(output).not.toContain("undeclared internal dep found");
    });

    it("flags import binding paths not in dependencies.internal", async () => {
      await createFile(tmpDir, "index.ts", 'import { foo } from "../lib.js";\nexport const x = 1;');
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
        dependencies: {
          internal: ["../other.js"],
        },
        imports: [
          { path: "../lib.js", symbols: ["foo"] },
          { path: "../other.js", symbols: ["bar"] },
        ],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      expect(output).toContain("import binding path not in dependencies.internal: ../lib.js");
      expect(output).not.toContain("import binding path not in dependencies.internal: ../other.js");
    });

    it("skips side-effect-only imports in cross-ref check", async () => {
      await createFile(tmpDir, "index.ts", 'import "./polyfill.js";\nexport const x = 1;');
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({
        fingerprint: fp,
        files: [{ name: "index.ts", purpose: "Entry point" }],
        dependencies: {
          internal: ["../utils.js"],
        },
        imports: [
          { path: "./polyfill.js", symbols: ["(side-effect)"] },
          { path: "../utils.js", symbols: ["helper"] },
        ],
      }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      // Side-effect-only path should NOT be flagged
      expect(output).not.toContain("import binding path not in dependencies.internal: ./polyfill.js");
    });

    it("collapses lean-skip messages into summary line", async () => {
      await createFile(tmpDir, "index.ts", "export const x = 1;");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeLeanContext({ fingerprint: fp }));

      await validateCommand({ path: tmpDir, strict: true });

      const output = logs.join("\n");
      // Should NOT print per-directory lean skip messages
      expect(output).not.toContain("file cross-reference skipped (lean context");
      // Should print aggregated summary
      expect(output).toContain("1 lean context");
      expect(output).toContain("file cross-ref skipped");
    });
  });

  describe("--policy mode", () => {
    it("exits 2 when the index is missing", async () => {
      await createFile(tmpDir, "index.ts", "export const x = 1;");
      const fp = await computeFingerprint(tmpDir);
      await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

      await expect(
        validateCommand({ path: tmpDir, policy: true }),
      ).rejects.toThrow("process.exit");
      expect(exitCode).toBe(2);
      const output = logs.join("\n");
      expect(output).toContain("index is missing or stale");
    });
  });
});
