# Changelog

All notable changes to autocontext will be documented in this file.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

### Release semantics

- **Patch** (0.1.x): Bug fixes, doc corrections, new optional schema fields
- **Minor** (0.x.0): New commands, new MCP tools, new evidence sources, new provider support
- **Major** (x.0.0): Schema version bump (v1 → v2), breaking CLI flag changes, breaking MCP response shape changes

---

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
