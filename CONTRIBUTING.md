# Contributing to autocontext

## Requirements

- Node.js >= 18
- npm (ships with Node)

## Setup

```bash
git clone https://github.com/salehsquared/autocontext.git
cd autocontext
npm install
npm run build
```

## Running Tests

```bash
npm test                  # Unit tests (vitest)
npm run test:conformance  # Schema conformance suite (ajv + Zod parity)
npm run test:e2e          # E2E smoke test (npm pack → install → run CLI)
npm run lint              # Type-check (tsc --noEmit)
```

All four must pass before submitting a PR.

## Project Structure

```
src/
  core/         Schema, scanner, fingerprint, reader/writer, semantic fingerprint, git helpers
  commands/     CLI command handlers (init, status, regen, impact, pack, verify, view, …)
  generator/    Static analysis and LLM-based context generation
  mcp/          MCP server, tool registration, navigation handlers, capabilities resource
  utils/        Config loading, display helpers, token estimation
  index/        Local code index (T1): NDJSON store, TS/JS/Python analyzers, builder
  impact/       Reverse-BFS impact analysis (T2)
  pack/         Token-budgeted context pack compiler (T3): BM25F, proximity, assembly
  policy/       Typed-rule evaluators (T4) + engine
  cache/        Content-addressed LLM response cache (T7)
  verify/       Active verification runner + parsers (T9)
  view/         Self-contained HTML viewer (T10)
  bench/        Benchmark harness + arms + ground-truth generators (T12)
  providers/    LLM provider adapters (Anthropic / OpenAI / Google / Ollama)
  lib.ts        Curated public library barrel
tests/          Mirrors src/ structure — one test file per source file
  fixtures/     Fixtures: index-precision/, impact-labels/, bench-small, …
conformance/    Data-driven schema test cases (valid/ and invalid/)
docs/           User-facing documentation
scripts/        Build helpers (schema generation, grammar building, compare-bench, …)
```

## Making Changes

1. Branch from `main`
2. Make your changes
3. Run `npm test && npm run test:conformance && npm run test:e2e && npm run lint`
4. Submit a PR against `main`

## Schema Changes

If you modify `src/core/schema.ts`:

1. Run `npm run generate:schemas` to regenerate `.context.schema.json` and `.context.config.schema.json`
2. Add or update conformance cases in `conformance/valid/` and `conformance/invalid/`
3. Update `docs/schema.md` if field descriptions changed
4. Check `docs/versioning.md` — new optional fields are patch-level; new required fields or type changes require a version bump

## Test Conventions

- Mirror `src/` paths: `src/core/scanner.ts` → `tests/core/scanner.test.ts`
- Use helpers from `tests/helpers.ts` (`makeValidContext`, `createTmpDir`, `cleanupTmpDir`, `createFile`)
- For tests that need the index, use `createMemoryIndexStore` from `tests/helpers/memory-index-store.ts` — an in-memory `IndexStore` adapter.
- Clean up temp directories in `afterEach` blocks
- Use `vitest` (`describe`, `it`, `expect`)

### Test groups by track

| Directory | Owner | What to run when touching |
|---|---|---|
| `tests/index/` | T1 | `src/index/` — index storage, TS/JS/Python analyzers, builder, resolver |
| `tests/impact/` | T2 | `src/impact/` — reverse-BFS over the graph |
| `tests/pack/` | T3 | `src/pack/` — tokenize, BM25, graph proximity, pack assembly |
| `tests/policy/` | T4 | `src/policy/` — glob matcher, seven evaluators, engine |
| `tests/verify/` | T9 | `src/verify/` — runner, nine parsers, orchestrator, no-auto-run lint |
| `tests/view/` | T10 | `src/view/` — collect, render, HTML guards |
| `tests/lib/` | T11 | `src/lib.ts` — stable + experimental surface, no-internal-leak lint |
| `tests/mcp/compat.test.ts` | T11 | Byte-identical output lock for the 4 legacy MCP tools (never bypass) |
| `tests/bench/` | T12 | Parsers, ground-truth symbols, pack prompts, aggregator matrix, provenance |
| `conformance/` | T4 + T9 | Any schema change — must round-trip ajv + Zod + validate both polarities |

### Precision fixtures

- `tests/fixtures/index-precision/` (T1-B) — labeled fixture for measuring analyzer precision/recall. Don't tweak labels without re-running the precision harness.
- `tests/fixtures/impact-labels/` (T2) — labeled impact set for bounded-scope fixtures. Same discipline.

### Before perf-sensitive PRs

Run `context bench --json --allow-stale > new.json` and compare against the committed baseline:

```bash
node scripts/compare-bench.mjs bench/baselines/autocontext-self.json new.json
```

Exits 1 when any `arm_deltas[*].accuracy_gain` dropped by more than 0.02. See [docs/bench.md](docs/bench.md).

## Code Style

- TypeScript strict mode
- ES modules with `.js` extensions in imports
- Match existing patterns — look at neighboring files before writing new code
- No default exports

## Reporting Issues

Open an issue at [github.com/salehsquared/autocontext/issues](https://github.com/salehsquared/autocontext/issues) with:

- **Expected behavior**
- **Actual behavior**
- **Steps to reproduce**
- **Environment** (Node version, OS, autocontext version)
