# autocontext

Local code-intelligence for every coding agent. `.context.yaml` routing, a local symbol + reference graph, token-budgeted prompt packs, and typed policy rules — all git-visible, offline, and portable across tools.

```
$ npx context init
Scanning project...
  ✓ .                    (12 files)
  ✓ src/                 (8 files)
  ✓ src/core/            (5 files)
  ✓ src/commands/        (9 files)
  ✓ src/generator/       (6 files)
  ✓ tests/               (4 files)
Done. 6 .context.yaml files created.

$ npx context show src/core
scope: src/core
summary: |
  Core scanning, fingerprinting, and schema validation.
  Handles directory tree traversal and content-hash based staleness detection.
decisions:
  - what: Fingerprint uses stat() only, not file content
    why: Performance — avoids reading every file on every status check
subdirectories:
  - name: scanner/
    summary: Recursive directory walker with gitignore support

$ npx context status
  ✓ .                  fresh
  ✓ src/               fresh
  ⚠ src/core/          stale (3 files changed)
  ✓ src/commands/      fresh
  ✓ src/generator/     fresh
  ✓ tests/             fresh
```

## Why

Every LLM coding tool — Claude Code, Cursor, Copilot, Windsurf, Aider — has the same problem: to understand a directory, it reads every file. This wastes tokens, doesn't scale, and means different LLMs working on the same project build no shared understanding of what the code does.

`.context.yaml` files fix this. A lean routing layer at each level of the directory tree. An LLM reads one file and knows what the directory is for, what architectural decisions were made, and where to look next — without opening a single source file.

By default, context files focus on what LLMs actually find useful: **summaries** (what is this directory?), **decisions** (why was it built this way?), and **constraints** (what rules must I follow?). File listings, interfaces, and dependency graphs are omitted — LLMs can get those faster from the source code itself.

### The real cost of file exploration

The token cost of exploring code is worse than it looks. When Claude Code, Cursor, or Copilot reads files to understand a directory, each file read is a tool call — and every tool call replays the entire conversation history. An agent reading 5 files doesn't pay for 5 files. It pays for the first file, then the first *and* second, then all three, and so on:

```
Turn 1:  system + file₁                          →  1 file of context
Turn 2:  system + file₁ + file₂                  →  2 files of context
Turn 3:  system + file₁ + file₂ + file₃          →  3 files of context
Turn 4:  system + file₁ + file₂ + file₃ + file₄  →  4 files of context
Turn 5:  ...                                      →  5 files of context
                                              Total: 15 file-reads of tokens
```

That's `N × (N + 1) / 2` — roughly **3x** the naive "just sum the file sizes" estimate. For a 10-file directory, it's closer to **5.5x**. And this doesn't count the files the agent opens that turn out to be irrelevant, or the imports it follows into other directories.

With `.context.yaml`, the agent reads one small file (~25 lines), gets oriented, and either answers immediately or opens exactly the one file it needs. Two turns instead of ten. The token savings compound with every file the agent *doesn't* have to explore.

## Why `.context.yaml` Instead of `README.md`?

`README.md` is still important, but it solves a different problem.

- **`README.md`** is project-level narrative for humans: onboarding, setup, usage, examples.
- **`.context.yaml`** is directory-level, structured context for agents: what this folder is for, key decisions, constraints, and where to look next.

Why `.context.yaml` helps where README alone does not:

- **Granularity**: one README cannot describe every directory without becoming huge.
- **Machine queryability**: MCP tools can request specific fields (`summary`, `decisions`, `constraints`) instead of dumping full prose.
- **Freshness tracking**: fingerprints provide `fresh`/`stale`/`missing` status per directory.
- **Trust model**: `derived_fields` makes machine-derived vs narrative content explicit.
- **Lean retrieval**: agents can load only the current directory context first, then drill down.

## Core Features

