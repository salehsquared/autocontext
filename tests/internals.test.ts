import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectInternals } from "../src/generator/internals.js";
import { isTreeSitterAvailable } from "../src/generator/ast.js";
import { createTmpDir, cleanupTmpDir, createFile, makeScanResult } from "./helpers.js";

let tmpDir: string;
let treeSitterAvailable: boolean;

beforeEach(async () => {
  tmpDir = await createTmpDir();
  treeSitterAvailable = await isTreeSitterAvailable();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("detectInternals", () => {
  // --- TS/JS ---

  it("detects non-exported function", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "helpers.ts", [
      "function parseConfig(raw: string) { return JSON.parse(raw); }",
      "export function loadConfig() { return parseConfig('{}'); }",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["helpers.ts"] });
    const result = await detectInternals(scan);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "parseConfig", kind: "function", file: "helpers.ts" });
  });

  it("detects non-exported const", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "config.ts", [
      "const DEFAULT_TIMEOUT = 5000;",
      "export const config = { timeout: DEFAULT_TIMEOUT };",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["config.ts"] });
    const result = await detectInternals(scan);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "DEFAULT_TIMEOUT", kind: "constant", file: "config.ts" });
  });

  it("detects non-exported class", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "engine.ts", [
      "class InternalEngine { run() {} }",
      "export class PublicEngine extends InternalEngine {}",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["engine.ts"] });
    const result = await detectInternals(scan);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ name: "InternalEngine", kind: "class", file: "engine.ts" });
  });

  it("detects non-exported type alias and interface", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "types.ts", [
      "type InternalConfig = { key: string };",
      "interface PrivateHandler { handle(): void }",
      "export type PublicConfig = InternalConfig & { extra: boolean };",
      "export interface PublicHandler extends PrivateHandler {}",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["types.ts"] });
    const result = await detectInternals(scan);
    const names = result.map(r => r.name);
    expect(names).toContain("InternalConfig");
    expect(names).toContain("PrivateHandler");
    expect(names).not.toContain("PublicConfig");
    expect(names).not.toContain("PublicHandler");
  });

  it("excludes exported items", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "mod.ts", [
      "export function publicFn() {}",
      "export const PUBLIC_VAL = 42;",
      "export class PublicClass {}",
      "function privateFn() {}",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["mod.ts"] });
    const result = await detectInternals(scan);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("privateFn");
  });

  it("skips let/var declarations", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "state.ts", [
      "let mutableState = 0;",
      "var oldStyle = true;",
      "const IMMUTABLE = 42;",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["state.ts"] });
    const result = await detectInternals(scan);
    const names = result.map(r => r.name);
    expect(names).toContain("IMMUTABLE");
    expect(names).not.toContain("mutableState");
    expect(names).not.toContain("oldStyle");
  });

  it("skips .d.ts files", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "types.d.ts", [
      "declare function internalFn(): void;",
      "declare const SOME_CONST: number;",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["types.d.ts"] });
    const result = await detectInternals(scan);
    expect(result).toEqual([]);
  });

  it("handles multi-file directory with correct file field", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "a.ts", "function helperA() {}");
    await createFile(tmpDir, "b.ts", "function helperB() {}");

    const scan = makeScanResult(tmpDir, { files: ["a.ts", "b.ts"] });
    const result = await detectInternals(scan);
    expect(result).toHaveLength(2);

    const entryA = result.find(r => r.name === "helperA");
    const entryB = result.find(r => r.name === "helperB");
    expect(entryA?.file).toBe("a.ts");
    expect(entryB?.file).toBe("b.ts");
  });

  it("caps at 20 entries", async () => {
    if (!treeSitterAvailable) return;

    const funcs = Array.from({ length: 25 }, (_, i) =>
      `function internal${i}() {}`
    ).join("\n");
    await createFile(tmpDir, "big.ts", funcs);

    const scan = makeScanResult(tmpDir, { files: ["big.ts"] });
    const result = await detectInternals(scan);
    expect(result).toHaveLength(20);
  });

  // --- Python ---

  it("detects Python internal (underscore-prefixed) functions", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "handler.py", [
      "def _private_helper():",
      "    pass",
      "",
      "def public_handler():",
      "    pass",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["handler.py"] });
    const result = await detectInternals(scan);
    const names = result.map(r => r.name);
    expect(names).toContain("_private_helper");
    expect(names).not.toContain("public_handler");
  });

  // --- Go ---

  it("detects Go unexported (lowercase) functions", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "handler.go", [
      "package handler",
      "",
      "func internalHelper() {}",
      "",
      "func PublicHandler() {}",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["handler.go"] });
    const result = await detectInternals(scan);
    const names = result.map(r => r.name);
    expect(names).toContain("internalHelper");
    expect(names).not.toContain("PublicHandler");
  });

  // --- Rust ---

  it("detects Rust non-pub items", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "lib.rs", [
      "fn private_fn() {}",
      "",
      "pub fn public_fn() {}",
      "",
      "struct PrivateStruct {",
      "    field: i32,",
      "}",
      "",
      "pub struct PublicStruct {",
      "    pub field: i32,",
      "}",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["lib.rs"] });
    const result = await detectInternals(scan);
    const names = result.map(r => r.name);
    expect(names).toContain("private_fn");
    expect(names).toContain("PrivateStruct");
    expect(names).not.toContain("public_fn");
    expect(names).not.toContain("PublicStruct");
  });

  // --- Edge cases ---

  it("returns empty when tree-sitter unavailable for extension", async () => {
    await createFile(tmpDir, "data.json", '{"key": "value"}');
    const scan = makeScanResult(tmpDir, { files: ["data.json"] });
    const result = await detectInternals(scan);
    expect(result).toEqual([]);
  });

  it("handles unreadable files gracefully", async () => {
    const scan = makeScanResult(tmpDir, { files: ["missing.ts"] });
    const result = await detectInternals(scan);
    expect(result).toEqual([]);
  });

  it("returns empty for file with only exports", async () => {
    if (!treeSitterAvailable) return;

    await createFile(tmpDir, "public.ts", [
      "export function publicA() {}",
      "export function publicB() {}",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["public.ts"] });
    const result = await detectInternals(scan);
    expect(result).toEqual([]);
  });
});
