import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { doctorCommand } from "../../src/commands/doctor.js";
import { writeContext } from "../../src/core/writer.js";
import { computeFingerprint } from "../../src/core/fingerprint.js";
import { saveConfig } from "../../src/utils/config.js";
import { createTmpDir, cleanupTmpDir, createFile, createNestedFile, makeValidContext } from "../helpers.js";
import { CONTEXT_FILENAME } from "../../src/core/schema.js";
import { AGENTS_SECTION_START, AGENTS_SECTION_END } from "../../src/generator/markdown.js";

let tmpDir: string;
let logs: string[];
let stdoutChunks: string[];

beforeEach(async () => {
  tmpDir = await createTmpDir();
  logs = [];
  stdoutChunks = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(tmpDir);
});

describe("doctorCommand", () => {
  it("reports pass for config when config exists", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await saveConfig(tmpDir, { provider: "anthropic" });

    await doctorCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("config:");
    expect(output).toContain("anthropic provider configured");
  });

  it("reports warn for config when no config", async () => {
    await createFile(tmpDir, "index.ts", "code");

    await doctorCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("No config file found");
  });

  it("reports fail for API key when not set", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await saveConfig(tmpDir, { provider: "anthropic" });

    // Ensure the env var is unset
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      await doctorCommand({ path: tmpDir });

      const output = logs.join("\n");
      expect(output).toContain("ANTHROPIC_API_KEY not set");
    } finally {
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  it("reports pass for API key when set", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await saveConfig(tmpDir, { provider: "anthropic" });

    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key-123";

    try {
      await doctorCommand({ path: tmpDir });

      const output = logs.join("\n");
      expect(output).toContain("ANTHROPIC_API_KEY is set");
    } finally {
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });

  it("reports correct coverage ratio", async () => {
    await createFile(tmpDir, "index.ts", "code");

    await doctorCommand({ path: tmpDir });

    const output = logs.join("\n");
    // With no context files, should show 0/N
    expect(output).toMatch(/0\/\d+ directories tracked/);
  });

  it("reports staleness warnings for stale dirs", async () => {
    await createFile(tmpDir, "index.ts", "short");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    // Make stale
    await createFile(tmpDir, "index.ts", "this is much longer content that changes the size");

    await doctorCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("stale");
  });

  it("reports AGENTS.md status correctly", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await writeFile(
      join(tmpDir, "AGENTS.md"),
      `# Agents\n${AGENTS_SECTION_START}\nContent\n${AGENTS_SECTION_END}\n`,
      "utf-8",
    );

    await doctorCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("AGENTS.md present with autocontext section");
  });

  it("reports schema validation status", async () => {
    await createFile(tmpDir, "index.ts", "code");
    const fp = await computeFingerprint(tmpDir);
    await writeContext(tmpDir, makeValidContext({ fingerprint: fp }));

    await doctorCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("All files pass schema validation");
  });

  it("detects invalid .context.yaml files that fail schema validation", async () => {
    await createFile(tmpDir, "index.ts", "code");
    // Write a .context.yaml that exists but is invalid (missing required fields)
    await writeFile(
      join(tmpDir, CONTEXT_FILENAME),
      "invalid: true\nrandom_field: hello\n",
      "utf-8",
    );

    await doctorCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("schema errors");
    expect(output).not.toContain("All files pass schema validation");
  });

  it("detects malformed YAML syntax as invalid", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await writeFile(join(tmpDir, CONTEXT_FILENAME), "summary: [unterminated\n", "utf-8");

    await doctorCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("schema errors");
    expect(output).not.toContain("All files pass schema validation");
  });

  it("counts invalid contexts distinctly even when other dirs are missing", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await createNestedFile(tmpDir, "src/app.ts", "code");
    await writeFile(join(tmpDir, CONTEXT_FILENAME), "summary: [unterminated\n", "utf-8");

    await doctorCommand({ path: tmpDir });

    const output = logs.join("\n");
    expect(output).toContain("1 file has schema errors");
    expect(output).not.toContain("All files pass schema validation");
  });

  it("honors api_key_env override when checking credentials", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await saveConfig(tmpDir, { provider: "openai", api_key_env: "CUSTOM_OPENAI_KEY" });

    const originalOpenAi = process.env.OPENAI_API_KEY;
    const originalCustom = process.env.CUSTOM_OPENAI_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.CUSTOM_OPENAI_KEY = "custom-key";

    try {
      await doctorCommand({ path: tmpDir });

      const output = logs.join("\n");
      expect(output).toContain("CUSTOM_OPENAI_KEY is set");
      expect(output).not.toContain("OPENAI_API_KEY is set");
    } finally {
      if (originalOpenAi !== undefined) {
        process.env.OPENAI_API_KEY = originalOpenAi;
      } else {
        delete process.env.OPENAI_API_KEY;
      }
      if (originalCustom !== undefined) {
        process.env.CUSTOM_OPENAI_KEY = originalCustom;
      } else {
        delete process.env.CUSTOM_OPENAI_KEY;
      }
    }
  });
});

