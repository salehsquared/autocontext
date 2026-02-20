import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { detectImportBindings } from "../src/generator/imports.js";
import { createTmpDir, cleanupTmpDir, createFile, makeScanResult } from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("detectImportBindings", () => {
  // --- TS/JS ---

  it("extracts named imports from ES imports", async () => {
    await createFile(tmpDir, "index.ts", [
      'import { Scanner, flattenBottomUp } from "../core/scanner.js";',
      'import { readFile } from "node:fs/promises";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("../core/scanner.js");
    expect(result[0].symbols).toEqual(["Scanner", "flattenBottomUp"]);
  });

  it("extracts type-only imports", async () => {
    await createFile(tmpDir, "index.ts", [
      'import type { ContextFile } from "./schema.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("./schema.js");
    expect(result[0].symbols).toEqual(["ContextFile"]);
  });

  it("extracts default imports", async () => {
    await createFile(tmpDir, "index.ts", [
      'import Config from "./config.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].symbols).toEqual(["default as Config"]);
  });

  it("extracts namespace imports", async () => {
    await createFile(tmpDir, "index.ts", [
      'import * as utils from "./utils.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].symbols).toEqual(["* as utils"]);
  });

  it("extracts side-effect imports", async () => {
    await createFile(tmpDir, "index.ts", [
      'import "./polyfill.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("./polyfill.js");
    expect(result[0].symbols).toEqual(["(side-effect)"]);
  });

  it("extracts re-exports", async () => {
    await createFile(tmpDir, "index.ts", [
      'export { foo, bar } from "./helpers.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("./helpers.js");
    expect(result[0].symbols).toEqual(["bar", "foo"]);
  });

  it("extracts CJS destructured require", async () => {
    await createFile(tmpDir, "old.js", [
      'const { helper, utils } = require("./lib.js");',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["old.js"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].symbols).toEqual(["helper", "utils"]);
  });

  it("captures aliased imports", async () => {
    await createFile(tmpDir, "index.ts", [
      'import { foo as bar, baz as qux } from "./mod.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].symbols).toEqual(["baz as qux", "foo as bar"]);
  });

  it("merges symbols across files importing same path", async () => {
    await createFile(tmpDir, "a.ts", 'import { foo } from "../shared/utils.js";');
    await createFile(tmpDir, "b.ts", 'import { bar } from "../shared/utils.js";');

    const scan = makeScanResult(tmpDir, { files: ["a.ts", "b.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("../shared/utils.js");
    expect(result[0].symbols).toEqual(["bar", "foo"]);
  });

  it("skips non-relative imports", async () => {
    await createFile(tmpDir, "index.ts", [
      'import { z } from "zod";',
      'import chalk from "chalk";',
      'import { readFile } from "node:fs/promises";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toEqual([]);
  });

  it("caps at 20 entries", async () => {
    const imports = Array.from({ length: 25 }, (_, i) =>
      `import { x${i} } from "../mod${i}/index.js";`
    ).join("\n");
    await createFile(tmpDir, "big.ts", imports);

    const scan = makeScanResult(tmpDir, { files: ["big.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(20);
  });

  it("sorts entries by path", async () => {
    await createFile(tmpDir, "index.ts", [
      'import { z } from "./zoo.js";',
      'import { a } from "./alpha.js";',
      'import { m } from "./mid.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result.map(r => r.path)).toEqual(["./alpha.js", "./mid.js", "./zoo.js"]);
  });

  it("sorts symbols alphabetically within each entry", async () => {
    await createFile(tmpDir, "index.ts", [
      'import { Zebra, Alpha, Middle } from "./animals.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result[0].symbols).toEqual(["Alpha", "Middle", "Zebra"]);
  });

  // --- Python ---

  it("extracts Python relative imports", async () => {
    await createFile(tmpDir, "handler.py", [
      "from .models import User, Role",
      "from ..utils import format_date",
      "import os",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["handler.py"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(2);

    const models = result.find(r => r.path === ".models");
    expect(models?.symbols).toEqual(["Role", "User"]);

    const utils = result.find(r => r.path === "..utils");
    expect(utils?.symbols).toEqual(["format_date"]);
  });

  it("handles Python wildcard import", async () => {
    await createFile(tmpDir, "handler.py", "from .models import *\n");

    const scan = makeScanResult(tmpDir, { files: ["handler.py"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].symbols).toEqual(["*"]);
  });

  // --- Rust ---

  it("extracts Rust grouped use imports", async () => {
    await createFile(tmpDir, "main.rs", [
      "use crate::config::{Config, Settings};",
      "use std::io;",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["main.rs"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("crate::config");
    expect(result[0].symbols).toEqual(["Config", "Settings"]);
  });

  it("extracts Rust single use imports", async () => {
    await createFile(tmpDir, "main.rs", "use crate::handlers::Router;\n");

    const scan = makeScanResult(tmpDir, { files: ["main.rs"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("crate::handlers");
    expect(result[0].symbols).toEqual(["Router"]);
  });

  // --- Go ---

  it("returns empty for Go files (no named bindings)", async () => {
    await createFile(tmpDir, "main.go", [
      'package main',
      '',
      'import (',
      '  "fmt"',
      '  "os"',
      ')',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["main.go"] });
    const result = await detectImportBindings(scan);
    expect(result).toEqual([]);
  });

  // --- Edge cases ---

  it("skips non-source files", async () => {
    await createFile(tmpDir, "data.json", '{"import": "not real"}');
    const scan = makeScanResult(tmpDir, { files: ["data.json"] });
    const result = await detectImportBindings(scan);
    expect(result).toEqual([]);
  });

  it("handles unreadable files gracefully", async () => {
    const scan = makeScanResult(tmpDir, { files: ["missing.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toEqual([]);
  });

  it("returns empty for directory with no relative imports", async () => {
    await createFile(tmpDir, "index.ts", 'const x = 1;\nexport default x;\n');
    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toEqual([]);
  });

  it("extracts lowercase default imports", async () => {
    await createFile(tmpDir, "index.ts", [
      'import config from "./config.js";',
      'import helper from "../utils/helper.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(2);
    expect(result.find(r => r.path === "./config.js")?.symbols).toEqual(["default as config"]);
    expect(result.find(r => r.path === "../utils/helper.js")?.symbols).toEqual(["default as helper"]);
  });

  it("extracts combined default + named imports", async () => {
    await createFile(tmpDir, "index.ts", [
      'import React, { useState, useEffect } from "./react.js";',
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("./react.js");
    expect(result[0].symbols).toEqual(["default as React", "useEffect", "useState"]);
  });

  it("handles side-effect import without semicolon", async () => {
    await createFile(tmpDir, "index.ts", 'import "./setup.js"\n');

    const scan = makeScanResult(tmpDir, { files: ["index.ts"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("./setup.js");
    expect(result[0].symbols).toEqual(["(side-effect)"]);
  });

  it("extracts Python multiline parenthesized imports", async () => {
    await createFile(tmpDir, "handler.py", [
      "from .models import (",
      "    User,",
      "    Role,",
      "    Permission",
      ")",
    ].join("\n"));

    const scan = makeScanResult(tmpDir, { files: ["handler.py"] });
    const result = await detectImportBindings(scan);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(".models");
    expect(result[0].symbols).toEqual(["Permission", "Role", "User"]);
  });
});
