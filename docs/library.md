# Library API

`autocontext` is consumable as a library, not just a CLI. Embedders (Aider plugins, editor extensions, custom scripts, CI glue) get the same capabilities the CLI and MCP server use, with typed signatures and a semver contract.

```ts
import { buildPack, scanProject, readContext } from "autocontext";

const scan = await scanProject(process.cwd());
const ctx = await readContext(process.cwd());
const pack = await buildPack({
  projectRoot: process.cwd(),
  query: "freshness fingerprint",
  budget: 4000,
});
```

The package ships ESM only (`"type": "module"`), targets Node ≥ 18, and exposes its public surface through a single root entry — `import "autocontext"`. There are no subpath exports yet (e.g., `autocontext/pack`); we'll add them if the barrel grows beyond ~30 symbols or if pack-only consumers complain.

## Stability tiers

Every export is tagged with a JSDoc `@stability` marker — IDE hovers carry the tier.

| Tier | Contract |
|---|---|
| **stable** | From `1.0.0` onward, breaking changes are major bumps. Pre-1.0 we still respect the spirit but call out breakage in the changelog. |
| **experimental** | May break in a minor release. Always ships valid types. Promoted to stable once it has a real consumer + has shipped unchanged across two minor releases. |

## Stable surface (v0)

### Pack — token-budgeted briefs

| Export | Source | Notes |
|---|---|---|
| `buildPack(opts)` | `src/pack/pack.ts` | Returns a `Pack` with header + ranked scopes. |
| `formatPackJson(pack)` | `src/pack/format.ts` | Deterministic JSON serializer. |
| `formatPackMarkdown(pack)` | `src/pack/format.ts` | Markdown with `<!-- autocontext:section:* -->` delimiters. |
| `Pack`, `PackOptions`, `PackScope` (types) | `src/pack/types.ts` | The schema is version-locked by the pack itself. |

### Core — read & traverse contexts

| Export | Source | Notes |
|---|---|---|
| `scanProject(root, opts?)` | `src/core/scanner.ts` | Walk the project tree; honors `.gitignore` + `.contextignore`. |
| `flattenBottomUp(scan)` | `src/core/scanner.ts` | Depth-first flatten of a `ScanResult`. |
| `readContext(dir)` | `src/core/writer.ts` | Returns the parsed `ContextFile` or `null`. Throws `UnsupportedVersionError` on newer schemas. |
| `writeContext(dir, ctx)` | `src/core/writer.ts` | Validates with Zod before writing. |
| `loadConfig(root)` | `src/utils/config.ts` | Returns the parsed `.context.config.yaml` or `null`. |
| `checkFreshness(dir, fp, ...)` | `src/core/fingerprint.ts` | 4-state freshness when an index is available; falls back to 3-state. |
| `legacyState(state)` | `src/core/fingerprint.ts` | Collapses 4-state → 3-state for legacy consumers. |
| `UnsupportedVersionError` | `src/core/writer.ts` | Thrown when a `.context.yaml`'s `version` exceeds `SCHEMA_VERSION`. |
| `SCHEMA_VERSION`, `CONTEXT_FILENAME`, `CONFIG_FILENAME` | `src/core/schema.ts` | Constants. |
| `contextSchema`, `configSchema` | `src/core/schema.ts` | Zod objects (Zod 4). Re-exported because conformance tooling needs them; consumers should normally infer types instead. |
| Types: `ContextFile`, `ConfigFile`, `ScanResult`, `FreshnessState`, `LegacyFreshnessState` | various | Mirrors the on-disk schema. |

## Experimental surface

These are useful today but their shapes may tighten as the underlying tracks evolve.

### Index (T1)

| Export | Notes |
|---|---|
| `openIndex(root, opts?)` | Returns an `IndexStore` (NDJSON-backed). Honor `readOnly: true` from library callers. |
| `IndexStore` (type) | Reader/writer interface. |
| `IndexSymbol`, `ImportEdge`, `Reference`, `DirEdge`, `FileFingerprint`, `IndexManifest`, `FileId` (types) | Index record shapes. |

