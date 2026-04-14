# Schema Reference

Every `.context.yaml` file follows a strict [Zod-validated](https://zod.dev/) schema. The CLI validates on every write — invalid context files cannot be created through normal tooling.

## Full Example

```yaml
# ---- Required fields (every .context.yaml) ----
version: 1
last_updated: "2026-02-10T14:30:00Z"
fingerprint: "a3f8b2c1"
scope: "src/auth"
summary: |
  Handles user authentication and session management.
  JWT-based with access/refresh token pairs.

files:
  - name: "handler.py"
    purpose: "FastAPI route handlers for /login, /register, /refresh"
  - name: "tokens.py"
    purpose: "JWT creation, validation, and expiry logic"
  - name: "middleware.py"
    purpose: "Auth middleware for protected routes"
    test_file: "tests/test_middleware.py"

maintenance: |
  If you modify files in this directory, update this .context.yaml.
  Do not include secrets, API keys, passwords, or PII in this file.

# ---- Optional fields ----
interfaces:
  - name: "POST /login"
    description: "Authenticates user, returns JWT token pair"
  - name: "verifyToken(token): User"
    description: "Validates JWT and returns decoded user"

decisions:
  - what: "JWT over server-side sessions"
    why: "Stateless, scales horizontally"
    tradeoff: "Revocation requires a blocklist table"

constraints:
  - "All endpoints except /health require authentication"

dependencies:
  internal:
    - "src/db — database models and connection"
  external:
    - "pyjwt ^2.8"
    - "fastapi ^0.110"

current_state:
  working:
    - "Login and register endpoints fully tested"
  broken:
    - "Refresh endpoint has race condition (#14)"
  in_progress:
    - "Adding rate limiting to login endpoint"

subdirectories:
  - name: "tests/"
    summary: "Unit and integration tests for auth module"

environment:
  - "JWT_SECRET — signing key for tokens"
  - "TOKEN_EXPIRY — access token lifetime in minutes"

testing:
  - "pytest tests/ — run all auth tests"
  - "pytest tests/test_handler.py -k login — run login tests only"

todos:
  - "Add rate limiting to login endpoint"
  - "Migrate to asymmetric JWT signing"

data_models:
  - "User — id, email, hashed_password, created_at"
  - "Session — id, user_id, refresh_token, expires_at"

events:
  - "user.login — emitted on successful authentication"
  - "user.register — emitted on new account creation"

config:
  - "auth.yaml — JWT settings and rate limit config"

# ---- Root-only fields (scope: ".") ----
project:
  name: "myapp"
  description: "REST API for task management"
  language: "python"
  framework: "fastapi"
  package_manager: "pip"

structure:
  - path: "src/auth"
    summary: "Authentication and JWT handling"
  - path: "src/api"
    summary: "REST endpoint handlers"
  - path: "src/db"
    summary: "SQLAlchemy models and migrations"

# ---- Machine-derived provenance ----
derived_fields:
  - "dependencies.external"
  - "files[].test_file"
  - "evidence"

evidence:
  collected_at: "2026-02-10T14:30:00Z"
  test_status: "passing"
  test_count: 142
```

## Required Fields

Every `.context.yaml` must include these fields. The CLI will refuse to write a file that fails validation.

| Field | Type | Description |
|---|---|---|
| `version` | `integer` | Schema version. Must be `1`. See [versioning.md](versioning.md). |
| `last_updated` | `string` | ISO 8601 timestamp of when this context was generated or updated. |
| `fingerprint` | `string` | 8-character hex SHA-256 hash of directory contents (`filename:mtime:size`). See [trust-model.md](trust-model.md). |
| `scope` | `string` | Relative path from project root. Root is `"."`. |
| `summary` | `string` | 1-3 sentence description of what this directory does. |
| `maintenance` | `string` | Self-describing instruction telling LLMs how to update this file. Embedded in every context file so it works across all tools. |

## Optional Fields

Include these when there's something meaningful to document. Empty arrays are omitted.

| Field | Type | Description |
|---|---|---|
| `files` | `array of {name, purpose, test_file?}` | File list (full mode). In lean mode this is usually omitted. |
| `interfaces` | `array of {name, description}` | Public APIs, exported functions, CLI commands, HTTP endpoints. `name` can be a function signature (`verifyToken(token): User`) or an endpoint (`POST /login`). |
| `decisions` | `array of {what, why, tradeoff?}` | Architectural choices. `tradeoff` is optional. |
| `constraints` | `array of string` | Hard rules the code must follow. |
| `dependencies` | `{internal?: string[], external?: string[]}` | Internal module references and external package dependencies. |
| `current_state` | `{working?: string[], broken?: string[], in_progress?: string[]}` | What's working, broken, or in progress. |
| `subdirectories` | `array of {name, summary}` | Child directories with brief descriptions. |
| `environment` | `array of string` | Required environment variables or config. |
| `testing` | `array of string` | Test commands and conventions. |
| `todos` | `array of string` | Known future improvements. |
| `data_models` | `array of string` | Key data structures or schemas. |
| `events` | `array of string` | Events emitted or consumed. |
| `config` | `array of string` | Config files or feature flags. |
| `exports` | `array of string` | Compact method/API signatures generated from source for routing. |

## Root-Only Fields

Only present in the root `.context.yaml` (where `scope` is `"."`):

| Field | Type | Description |
|---|---|---|
| `project` | `{name, description, language, framework?, package_manager?}` | Project metadata. `framework` and `package_manager` are optional. |
| `structure` | `array of {path, summary}` | Top-level directory map with one-line summaries. |

## Provenance Fields

| Field | Type | Description |
|---|---|---|
| `derived_fields` | `array of string` | JSON pointer-style paths listing which fields were machine-generated rather than LLM-narrated. See [trust-model.md](trust-model.md) for what this means. |
| `evidence` | `object` | Machine-collected code health data. Never from LLM generation — always from reading existing artifacts. Fields: `collected_at` (ISO 8601, required), `commit_sha` (git SHA), `test_status` / `test_count` / `failing_tests` / `test_tool` (test results), `typecheck` / `typecheck_tool` (type checking), `lint_status` / `lint_tool` (linting), `coverage_percent` (line coverage 0-100). Uses `.strict()` validation. See [evidence.md](evidence.md) for the full contract. |
| `semantic_fingerprint` | `string` (12-hex lowercase) | Semantic fingerprint over exported API + resolved imports + policy facts. Optional. When present, enables `explain_staleness` to distinguish `cosmetic_stale` from `semantic_stale`. See [freshness.md](freshness.md). |
| `rules` | `array of Rule` | Typed policy rules enforced by `context validate --policy`. Seven discriminated-union shapes: `forbid_import`, `require_import`, `require_export`, `max_file_lines`, `require_test_file`, `dependency_boundary`, `evidence_requires`. See [policies.md](policies.md). |

The six fields `environment`, `testing`, `todos`, `data_models`, `events`, and `config` are now populated automatically by static extractors in `init` / `regen`. Their shape is unchanged (all `string[]`); what changed is that they stop being sparse.

## Config File Schema

`.context.config.yaml` lives at the project root and stores provider settings. Should be added to `.gitignore`.

```yaml
provider: anthropic           # anthropic | openai | google | ollama
model: claude-3-5-haiku-latest         # optional model override
api_key_env: MY_CUSTOM_KEY    # optional env var name for API key
ignore:                       # additional directories to ignore
  - tmp
  - scratch
max_depth: 5                  # max directory scan depth
mode: lean                    # lean | full
min_tokens: 4096              # skip tiny directories unless needed for routing
```

| Field | Type | Required | Description |
|---|---|---|---|
| `provider` | `enum` | yes | `"anthropic"`, `"openai"`, `"google"`, or `"ollama"` |
| `model` | `string` | no | Model ID override. If omitted, uses provider default. |
| `api_key_env` | `string` | no | Environment variable name for API key. Overrides the provider default. |
| `ignore` | `string[]` | no | Additional directory patterns to ignore during scanning. |
| `max_depth` | `integer` | no | Maximum directory depth for scanning. Must be >= 1. |
| `mode` | `enum` | no | `"lean"` or `"full"` default generation mode. |
| `min_tokens` | `integer` | no | Minimum estimated token size for a directory to be tracked. Default is `4096`; set `0` to disable threshold filtering. |
| `verify` | `object` | no | Commands the `context verify` command runs (test / typecheck / lint / coverage / build). Strings or `{command, cwd, timeout_seconds, env, artifact, parser}` objects, plus an optional `scope_overrides` map. See [docs/verify.md](verify.md). |
