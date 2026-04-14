# Trust Model

Not all fields in a `.context.yaml` are created equal. Some are machine-derived ground truth. Others are LLM-generated narrative that may contain inaccuracies. The `derived_fields` array tells you which is which.

## Field Provenance

| Field | Source | Trust Level |
|---|---|---|
| `version`, `last_updated`, `fingerprint`, `scope` | Always machine-generated | Ground truth |
| `files` (names) | Static mode: filesystem scan. LLM full mode: model output (schema-validated only) | High confidence in static mode; cross-check in LLM mode |
| `files[].purpose` (static mode) | Heuristic from filename/content | High confidence |
| `files[].purpose` (LLM mode) | LLM-generated | Cross-check with code |
| `files[].test_file` | Heuristic filename matching | Best-effort guess |
| `dependencies.external` | Parsed from package manifests when machine-derived; otherwise may come from LLM/human | Trust `derived_fields` marker |
| `dependencies.internal` | Parsed from import/require statements | Ground truth |
| `interfaces` (static mode) | AST-extracted via tree-sitter | High confidence (5 languages) |
| `interfaces` (LLM mode) | LLM-generated | Cross-check with code |
| `evidence` | Read from test artifact files | Ground truth (if artifacts current) |
| `project`, `structure` | Static mode/fallback: filesystem + manifests. LLM mode: may be model-authored | High confidence for static/fallback values; caution for LLM-authored narrative |
| `subdirectories` | Filesystem scan | Ground truth |
| `summary` | Static heuristic (no-LLM mode) or LLM narrative (LLM mode) | High confidence in static mode; caution in LLM mode |
| `decisions` | LLM- or human-authored narrative | Interpret with caution |
| `constraints` | LLM- or human-authored narrative | Interpret with caution |
| `current_state` | LLM- or human-authored narrative | Interpret with caution |
| `maintenance` | Static template | Ground truth |

### How to Read `derived_fields`

The `derived_fields` array lists JSON pointer-style paths for fields that were machine-derived:

```yaml
derived_fields:
  - "version"
  - "last_updated"
  - "fingerprint"
  - "scope"
  - "dependencies.external"
  - "dependencies.internal"
  - "subdirectories"
  - "structure"
  - "evidence"
```

**If a field is in `derived_fields`**: it was computed from source code, manifests, or artifacts. Treat it as structural fact.

**If a field is NOT in `derived_fields`**: it was either LLM-generated or human-written. Treat it as narrative — useful context but not guaranteed accurate.

## Freshness Model

### What the Fingerprint Measures

```
fingerprint = SHA256(sorted(filename:mtime:size for each file))[:8]
```

The fingerprint is computed from `stat()` calls only — no file reads. It captures:
- File additions (new filename in the sorted list)
- File deletions (filename removed from list)
- File modifications (mtime and/or size change)

### What "Stale" Means

| State | What it tells you |
|---|---|
| **fresh** | No files have been added, removed, or modified since the context was generated. The machine-derived fields are current. Narrative fields (LLM- or human-authored) reflect the code state at generation/edit time. |
| **stale** | At least one file has changed. Machine-derived fields may be outdated. LLM-generated summaries may no longer reflect the code. |
| **missing** | No `.context.yaml` exists for this directory. |

### What Freshness Does NOT Guarantee

**Stale does not mean wrong.** A formatting-only change to a source file triggers staleness, but the summary is still accurate. A file touch without content changes also triggers staleness.

**Fresh does not mean correct.** A summary/decision may still be wrong (for example LLM hallucination or stale human notes). Freshness only confirms files have not changed since generation/edit — not that narrative interpretation was perfect.

**Fingerprints are not content-stable.** Two identical file trees with different modification times produce different fingerprints. This is a deliberate tradeoff — `stat()` is cheap, content hashing would be expensive for large directories.

## When to Trust, Verify, or Regenerate

| Situation | Action |
|---|---|
| Context is fresh, you need file/dependency info | Trust it — these are machine-derived |
| Context is fresh, you need summary/decisions | Trust with caution — LLM narratives can have inaccuracies |
| Context is stale, you need file/dependency info | Verify or regenerate — files have changed |
| Context is stale, you need summary/decisions | Regenerate — summary may no longer reflect the code |
| `validate --strict` reports phantom files | Context lists files that no longer exist — regenerate |
| `validate --strict` reports phantom interfaces | Context declares interfaces not found in exports — cross-check |

## Index trust model

The local code index at `.autocontext/index/` (built by `context index`) is a **syntactic** artifact, not a semantic one. It's powered by tree-sitter grammars and records only what a parser can extract without type inference.

| What the index claims | What it explicitly does NOT claim |
|---|---|
| Every top-level symbol definition per language (TS/JS/Python in v1). | Method-level resolution on classes is v1-deferred (class *definitions* are indexed; their methods are not separate symbols). |
| One `ImportEdge` per static import / `require` / `from …` / `use` statement. | Imports synthesized at runtime (template-literal `import()`, dynamic require) are not indexed. |
| `Reference` rows for identifier uses **bound** by a static import in the same file that resolve to a concrete symbol. | Free identifier uses, member-access chains, polymorphic dispatch, and type-only uses are NOT reference rows. |
| Directory-level import edges (`DirEdge`). | Call graph / control flow / data flow. |

Precision / recall targets (measured on the test fixtures):

- **TypeScript / JavaScript** — precision ≥ 0.95, recall ≥ 0.70.
- **Python** — precision ≥ 0.90, recall ≥ 0.70.
- **Go / Rust** — deferred in v1; WASM grammars are copied, analyzers are specced. Tools that need the index on these languages should error cleanly (`INDEX_MISSING` or similar) until a later release.

Every user-facing output that consumes references surfaces this boundary:

- `find_references` MCP tool pins `reference_kind: "import_bound"` plus a caveat string.
- `context impact` prints the pinned `IMPACT_CAVEAT` on every invocation.
- Bench ground truth carries `ground_truth_provenance.precision_class` (`"authoritative"` vs `"import_bound"`) so analyzers can weight by confidence tier.

Treat a zero result from `find_references` / `impact` as "no import-bound callers," **not** as "no callers at all." Agents that need dynamic-dispatch or runtime-injection coverage should supplement with actual execution (tests, tracing).

See [docs/limitations.md](limitations.md) for the per-language honest status, and [docs/index.md](index.md) for the full layout + versioning story.

## For LLM Tool Developers

If you're building an MCP client or tool that reads `.context.yaml`:

1. **Always check freshness first.** Use `check_freshness` MCP tool or compare the stored `fingerprint` against a fresh computation.
2. **Use `derived_fields` to decide trust level.** Fields listed there are machine-derived and reliable (when fresh).
3. **Treat summaries as context, then decide trust by mode/provenance.** Static-derived summaries are usually high confidence; LLM or human narrative still needs judgment.
4. **Prefer `query_context` with filters** to request only the fields you need, reducing token usage.
5. **If context is stale, tell the user** rather than silently relying on outdated information.