### Impact (T2)

| Export | Notes |
|---|---|
| `computeImpact(store, seeds, opts?)` | Reverse-BFS over the import graph from a file/symbol/diff seed. Recall-imperfect — see `IMPACT_CAVEAT`. |
| `IMPACT_CAVEAT` | Pinned caveat string surfaced everywhere impact is reported. |
| `ImpactReport`, `ImpactSeed` (types) | |

### Semantic staleness (T2)

| Export | Notes |
|---|---|
| `computeSemanticFingerprint(...)` | Returns a 12-hex fingerprint over exported API + imports + policy facts. |
| `extractPolicyFacts(ctx)` | Pulls the policy facts a semantic fingerprint depends on. |
| `SEMANTIC_FINGERPRINT_MARKER` | The "semv1" prefix used to detect format generation. |

### Policy (T4)

| Export | Notes |
|---|---|
| `runPolicies(opts)` | Evaluate `rules:` blocks against the loaded index. Returns `PolicyRunResult` (capped at 500 violations with `truncated`). |
| `ruleSchema`, `RULE_KINDS` | The Zod discriminated union and string-literal list. |
| `PolicyRunResult`, `RunPoliciesOptions`, `PolicyIndexState`, `Rule`, `RuleKind`, `PolicyViolation` (types) | Plus per-rule type aliases (`ForbidImportRule`, `RequireExportRule`, …). |

## What's NOT in the library API

These are intentionally internal. If you need one, file an issue rather than deep-importing `autocontext/dist/...`.

| Area | Why internal |
|---|---|
| `src/commands/*` (CLI) | Calls `process.exit`, parses `process.argv`. Embedding it is a footgun. |
| `src/mcp/*` (MCP server + tools) | Has its own transport contract. To get the same data, call the underlying function (`buildPack`, `runPolicies`, `computeImpact`). |
| `src/providers/*`, `src/generator/llm.ts` | Provider selection is environment-driven and cache-sensitive (T7 LLM cache invariants). |
| `src/generator/*` (extractors, AST, imports) | Implementation details of `init`/`regen`. Read the *results* via `readContext` instead. |
| `src/commands/watch.ts` | Long-lived stateful — not a function-call surface. |
| `src/utils/*` | CLI conventions only. |
| `src/verify/*` | Spawns shell commands the user configures — only safe behind the `context verify` CLI's first-run prompt. |
| `src/view/*` | The viewer is a CLI artifact generator. Inline the renderer if you need its output. |

## Versioning

- **Today:** package is `0.2.0`. The same bump that introduced the `exports` map. We treat the experimental tier as best-effort and call out breakage in the changelog.
- **At `1.0.0`:** every stable symbol locks down. Experimental symbols stay experimental until promoted; promotion is a JSDoc tag flip + a changelog entry.
- **Promotion rules** — a symbol moves from experimental to stable once it has shipped unchanged across two minor releases, has at least one documented consumer example here, and has no open issue proposing a signature change.
- **Removal** — stable symbols only disappear at a major version after a `@deprecated` cycle. Experimental symbols may be removed in the next minor with a changelog entry.

## Module resolution

`package.json` declares:

```jsonc
{
  "main": "dist/lib.js",
  "types": "dist/lib.d.ts",
  "exports": {
    ".": {
      "types": "./dist/lib.d.ts",
      "import": "./dist/lib.js",
      "default": "./dist/lib.js"
    },
    "./package.json": "./package.json"
  },
  "sideEffects": false
}
```

- `import "autocontext"` resolves to `dist/lib.js` (the curated barrel) — never to the CLI.
- TypeScript ≥ 4.7 picks up types via the `exports.types` condition; older setups fall back to the top-level `types` key.
- `sideEffects: false` lets bundlers tree-shake unused exports. The CLI bin is shipped under `bin`, which bypasses the `exports` map.

## CHANGELOG

Library-affecting changes are noted in `CHANGELOG.md` under the `Library` heading. Inspect that file to see what shifted between releases before upgrading.
