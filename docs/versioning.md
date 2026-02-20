# Versioning Policy

## Schema Version

Every `.context.yaml` file has a required `version` field. Currently: `version: 1`.

The schema version tracks the **structure** of `.context.yaml` files — which fields exist, their types, and validation rules. It is independent of the autocontext CLI version (currently v0.1.0).

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
