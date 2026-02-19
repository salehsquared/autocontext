#!/usr/bin/env node

/**
 * Conformance test runner for autocontext schema.
 *
 * Validates YAML test cases against the published JSON Schema (via ajv)
 * and against the Zod schema (parity check). Exits with code 1 on any mismatch.
 *
 * Usage: node conformance/runner.mjs
 */

import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { contextSchema } from "../dist/core/schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

// Load the published JSON Schema
const schemaPath = resolve(root, ".context.schema.json");
const jsonSchema = JSON.parse(readFileSync(schemaPath, "utf-8"));

// Set up ajv
const ajv = new Ajv2020({ strict: false, allErrors: true });
const ajvValidate = ajv.compile(jsonSchema);

// Collect test cases from a directory
function collectCases(dir) {
  const fullDir = join(__dirname, dir);
  const files = readdirSync(fullDir).filter((f) => f.endsWith(".yaml") && f !== ".context.yaml");
  return files.map((f) => {
    const metaPath = join(fullDir, f.replace(".yaml", ".meta.json"));
    const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
    return {
      name: `${dir}/${f}`,
      yamlPath: join(fullDir, f),
      meta,
    };
  });
}

const validCases = collectCases("valid");
const invalidCases = collectCases("invalid");
const allCases = [...validCases, ...invalidCases];

console.log(
  `conformance: ${validCases.length} valid cases, ${invalidCases.length} invalid cases\n`
);

let passed = 0;
let failed = 0;
let parityMismatches = 0;

for (const testCase of allCases) {
  const { name, yamlPath, meta } = testCase;
  const expectedValid = meta.expected === "valid";

  // Step 1: Parse YAML
  let data;
  let yamlParseError = false;
  try {
    data = parse(readFileSync(yamlPath, "utf-8"));
  } catch {
    yamlParseError = true;
  }

  // Step 2: ajv validation (primary check)
  let ajvPass = false;
  if (!yamlParseError && data !== null && data !== undefined) {
    ajvPass = ajvValidate(data);
  }

  // Step 3: Zod validation (parity check)
  let zodPass = false;
  if (!yamlParseError && data !== null && data !== undefined) {
    zodPass = contextSchema.safeParse(data).success;
  }

  // Step 4: Check result against expectation
  const ajvMatchesExpected = ajvPass === expectedValid;

  // Step 5: Check parity
  const parity = ajvPass === zodPass;
  if (!parity) parityMismatches++;

  if (ajvMatchesExpected) {
    passed++;
    const ajvLabel = ajvPass ? "pass" : "fail";
    const zodLabel = zodPass ? "pass" : "fail";
    const parityWarn = parity ? "" : " [PARITY MISMATCH]";
    console.log(
      `  ${name.padEnd(45)} \u2713 (ajv: ${ajvLabel}, zod: ${zodLabel})${parityWarn}`
    );
  } else {
    failed++;
    const ajvLabel = ajvPass ? "pass" : "fail";
    const zodLabel = zodPass ? "pass" : "fail";
    console.log(
      `  ${name.padEnd(45)} \u2717 FAIL (expected: ${meta.expected}, ajv: ${ajvLabel}, zod: ${zodLabel})`
    );
    if (!ajvPass && ajvValidate.errors) {
      for (const err of ajvValidate.errors.slice(0, 3)) {
        console.log(`    ajv: ${err.instancePath || "/"} ${err.message}`);
      }
    }
  }
}

console.log(
  `\nconformance: ${passed}/${allCases.length} passed (${parityMismatches} parity mismatches)`
);

if (failed > 0 || parityMismatches > 0) {
  process.exit(1);
}
