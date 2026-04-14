# Validation

`context validate` checks `.context.yaml` files for correctness. Two modes: standard (schema compliance) and strict (cross-reference against source code).

## Standard Validation

```bash
context validate
```

Checks every `.context.yaml` in the project:

1. **YAML syntax** — is the file valid YAML?
2. **Schema compliance** — does it pass Zod validation? Required fields present, correct types, valid enum values.
3. **Root advisory** — warns (does not fail) if the root context is missing `project` or `structure` fields.

```
  ✓ (root)
  ✓ src
  ✓ src/core
  ✗ src/commands
       summary: Required

3 valid, 1 invalid, 0 missing.
```

Exit code is `1` if any file is invalid. Use this in CI to catch broken context files.

## Strict Validation

```bash
context validate --strict
```

Runs standard validation plus four cross-reference checks that compare context content against actual source code.

Note: file list cross-checks only run when a context has a `files` field. Lean contexts often omit `files`, so strict mode reports that this specific check was skipped.

### 1. Phantom Files

Files listed in `files` that don't exist on disk.

```
  ⚠ strict: phantom file: deleted-module.ts (listed but not on disk)
```

**Cause:** A file was deleted but the context wasn't regenerated.
**Fix:** `context regen <directory>`

### 2. Unlisted Files

Files on disk that aren't listed in `files`.

```
    strict: unlisted file: new-helper.ts (on disk but not in context)
```

**Cause:** A new file was added but the context wasn't regenerated.
**Severity:** Info (not warning) — new files are expected during development.
**Fix:** `context regen <directory>`

### 3. Phantom Interfaces

Interfaces declared in context but not found in code exports.

```
  ⚠ strict: phantom interface: oldFunction (declared but not found in code)
```

**How it works:**
- Reads all source files and detects exports using tree-sitter AST (for TypeScript, JavaScript, Python, Go, Rust) or regex fallback (all other languages)
- Compares declared interface names against detected exports
- Extracts the leading identifier from signature-style names: `verifyToken(token): User` checks for `verifyToken`
- Skips non-identifier names entirely: `POST /login`, `GET /users` are not checked (they're endpoints, not code exports)

**Cause:** A function/class was removed or renamed but the context still references it.
**Fix:** `context regen <directory>`

### 4. Dependency Cross-Check

Compares declared `dependencies.internal` against import statements detected in source files.

```
    strict: declared internal dep not found in imports: ../utils
    strict: undeclared internal dep found in imports: ../helpers
```

**Important caveat:** This check only runs when `dependencies.internal` has at least one entry. If the field is absent or empty, undeclared imports won't be flagged. This is intentional — static-generated context files often don't populate internal deps, and flagging every import would produce noise. See [limitations.md](limitations.md).

**Cause:** Dependencies were added or removed but context wasn't updated.
**Fix:** `context regen <directory>`

## Severity Levels

| Finding | Severity | Meaning |
|---|---|---|
| Phantom files | Warning | Listed file doesn't exist — context is definitely wrong |
| Phantom interfaces | Warning | Declared interface not found — likely stale |
| Unlisted files | Info | New file not yet documented — expected during development |
| Undeclared deps | Info | Import exists but isn't declared — context is incomplete |
| Declared dep not found | Info | Declared dep not detected in imports — may have been removed |
| File cross-ref skipped (lean) | Info summary | `files` field was absent, so file list checks were skipped |

## Summary Output

```
3 valid, 1 invalid, 0 missing.
strict: 2 warnings, 3 info; 5 lean contexts (file cross-ref skipped) across 8 directories
```

Exit code is `1` only for schema validation failures (invalid files), not for strict findings. Strict findings are reported but don't change the exit code. To fail CI on strict findings, parse the output or use a wrapper script.

## Recommended Workflow

```bash
# During development — quick schema check
context validate

# Before committing — full cross-reference
context validate --strict

# In CI — see docs/ci.md for pipeline setup
context validate --strict
```

## Policy Engine

`context validate --policy` runs the typed policy engine over `rules:` blocks in every `.context.yaml`. Seven rule kinds, no DSL, no call-graph reasoning. See [docs/policies.md](policies.md) for the rule reference, glob dialect, JSON output schema, CI integration, and the `check_policies` MCP tool.

Policy evaluation requires a built code index (`context index`); without one, the command exits 2.
