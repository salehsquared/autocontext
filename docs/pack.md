# `context pack`

`context pack` compiles a token-budgeted brief for an LLM from the project's `.context.yaml` corpus. It uses BM25F retrieval across seven yaml zones (summary / decisions / constraints / symbols / facets / state / path) plus graph proximity (when the code index is built) to pick the scopes most useful for a seed, then packs them into a budget via a greedy tier-based assembler.

Output is deterministic for the same inputs + index version.

## Quick start

```bash
# Query seed
context pack --query "freshness fingerprint" --budget 1500

# File seed (anchors on the nearest .context.yaml scope)
context pack --file src/commands/pack.ts --budget 2000

# Symbol seed (picks scopes that export the name)
context pack --symbol buildPack --budget 2000

# JSON output to pipe into tooling
context pack --query "policy rules" --format json --out brief.json
```

## Flags

| Flag | Default | Behavior |
|---|---|---|
| `--query <text>` | — | Free-text seed. Tokenized per the BM25 tokenizer rules. |
| `--file <path>` | — | File-path seed. The pack anchors on the nearest `.context.yaml` scope. |
| `--symbol <name>` | — | Symbol-name seed. Must-include bias lifts scopes that export the name. |
| `--budget <n>` | `4000` | Target token budget. Tier-0 (root) stays ≤ 200 tokens; tier-1 greedy takes up to 85% of the remaining budget. |
| `--format <md\|json>` | `md` on TTY, `json` otherwise | Output format. |
| `--out <path>` | stdout | Write output to a file instead of stdout. |
| `-p, --path <root>` | `.` | Project root override. |

Exactly one of `--query` / `--file` / `--symbol` must be set.

## Ranking

Composite score per candidate scope:

```
score = 0.55 · BM25F + 0.35 · graph_proximity + must_include_bias
```

- **BM25F** runs over seven zones with per-zone weights: summary 3.0 · decisions 2.5 · symbols 2.0 · constraints 1.5 · state 1.0 · facets 0.7 · path 0.5. `k1=1.5, b=0.75`. Global DF.
- **Graph proximity** — BFS over the T1 `DirEdge` graph (undirected). `1 / (1 + hops)`, capped at `MAX_HOPS=4`. Falls back to 0 when the index is absent.
- **Must-include bias** — a small constant lift for scopes that export the seed symbol, or that own the seed file's directory. Keeps the right scope on top when the signal is unambiguous.

Recency boost (γ=0.10) is wired but inert today — it needs git-history integration that's tracked separately.

## Assembly (tier 0 + tier 1)

Once scopes are ranked the assembler walks them greedily:

| Tier | What | Budget |
|---|---|---|
| 0 | Root scope summary (sentence-truncated) | ≤ 200 tokens |
| 1 | Top-ranked scopes, greedy | Up to 85% of the remaining budget, min 3 / max 20 |

Each included scope lists its summary, decisions, constraints, exports, and current state (when set). Symbol signatures, evidence, and source excerpts (tier 2-4 in the plan) are **deferred** — see below.

## Output format — Markdown

Every section carries stable delimiters so downstream tooling can parse or surgically edit:

```markdown
<!-- autocontext:pack:meta -->
- Budget: 1500 tokens (used 686)
- Seed: query "freshness fingerprint"
- Scopes considered: 75

<!-- autocontext:section:root -->
## Root — autocontext

Local code-intelligence for every coding agent. `.context.yaml` routing…

<!-- autocontext:section:scopes -->
## Scopes (ranked)

### src/core
- Summary: Fingerprinting and semantic staleness utilities.
- Decisions:
  - Split cosmetic vs semantic freshness — Pre-commit hook noise.
- Exports: computeFingerprint, checkFreshness, computeSemanticFingerprint
```

## Output format — JSON

```jsonc
{
  "seed": { "kind": "query", "value": "freshness fingerprint" },
  "budget": 1500,
  "used_tokens": 686,
  "root": { "scope": ".", "summary": "…" },
  "scopes": [
    {
      "scope": "src/core",
      "score": 7.234,
      "hops": 1,
      "rendered": "scope: src/core\nsummary: …",
      "mustInclude": false,
      "context": { /* full ContextFile */ },
      "tokens": 180
    }
  ],
  "warnings": [],
  "metadata": {
    "autocontext_version": "0.2.0",
    "n_scopes_considered": 75,
    "truncated": false
  }
}
```

Deterministic ordering (scopes by `(score desc, scope asc)`). Same inputs + same index version = same JSON bytes.

## MCP tool — `build_context_pack`

```ts
{
  query?: string;
  file?: string;
  symbol?: string;
  budget?: number;   // default 4000
  format?: "md" | "json";   // default md
  path?: string;
}
→ MCP content-item with the rendered pack text.
```

See [docs/mcp.md](mcp.md) for response-size limits and the full MCP error envelope.

## Library usage

```ts
import { buildPack, formatPackMarkdown } from "autocontext";

const pack = await buildPack({
  projectRoot: process.cwd(),
  query: "freshness fingerprint",
  budget: 2000,
});
console.log(formatPackMarkdown(pack));
```

`buildPack` is `@stability stable`; `Pack`/`PackOptions`/`PackScope` types are part of the committed surface. See [docs/library.md](library.md).

## Deferrals (documented, will not change the shape)

| Feature | Status |
|---|---|
| Persistent BM25 inverted-index cache at `.autocontext/index/bm25/` | In-memory build is sub-second on the autocontext corpus. Cache lands additively when measured necessary. |
| Tier-2 symbol signatures via `getImporters` / `getImportees` | Scope-level exports already carry the routing signal. |
| Tier-3 evidence / tier-4 source excerpts | Same reason. |
| Recency boost (γ=0.10) | Needs git history per scope. Score weights sum to 0.90 today; γ branch inert. |
| `--diff <ref1..ref2>` seed | `context diff` already covers the change-review workflow. |

## Caveats

- Pack is a retrieval layer over the `.context.yaml` corpus. If `.context.yaml` files are missing or stale, the pack will reflect that — freshness chips are not computed here; check `context status` or `explain_staleness` first.
- Symbol seed precision depends on symbol-name uniqueness. For common names, combine `--symbol` with `--file` in a follow-up call.
- Budget is advisory in the sense that tier-0 always emits (even if it exceeds the budget by a few tokens). The final `used_tokens` never exceeds `budget + 50`.
