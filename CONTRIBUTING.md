# Contributing to autocontext

## Requirements

- Node.js >= 18
- npm (ships with Node)

## Setup

```bash
git clone https://github.com/salehsquared/autocontext.git
cd autocontext
npm install
npm run build
```

## Running Tests

```bash
npm test                  # Unit tests (vitest)
npm run test:conformance  # Schema conformance suite (ajv + Zod parity)
npm run test:e2e          # E2E smoke test (npm pack → install → run CLI)
npm run lint              # Type-check (tsc --noEmit)
```

All four must pass before submitting a PR.

## Project Structure

```
src/
  core/         Schema, scanner, fingerprint, reader/writer
  commands/     CLI command handlers (init, status, regen, etc.)
  generator/    Static analysis and LLM-based context generation
  mcp/          MCP server and tool registration
  utils/        Config loading, display helpers, token estimation
tests/          Mirrors src/ structure — one test file per source file
conformance/    Data-driven schema test cases (valid/ and invalid/)
docs/           User-facing documentation
scripts/        Build helpers (schema generation, grammar building)
```

## Making Changes

1. Branch from `main`
2. Make your changes
3. Run `npm test && npm run test:conformance && npm run test:e2e && npm run lint`
4. Submit a PR against `main`

## Schema Changes

If you modify `src/core/schema.ts`:

1. Run `npm run generate:schemas` to regenerate `.context.schema.json` and `.context.config.schema.json`
2. Add or update conformance cases in `conformance/valid/` and `conformance/invalid/`
3. Update `docs/schema.md` if field descriptions changed
4. Check `docs/versioning.md` — new optional fields are patch-level; new required fields or type changes require a version bump

## Test Conventions

- Mirror `src/` paths: `src/core/scanner.ts` → `tests/core/scanner.test.ts`
- Use helpers from `tests/helpers.ts` (`makeValidContext`, `createTmpDir`, `cleanupTmpDir`, `createFile`)
- Clean up temp directories in `afterEach` blocks
- Use `vitest` (`describe`, `it`, `expect`)

## Code Style

- TypeScript strict mode
- ES modules with `.js` extensions in imports
- Match existing patterns — look at neighboring files before writing new code
- No default exports

## Reporting Issues

Open an issue at [github.com/salehsquared/autocontext/issues](https://github.com/salehsquared/autocontext/issues) with:

- **Expected behavior**
- **Actual behavior**
- **Steps to reproduce**
- **Environment** (Node version, OS, autocontext version)
