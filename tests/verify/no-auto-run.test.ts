import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const FORBIDDEN_IMPORT = /\bfrom\s+["'](?:\.\.\/)+(?:commands\/verify|verify\/(?:orchestrator|runner|writeback))/;

const CALLERS = [
  "src/commands/init.ts",
  "src/commands/regen.ts",
  "src/commands/status.ts",
  "src/commands/watch.ts",
  "src/commands/doctor.ts",
  "src/mcp/server.ts",
  "src/mcp/tools.ts",
  "scripts/sync-context-staged.mjs",
];

describe("verify never auto-runs", () => {
  const root = process.cwd();
  for (const path of CALLERS) {
    it(`${path} does not import verify internals`, async () => {
      let text = "";
      try {
        text = await readFile(join(root, path), "utf-8");
      } catch {
        return; // File may not exist; skip silently.
      }
      expect(FORBIDDEN_IMPORT.test(text)).toBe(false);
    });
  }
});
