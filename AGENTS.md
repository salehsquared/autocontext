# AGENTS.md

> Instructions for AI coding agents working in this repository.
> Project: autocontext

<!-- autocontext:agents-section -->
## Project Context

This project uses [autocontext](https://github.com/salehsquared/autocontext) for structured codebase documentation.

**Every directory with source files contains a `.context.yaml` file.** It describes:

- What the directory contains and its purpose (summary)
- Architectural decisions and constraints (things you can't infer from code)
- Subdirectory routing (what's inside each subdirectory)

### How to Use Context Files

1. **Before exploring a directory**, read its `.context.yaml` summary to understand what it does
2. **Before modifying code**, check `decisions` and `constraints` for rationale and hard rules
3. **After modifying files**, update the summary if the directory's purpose changed
4. **To check freshness**, run `context status` — stale contexts may have outdated information

### Directory Index

| Directory | Summary |
|-----------|---------|
| `.` (root) | Folder-level documentation for LLMs — .context.yaml files for every directory |
| `conformance` | Documentation. |
| `conformance/invalid` | Source directory. |
| `conformance/valid` | Source directory. |
| `docs` | Documentation. |
| `scripts` | Build and utility scripts. |
| `src` | Source code. |
| `src/bench` | Source directory. |
| `src/commands` | CLI command implementations. |
| `src/core` | Core functionality. |
| `src/generator` | Code generation. |
| `src/mcp` | MCP server integration. |
| `src/providers` | Abstract LLM provider interface. |
| `src/utils` | Utility functions. |
| `tests` | Test suite. |
| `tests/bench` | Test suite. |
| `tests/commands` | CLI command implementations. |
| `tests/core` | Core functionality. |
| `tests/e2e` | Source directory. |
| `tests/fixtures` | Test fixtures. |
| `tests/fixtures/monorepo` | Source directory. |
| `tests/fixtures/monorepo/packages` | Source directory. |
| `tests/fixtures/monorepo/packages/api` | API layer. |
| `tests/fixtures/monorepo/packages/api/src` | Source code. |
| `tests/fixtures/monorepo/packages/shared` | Source directory. |
| `tests/fixtures/monorepo/packages/shared/src` | Source code. |
| `tests/fixtures/simple-project` | Source directory. |
| `tests/fixtures/simple-project/src` | Source code. |
| `tests/fixtures/with-contextignore` | Source directory. |
| `tests/fixtures/with-contextignore/src` | Source code. |
| `tests/generator` | Code generation. |
| `tests/mcp` | MCP server integration. |
| `tests/utils` | Utility functions. |

### Maintenance

When you significantly change files in a directory, update its `.context.yaml`:
- Update `summary` if the directory's purpose shifted
- Update `decisions` if architectural choices changed
- Update `constraints` if hard rules changed

The `maintenance` field in each `.context.yaml` contains specific instructions.
<!-- autocontext:agents-section-end -->