- **Lean by default** — context files contain only what LLMs can't infer from code: summaries, decisions, constraints. Use `--full` for verbose output with file listings, interfaces, and dependencies.
- **Local symbol + reference graph** — `context index` builds a tree-sitter index at `.autocontext/index/` (TS/JS/Python in v1). Powers `find_definition`, `find_references`, impact analysis, and semantic staleness. Import-bound references only — see [docs/limitations.md](docs/limitations.md).
- **Token-budgeted prompt packs** — `context pack` compiles a budget-respecting brief using BM25F retrieval over the `.context.yaml` corpus plus graph proximity. Seeds accept query text, a file path, or a symbol name.
- **Typed policy rules** — `rules:` blocks in `.context.yaml` enforce import boundaries, file-size caps, evidence thresholds, and more. `context validate --policy` runs them mechanically against the index.
- **4-state semantic staleness** — distinguishes cosmetic edits from API-surface changes via a semantic fingerprint over exports, imports, and policy facts. Legacy 3-state stays the default for compat.
- **Active verification** — `context verify` runs your configured test/typecheck/lint/coverage commands, normalizes the output, and writes the result back into each scope's evidence block. Opt-in; never auto-runs.
- **Deterministic LLM cache** — content-addressed cache at `.autocontext/llm-cache/` skips redundant provider calls between regens.
- **Git-aware history** — `context diff`, `context timeline`, `context hotspots` — read-only git helpers for review and discovery.
- **Schema validation** — `.context.yaml` files are validated against a strict schema; `context validate --policy` adds rule enforcement on top.
- **MCP queryability** — 12 tools via MCP (stdio). Query context, navigate symbols, evaluate policies, build packs.
- **Fingerprint-based freshness** — each directory has a content fingerprint with `fresh`, `stale`, and `missing` states.
- **Self-contained HTML viewer** — `context view` generates a single offline HTML report (tree + detail pane + optional dep graph) ready to share in a PR.
- **Library API** — `import { buildPack, runPolicies, computeImpact } from "autocontext"` — every capability the CLI uses, with stability tiers.

## Schema

