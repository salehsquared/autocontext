# Changelog

All notable changes to autocontext will be documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Release semantics

- **Patch** (0.1.x): Bug fixes, doc corrections, new optional schema fields
- **Minor** (0.x.0): New commands, new MCP tools, new evidence sources, new provider support
- **Major** (x.0.0): Schema version bump (v1 → v2), breaking CLI flag changes, breaking MCP response shape changes

---

## [Unreleased]

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
