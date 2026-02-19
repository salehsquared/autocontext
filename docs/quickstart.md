# Quickstart

Get autocontext running in 5 minutes. No API key needed.

## 1. Install

```bash
npm install -g autocontext
```

Requires Node.js >= 18.

## 2. Generate Context Files

```bash
cd your-project
context init
```

```
Scanning project structure...
Found 6 directories with source code.

Generating structural context (no LLM)...
  ████████████████████████████████ 100%
  ✓ .context.yaml  (root)
  ✓ .context.yaml  src
  ✓ .context.yaml  src/core
  ✓ .context.yaml  src/commands
  ✓ .context.yaml  src/generator
  ✓ .context.yaml  tests

Done. 6 .context.yaml files created.
```

This uses static analysis by default — no API key, no cloud calls, fully offline. By default (lean mode), it generates routing-focused fields like `summary`, `subdirectories`, and compact `exports` signatures. Use `--full` when you want verbose `files` and `interfaces`.

## 3. Check Freshness

```bash
context status
```

```
  ✓ .                  fresh
  ✓ src/               fresh
  ✓ src/core/          fresh
  ✓ src/commands/      fresh
```

All directories show **fresh** because nothing has changed since generation. Edit a source file and run `context status` again — that directory will show **stale**.

## 4. View a Context File

```bash
context show src/core
```

```yaml
version: 1
last_updated: "2026-02-10T14:30:00Z"
fingerprint: "a3f8b2c1"
scope: src/core
summary: |
  Core scanning, fingerprinting, and schema validation.
exports:
  - scanProject(rootPath: string): Promise<ScanResult>
maintenance: |
  If you modify files in this directory, update this .context.yaml...
```

If you want `files`, `interfaces`, and richer dependency detail in generated output:

```bash
context init --full
# or
context regen --all --full
```

## 5. Validate

```bash
context validate              # Schema compliance check
context validate --strict     # Cross-reference against actual source code
```

Strict mode catches phantom files, unlisted files, and phantom interfaces when those fields are present. In lean contexts (no `files` field), file-list checks are skipped by design.

## 6. Connect to Your LLM Tool

### Claude Code

```bash
claude mcp add autocontext -- context serve --path /path/to/project
```

### Cursor

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "autocontext": {
      "command": "context",
      "args": ["serve", "--path", "/path/to/project"]
    }
  }
}
```

### Any MCP Client

```bash
context serve --path /path/to/project
```

The MCP server exposes three tools: `query_context`, `check_freshness`, and `list_contexts`. See [integrations.md](integrations.md) for detailed recipes.

## Next Steps

- Want richer summaries? Run `context init --llm` to use an LLM provider
- Want test evidence? Add `--evidence` flag to collect from existing test artifacts
- Want real-time monitoring? Run `context watch`
- See [schema.md](schema.md) for the full `.context.yaml` field reference
- See [trust-model.md](trust-model.md) to understand which fields are machine-derived vs LLM-generated