autocontext files are validated against a [JSON Schema (Draft 2020-12)](https://json-schema.org/draft/2020-12/schema):

- **`.context.yaml`** — [`.context.schema.json`](.context.schema.json)
- **`.context.config.yaml`** — [`.context.config.schema.json`](.context.config.schema.json)

The schemas are published in the npm package and can be used for editor autocompletion (via YAML language server) or custom validation in any language. See [docs/schema.md](docs/schema.md) for the full field reference.

## How It Compares

| Capability | autocontext | CLAUDE.md / .cursorrules | Tool-native indexes | Memory tools |
|---|---|---|---|---|
| What it stores | Factual docs (what code does) | Behavioral rules (how AI acts) | Embeddings / vectors | Conversation history |
| Portable across tools | Yes — plain YAML in git | No — tool-specific | No — proprietary | No — tied to service |
| Git-visible | Yes — committed, diffable | Yes | No | No |
| Works offline | Yes — static analysis default | Yes | Depends | No |
| Machine-queryable | Yes — MCP + schema | No — unstructured | Partial | Partial |
| Staleness detection | Yes — fingerprint + semantic fingerprint | No | Varies | N/A |
| Symbol / reference graph | Yes — local, git-visible | No | Yes — remote, proprietary | No |
| Token-budgeted prompt assembly | Yes — `context pack` | No | Varies | No |
| Policy enforcement via static analysis | Yes — `rules:` + `validate --policy` | No | No | No |
| Self-maintaining | Yes — embedded instructions | No | Auto-updated | Auto-updated |

**autocontext is not:**
- An agent framework (no tool calling, no execution)
- A vector database (no embeddings, no semantic search)
- A type-aware analyzer (tree-sitter is syntactic — see [docs/limitations.md](docs/limitations.md) for the per-language honest status)
- Behavioral rules (that's what CLAUDE.md is for)
- A cloud service (everything local, data stays on disk)

## Comparison Questions

Use these questions when comparing autocontext with alternatives (tool-native indexes, memory systems, CLAUDE.md-only workflows, etc.):

1. Can I fetch context by **directory** and **field** (not just full-text blobs)?
2. Can I detect **staleness** automatically when code changes?
3. Is the context **git-visible**, diffable, and code-reviewable?
4. Is it **portable across tools** (Claude, Cursor, Copilot, custom MCP clients)?
5. Can I distinguish **machine-derived facts** from narrative summaries?
6. Does it support a **lean mode** for low token overhead, with optional verbose mode?
7. Does it work **offline/local-first** without requiring cloud indexing?
8. Can CI enforce freshness/validity (`status`, `validate`, `doctor`)?
9. Does it complement, rather than replace, human docs like `README.md`?

## Quick Start

```bash
npm install -D autocontext

npx context init                # Generate lean .context.yaml files and AGENTS.md
npx context status              # Check which files are fresh/stale
npx context regen --all --stale # Regenerate only what changed
npx context doctor              # Diagnose setup issues
npx context show src/core       # Pretty-print a context file
```

Requires Node.js >= 18. No accounts, no cloud services, works fully offline. See [docs/quickstart.md](docs/quickstart.md) for the full 5-minute guide.
Want a global binary instead? Use `npm install -g autocontext` and run `context ...` directly.

A `.autocontext/` directory is created on first run for the index, LLM cache, and policy results. `context init` adds it to `.gitignore` automatically; existing projects can run `context doctor` to surface the check.

## Commands

| Command | Description |
|---|---|
| `context init` | Scan project, generate all `.context.yaml` and `AGENTS.md` |
| `context init --llm` | Use LLM for richer summaries, decisions, constraints |
| `context init --full` | Generate verbose context (files, interfaces, dependencies) |
| `context status` | Check freshness of all context files |
| `context status --json` | Machine-readable JSON output for CI |
| `context regen [path]` | Regenerate context for a specific directory (or `--all`) |
| `context regen --stale` | Only regenerate stale or missing directories |
| `context regen --dry-run` | Preview what would be regenerated without changes |
| `context regen --full` | Include files, interfaces, dependencies in output |
| `context regen --parallel <n>` | Process directories concurrently |
| `context regen --force` | Accepted for forward compatibility (currently no behavior change) |
| `context doctor` | Check project health: config, API keys, coverage, staleness, validation |
| `context doctor --json` | Machine-readable diagnostics for CI |
| `context rehash` | Recompute fingerprints without regenerating content |
| `context validate` | Schema compliance check |
| `context validate --strict` | Cross-reference against actual source code |
| `context validate --policy` | Evaluate typed `rules:` blocks against the code index |
| `context watch` | Real-time staleness monitoring |
| `context show <path>` | Pretty-print a context file |
| `context config` | View/edit provider settings |
| `context config --mode <lean\|full>` | Set default generation mode |
| `context ignore <path>` | Add directory to `.contextignore` |
| `context health` | Aggregate code health evidence across all scopes |
| `context health --json` | Machine-readable health evidence for CI |
| `context index [--rebuild]` | Build or refresh the local symbol + reference index |
| `context impact <target>` | List scopes affected by a file or symbol change (import-bound) |
| `context pack` | Assemble a token-budgeted prompt pack (query / file / symbol seed) |
| `context diff` | Show the diff of `.context.yaml` files between two git revs |
| `context timeline <path>` | Show context history for a scope across commits |
| `context hotspots` | Surface churn-vs-complexity hotspots from git history |
| `context verify` | Run configured tests/typecheck/lint/coverage and write evidence |
| `context view` | Generate a self-contained HTML report (tree + detail + dep graph) |
| `context cache stats` / `context cache clear` | Inspect or clear the LLM cache |
| `context bench` | Benchmark baseline / context / pack / pack+impact / pack+policy arms |
| `context bench --arm pack,pack+policy --pack-budget 5000` | Run selected comparator arms with an explicit pack budget |
| `context bench --repo <url>` | Clone and benchmark another repository |
| `context serve` | Start MCP server for LLM tool integration |

When installed locally (`npm install -D autocontext`), run commands as `npx context ...`.

Most commands accept `-p, --path <path>` to target a specific project root. `context show <target>` is the exception and resolves from the current working directory. `init` and `regen` accept `--no-agents` to skip `AGENTS.md` generation, `--evidence` to collect test/typecheck signals, and `--parallel <n>` for concurrent processing. `bench --tasks <path>` is currently reserved for future task-file support and has no effect yet. `bench --arm <csv>` accepts `baseline,context,pack,pack+impact,pack+policy`; `pack+impact` and `pack+policy` require a usable code index and fail fast with rebuild guidance when the index is missing or stale.

## Everyday Workflow

```bash
# First run — generate everything (lean by default)
npx context init

# After editing code — regenerate only what changed
npx context regen --all --stale

# Preview before regenerating
npx context regen --all --stale --dry-run

# Speed up with concurrency (especially useful with --llm)
npx context regen --all --stale --parallel 4

# Generate verbose context with file listings and interfaces
npx context init --full
npx context regen --all --full

# Set full mode as the project default
npx context config --mode full

# Check project health in one command
npx context doctor

# CI: machine-readable output
npx context status --json
npx context doctor --json
npx context health --json
```

## Lean vs Full Mode

By default, autocontext generates **lean** context files — a routing layer that tells LLMs what they need to know without duplicating information available in source code.

**Lean mode** (default) produces:
- `summary` — 1-3 sentences describing the directory's purpose
- `decisions` — architectural choices that can't be inferred from code
- `constraints` — hard rules a developer must follow
- `subdirectories` — routing to child directories with summaries
- `dependencies.internal` — cross-directory import relationships (when detected; high signal for navigation)
- `exports` — compact API/method signatures for routing
- Metadata: `version`, `fingerprint`, `scope`, `maintenance`, `derived_fields`
- Root only: `project`, `structure`

**Full mode** (`--full` flag or `context config --mode full`) adds:
- `files[]` — every file with its purpose
- `interfaces[]` — exported functions, classes, endpoints
- `dependencies.external` — from package manifests
- `current_state` — what's working, broken, in progress

Mode resolution: `--full` CLI flag > `config.mode` > default `lean`.

A typical lean `.context.yaml` is ~20-25 lines vs ~60-80 lines in full mode. The high-value fields stay; the redundant-with-source fields move behind `--full`.

**Static analysis** (default) — no API key, works offline:
- Auto-detected summaries from file structure
- AST-based export/signature detection via tree-sitter (TypeScript, JavaScript, Python, Go, Rust) with regex fallback
- Internal dependencies from source imports (all modes when detected)
- External dependencies from package manifests in full mode
- Test evidence from existing artifacts (opt-in, `--evidence`)

**LLM-enhanced** (`--llm`) — richer output via configured provider:
- Rich summaries, architectural decisions, and constraints
- In full mode: interface descriptions, current state assessment
- Machine-derived fields always overlay LLM output for accuracy

## MCP Server

Twelve tools via [Model Context Protocol](https://modelcontextprotocol.io) (stdio transport). Grouped by intent:

- **Discover:** `list_contexts`, `search_context`
- **Read:** `query_context`, `check_freshness`, `aggregate_evidence`
- **Navigate:** `find_definition`, `find_references`, `find_related`
- **Analyze:** `explain_staleness`, `impact`, `check_policies`
- **Assemble:** `build_context_pack`

Full request/response shapes, error envelopes, and response-size limits live in [docs/mcp.md](docs/mcp.md). Server version is exposed via the `autocontext://capabilities` resource (`server_version`, `tools_version`, per-tool `since`).

```bash
# Claude Code
claude mcp add autocontext -- npx --no-install context serve --path /path/to/project

# Cursor (.cursor/mcp.json)
{ "mcpServers": { "autocontext": { "command": "npx", "args": ["--no-install", "context", "serve", "--path", "."] } } }
```

See [docs/integrations.md](docs/integrations.md) for Windsurf, Continue, generic MCP clients, non-MCP usage, and CI/CD setup.

## Configuration

```yaml
# .context.config.yaml (add to .gitignore)
provider: anthropic
model: claude-3-5-haiku-latest
mode: lean          # or "full" for verbose output
ignore: [tmp, scratch]
max_depth: 5
min_tokens: 4096  # skip tiny directories unless they are needed for routing
```

| Setting | Values | Description |
|---|---|---|
| `provider` | `anthropic`, `openai`, `google`, `ollama` | LLM provider for `--llm` mode |
| `model` | any model ID | Override default model for provider |
| `mode` | `lean` (default), `full` | Default generation mode |
| `ignore` | directory list | Additional directories to skip |
| `max_depth` | integer | Maximum scan depth |
| `min_tokens` | integer (default `4096`) | Minimum estimated directory size to track |
| `api_key_env` | env var name | Custom env var for API key |

| Provider | Default Model | Env Var |
|---|---|---|
| Anthropic | claude-3-5-haiku-latest | `ANTHROPIC_API_KEY` |
| OpenAI | gpt-4o-mini | `OPENAI_API_KEY` |
| Google | gemini-2.0-flash-lite | `GOOGLE_API_KEY` |
| Ollama | llama3.2:3b | `OLLAMA_HOST` (local, no key) |

```bash
# Set config from CLI
npx context config --provider anthropic --model claude-3-5-haiku-latest
npx context config --mode full
npx context config --ignore tmp scratch
npx context config              # View current settings
```

## How It Works

**Scanning** — walks the directory tree, finds directories with source files. Skips `node_modules`, `.git`, `dist`, `build`, and 15+ other non-source directories. Respects `.gitignore` and `.contextignore` patterns (exact names, globs, path rules, negation). A token threshold filter (`min_tokens`, default `4096`) excludes very small directories unless they are required for parent-child routing.

**Fingerprinting** — 8-char SHA-256 from sorted `filename:mtime:size`. Cheap (`stat()` only, no file reads). Detects additions, deletions, and modifications.

**Staleness** — `fresh` (fingerprint matches), `stale` (files changed), `missing` (no context file). `context status` checks all; `context watch` monitors live.

**AGENTS.md** — `init` and full-tree `regen` generate an `AGENTS.md` at project root: a directory index with summaries and instructions for reading context files. User content outside the managed section is preserved. Skip with `--no-agents`.

**Self-maintenance** — every `.context.yaml` embeds a `maintenance` field instructing LLMs to update the summary, decisions, and constraints after modifying files. Works across all tools.

## Documentation

| Doc | What it covers |
|---|---|
| [Quickstart](docs/quickstart.md) | Install to MCP in 5 minutes |
| [Schema Reference](docs/schema.md) | Full `.context.yaml` field reference with examples |
| [Trust Model](docs/trust-model.md) | Machine-derived vs LLM-generated fields, freshness guarantees |
| [Validation](docs/validation.md) | Schema, strict cross-reference, and `--policy` enforcement |
| [Policies](docs/policies.md) | Typed `rules:` reference: seven rule kinds + glob dialect + CI integration |
| [Pack](docs/pack.md) | `context pack` user guide: seeds, budget, MCP tool |
| [Index](docs/index.md) | Local code index: layout, versioning, precision boundary, consumers |
| [Library API](docs/library.md) | `import … from "autocontext"`: stable + experimental surface |
| [Freshness](docs/freshness.md) | 4-state model: fresh / cosmetic_stale / semantic_stale / missing |
| [Impact](docs/impact.md) | `context impact` — reverse-BFS over import graph |
| [Verify](docs/verify.md) | `context verify` active-verification command |
| [View](docs/view.md) | `context view` self-contained HTML report |
| [Bench](docs/bench.md) | Comparator arms, task categories, provenance, regression canary |
| [Integrations](docs/integrations.md) | Claude Code, Cursor, Windsurf, Continue, non-MCP, CI/CD |
| [CI/CD Guide](docs/ci.md) | GitHub Actions, GitLab CI, fail policies |
| [Versioning](docs/versioning.md) | Schema version policy and compatibility guarantees |
| [Troubleshooting](docs/troubleshooting.md) | Common issues with fixes |
| [Limitations](docs/limitations.md) | What autocontext does not guarantee |
| [MCP Contract](docs/mcp.md) | 12-tool request/response shapes + error envelopes + capability resource |
| [Evidence](docs/evidence.md) | Evidence contract: artifact formats, search paths, freshness |

## License

MIT
