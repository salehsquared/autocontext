# Freshness states

autocontext classifies every tracked scope as one of four states. The legacy
three-state contract (`fresh | stale | missing`) is preserved for every JSON
output that existed before T2; new consumers opt into the four-state view
via `status --explain` (CLI) or `explain_staleness` (MCP).

| State | When | What to do |
|---|---|---|
| `fresh` | Directory fingerprint matches AND semantic fingerprint matches (or no stored semantic fingerprint + file layer unchanged). | Nothing. |
| `cosmetic_stale` | Directory fingerprint differs, but semantic fingerprint is still equal (or can't be proven changed). Typical causes: formatter run, whitespace, comment edits, non-exported body changes. | `context rehash` is enough; regen is optional. |
| `semantic_stale` | Both fingerprints differ. Exports, signatures, imports, or policy facts actually changed. | `context regen <scope>` recommended. The pre-commit hook gates on this. |
| `missing` | No `.context.yaml` at this scope. | `context init` or `context regen <scope>`. |

## The two fingerprints

- **Directory fingerprint** (legacy, 8-hex) — sha256 of `name:mtime:size` for
  every file in the directory. Cheap mtime-based trigger. Unchanged by T2.
- **Semantic fingerprint** (new, 12-hex) — sha256 over the directory's
  **exported symbols + signatures + import edges + policy-relevant facts**
  (`constraints`, `rules`, `environment`). Stored in the new optional
  `semantic_fingerprint` field of `.context.yaml`. Schema stays v1.

A directory is `cosmetic_stale` when its disk fingerprint moved but the
semantic one didn't — the canonical "formatter run" case.

## Legacy 3-state contract

Every pre-T2 JSON consumer continues to see exactly `"fresh" | "stale" |
"missing"`. `cosmetic_stale` and `semantic_stale` both collapse to `"stale"`
via the `legacyState()` helper. MCP clients, CI scripts, and any downstream
that parsed the previous shape keep working without changes.

## Pre-commit hook

`scripts/sync-context-staged.mjs` warms the index and then runs
`regen --all --semantic-stale`. Formatter-only commits no longer trigger
regen. A failed index build falls back to the old `--stale` gate so the hook
stays robust against transient failures.

## Precision caveat

The semantic fingerprint relies on the T1 import-bound reference index:
precision ≥ 0.95 / recall ≥ 0.70 for TS/JS; lower for Python, Go, Rust.
Dynamic imports, polymorphic dispatch, and attribute access through a
namespace import are not tracked. Treat `cosmetic_stale` as "probably safe to
skip" rather than a proof that nothing changed.
