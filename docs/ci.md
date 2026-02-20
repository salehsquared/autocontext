# CI/CD Pipeline Guide

autocontext integrates into CI pipelines to enforce context quality. The key command is `context validate --strict`.
Examples below assume `autocontext` is in your repo `devDependencies` (`npm install -D autocontext`).

## GitHub Actions

### Minimal Gate

```yaml
name: Context Validation
on: [pull_request]

jobs:
  validate-context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm ci
      - run: npx context validate --strict
```

This fails the build if any `.context.yaml` has schema violations. Strict findings (phantom files, unlisted files) are reported but don't change the exit code — see "Fail Policy" below for stricter options.

### With Caching

```yaml
name: Context Validation
on: [pull_request]

jobs:
  validate-context:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
          cache: npm
      - run: npm ci
      - run: npx context validate --strict
```

## GitLab CI

```yaml
validate-context:
  image: node:18
  script:
    - npm ci
    - npx context validate --strict
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
```

## When to Run Each Command

| Command | When | Purpose |
|---|---|---|
| `context validate` | Every PR | Catch invalid YAML and schema violations |
| `context validate --strict` | Every PR | Also catch phantom files, interfaces, dependency drift |
| `context status` | Informational | Report staleness without failing |
| `context rehash` | After codegen or bulk changes | Recompute fingerprints, then commit |

### Commands You Should NOT Run in CI

| Command | Why Not |
|---|---|
| `context init` | Overwrites existing context files |
| `context regen --all --llm` | Costs money (LLM API calls), non-deterministic |
| `context regen --all --no-llm` | Safe but changes files — only for nightly/scheduled jobs |

## Fail Policy

`context validate` exits with code 1 on schema violations. Strict findings are printed but don't affect the exit code. To enforce stricter policies:

### Conservative: Fail on Any Warning

```yaml
- name: Validate context (strict)
  run: |
    OUTPUT=$(npx context validate --strict 2>&1)
    echo "$OUTPUT"
    if echo "$OUTPUT" | grep -q "strict:.*warning"; then
      echo "::error::Strict validation found warnings"
      exit 1
    fi
```

This enforces tight alignment between context files and source code. Good for projects where context accuracy is critical.

### Pragmatic: Fail on Phantom Files Only

```yaml
- name: Validate context (strict)
  run: |
    OUTPUT=$(npx context validate --strict 2>&1)
    echo "$OUTPUT"
    if echo "$OUTPUT" | grep -q "phantom file"; then
      echo "::error::Context references files that don't exist"
      exit 1
    fi
```

Catches the worst drift (referencing deleted files) while allowing unlisted new files and other info-level findings.

### Permissive: Warn Only

```yaml
- name: Validate context (strict)
  run: npx context validate --strict
  continue-on-error: true
```

Reports findings without blocking the PR. Useful during adoption when teams are still building habits around context maintenance.

## Nightly Regeneration

For teams that want automated context refresh:

```yaml
name: Nightly Context Refresh
on:
  schedule:
    - cron: '0 3 * * 1-5'  # 3am weekdays

jobs:
  refresh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
      - uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm ci
      - run: npx context regen --all --no-llm
      - name: Commit if changed
        run: |
          git diff --quiet || {
            git config user.name "github-actions"
            git config user.email "github-actions@github.com"
            git add -A '*.context.yaml'
            git commit -m "chore: refresh context files (static analysis)"
            git push
          }
```

This uses static analysis only (no LLM, no cost). For LLM regeneration, add API key secrets and use `--llm` instead.

## Recommended Pipeline

For most teams, start with this and tighten over time:

```
Week 1:  npx context validate              (catch broken YAML)
Week 2:  npx context validate --strict     (see drift reports)
Week 4:  Fail on phantom files         (enforce basics)
Month 2: Fail on all warnings          (enforce full alignment)
```
