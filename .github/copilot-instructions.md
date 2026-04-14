# Copilot instructions

> How to navigate this codebase. Read this before grepping or opening files —
> autocontext (below) has the map.
> Project: autocontext

<!-- autocontext:agents-section -->
## autocontext

**autocontext is your map of this codebase.** Before you grep, before you open random files, query here — every directory has a `.context.yaml` summarizing its purpose, architectural decisions, and sometimes a `rules:` block that is mechanically enforced. Parsing these files by hand is the wrong move; use the tools below.

### Routing
- **MCP** (`context serve`): `list_contexts` / `search_context` → find; `query_context` → read; `find_definition` / `find_references` / `find_related` / `impact` → navigate; `check_policies` → enforce; `build_context_pack` → token-budgeted brief; `explain_staleness` / `check_freshness` / `aggregate_evidence` → state.
- **CLI** (no MCP): `context show <dir>`, `context impact <file>`, `context validate --policy`, `context pack --query "..."`, `context verify`, `context status`.

### Before an edit
1. `impact <file>` (MCP) or `context impact <file>` — know the blast radius.
2. Read the enclosing scope's `decisions`, `constraints`, and `rules:`. Honor them.
3. If the scope is `semantic_stale`, call `explain_staleness` before trusting the summary.

### Before a commit
1. `context validate --policy` — fix violations, don't bypass.
2. `context regen --semantic-stale` — regenerates only scopes whose symbols actually changed.

### Do not
- Edit `.context.yaml` by hand unless code structure changed; `context regen` handles it.
- Strip `decisions`, `constraints`, or `rules:` — these are user-authored and never auto-generated.
- Invent rules outside the 7 kinds: `forbid_import`, `require_import`, `require_export`, `max_file_lines`, `require_test_file`, `dependency_boundary`, `evidence_requires`.

### Freshness (4 states)
`fresh` · `cosmetic_stale` (whitespace only — ignore) · `semantic_stale` (symbols changed — likely regen) · `missing`.

### Top-level map
| Directory | Summary |
|-----------|---------|
| `.` (root) | Folder-level documentation for LLMs — .context.yaml files for every directory |
| `conformance` | Documentation. |
| `docs` | Documentation. |
| `scripts` | Build and utility scripts. |
| `src` | Source code. |
| `tests` | Test suite. |

Full index: `list_contexts` (MCP) or `context status`.
<!-- autocontext:agents-section-end -->
