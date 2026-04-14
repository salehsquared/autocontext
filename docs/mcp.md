# MCP Contract

autocontext exposes twelve tools via [Model Context Protocol](https://modelcontextprotocol.io) (stdio transport). Transport: stdio. Server version: `0.2.0`, `tools_version: 2`. Tool availability and index requirements are also advertised at the `autocontext://capabilities` resource.

## Tools Overview

Grouped by intent. Recommended call sequences:

- **Symbol navigation:** `find_definition` → `find_references` → `build_context_pack`
- **Diff review:** `impact` → `explain_staleness` → `build_context_pack`
- **Policy gating:** `check_policies` → `query_context`
- **Corpus search:** `search_context` → `query_context` → `build_context_pack`

| Group | Tool | Purpose |
|---|---|---|
| Discover | `list_contexts` | List all tracked scopes with staleness status |
| Discover | `search_context` | BM25F search over the `.context.yaml` corpus |
| Read | `query_context` | Retrieve a scope's context content (optional field filter) |
| Read | `check_freshness` | 3-state freshness (`fresh` / `stale` / `missing`) |
| Read | `aggregate_evidence` | Project-wide test / typecheck / lint / coverage rollup |
| Navigate | `find_definition` | Definition locations for a bare symbol name |
| Navigate | `find_references` | Import-bound references to a symbol |
| Navigate | `find_related` | Importers / importees / siblings / directory neighbors |
| Analyze | `explain_staleness` | 4-state freshness (adds `cosmetic_stale` / `semantic_stale`) |
| Analyze | `impact` | Reverse-BFS over import graph from a seed file or symbol |
| Analyze | `check_policies` | Evaluate typed `rules:` blocks from the `.context.yaml` corpus |
| Assemble | `build_context_pack` | Token-budgeted Markdown or JSON pack from a seed |

### Index / BM25 requirements

- **Requires the code index** (`.autocontext/index/`): `find_definition`, `find_references`, `find_related`, `impact`, `check_policies`, `explain_staleness`. Returns `{ok:false, error:{code:"INDEX_MISSING", remediation:"Run `context index`…"}}` if the index is absent. **No MCP handler rebuilds the index** (a long rebuild looks indistinguishable from a hang).
- **Requires the context corpus** (`.context.yaml` files): `search_context`, `build_context_pack`. BM25 is built in-memory on each call (the persistent BM25 cache is deferred; see `docs/pack.md`).
- **No prerequisites:** `query_context`, `check_freshness`, `list_contexts`, `aggregate_evidence`.

### Capability resource

Clients may read `autocontext://capabilities` to discover tool versioning:

```json
{
  "server_version": "0.2.0",
  "tools_version": 2,
  "tools": [
    { "name": "aggregate_evidence", "since": 1 },
    { "name": "build_context_pack", "since": 2 },
    ...
  ],
  "index": { "required_by": ["find_definition", "find_references", "find_related", "impact", "check_policies", "explain_staleness"] },
  "bm25": { "required_by": ["search_context", "build_context_pack"] }
}
```

Additive changes to existing tools (new optional inputs or output fields) do not bump `tools_version`. Breaking changes do; removed tools get one release cycle of `stderr` deprecation warnings first.

**Recommended call sequences:**
- Content: `list_contexts` → `check_freshness` → `query_context`
- Health: `list_contexts` → `aggregate_evidence`

---

## `query_context`

Retrieve `.context.yaml` content for a directory scope.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | `string` | yes | Relative path from project root, e.g. `"src/core"` or `"."` for root |
| `filter` | `string[]` | no | Fields to include. Metadata fields (`version`, `scope`, `fingerprint`, `last_updated`) are always included. |
| `path` | `string` | no | Project root path override. Defaults to the server's configured root. |

**Filterable fields:** `summary`, `files`, `interfaces`, `decisions`, `constraints`, `dependencies`, `current_state`, `subdirectories`, `environment`, `testing`, `todos`, `data_models`, `events`, `config`, `project`, `structure`, `maintenance`, `exports`

### Success response

```json
{
  "found": true,
  "scope": "src/core",
  "context": {
    "version": 1,
    "scope": "src/core",
    "fingerprint": "a3f8b2c1",
    "last_updated": "2026-02-13T10:00:00Z",
    "summary": "Core scanning, fingerprinting, and schema validation.",
    "files": [...],
    "decisions": [...],
    ...
  }
}
```

### Filtered response

With `filter: ["summary", "decisions"]`:

```json
{
  "found": true,
  "scope": "src/core",
  "context": {
    "version": 1,
    "scope": "src/core",
    "fingerprint": "a3f8b2c1",
    "last_updated": "2026-02-13T10:00:00Z",
    "summary": "Core scanning, fingerprinting, and schema validation.",
    "decisions": [
      { "what": "Fingerprint uses stat() only", "why": "Performance" }
    ]
  }
}
```

Metadata fields are always present. Only requested filterable fields are included.

### Error responses

**Missing context:**
```json
{
  "found": false,
  "scope": "src/unknown",
  "error": "No .context.yaml found at scope \"src/unknown\". This scope may be below the min_tokens threshold; use list_contexts to see eligible scopes."
}
```

**Path traversal:**
```json
{
  "found": false,
  "scope": "../../etc",
  "error": "Invalid scope: path traversal detected"
}
```

**Unsupported schema version:**
```json
{
  "found": false,
  "scope": ".",
  "error": "Unsupported schema version 2 (this tool supports version 1). Upgrade autocontext to read this file."
}
```

**Corrupt file:**
```json
{
  "found": false,
  "scope": ".",
  "error": "Invalid or corrupt .context.yaml at scope \".\""
}
```

### `isError` semantics

`isError: !result.found` — any response where the context was not successfully retrieved is flagged as an error.

---

## `check_freshness`

Check whether a `.context.yaml` file is current.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `scope` | `string` | yes | Relative path from project root |
| `path` | `string` | no | Project root path override |

### Fresh response

```json
{
  "scope": "src/core",
  "state": "fresh",
  "fingerprint": {
    "stored": "a3f8b2c1",
    "computed": "a3f8b2c1"
  },
  "last_updated": "2026-02-13T10:00:00Z"
}
```

### Stale response

```json
{
  "scope": "src/core",
  "state": "stale",
  "fingerprint": {
    "stored": "a3f8b2c1",
    "computed": "d7e6f5a4"
  },
  "last_updated": "2026-02-13T10:00:00Z"
}
```

### Missing response

```json
{
  "scope": "src/unknown",
  "state": "missing",
  "error": "No .context.yaml found at scope \"src/unknown\". This scope may be below the min_tokens threshold; use list_contexts to see eligible scopes."
}
```

### Error responses

Same error patterns as `query_context`: path traversal, unsupported version, corrupt file.

### `isError` semantics

`isError: !!result.error` — only when there is an error message. **Stale is NOT an error** — it's a valid state that tells the consumer to regenerate or verify before relying on the context.

---

## `list_contexts`

List all tracked directories with their staleness status.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | no | Project root path override |

### Success response

```json
{
  "root": "/path/to/project",
  "total_directories": 6,
  "skipped_directories": 2,
  "tracked": 5,
  "entries": [
    {
      "scope": ".",
      "state": "fresh",
      "has_context": true,
      "last_updated": "2026-02-13T10:00:00Z",
      "summary": "REST API for task management"
    },
    {
      "scope": "src",
      "state": "stale",
      "has_context": true,
      "last_updated": "2026-02-12T08:00:00Z",
      "summary": "Source code"
    },
    {
      "scope": "tests",
      "state": "missing",
      "has_context": false
    }
  ]
}
```

Entries are sorted lexicographically by scope. Directories with unsupported schema versions appear as `has_context: false, state: "missing"`.

### Error response (global failure)

```json
{
  "root": "/nonexistent/path",
  "total_directories": 0,
  "skipped_directories": 0,
  "tracked": 0,
  "entries": [],
  "error": "Failed to scan project at \"/nonexistent/path\""
}
```

### `isError` semantics

`isError: !!result.error` — only on global scan failure. Individual missing or stale entries are not errors.

---

## `aggregate_evidence`

Aggregate code health evidence across all tracked scopes. Returns per-scope evidence entries and a project-wide health summary.

### Input

| Parameter | Type | Required | Description |
|---|---|---|---|
| `path` | `string` | no | Project root path override |

### Success response

```json
{
  "root": "/path/to/project",
  "total_scopes": 6,
  "scopes_with_evidence": 4,
  "health": {
    "tests": {
      "passing": 3,
      "failing": 1,
      "unknown": 0,
      "total_test_count": 342,
      "failing_scopes": ["src/auth"]
    },
    "typecheck": { "clean": 3, "errors": 0, "unknown": 1 },
    "lint": { "clean": 2, "errors": 1, "unknown": 1 },
    "coverage": {
      "scopes_reported": 3,
      "average_percent": 85.3,
      "min_percent": 62.1,
      "max_percent": 98.0
    }
  },
  "scopes": [
    { "scope": ".", "has_evidence": true, "evidence": { "collected_at": "2026-02-18T00:00:00Z", "test_status": "passing", "test_count": 120 } },
    { "scope": "src", "has_evidence": false },
    { "scope": "src/auth", "has_evidence": true, "evidence": { "collected_at": "2026-02-18T00:00:00Z", "test_status": "failing", "test_count": 45, "failing_tests": ["auth.login"] } }
  ],
  "scope_errors": []
}
```

`total_scopes` is the number of directories after min-token filtering (same semantics as `total_directories` in `list_contexts`). All filtered directories appear in `scopes`, whether or not they have a `.context.yaml` or evidence.

**`total_test_count` caveat:** Raw sum across all reporting scopes. May double-count when a parent scope's test runner includes child-scope tests. No deduplication is attempted.

**Coverage average:** Computed only over scopes that report `coverage_percent`. Scopes without coverage are excluded from the average.

**Stale contexts:** Evidence is included in the rollup regardless of fingerprint freshness. Staleness means source files changed, not that evidence is invalid.

### Scope errors response

When individual scopes have corrupt or unsupported-version `.context.yaml` files:

```json
{
  "root": "/path/to/project",
  "total_scopes": 3,
  "scopes_with_evidence": 1,
  "health": { "..." : "..." },
  "scopes": [
    { "scope": ".", "has_evidence": true, "evidence": { "..." : "..." } },
    { "scope": "lib", "has_evidence": false },
    { "scope": "src", "has_evidence": false }
  ],
  "scope_errors": [
    { "scope": "src", "error": "Invalid or corrupt .context.yaml at scope \"src\"" }
  ]
}
```

Per-scope errors do not prevent aggregation of valid scopes.

### Error response (global failure)

```json
{
  "root": "/nonexistent/path",
  "total_scopes": 0,
  "scopes_with_evidence": 0,
  "health": { "tests": { "passing": 0, "failing": 0, "unknown": 0, "total_test_count": 0, "failing_scopes": [] }, "typecheck": { "clean": 0, "errors": 0, "unknown": 0 }, "lint": { "clean": 0, "errors": 0, "unknown": 0 }, "coverage": { "scopes_reported": 0, "average_percent": null, "min_percent": null, "max_percent": null } },
  "scopes": [],
  "scope_errors": [],
  "error": "Failed to scan project at \"/nonexistent/path\""
}
```

### `isError` semantics

`isError: !!result.error` — only on global scan failure. Per-scope errors in `scope_errors` are NOT tool-level errors.

---

## Navigation Tools (since v0.2)

### `find_definition`

Return every definition location for a bare symbol name.

**Input:** `{ symbol, scope?: { file?, dir? }, limit?, path? }` — default limit 25, hard cap 50.
**Output:** `{ ok, symbol, results[], truncated, total_matched }` where each result carries `symbol_id`, `file`, `kind`, `exported`, `span`, `signature?`, `lang`. Results sort by `(file, span.startLine)`. Empty result set is `ok: true`, not an error.

### `find_references`

**Import-bound references only.** Returns identifier uses bound by a static import statement in the same file. Free identifiers, member-access chains, and dynamic imports are NOT indexed — a zero result is not proof of zero callers.

**Input:** `{ symbol? | symbol_id?, scope?, limit?, path? }` — exactly one of `symbol`/`symbol_id`. Prefer `symbol_id` (from `find_definition`) for disambiguation.
**Output:** `{ ok, targets[], references[], truncated, total_matched, reference_kind: "import_bound", caveat }`. The caveat string is pinned.

### `find_related`

Expand a seed into a neighborhood before assembling a pack.

**Input:** `{ seed: { file? | symbol? }, kinds?, max_results?, path? }` — default kinds `["importers","importees","dir_neighbors"]`. `siblings` is opt-in (often dominates on flat directories).
**Output:** `{ ok, seed: { kind, resolved_file, resolved_symbol_id? }, related[], truncated, total_matched }`. Each entry: `{ file, reason, strength }`. Sorts by `strength DESC, file ASC`.

### `search_context`

BM25F over the `.context.yaml` corpus — zones: `summary`, `decisions`, `constraints`, `symbols`, `state`, `facets`, `path`.

**Input:** `{ query, fields?, limit?, path? }` — default limit 10, hard cap 50.
**Output:** `{ ok, query, results[], truncated, total_matched }`. Each result carries `{ scope, score, matches: [{ zone, excerpt }], summary?, last_updated? }`. Scores round to 4 decimals; same query on unchanged corpus returns byte-identical JSON.

### `impact`

Reverse-BFS over the import graph.

**Input:** `{ seed, kind?: "file" | "symbol" | "diff", max_depth?, max_results?, path? }` — default `kind: "file"`. `kind: "diff"` is reserved; v1 returns `INVALID_INPUT`.
**Output:** `{ ok, seeds, affected, affected_scopes, stopped, caveat }`. Recall-imperfect — use to narrow a review, not to prove absence of effect. See [docs/impact.md](impact.md).

### `build_context_pack`

Token-budgeted pack. See [docs/pack.md](pack.md) for the full reference. Inputs: `{ query? | file? | symbol?, budget?, format?: "md"|"json", path? }`. Default budget 4000. Output delivered as a single `text` content item.

### `explain_staleness`

4-state freshness classification (`fresh` / `cosmetic_stale` / `semantic_stale` / `missing`). See [docs/freshness.md](freshness.md). Degrades to the disk-fingerprint-only view when the code index is absent (logs `error: "INDEX_MISSING"` but still returns a usable envelope).

### `check_policies`

Evaluate typed `rules:` blocks. See [docs/policies.md](policies.md). Input: `{ scope?, rule_kinds?, path? }`. Output: `{ ok, scope, rules_evaluated, rules_passed, violations, index_state, truncated, contexts_scanned }`. Violation array capped at 500; `truncated: true` signals the cap.

## Error Envelopes (since v0.2)

Navigation tools (and `impact`, `check_policies`, `explain_staleness`, `build_context_pack`) use a uniform error shape:

```json
{
  "ok": false,
  "error": {
    "code": "INDEX_MISSING",
    "message": "Code index not found at .autocontext/index/.",
    "remediation": "Run `context index` in the project root, then retry."
  }
}
```

| Code | When |
|---|---|
| `INDEX_MISSING` | `.autocontext/index/` absent or version-mismatched |
| `NOT_FOUND` | `symbol_id` / seed file does not resolve |
| `INVALID_INPUT` | mutually-exclusive input violated, or unsupported seed kind |
| `PATH_TRAVERSAL` | `scope.file`, `scope.dir`, or `seed.file` escapes project root |
| `INTERNAL` | unhandled exception, message sanitized |

Legacy tools (`query_context`, `check_freshness`, `list_contexts`, `aggregate_evidence`) keep their existing ad-hoc error strings for compat.

## Response Size Limits (since v0.2)

| Tool | Default limit | Hard cap | Serialized ceiling |
|---|---|---|---|
| `find_definition` | 25 | 50 | 10 KB |
| `find_references` | 50 | 50 | 10 KB |
| `find_related` | 25 | 50 | 10 KB |
| `search_context` | 10 | 50 | 10 KB |
| `impact` | 100 files | 500 | — |
| `check_policies` | 500 violations | 500 | — |
| `build_context_pack` | budget-aware | 50 KB | — |

No cursor-based pagination in v1. When a caller hits truncation (`truncated: true`, `total_matched` set), narrow via `scope.dir` / `scope.file` / `symbol_id` / a more specific `query`.

## Common Patterns

### Path override

All tools accept an optional `path` parameter that overrides the default project root configured when the MCP server was started. Useful when a single MCP server instance needs to serve multiple projects.

### Backslash normalization

Scope paths with backslashes (Windows-style) are automatically normalized to forward slashes before resolution.

---

## Compatibility Rules

- Within schema v1, existing response fields will not change type or be removed.
- New optional fields may be added to response objects at any time.
- New tools may be added; existing tool input schemas may gain optional parameters.
- Consumers should ignore unknown fields rather than fail on them.
- Capability resource shape is guaranteed stable within `tools_version: 2`.
- `list_contexts` and `check_freshness` stay on the 3-state enum for legacy clients; 4-state freshness lives exclusively on `explain_staleness`.
