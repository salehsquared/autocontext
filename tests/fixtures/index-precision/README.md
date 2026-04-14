# index-precision fixture

Hand-labeled fixture for measuring T1-B's import-bound reference extractor.

## Format

Each language directory has:
- `src/` — source files. The files named `src/math.*` and `src/strings.*` are **targets** (modules that export symbols). The files named `src/NN-name.*` are **cases** (files that import from the targets).
- `expected.json` — one entry per case, listing every import-bound reference that case should produce.

## Reference shape

Each expected reference:

```json
{"target_file": "<rel path>", "target_symbol": "<name>", "count": <int>}
```

`count` is the number of distinct reference sites (textual uses) inside the case file that bind to `target_file:target_symbol`. When the binding resolves through a one-hop re-export, count the re-export site itself.

## Precision / Recall

- **Precision** = |actual ∩ expected| / |actual|
- **Recall**    = |actual ∩ expected| / |expected|

A reference emitted by T1-B but not in `expected.json` is a **false positive** (precision hit).
A reference in `expected.json` but not emitted by T1-B is a **false negative** (recall hit).

## v1 precision boundary (reminder)

The extractor is **import-bound-only**. Member access through namespace imports (`m.foo`), dynamic imports, and transitive re-exports beyond one hop are **deferred** in v1. Cases covering those patterns have `expected_references: []` and a note explaining why.

## Acceptance targets (per T1-B plan)

- TS/JS import-bound precision ≥ 0.95
- Python import-bound precision ≥ 0.90
- Recall ≥ 0.70 across languages
