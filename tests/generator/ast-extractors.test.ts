import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createTmpDir, cleanupTmpDir, createFile, makeScanResult } from "../helpers.js";
import { extractDataModels } from "../../src/generator/extractors/data-models.js";
import { extractEvents } from "../../src/generator/extractors/events.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("extractDataModels — TypeScript", () => {
  it("captures interfaces, object-typed type aliases, and class fields", async () => {
    await writeFile(
      join(tmpDir, "models.ts"),
      `export interface User { id: string; email: string; }
       export type Token = { value: string; expiresAt: number };
       export class Invoice { id!: string; total!: number; }
       type Primitive = string; // object-less alias — should be skipped
       interface Marker {}      // empty — should be skipped`,
    );
    const out = await extractDataModels(
      makeScanResult(tmpDir, { files: ["models.ts"] }),
    );
    expect(out).toHaveLength(3);
    expect(out[0]).toBe("interface User { id: string, email: string }");
    expect(out[1]).toBe("type Token { value: string, expiresAt: number }");
    expect(out[2]).toBe("class Invoice { id: string, total: number }");
  });

  it("clips wrapped long types to their outermost constructor and caps fields per model", async () => {
    const fields = Array.from(
      { length: 12 },
      (_, i) => `f${i}: Array<SomeVeryLongFullyQualifiedIdentifier>`,
    ).join(";");
    await writeFile(join(tmpDir, "big.ts"), `export interface Big { ${fields}; }`);
    const out = await extractDataModels(
      makeScanResult(tmpDir, { files: ["big.ts"] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^interface Big \{ f0: Array, f1: Array, .*\+4 more \}$/);
  });
});

describe("extractDataModels — Python", () => {
  it("detects dataclasses and BaseModel subclasses with typed fields", async () => {
    await writeFile(
      join(tmpDir, "settings.py"),
      `from dataclasses import dataclass
from pydantic import BaseModel


@dataclass
class Settings:
    host: str
    port: int = 5432


class Config(BaseModel):
    debug: bool
    retries: int
`,
    );
    const out = await extractDataModels(
      makeScanResult(tmpDir, { files: ["settings.py"] }),
    );
    expect(out).toEqual([
      "dataclass Settings { host: str, port: int }",
      "class Config { debug: bool, retries: int }",
    ]);
  });

  it("ignores untyped / underscore-prefixed / markerless classes", async () => {
    await writeFile(
      join(tmpDir, "noise.py"),
      `class _Private:
    x: int


class Regular:
    x = 5  # plain assignment, no annotation


class Marker:
    pass
`,
    );
    const out = await extractDataModels(
      makeScanResult(tmpDir, { files: ["noise.py"] }),
    );
    expect(out).toEqual([]);
  });
});

describe("extractEvents", () => {
  it("captures EventEmitter and addEventListener patterns", async () => {
    await createFile(
      tmpDir,
      "bus.ts",
      `import { EventEmitter } from "node:events";
       const bus = new EventEmitter();
       bus.emit("user.created", { id: 1 });
       bus.on("user.created", (u) => console.log(u));
       document.addEventListener("click", () => {});`,
    );
    const out = await extractEvents(
      makeScanResult(tmpDir, { files: ["bus.ts"] }),
    );
    expect(out).toContain('emit("user.created") via bus');
    expect(out).toContain('on("user.created") via bus');
    expect(out).toContain('addEventListener("click") on document');
  });

  it("skips false positives on noisy globals", async () => {
    await createFile(
      tmpDir,
      "noise.ts",
      `console.log("hi");
       const m = Math.max(1, 2);
       JSON.parse("{}");`,
    );
    const out = await extractEvents(
      makeScanResult(tmpDir, { files: ["noise.ts"] }),
    );
    expect(out).toEqual([]);
  });

  it("ignores events in comments", async () => {
    await createFile(
      tmpDir,
      "commented.ts",
      `// bus.emit("ignored")
       /* bus.on("also-ignored", cb); */`,
    );
    const out = await extractEvents(
      makeScanResult(tmpDir, { files: ["commented.ts"] }),
    );
    expect(out).toEqual([]);
  });
});
