# Changelog

All notable changes to autocontext will be documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Release semantics

- **Patch** (0.1.x): Bug fixes, doc corrections, new optional schema fields
- **Minor** (0.x.0): New commands, new MCP tools, new evidence sources, new provider support
- **Major** (x.0.0): Schema version bump (v1 → v2), breaking CLI flag changes, breaking MCP response shape changes

---

## [0.2.0] — 2026-04-14

Major minor: the 0.2.x line ships a local code index, token-budgeted prompt packs, typed policy rules, 4-state freshness, active verification, a self-contained HTML viewer, a library API, a twelve-tool MCP surface, and a rewritten agent instruction template emitted across four agent-file conventions. **Schema stays at v1** — every addition is optional; every legacy `.context.yaml` keeps parsing.

**Upgrade note.** Existing projects only need three one-shot actions after installing 0.2.x:

1. `context index --rebuild` — build the local symbol + reference graph at `.autocontext/index/`.
2. `context regen --all --stale` — populate the new `semantic_fingerprint` and the `environment`/`testing`/`todos`/`data_models`/`events`/`config` fields.
3. `context doctor` — confirm `.autocontext/` is gitignored (first run of `context init` does this automatically; older checkouts may need `echo '.autocontext/' >> .gitignore`).

Nothing else changes. `context status`, `check_freshness`, `list_contexts`, `query_context`, and `aggregate_evidence` all keep their v1 output shapes byte-for-byte — a compat snapshot at `tests/mcp/compat.test.ts` locks that down.

### Added — Agent instruction overhaul

- **Template rewrite.** `AGENTS.md` dropped from ~50 lines of advisory prose to ~30 lines of playbooks: routing (MCP vs CLI), before-edit, before-commit, do-not, 4-state freshness glossary, top-level-only directory map. Purpose-first opening redirects the agent's default grep reflex at the first sentence.
- **Multi-format emission** from a single canonical body: `AGENTS.md`, `CLAUDE.md`, `.github/copilot-instructions.md`, `.cursor/rules/autocontext.mdc` (MDC frontmatter with `alwaysApply: true`). Markdown formats use marker-based merge to preserve user content; Cursor's `.mdc` is owned outright.
- **`--agents-format <csv>`** CLI flag on `init` and `regen`. Accepts any subset of `agents,claude,copilot,cursor` plus `all` and `none`. Resolution precedence: CLI → `config.agents.formats` → auto-detect existing files → default `["agents"]`. Existing projects see no new files unless they already use that client.
- **`config.agents.formats`** optional block in `.context.config.yaml` for pinning the emit set.
- **`DEFAULT_MAINTENANCE` / `FULL_MAINTENANCE` compressed** from 6 lines each to 1 line each — removed ~840 lines of identical boilerplate across 84 `.context.yaml` files without losing keyword coverage.

### Added — Bench expansion (T12)

- **Three new comparator arms** — `pack`, `pack+impact`, `pack+policy`. Each
  exercises an upstream capability track (T3 retrieval, T2 impact, T4 policy)
  against the legacy `baseline`/`context` arms. The legacy `delta` field stays
  unchanged; new `arms`, `matrix`, and `arm_deltas` fields are additive.
- **Three new task categories** — `find-definition`, `find-callers`, and
  `impact-of-change`. Ground truth is synthesized exclusively from the T1 index
  (`IndexStore.findSymbolsByName` / `getReferencesTo`) and T2's `computeImpact`.
  Every task now carries a `ground_truth_provenance` block
  (`source` / `precision_class` / `recall_class`) so analyzers can filter or
  weight by confidence tier. Precision never exceeds what T1 can verify —
  import-bound references only.
- **`BenchReport.provenance`** — pins seed, versions (schema, index, BM25,
  impact, policy, question_template, token_estimator), provider/model, and
  autocontext git SHA. Two runs with the same tuple must produce byte-identical
  JSON modulo `timestamp` / `latency_ms`.
- **`scripts/compare-bench.mjs`** — regression canary. Diffs two JSON reports,
  exits 1 when `delta.accuracy_gain` or any `arm_deltas[arm].accuracy_gain`
  regressed beyond `--threshold` (default 0.02), and exits 2 when
  `question_template_version` or `schema_version` diverges.
- **Library exports** — `runBench`, `generateTasks`, `generateSymbolTasks`,
  `generateImpactTasks`, `buildProvenance`, `ARMS`, plus bench type aliases.
  All tagged `@stability experimental`.

### Added — Library API (T11)

- **`autocontext` is now consumable as a library.** `package.json` declares
  `main`, `types`, `exports`, and `sideEffects: false`. `import "autocontext"`
  resolves to the curated barrel at `dist/lib.js` — never to the CLI bin.
