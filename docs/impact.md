# `context impact`

Answer the question: *"If I change this file or this symbol, which
directories' `.context.yaml` files become suspect?"*

## Usage

```
context impact <path>              # every exported symbol of <path> as seed
context impact <path>#<symbol>     # one specific exported symbol
context impact <path> --json       # machine-readable report
context impact <path> --max-depth 5  # BFS depth bound (default 3)
context impact <path> --max 200    # cap affected files (default 100)
```

Exit codes:

| Code | Meaning |
|---|---|
| 0 | Successful walk, report emitted. |
| 2 | Empty seed set. |
| 3 | Index missing (`context index` not yet run). |
| 4 | Invalid target (file not under project root, symbol not found). |

## Algorithm

Impact walks the reverse adjacency of T1's import-bound reference graph via
breadth-first search. Each hop considers two edge kinds:

1. **Reference** — who references an exported symbol of the current file?
2. **Import** — who imports the current file at all (catches side-effect
   imports and Python `from X import *`).

Output is deterministic: affected files are sorted by `(hops, path)`, and
affected scopes are sorted by `(min_hops, scope)`. Every report carries a
`caveat` string pinning the T1 precision boundary.

## Precision boundary

Impact is **import-bound-only**. What it does *not* walk:

- Polymorphic dispatch (virtual methods, trait objects).
- Dynamic imports (`import(expr)`, `require(variable)`, `importlib.import_module`).
- Member access through a namespace import (`ns.foo`) — T1-B intentionally
  excludes this.
- Transitive re-exports beyond one hop.

Measured precision on the labeled fixture at
`tests/fixtures/impact-labels/`: 1.00 / 1.00 across all 5 scenarios (gate
set to ≥0.90 precision / ≥0.70 recall).

Use impact to **narrow** the review surface, not to **prove** absence of
effect. See [src/impact/README.md](../src/impact/README.md) for the full
design and fixture description.
