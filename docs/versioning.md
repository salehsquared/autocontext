# Versioning Policy

## Schema Version

Every `.context.yaml` file has a required `version` field. Currently: `version: 1`.

The schema version tracks the **structure** of `.context.yaml` files — which fields exist, their types, and validation rules. It is independent of the autocontext CLI version (currently v0.2.0).

## Compatibility Guarantees

### Within a schema version (v1)

- **New optional fields may be added** without bumping the version. When this happens, a new JSON Schema is published. Tools should validate against the latest schema.
- **No required fields will be added** — that would break existing files.
- **No fields will be removed or have their types changed** — that would break existing parsers.
- **`additionalProperties: false`** is enforced — only fields defined in the schema are allowed. This prevents field sprawl and ensures all implementations agree on the exact structure. If you need custom metadata, use the `config` field (array of strings).

### Version bumps (v1 → v2)

A version bump happens when:
- A new **required** field is added
- An existing field's **type changes** (e.g., `string` → `object`)
- A field is **removed**
- Validation rules become **stricter** in a breaking way

When a version bump occurs:
- The CLI will support reading both old and new versions
- A migration command (`context migrate`) will convert old files to the new version
- The old schema will remain published alongside the new one

## Unsupported Version Behavior

If the CLI encounters a `.context.yaml` with a `version` higher than it supports:

- **`context validate`** — reports the file as invalid (the `version` field fails schema validation against the expected literal value)
- **`context status`** / **`context stats`** — skips the directory with a warning and treats it as missing
- **`context show`** — prints the raw file contents (no version check — it's a file viewer, not a validator)
- **MCP tools** — returns an error response for that scope without crashing the server
- **`context regen`** / **`context rehash`** / **`context watch`** — skips the directory with a warning
- **No silent data loss** — the file is never modified, deleted, or misinterpreted

Update your dependency (`npm install -D autocontext@latest`) to get support for newer schema versions.

### For tool developers

If you're building a tool that reads `.context.yaml`:

1. **Check the `version` field first.** If it's higher than what you support, warn the user and skip the file rather than parsing it incorrectly.
2. **Tolerate missing optional fields.** New optional fields may appear in v1 files at any time.
3. **Validate against the published JSON Schema.** It's the canonical definition — available in the npm package at `.context.schema.json` or referenced by the `$id` URL.

## Current Version

| Version | Status | Schema File |
|---------|--------|-------------|
| 1 | **Current** | `.context.schema.json` |

### 0.2.0 affirmation

The 0.2.x line adds a substantial set of capabilities (local code index, semantic fingerprint, policy rules, active verification, prompt packs, library API, twelve-tool MCP) and **does not bump the schema version**. Every addition is optional:

- `semantic_fingerprint` — optional 12-hex field. Absent → freshness falls back to 3-state.
- `rules` — optional array. Absent → `validate --policy` reports "no rules defined" and exits 0.
- Populated `environment` / `testing` / `todos` / `data_models` / `events` / `config` — shape unchanged (`string[]`); what changed is that static extractors now fill them.
- `.context.config.yaml` `verify:` block — optional. Absent → `context verify` prints a help message and exits 2.

Legacy `.context.yaml` files parse unchanged under 0.2.x. The MCP tools `query_context`, `check_freshness`, `list_contexts`, and `aggregate_evidence` preserve their output shapes byte-for-byte (locked by `tests/mcp/compat.test.ts`).

## `INDEX_VERSION` (separate from schema)

The local code index at `.autocontext/index/` carries its own integer version: `INDEX_VERSION` (stored in `.autocontext/index/manifest.json`). This is **orthogonal** to `SCHEMA_VERSION`.

- Bumping `INDEX_VERSION` is free-form — format changes, new record fields, sharding changes — and triggers a rebuild on the next `context index` call.
- Bumping `SCHEMA_VERSION` is a major event, signaled throughout `.context.yaml` files and all downstream tooling.

The separation lets index-format evolution move at its own pace without affecting the `.context.yaml` contract users commit to git. Consumer tools that read the index should open it with `{ readOnly: true, autoRebuild: false }` and surface rebuild-needed states cleanly (`EAUTOCONTEXTREBUILD` / stale index) — **never** auto-rebuild inside a handler.

See [docs/index.md](index.md) for the index layout, versioning decisions, and per-language coverage.