- **`src/lib.ts` curated surface** — every export tagged `@stability stable` or
  `@stability experimental`. Stable: `buildPack`, `formatPackJson`/`Markdown`,
  `scanProject`, `flattenBottomUp`, `readContext`, `writeContext`,
  `loadConfig`, `checkFreshness`, `legacyState`, `UnsupportedVersionError`,
  schema constants + types. Experimental: `openIndex`, `computeImpact`,
  `computeSemanticFingerprint`, `extractPolicyFacts`, `runPolicies` + types.
- **`docs/library.md`** — full reference, stability tiers, what's intentionally
  internal, module resolution.
- **MCP compat snapshot** (`tests/mcp/compat.test.ts`) — pins the byte-identical
  output shape of the four legacy MCP tools (`query_context`,
  `check_freshness`, `list_contexts`, `aggregate_evidence`). 4-state freshness
  stays exclusive to `explain_staleness`; legacy callers always see the
  3-state enum.

### Added

- **Local code index** (Track T1) — new on-disk code-intelligence index at
  `.autocontext/index/` that persists symbols, imports, import-bound
  references, and directory-level import edges. Populated by a tree-sitter
  analyzer for TypeScript, JavaScript (TS/JS), and Python in v1. Accessible
  via a new `IndexStore` interface (default NDJSON backend; pluggable for a
  future SQLite backend). Reference extraction is **import-bound only**
  (namespace member access, dynamic imports, and transitive re-export chains
  are out of scope); measured precision on fixture:
  - TS/JS: precision 1.00 / recall 1.00 (target: 0.95 / 0.70)
  - Python: precision 1.00 / recall 1.00 (target: 0.90 / 0.70)
- **New CLI command** — `context index [--rebuild]` builds or refreshes the
  local code index. Runs automatically after `context init` and full-tree
  `context regen` (including the pre-commit hook's path).
- **`.autocontext/` gitignore handling** — `context init` appends
  `.autocontext/` to `.gitignore` when the file exists; `context doctor`
  verifies the entry.
- **`INDEX_VERSION`** — internal version tag for the on-disk index, bumped
  independently of the `.context.yaml` schema. A mismatch triggers a
  rebuild; **the schema stays at v1** for this track.

### Changed

- `context doctor` gains two additional checks: `gitignore` (verifies
  `.autocontext/` is gitignored) and `index` (verifies manifest is present
  and at the current `INDEX_VERSION`).
- Scanner's `ALWAYS_IGNORE` now includes `.autocontext` so the index
  directory is never traversed during generation.

### Not yet indexed

- **Go and Rust** — tree-sitter queries are spec'd in the T1-B plan
  (package-qualified `selector_expression` for Go, `use_declaration`
  bindings for Rust) but no analyzer ships in this release. `.go` / `.rs`
  files are ignored by the index for now; they continue to work for
  `.context.yaml` generation via the existing pipeline.

## [0.1.0] - 2026-02-13

Initial public release.

### Added

- **CLI** — 13 commands: `init`, `status`, `regen`, `rehash`, `validate`, `show`, `config`, `ignore`, `watch`, `doctor`, `stats`, `bench`, `serve`
- **MCP server** — 3 tools (`query_context`, `check_freshness`, `list_contexts`) via stdio transport
- **JSON Schema publication** — `.context.schema.json` and `.context.config.schema.json` with Draft 2020-12 `$id` URIs, shipped in npm package
- **Schema version pinning** — `version: 1` literal enforced by Zod; `UnsupportedVersionError` for graceful handling of future versions
- **Conformance suite** — 22 data-driven test cases (YAML + meta.json) with parallel ajv + Zod validation
- **Static analysis** — tree-sitter AST parsing for TypeScript, JavaScript, Python, Go, Rust; regex fallback for all other languages
- **LLM generation** — Anthropic, OpenAI, Google, and Ollama provider support with `--llm` flag
- **Evidence collection** — read-only artifact scanning (`--evidence` flag) for test results (Jest/Vitest JSON, JUnit XML), typecheck (tsbuildinfo), lint (.eslintcache), coverage (Istanbul/c8, pytest-cov), and commit SHA; per-directory scoping
- **AGENTS.md generation** — auto-generated directory index with summaries and context-reading instructions
- **Lean/full modes** — lean by default (summary, decisions, constraints); `--full` adds files, interfaces, dependencies
- **`min_tokens` threshold** — skip tiny directories unless needed for routing (default: 4096)
- **`.contextignore`** — project-specific ignore patterns beyond `.gitignore`
- **Strict validation** — `validate --strict` cross-checks context against actual source code (phantom files, phantom interfaces, undeclared deps)
- **Fingerprint-based freshness** — mtime-based directory fingerprints with `fresh`/`stale`/`missing` states
- **Watch mode** — real-time staleness monitoring via `context watch`
- **Benchmark command** — `context bench` for comparing baseline vs context-aided prompts
- **Doctor command** — `context doctor` for project health diagnostics
- **`derived_fields` provenance** — machine-derived fields explicitly marked for trust differentiation
- **Self-maintenance** — `maintenance` field in every context file instructs LLMs to keep context updated
