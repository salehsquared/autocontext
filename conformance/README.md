# Conformance Test Suite

Data-driven test cases for validating `.context.yaml` parsers against the autocontext schema.

## What This Tests

**Schema compliance only** — whether a `.context.yaml` file passes or fails JSON Schema validation. This does not test cross-reference checks (phantom files, unlisted files, etc.) or CLI behavior.

## Running the Suite

```bash
# Requires: npm run build (to generate dist/ and .context.schema.json)
node conformance/runner.mjs
```

The runner validates each test case two ways:
1. **ajv** against the published `.context.schema.json` (primary — this is what third parties consume)
2. **Zod** against the internal `contextSchema` (parity check — ensures JSON Schema and Zod agree)

Exit code is `1` if any case produces an unexpected result or if ajv and Zod disagree.

## Test Data Format

Each test case is a `.yaml` file with a companion `.meta.json`:

```
conformance/
  valid/
    minimal.yaml          # Test case
    minimal.meta.json     # Expected result
  invalid/
    missing-version.yaml
    missing-version.meta.json
```

### Meta file format

```json
{
  "description": "Human-readable description of what this tests",
  "expected": "valid",
  "category": "required-fields"
}
```

For invalid cases, an optional `error_field` identifies which field should cause the failure:

```json
{
  "description": "Missing required field: version",
  "expected": "invalid",
  "category": "required-fields",
  "error_field": "version"
}
```

`error_field` is advisory — validators differ in how they report error paths. A pass/fail check is sufficient for conformance.

### Categories

| Category | What it tests |
|---|---|
| `required-fields` | Missing required fields |
| `type-validation` | Wrong types, malformed entries |
| `optional-fields` | Valid use of optional fields |
| `root-fields` | Root-only fields (project, structure) |
| `provenance` | derived_fields and evidence |
| `version-guard` | Unsupported version values |
| `syntax` | Malformed YAML (parsing, not schema) |

## For Third-Party Implementors

To verify your own `.context.yaml` parser:

1. Read each `.yaml` file and parse it
2. Validate the parsed data against `.context.schema.json` (JSON Schema Draft 2020-12)
3. Compare your pass/fail result against `expected` in the companion `.meta.json`
4. The `bad-yaml-syntax` case tests YAML parsing — if your parser rejects it, that counts as a correct "invalid" result

You do not need to use our runner script. The test data is language-agnostic.
