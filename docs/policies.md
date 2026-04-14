# Policy rules

`rules:` is an optional sibling field to `constraints:` in every `.context.yaml`. Where `constraints:` carries free-form prose for humans, `rules:` carries typed assertions that `context validate --policy` can mechanically enforce against the local code index.

This is intentionally small: seven rule kinds, no DSL, no plugins, no call-graph reasoning. Every rule resolves to one or two reads against the T1 index (or, for `max_file_lines` / `require_test_file`, the filesystem).

## When to reach for rules vs. prose

- Prefer `constraints:` for intent a human must read ("all endpoints except /health require authentication"). These rarely map cleanly onto an import graph.
- Reach for `rules:` when the assertion is about imports, exports, file size, test colocation, or evidence thresholds — things CI can catch.

## Rule kinds

### `forbid_import`

Block imports from files matching `from` to targets matching `to`.

```yaml
rules:
  - kind: forbid_import
    from: src/server/**
    to:
      - src/client/**
      - "!src/client/types.ts"
    message: "server must not depend on browser code"
```

- `from` / `to` accept a string or an array of strings. Arrays allow negation (leading `!`) with last-match-wins semantics.
- When an import is unresolved (external package, broken path), `to` matches against the raw specifier, so `to: "lodash"` works.

### `require_import`

Every file matching `from` must have at least one import matching `to`.

```yaml
rules:
  - kind: require_import
    from: src/api/**/*.ts
    to: src/api/schema.ts
```

Re-exports count as imports (they register as `ImportEdge` rows), so the usual "every barrel must re-export from `./schema`" pattern works.

### `require_export`

At least one exported symbol named `name` must exist in the rule's subtree.

```yaml
rules:
  - kind: require_export
    name: buildPack
    symbol_kind: function    # optional: function | class | interface | type | constant | enum
```

Field name note: the symbol-kind filter is `symbol_kind`, not `kind`, to avoid colliding with the rule discriminator.

### `max_file_lines`

Every file in the rule's subtree must have ≤ `value` lines.

```yaml
rules:
  - kind: max_file_lines
    value: 500
    exclude:
      - "**/*.generated.ts"
```

`exclude` entries follow the same glob dialect (see below); last-match-wins for negations.

### `require_test_file`

Every source file matching `for` must have a sibling test file matching `pattern`. `{name}` = basename without extension, `{ext}` = extension without dot.

```yaml
rules:
  - kind: require_test_file
    for: src/**/*.ts
    pattern: "{name}.test.{ext}"
```

Test files are matched anywhere in the project, not just colocated — monorepos with `tests/` directories work out of the box. Files that already look like test files per the pattern are skipped (no "require tests for tests").

### `dependency_boundary`

Every import from a file matching `from` must have its target in one of the globs in `allowed_to`.

```yaml
rules:
  - kind: dependency_boundary
    from: src/policy/**
    allowed_to:
      - src/index/**
      - src/core/**
```

If you want "no imports allowed," use `forbid_import` with `to: "**"` instead.

### `evidence_requires`

Every `.context.yaml` in the rule's subtree must satisfy the stated evidence minimums.

```yaml
rules:
  - kind: evidence_requires
    test_status: passing
    typecheck: clean
    lint_status: clean
    coverage_min: 80
```

Allowed values match [docs/evidence.md](evidence.md) exactly:

- `test_status: passing`
- `typecheck: clean`
- `lint_status: clean`
- `coverage_min: 0..100`

A scope with no evidence block fails the rule.

## Glob dialect

Policy globs use a tiny dialect — no character classes, no extglob.

- `*` matches one path segment
- `**` matches zero or more path segments
- `?` matches a single character within a segment
- `{a,b}` brace expansion (no nesting)
- `!pattern` negates when the glob is part of an array (last-match-wins)

Paths are project-relative POSIX. The colon in `node:fs` is a literal character, so `to: "node:**"` matches every node-prefixed specifier.

## Scope and inheritance

Rules are **subtree-scoped**: a rule declared in `D/.context.yaml` applies to `D` and every descendant directory. Put project-wide rules in the root `.context.yaml`; put narrower rules deeper. `rules:` blocks do not merge from parent to child — each directory's block is evaluated independently (and then runs over its own subtree).

To narrow scope without moving the rule, tighten the `from` / `for` glob.

## Running the engine

```bash
# Human output.
context validate --policy

# Machine-readable JSON (suppresses human output).
context validate --policy --json

# Schema strict mode + policy together.
context validate --strict --policy
```

`--policy` requires the local code index. If `.autocontext/index/` is missing or version-mismatched, the command exits 2 with a message instructing you to run `context index`.

### Exit codes

| Condition | Exit code |
|---|---|
| Schema valid, no policy violations | 0 |
| Schema invalid anywhere, or any policy violation | 1 |
| `--policy` requested but index is missing/stale | 2 |

### JSON output

```json
{
  "summary": {
    "rules_evaluated": 4,
    "rules_passed": 1,
    "violations": 3,
    "scopes": 2,
    "schema_invalid": 0,
    "schema_missing": 0,
    "truncated": false
  },
  "violations": [
    {
      "rule_kind": "forbid_import",
      "rule_index": 0,
      "scope": "src/server",
      "severity": "error",
      "message": "server code must not depend on browser code",
      "file": "src/server/api.ts",
      "line": 4,
      "to": "src/client/types.ts"
    }
  ],
  "schema_findings": []
}
```

This shape is a stable contract — we add fields, we do not rename or remove them.

## MCP: `check_policies`

The MCP tool `check_policies` mirrors the CLI output:

```ts
{
  scope?: string;           // subtree to evaluate; default "."
  rule_kinds?: RuleKind[];  // optional filter
  path?: string;            // project root override
}
→ {
  ok: boolean;
  scope: string;
  rules_evaluated: number;
  rules_passed: number;
  violations: Violation[];
  index_state: "ready" | "missing" | "stale";
  truncated: boolean;
  contexts_scanned: number;
}
```

Results are capped at 500 violations; excess is dropped and `truncated` flips to `true`. When the index is missing or stale, `violations` is empty and `ok` is `false` — retry after running `context index`.

## CI integration

```yaml
- run: npx autocontext index
- run: npx autocontext validate --policy --json > policy.json
- run: jq -e '.summary.violations == 0' policy.json
```

The `--json` output schema is documented above. Prefer parsing `summary.violations` over grepping human output.

## Versioning

`rules:` is an additive v1 field — the schema version stays `1`. Future minors may add new rule kinds; older binaries reading a file that contains an unknown rule kind will fail validation cleanly with "expected kind to be one of …". The documented remedy is to update the binary.

## Limitations

- No call-graph reasoning. `forbid_import` looks at import statements, not transitive call paths.
- No type-aware checks. For "this function returns the wrong type," reach for `tsc` / `pyright`.
- No custom rule plugins in v1. Extending requires a schema + evaluator change.
- No `--fix` mode. `validate --policy` reports and never edits files.
- No rule-disable directive. Narrow the `from` / `for` glob or move the rule deeper.
