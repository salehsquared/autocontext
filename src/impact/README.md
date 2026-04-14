# Change impact

`src/impact/` owns the reverse-reference walk that powers `context impact`
and the `impact` MCP tool (T6).

## Precision boundary

Impact walks the T1 **import-bound** reference graph. That graph is
high-precision and deliberately recall-imperfect:

- Precision ≥ 0.95 for TS/JS import-bound references.
- Recall ≥ 0.70 for TS/JS; lower for Python, Go, Rust.

Consequences for impact:

- **Polymorphic dispatch** (virtual methods, trait-object dispatch) is not
  walked. Two types that share a method name but live in unrelated files
  will look unrelated here.
- **Dynamic imports** (`import(expr)` where `expr` is not a string literal,
  `require(variable)`, `importlib.import_module(...)`) are not walked.
- **Member access** (`ns.foo`) through a namespace import is not walked —
  T1-B intentionally excludes the namespace case.
- **Transitive re-exports beyond one hop** are not followed.

The practical takeaway, restated in every `ImpactReport.caveat` field: use
impact to **narrow** the review surface, not to prove absence of effect.

## Algorithm

BFS over reverse adjacency, bounded by `maxDepth` (default 3) and
`maxResults` (default 100). Two edge kinds contribute to the frontier:

1. `reference` — who uses an exported symbol of the current file.
2. `import` — who imports the current file at all (catches side-effect
   imports and Python `from X import *`).

Output is deterministic: `affected[]` sorted by `(hops, file)`,
`affected_scopes[]` by `(min_hops, scope)`.

## Fixture

`tests/fixtures/impact-labels/` carries a mini-project with five labeled
scenarios (signature change, unused-export change, new export, other used
export, internal helper). `tests/impact/precision.test.ts` builds the
baseline index, overlays each scenario's `modified/` files, diffs exported
symbols, seeds the BFS, and asserts precision ≥ 0.90 / recall ≥ 0.70 across
all scenarios.