describe("doctorCommand --json", () => {
  it("outputs valid JSON with checks array and summary", async () => {
    await createFile(tmpDir, "index.ts", "code");

    await doctorCommand({ path: tmpDir, json: true });

    const parsed = JSON.parse(stdoutChunks.join(""));
    expect(parsed.checks).toBeInstanceOf(Array);
    expect(parsed.checks.length).toBeGreaterThan(0);
    expect(parsed.summary).toHaveProperty("pass");
    expect(parsed.summary).toHaveProperty("warn");
    expect(parsed.summary).toHaveProperty("fail");
  });

  it("sorts checks deterministically by name in JSON mode", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await doctorCommand({ path: tmpDir, json: true });

    const parsed = JSON.parse(stdoutChunks.join(""));
    const names = parsed.checks.map((c: { name: string }) => c.name);
    expect(names).toEqual([...names].sort());
  });

  it("emits no extra stdout noise", async () => {
    await createFile(tmpDir, "index.ts", "code");

    await doctorCommand({ path: tmpDir, json: true });

    // console.log should not be called in JSON mode
    expect(logs).toHaveLength(0);

    // stdout should contain exactly one valid JSON object
    const raw = stdoutChunks.join("");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it("exit code 1 when any check fails", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await saveConfig(tmpDir, { provider: "anthropic" });

    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      process.exitCode = 0;
      await doctorCommand({ path: tmpDir, json: true });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  it("exit code 1 in mixed fail+warn state", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await saveConfig(tmpDir, { provider: "anthropic" });

    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      process.exitCode = 0;
      await doctorCommand({ path: tmpDir, json: true });
      const parsed = JSON.parse(stdoutChunks.join(""));
      expect(parsed.summary.fail).toBeGreaterThan(0);
      expect(parsed.summary.warn).toBeGreaterThan(0);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = 0;
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      }
    }
  });

  it("exit code 0 when all pass/warn", async () => {
    await createFile(tmpDir, "index.ts", "code");
    // No config = warn (not fail), so exitCode should be 0

    process.exitCode = 0;
    await doctorCommand({ path: tmpDir, json: true });
    expect(process.exitCode).toBe(0);
  });

  it("never leaks API key values in output", async () => {
    await createFile(tmpDir, "index.ts", "code");
    await saveConfig(tmpDir, { provider: "anthropic" });

    const originalKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-super-secret-key-12345";

    try {
      await doctorCommand({ path: tmpDir, json: true });

      const raw = stdoutChunks.join("");
      expect(raw).not.toContain("sk-super-secret-key-12345");
      expect(raw).toContain("ANTHROPIC_API_KEY is set");
    } finally {
      if (originalKey !== undefined) {
        process.env.ANTHROPIC_API_KEY = originalKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  });
});
