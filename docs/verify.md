# `context verify`

Run the project's own test / typecheck / lint / coverage commands, normalize their output, and write the result into the `evidence:` block of the relevant `.context.yaml` files. Everything that already consumes `evidence:` (`context health`, `context doctor`, `aggregate_evidence` MCP tool, `check_policies`) gets fresher data automatically.

**`context verify` is opt-in.** `init`, `regen`, `status`, `watch`, `doctor`, MCP handlers, and the pre-commit hook never invoke it. The only entry point is this command.

## Security note (read first)

`context verify` runs **arbitrary shell commands** from your `.context.config.yaml`. Anyone who can edit that file can run anything as your shell user: `npm install` malware, `git pull` of an untrusted PR, etc.

Mitigations:
- **First-run prompt.** The first invocation prints the resolved commands and waits for `y`. A marker file at `.autocontext/verify.first-run` suppresses the prompt on later runs. `--yes` skips it from the start; `--dry-run` shows commands without prompting and without running.
- **Never auto-run.** See above — no other autocontext command triggers verify.
- **Review before running**, especially in untrusted repos. Commands are intentionally a string so they're easy to eyeball.

We intentionally do not sandbox the runner — the whole point is to invoke the project's own tools.

## Configure

Add a `verify:` block to `.context.config.yaml`. Commands accept a string or an object with extra knobs.

```yaml
provider: anthropic
verify:
  test: "npm test --silent -- --reporter=json --outputFile=test-results.json"
  typecheck: "npx tsc --noEmit"
  lint: "npx eslint . --format json --output-file=.eslint-results.json"
  coverage:
    command: "npx c8 --reporter=json-summary npm test --silent"
    artifact: "coverage/coverage-summary.json"
  default_timeout_seconds: 600
  scope_overrides:
    apps/web:
      test: "pnpm --filter web test -- --reporter=json --outputFile=test-results.json"
    packages/api:
      test: "pnpm --filter api test -- --reporter=json --outputFile=test-results.json"
```

### Object-form keys

| Key | Purpose |
|---|---|
| `command` | Shell command. Required. |
| `cwd` | Working directory (relative to project root). Defaults to the resolved scope. |
| `timeout_seconds` | Per-command timeout. Falls back to `default_timeout_seconds` then 600. |
| `env` | Extra env vars merged into `process.env`. |
| `artifact` | Path (relative to the resolved `cwd`) to a JSON/XML file the runner produces. Preferred over stdout parsing. |
| `parser` | Override the auto-detected parser. See list below. |

### Per-scope overrides

Rules of thumb:
- A scope inherits the root command unless it or an ancestor scope defines an override.
- Most-specific ancestor wins (`apps/web/admin` prefers `apps/web`'s override over the root).
- Overrides do not bubble to siblings.

## Supported parsers

| Parser | Detected by | Maps to |
|---|---|---|
| `vitest-json` | default for `test` | `test_status`, `test_count`, `failing_tests`, `test_tool: "vitest"` |
| `jest-json` | command contains `jest` | same shape; `test_tool: "jest"` |
| `junit-xml` | command/parser explicitly set | aggregates `<testsuite>` + extracts failing `<testcase>` |
| `go-test-json` | command contains `go test` | NDJSON aggregation; skip excluded from `test_count` |
| `tsc` | default for `typecheck` | `typecheck: "clean"|"errors"|"unknown"` (from exit + `error TS\d+:` grep) |
| `eslint-json` | default for `lint` | `lint_status: "clean"|"errors"` (warnings don't flip status) |
| `istanbul-summary` | default for `coverage` | `coverage_percent` from `total.lines.pct` |
| `pytest-cov` | command contains `pytest` or `--cov` | `coverage_percent` from `totals.percent_covered` |
| `exit-code` | default for `build` | No evidence write on success; promotes to `typecheck: "errors"` on failure if no typecheck ran |

## Running

```bash
# Verify the whole project (root .context.yaml).
context verify

# Verify a subtree.
context verify src/cli

# Only some kinds.
context verify --only test,lint

# Preview without running.
context verify --dry-run

# Merge instead of replace the evidence block.
context verify --merge

# CI-ready.
context verify --json --yes > verify.json
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | All configured kinds succeeded |
| 1 | At least one scope is `partial` or `failed`; with `--strict`, also any `unknown` |
| 2 | Config error (no `verify:`, unknown kind in `--only`, non-TTY + no `--yes` on first run) |
| 3 | User declined the first-run prompt |

### CI example (GitHub Actions)

```yaml
- run: npm ci
- run: npx autocontext verify --json --yes > verify.json
- run: jq -e '[.scopes[].status] | all(. == "ok")' verify.json
```

## Write-back model

- Default: **full replacement** of the scope's `evidence:` block. Guarantees the snapshot is internally consistent (no stale coverage from yesterday next to today's test results).
- `--merge`: merges new fields over the previous block. Use when you only ran `--only test` and want to keep yesterday's typecheck/lint.
- Every other field in `.context.yaml` (`summary`, `decisions`, `files`, …) is preserved verbatim via the round-trip writer.
- Writes are atomic (`writeFile` → `rename`) so Ctrl-C mid-run leaves the old file intact.

## Partial-success handling

If one kind passes and another fails, verify still writes the evidence it gathered. The scope's `status` becomes `partial`, not `failed`. This keeps `.context.yaml` files coherent across a run and surfaces the `unknown` / `failing` enums in the next health rollup.

## Limitations

- No coverage-delta reporting. `verify` writes the absolute percent; history is `context timeline`/`context diff` territory.
- No sidecar evidence store. Evidence stays inline in `.context.yaml` — the decision, and why, is documented at [docs/evidence.md](evidence.md).
- No auto-detect of test runners from `package.json`. You configure the exact command.
- `--changed` (impact-set scope filter) is a follow-up; until then `verify [scope]` is the narrowing mechanism.
