import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ContextFile } from "../src/core/schema.js";
import type { ScanResult } from "../src/core/scanner.js";

export async function createTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "autocontext-test-"));
}

export async function cleanupTmpDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function createFile(dirPath: string, name: string, content = ""): Promise<void> {
  await writeFile(join(dirPath, name), content);
}

export async function createNestedFile(basePath: string, relativePath: string, content = ""): Promise<void> {
  const fullPath = join(basePath, relativePath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content);
}

export function makeValidContext(overrides?: Partial<ContextFile>): ContextFile {
  return {
    version: 1,
    last_updated: "2025-01-01T00:00:00.000Z",
    fingerprint: "abc12345",
    scope: ".",
    summary: "Test directory",
    files: [{ name: "index.ts", purpose: "Entry point" }],
    maintenance: "Keep updated",
    ...overrides,
  };
}

export function makeLeanContext(overrides?: Partial<ContextFile>): ContextFile {
  return {
    version: 1,
    last_updated: "2025-01-01T00:00:00.000Z",
    fingerprint: "abc12345",
    scope: ".",
    summary: "Test directory",
    maintenance: "Keep updated",
    ...overrides,
  };
}

export function makeScanResult(path: string, overrides?: Partial<ScanResult>): ScanResult {
  return {
    path,
    relativePath: ".",
    files: [],
    hasContext: false,
    children: [],
    ...overrides,
  };
}
