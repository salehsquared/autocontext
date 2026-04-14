import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTmpDir, cleanupTmpDir } from "../helpers.js";
import { buildProvenance } from "../../src/bench/provenance.js";
import { SCHEMA_VERSION } from "../../src/core/schema.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await createTmpDir();
});

afterEach(async () => {
  await cleanupTmpDir(tmpDir);
});

describe("buildProvenance", () => {
  it("captures seed + model + versions + pack budget", async () => {
    const prov = await buildProvenance({
      projectRoot: tmpDir,
      seed: 42,
      iterations: 1,
      armSet: ["baseline", "context"],
      categorySet: ["comprehension"],
      provider: "anthropic",
      model: "claude",
    });
    expect(prov.seed).toBe(42);
    expect(prov.iterations).toBe(1);
    expect(prov.arm_set).toEqual(["baseline", "context"]);
    expect(prov.provider).toBe("anthropic");
    expect(prov.model).toBe("claude");
    expect(prov.schema_version).toBe(SCHEMA_VERSION);
    expect(prov.pack_budget_default).toBe(4000);
    expect(typeof prov.question_template_version).toBe("number");
    expect(typeof prov.token_estimator_version).toBe("number");
    expect(typeof prov.autocontext_version).toBe("string");
  });

  it("returns null for index_version when no .autocontext/ exists", async () => {
    const prov = await buildProvenance({
      projectRoot: tmpDir,
      seed: 1,
      iterations: 1,
      armSet: ["baseline"],
      categorySet: [],
      provider: "x",
      model: "y",
    });
    expect(prov.index_version).toBeNull();
  });

  it("produces identical provenance across back-to-back calls with the same inputs", async () => {
    const a = await buildProvenance({
      projectRoot: tmpDir,
      seed: 42,
      iterations: 1,
      armSet: ["baseline", "context", "pack"],
      categorySet: ["comprehension"],
      provider: "a",
      model: "b",
    });
    const b = await buildProvenance({
      projectRoot: tmpDir,
      seed: 42,
      iterations: 1,
      armSet: ["baseline", "context", "pack"],
      categorySet: ["comprehension"],
      provider: "a",
      model: "b",
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
