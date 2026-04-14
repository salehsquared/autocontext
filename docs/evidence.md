# Evidence Contract

Evidence is machine-collected code health data embedded in `.context.yaml` files. It captures the state of tests, type checking, linting, and coverage by reading existing artifact files — never by running commands.

## Principles

- **Read-only** — autocontext never executes test runners, linters, or compilers. It only reads files that already exist on disk. The `commit_sha` field is resolved by reading `.git/HEAD` (pure file I/O, no process execution).
- **Opt-in** — evidence collection requires the `--evidence` flag on `init` or `regen`.
- **Timestamped** — `collected_at` records when evidence was gathered (ISO 8601).
- **Commit-anchored** — `commit_sha` records which git commit the evidence corresponds to. Compare against current HEAD to detect staleness.
- **Tool-attributed** — `test_tool`, `typecheck_tool`, and `lint_tool` record which tool produced each artifact.
- **Per-directory** — each directory reports only its own local artifacts. No inheritance or fallback from parent directories. Directories without local artifacts simply have no evidence block.

## Schema

All fields except `collected_at` are optional.

```yaml
evidence:
  collected_at: "2026-02-13T10:00:00Z"
  commit_sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
  test_status: "passing"        # "passing" | "failing" | "unknown"
  test_count: 142
  failing_tests:
    - "auth.test.ts > refresh token race condition"
  test_tool: "vitest"
  typecheck: "clean"            # "clean" | "errors" | "unknown"
  typecheck_tool: "tsc"
  lint_status: "clean"          # "clean" | "errors" | "unknown"
  lint_tool: "eslint"
  coverage_percent: 87.3
```

| Field | Type | Description |
|---|---|---|
| `collected_at` | `string` | **Required.** ISO 8601 timestamp of evidence collection. |
| `commit_sha` | `string` | Git commit SHA at time of collection. Read from `.git/HEAD`. |
| `test_status` | `enum` | `"passing"`, `"failing"`, or `"unknown"`. |
| `test_count` | `integer` | Total number of tests. |
| `failing_tests` | `string[]` | Names of failing test suites. |
| `test_tool` | `string` | Test runner that produced the artifact (e.g. `"vitest"`, `"jest"`, `"junit"`). |
| `typecheck` | `enum` | `"clean"`, `"errors"`, or `"unknown"`. |
| `typecheck_tool` | `string` | Type checker (e.g. `"tsc"`, `"mypy"`). |
| `lint_status` | `enum` | `"clean"`, `"errors"`, or `"unknown"`. |
| `lint_tool` | `string` | Linter (e.g. `"eslint"`, `"ruff"`). |
| `coverage_percent` | `number` | Line coverage percentage (0-100). |

The evidence object uses `.strict()` validation — unknown fields are rejected.

## Artifact Search Paths

Evidence is collected by reading these files from the directory being analyzed:

### Test artifacts

| File | Format | Detected tool |
|---|---|---|
| `.vitest-results.json` | Vitest JSON (`{ success, numTotalTests, ... }`) | `vitest` |
| `test-results.json` | Jest/Vitest JSON (`{ success, numTotalTests, ... }`) | `jest` or `vitest` (distinguished by `startTime` field) |
| `junit.xml` | JUnit XML (`<testsuite tests="..." failures="..." errors="...">`) | `junit` |
| `test-results.xml` | JUnit XML (same format) | `junit` |

Priority: `.vitest-results.json` > `test-results.json` > JUnit XML. First match wins.

### Typecheck artifacts

| File | Format | Detected tool |
|---|---|---|
| `tsconfig.tsbuildinfo` | TypeScript build info (existence + mtime check) | `tsc` |

`tsc --build` only writes `tsbuildinfo` when compilation succeeds. autocontext compares the artifact's mtime against the newest source file mtime in the directory:
- Artifact mtime >= newest source mtime → `typecheck: "clean"`
- Artifact mtime < newest source mtime → `typecheck: "unknown"` (stale — sources changed since last build)

### Lint artifacts

| File | Format | Detected tool |
|---|---|---|
| `.eslintcache` | ESLint cache (existence + mtime check) | `eslint` |

Same mtime comparison as typecheck: fresh artifact → `"clean"`, stale artifact → `"unknown"`.

### Coverage artifacts

| File | Format | Extracted field |
|---|---|---|
| `coverage/coverage-summary.json` | Istanbul/c8 (`{ total: { lines: { pct } } }`) | `coverage_percent` |
| `coverage.json` | pytest-cov (`{ totals: { percent_covered } }`) | `coverage_percent` |

Priority: Istanbul/c8 format checked first.

## Freshness of Evidence

Evidence staleness can be detected using two fields:

1. **`collected_at`** — compare against current time. Old timestamps suggest stale evidence.
2. **`commit_sha`** — compare against current HEAD. If they differ, code has changed since evidence was collected.

### CI guidance

For accurate evidence in CI, run your tools before regenerating context:

```bash
npm test                          # produces test-results.json
npx tsc --build                   # produces tsconfig.tsbuildinfo
npx eslint . --cache              # produces .eslintcache
npx c8 --reporter=json-summary    # produces coverage/coverage-summary.json
context regen --all --evidence     # collects evidence from all artifacts
```

## Per-Directory Scoping

Each directory reports only evidence from artifacts found in its own directory. There is no fallback to root or parent directories.

This means:
- A subdirectory with its own `test-results.json` gets its own test evidence
- A subdirectory without any test artifacts gets no test evidence
- Root-level test results do not propagate to subdirectories

This prevents misattribution — a subdirectory appearing "healthy" because it inherited root-level test results when it has no test suite of its own.

## For Tool Producers

If you want autocontext to pick up your tool's output, write artifacts in these standard formats:

- **Test results**: Jest/Vitest JSON format with `success`, `numTotalTests`, `numFailedTests` fields
- **Type checking**: `tsc --build` produces `tsconfig.tsbuildinfo` automatically
- **Linting**: `eslint --cache` produces `.eslintcache` automatically
- **Coverage**: Istanbul/c8 `coverage-summary.json` with `total.lines.pct` field

## For Evidence Consumers

When reading evidence from `.context.yaml`:

1. Check `collected_at` — if it's old, evidence may not reflect current code
2. Compare `commit_sha` against current HEAD — if they differ, evidence is from a different version
3. Use `test_tool` / `typecheck_tool` / `lint_tool` for provenance — know which tool produced the data
4. `typecheck: "unknown"` and `lint_status: "unknown"` mean the artifact exists but is stale (sources changed since)
5. Evidence is always in `derived_fields` — it is machine-collected ground truth (when fresh)

## Active verification (`context verify`)

`context verify` closes the read-only loop: it runs your own test/typecheck/lint/coverage commands, normalizes the output to the enums in this document, and writes the result back into the `evidence:` block of the appropriate `.context.yaml` files. See [docs/verify.md](verify.md) for config, security model, parsers, CI example, and exit codes.

### Sidecar (rejected for v1)

The roadmap previously considered writing verify's output to a separate `.context.evidence.yaml` sidecar file. Rejected, for the record:

- **Single source of truth.** Every existing reader (`context health`, `doctor`, `aggregate_evidence` MCP tool, `check_policies`) already expects inline `evidence:`. A sidecar doubles every read path.
- **Atomicity.** Inline evidence updates in the same YAML write as `last_updated`. A sidecar can diverge.
- **Discoverability.** Users grep `.context.yaml` for "did the tests pass?". A sidecar is invisible.
- **Schema surface.** No new schema, no new validation, no version bump.
