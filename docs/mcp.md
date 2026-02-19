# MCP Contract

autocontext exposes four tools via [Model Context Protocol](https://modelcontextprotocol.io) (stdio transport). This document defines their exact request/response shapes.

## Tools Overview

| Tool | Purpose | When to use |
|---|---|---|
| `list_contexts` | List all tracked directories with staleness status | First call — discover what scopes exist |
| `check_freshness` | Check if a specific context is fresh, stale, or missing | Before relying on a context — verify it's current |
| `query_context` | Retrieve context content with optional field filtering | Read the actual context data for a scope |
| `aggregate_evidence` | Aggregate code health evidence across all scopes | Get project-wide test, typecheck, lint, and coverage summary |

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

## Common Patterns

### Path override

All four tools accept an optional `path` parameter that overrides the default project root configured when the MCP server was started. This is useful when a single MCP server instance needs to serve multiple projects.

### Backslash normalization

Scope paths with backslashes (Windows-style) are automatically normalized to forward slashes before resolution.

---

## Compatibility Rules

- Within schema v1, existing response fields will not change type or be removed
- New optional fields may be added to response objects at any time
- New tools may be added; existing tool input schemas may gain optional parameters
- Consumers should ignore unknown fields rather than fail on them
