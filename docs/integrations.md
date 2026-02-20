# Integrations

autocontext works at two levels: `.context.yaml` files are plain YAML readable by any tool, and the MCP server provides structured access for LLM clients.
Examples below assume a local install (`npm install -D autocontext`) and use `npx context ...`.

## MCP Server

The MCP server exposes three tools via stdio transport (JSON-RPC over stdin/stdout).

### Starting the Server

```bash
npx context serve --path /path/to/project
```

The server runs until terminated. Protocol traffic uses stdin/stdout; startup logs are written to stderr.

### Tools

**`query_context`** — Retrieve context for a directory.

```json
// Input
{ "scope": "src/core", "filter": ["summary", "interfaces"] }

// Output
{
  "found": true,
  "scope": "src/core",
  "context": {
    "version": 1,
    "scope": "src/core",
    "fingerprint": "a3f8b2c1",
    "last_updated": "2026-02-10T14:30:00Z",
    "summary": "Core scanning, fingerprinting, and schema validation.",
    "interfaces": [
      { "name": "scanProject(rootPath, options)", "description": "Walk directory tree" }
    ]
  }
}
```

Metadata fields (`version`, `scope`, `fingerprint`, `last_updated`) are always included regardless of filter. Filterable fields: `summary`, `files`, `interfaces`, `decisions`, `constraints`, `dependencies`, `current_state`, `subdirectories`, `environment`, `testing`, `todos`, `data_models`, `events`, `config`, `project`, `structure`, `maintenance`, `exports`.

**`check_freshness`** — Check if context is current.

```json
// Input
{ "scope": "src/core" }

// Output
{
  "scope": "src/core",
  "state": "stale",
  "fingerprint": { "stored": "a3f8b2c1", "computed": "f7e2d9a0" },
  "last_updated": "2026-02-10T14:30:00Z"
}
```

States: `fresh`, `stale`, `missing`.

**`list_contexts`** — List all directories with status.

```json
// Output
{
  "root": "/path/to/project",
  "total_directories": 6,
  "skipped_directories": 12,
  "tracked": 6,
  "entries": [
    { "scope": ".", "state": "fresh", "has_context": true, "summary": "Project root..." },
    { "scope": "src/core", "state": "stale", "has_context": true, "summary": "Core modules..." },
    { "scope": "src/commands", "state": "fresh", "has_context": true, "summary": "CLI commands..." }
  ]
}
```

### Security

All scope parameters are validated against path traversal. Attempting to access `../../etc/passwd` or `/absolute/path/outside/root` returns an error, not file contents. The MCP server is read-only — it never writes to disk.

---

## Claude Code

### Setup

```bash
claude mcp add autocontext -- npx --no-install context serve --path /path/to/project
```

Verify it's registered:

```bash
claude mcp list
```

### Usage Patterns

Once connected, Claude Code can use autocontext tools automatically. Useful prompts:

- "Check if the context for src/core is fresh before you read any files there"
- "Query just the interfaces for src/api so you know what's exported"
- "List all contexts and tell me which directories are stale"
- "Before modifying src/auth, read its context to understand the architecture"

---

## Cursor

### Setup

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "autocontext": {
      "command": "npx",
      "args": ["--no-install", "context", "serve", "--path", "."]
    }
  }
}
```

Restart Cursor after adding the config. The MCP server starts automatically when Cursor opens the project.

### Usage

Cursor's agent mode will discover the autocontext tools automatically. You can reference them in prompts or let the agent decide when to use them.

---

## Windsurf

### Setup

Add to your MCP configuration (check Windsurf docs for the config file location):

```json
{
  "mcpServers": {
    "autocontext": {
      "command": "npx",
      "args": ["--no-install", "context", "serve", "--path", "/path/to/project"]
    }
  }
}
```

---

## Continue

### Setup

Add to `.continue/config.json`:

```json
{
  "experimental": {
    "modelContextProtocolServers": [
      {
        "transport": {
          "type": "stdio",
          "command": "npx",
          "args": ["--no-install", "context", "serve", "--path", "."]
        }
      }
    ]
  }
}
```

---

## Generic MCP Client

Any MCP client that supports stdio transport can connect:

```bash
npx context serve --path /path/to/project
```

The server speaks JSON-RPC 2.0 over stdin/stdout. Stderr is used for logging.

---

## Non-MCP Usage

`.context.yaml` files are plain YAML. No MCP server needed for basic usage.

### Any LLM Tool

Point your LLM at `.context.yaml` files in each directory. The files are self-describing — the `maintenance` field tells the LLM how to keep them updated.

### Script Access

```bash
# Read a context file
cat src/core/.context.yaml

# Parse with yq
yq '.interfaces[].name' src/core/.context.yaml

# Check all summaries
for f in $(find . -name ".context.yaml"); do
  echo "=== $(yq '.scope' $f) ==="
  yq '.summary' $f
done
```

### Programmatic Access (Node.js)

```typescript
import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const content = await readFile("src/core/.context.yaml", "utf-8");
const context = parse(content);
console.log(context.summary);
console.log(context.interfaces);
```

---

## CI/CD

See [ci.md](ci.md) for pipeline recipes with GitHub Actions and GitLab CI.
