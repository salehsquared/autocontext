import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  updateAgentsFiles,
  detectExistingAgentsFormats,
  parseAgentsFormats,
  resolveAgentsFormats,
  AGENTS_FILENAME,
  CLAUDE_FILENAME,
  COPILOT_PATH,
  CURSOR_PATH,
} from "../../src/core/markdown-writer.js";
import { AGENTS_SECTION_START, AGENTS_SECTION_END } from "../../src/generator/markdown.js";
import { createTmpDir, cleanupTmpDir } from "../helpers.js";

const entries = [
  { scope: ".", summary: "Project root" },
  { scope: "src", summary: "Source code" },
];

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("parseAgentsFormats", () => {
  it("returns undefined for undefined input (no override)", () => {
    expect(parseAgentsFormats(undefined)).toBeUndefined();
  });

  it("parses a csv into a deduped list", () => {
    expect(parseAgentsFormats("agents,claude,agents")).toEqual(["agents", "claude"]);
  });

  it("expands 'all' into every format", () => {
    expect(parseAgentsFormats("all")).toEqual(["agents", "claude", "copilot", "cursor"]);
  });

  it("returns an empty list for 'none'", () => {
    expect(parseAgentsFormats("none")).toEqual([]);
  });

  it("throws on an unknown format", () => {
    expect(() => parseAgentsFormats("agents,bogus")).toThrow(/Unknown agent format/);
  });
});

describe("detectExistingAgentsFormats", () => {
  it("returns an empty list on a pristine project", () => {
    expect(detectExistingAgentsFormats(tmpDir)).toEqual([]);
  });

  it("detects each format that already has a file", async () => {
    await writeFile(join(tmpDir, AGENTS_FILENAME), "# AGENTS\n");
    await writeFile(join(tmpDir, CLAUDE_FILENAME), "# CLAUDE\n");
    await mkdir(join(tmpDir, ".github"), { recursive: true });
    await writeFile(join(tmpDir, COPILOT_PATH), "# Copilot\n");

    const detected = detectExistingAgentsFormats(tmpDir);
    expect(detected.sort()).toEqual(["agents", "claude", "copilot"]);
  });

  it("treats an empty .cursor/ directory as cursor-opt-in", async () => {
    await mkdir(join(tmpDir, ".cursor"), { recursive: true });
    expect(detectExistingAgentsFormats(tmpDir)).toContain("cursor");
  });
});

describe("resolveAgentsFormats (precedence chain)", () => {
  it("CLI override wins over config and detection", async () => {
    await writeFile(join(tmpDir, CLAUDE_FILENAME), "# CLAUDE\n");
    expect(
      resolveAgentsFormats(tmpDir, ["cursor"], ["claude"]),
    ).toEqual(["cursor"]);
  });

  it("config wins over detection when no CLI override", async () => {
    await writeFile(join(tmpDir, CLAUDE_FILENAME), "# CLAUDE\n");
    expect(
      resolveAgentsFormats(tmpDir, undefined, ["copilot"]),
    ).toEqual(["copilot"]);
  });

  it("falls back to detected when config is unset", async () => {
    await writeFile(join(tmpDir, CLAUDE_FILENAME), "# CLAUDE\n");
    expect(
      resolveAgentsFormats(tmpDir, undefined, undefined),
    ).toContain("claude");
  });

  it("defaults to ['agents'] when nothing is set and nothing detected", () => {
    expect(
      resolveAgentsFormats(tmpDir, undefined, undefined),
    ).toEqual(["agents"]);
  });

  it("CLI 'none' (empty array) is respected", () => {
    expect(
      resolveAgentsFormats(tmpDir, [], undefined),
    ).toEqual([]);
  });
});

describe("updateAgentsFiles — multi-format emission", () => {
  it("creates every requested format file", async () => {
    const results = await updateAgentsFiles(tmpDir, entries, "demo", [
      "agents", "claude", "copilot", "cursor",
    ]);

    expect(results.every((r) => r.action === "created")).toBe(true);
    expect(existsSync(join(tmpDir, AGENTS_FILENAME))).toBe(true);
    expect(existsSync(join(tmpDir, CLAUDE_FILENAME))).toBe(true);
    expect(existsSync(join(tmpDir, COPILOT_PATH))).toBe(true);
    expect(existsSync(join(tmpDir, CURSOR_PATH))).toBe(true);
  });

  it("uses format-specific headers", async () => {
    await updateAgentsFiles(tmpDir, entries, "demo", ["agents", "claude", "copilot"]);
    expect(await readFile(join(tmpDir, AGENTS_FILENAME), "utf-8")).toContain("# AGENTS.md");
    expect(await readFile(join(tmpDir, CLAUDE_FILENAME), "utf-8")).toContain("# CLAUDE.md");
    expect(await readFile(join(tmpDir, COPILOT_PATH), "utf-8")).toContain("# Copilot instructions");
  });

  it("emits cursor .mdc with frontmatter and no section markers", async () => {
    await updateAgentsFiles(tmpDir, entries, "demo", ["cursor"]);
    const content = await readFile(join(tmpDir, CURSOR_PATH), "utf-8");
    expect(content.startsWith("---\n")).toBe(true);
    expect(content).toContain("alwaysApply: true");
    expect(content).toContain("## autocontext");
    // Cursor file is owned outright — no merge markers.
    expect(content).not.toContain(AGENTS_SECTION_START);
    expect(content).not.toContain(AGENTS_SECTION_END);
  });

  it("preserves user content around markers on re-emit of markdown formats", async () => {
    await updateAgentsFiles(tmpDir, entries, "demo", ["claude"]);
    const initial = await readFile(join(tmpDir, CLAUDE_FILENAME), "utf-8");
    const withUser =
      "# My Custom CLAUDE.md\n\nImportant project notes.\n\n" +
      initial.slice(initial.indexOf(AGENTS_SECTION_START)) +
      "\n\n## Footer\n\nMore notes.\n";
    await writeFile(join(tmpDir, CLAUDE_FILENAME), withUser, "utf-8");

    await updateAgentsFiles(tmpDir, entries, "demo", ["claude"]);
    const result = await readFile(join(tmpDir, CLAUDE_FILENAME), "utf-8");
    expect(result).toContain("# My Custom CLAUDE.md");
    expect(result).toContain("Important project notes.");
    expect(result).toContain("## Footer");
    expect(result).toContain("More notes.");
  });

  it("skips when content is unchanged (idempotent)", async () => {
    await updateAgentsFiles(tmpDir, entries, "demo", ["agents", "cursor"]);
    const results = await updateAgentsFiles(tmpDir, entries, "demo", ["agents", "cursor"]);
    expect(results.every((r) => r.action === "skipped")).toBe(true);
  });

  it("creates parent directories for copilot + cursor files", async () => {
    await updateAgentsFiles(tmpDir, entries, "demo", ["copilot", "cursor"]);
    expect(existsSync(join(tmpDir, ".github"))).toBe(true);
    expect(existsSync(join(tmpDir, ".cursor/rules"))).toBe(true);
  });
});
