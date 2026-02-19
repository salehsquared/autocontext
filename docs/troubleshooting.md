# Troubleshooting

## Common Issues

### `context init` produces no files

**Symptom:** "No directories with source files found."

**Cause:** The scanner didn't find any directories with recognized source files.

**Fixes:**
- Make sure you're running from the project root (where `.git` lives)
- Check that `.gitignore` or `.contextignore` isn't excluding your source directories
- Verify your files have recognized extensions (`.ts`, `.py`, `.rs`, `.go`, `.java`, etc. — 30+ supported)
- Files like `Dockerfile`, `Makefile`, `Cargo.toml` are also recognized as meaningful

### All directories show "stale" immediately after `init`

**Symptom:** `context status` shows everything as stale right after `context init`.

**Cause:** File modification times changed during the generation process (build tools, editors, or formatters running concurrently).

**Fix:** Run `context rehash` to recompute fingerprints without regenerating content.

### LLM generation fails or produces minimal context

**Symptom:** Context files have only basic structural information, no summaries or decisions.

**Causes:**
- API key missing or invalid
- Provider not configured
- LLM returned invalid YAML (the CLI falls back to minimal context)

**Fixes:**
- Check configuration: `context config`
- Verify API key is set: check the environment variable shown in config
- Try a different provider or model via `context config --provider <name> --model <model>`

### `context serve` appears to hang

**Symptom:** Running `context serve` keeps running and does not return to the prompt.

**Cause:** This is expected. The MCP server is long-lived and communicates via stdio (JSON-RPC on stdin/stdout). You may see startup logs on stderr only.

**Fix:** Connect an MCP client. See [integrations.md](integrations.md) for setup.

### `validate --strict` reports false positives on interfaces

**Symptom:** Interfaces like `POST /login` flagged as "phantom interface."

**Cause:** This won't happen — strict mode automatically skips non-identifier interface names (endpoints, CLI commands). If you're seeing phantom interface warnings, the interface name starts with a code identifier that isn't found in exports.

**Fix:** Check if the function was renamed or removed. Run `context regen <dir>` to update.

### Ignore patterns don't seem to work

**Symptom:** A directory you thought was ignored still gets scanned.

**Causes:**
- Pattern syntax issue
- Pattern added to wrong file

**Supported patterns:**
- Exact names: `dist`, `node_modules`
- Glob wildcards: `*.cache`, `.*.swp`
- Path patterns: `src/generated`, `packages/*/dist`
- Double-star: `**/temp`
- Negation: `!important-build` (un-ignores a previously matched entry)

**Where to add patterns:**
- `.gitignore` — respected automatically (root only)
- `.contextignore` — project-specific exclusions
- Config: `context config --ignore <pattern>`

### `context watch` doesn't detect new directories

**Symptom:** A newly created directory with source files isn't monitored.

**Cause:** `context watch` scans the directory tree once at startup and monitors only those directories.

**Fix:** Restart `context watch`. This is a known limitation — see [limitations.md](limitations.md).

### Evidence section is empty

**Symptom:** Generated context has no `evidence` field.

**Causes:**
- `--evidence` flag not passed
- No test artifact files found
- Not at project root (evidence is root-only)

**Fixes:**
- Use `context init --llm --evidence` or `context regen --all --evidence`
- Run your tests first to generate artifacts (`test-results.json`, `.vitest-results.json`, or `junit.xml`)
- Evidence only appears in the root `.context.yaml`

### `bench` says "No provider configured"

**Symptom:** `context bench` exits with `No provider configured. Run context config --provider <name> first.`

**Cause:** Bench uses your local `.context.config.yaml` for provider credentials, even when benchmarking a cloned `--repo`.

**Fixes:**
- Set provider/model in your current project: `context config --provider openai --model gpt-4o-mini`
- Export the matching API key env var (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.)

### `bench` says contexts are stale

**Symptom:** `context bench` exits with `N context file(s) are stale`.

**Cause:** Bench requires fresh context by default for fair comparisons.

**Fixes:**
- Regenerate first: `context regen --all --stale`
- Or allow stale contexts explicitly: `context bench --allow-stale`

### `context regen --force` does nothing

**Symptom:** Running with `--force` produces the same behavior as without it.

**Cause:** `--force` is currently accepted for forward compatibility and is a no-op in current releases.

**Fix:** Omit `--force` for now; behavior is unchanged.

### `context bench --tasks <file>` has no effect

**Symptom:** Passing `--tasks` does not change generated tasks.

**Cause:** The flag is currently reserved for future manual task-file support and is not wired yet.

**Fix:** Use `--max-tasks`, `--seed`, and `--category` for current task control.

## Provider-Specific Issues

### Anthropic

| Error | Cause | Fix |
|---|---|---|
| 401 Unauthorized | Invalid or expired API key | Verify `ANTHROPIC_API_KEY` is set and valid |
| 429 Rate Limited | Too many requests | Wait and retry, or reduce concurrency |
| 500/503 | Service outage | Check [status.anthropic.com](https://status.anthropic.com), retry later |

### OpenAI

| Error | Cause | Fix |
|---|---|---|
| 401 Unauthorized | Invalid API key | Verify `OPENAI_API_KEY` |
| 429 Rate Limited | Quota exceeded | Check usage at platform.openai.com, wait, or upgrade plan |
| Model not found | Invalid model name in config | Check `context config`, fix model name |

### Google

| Error | Cause | Fix |
|---|---|---|
| 403 Forbidden | API not enabled | Enable "Generative Language API" in Google Cloud Console |
| 401 Unauthorized | Invalid API key | Verify `GOOGLE_API_KEY` |

### Ollama

| Error | Cause | Fix |
|---|---|---|
| ECONNREFUSED | Ollama not running | Start with `ollama serve` |
| Model not found | Model not pulled | Run `ollama pull llama3.2:3b` (or your configured model) |
| Slow generation | Model too large for hardware | Try a smaller model: `context config --model llama3.2:1b` |

## Still Stuck?

- Check if the issue is tracked: [github.com/salehsquared/autocontext/issues](https://github.com/salehsquared/autocontext/issues)
- File a bug with `context validate` output and your Node.js version
