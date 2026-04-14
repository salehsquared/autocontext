# impact-labels fixture

Hand-labeled fixture for measuring T2's `context impact` precision and recall.

## Layout

- `mini-project/` — a tiny realistic project with a known dependency topology. Baseline state.
- `scenarios/<NN-name>/` — one directory per labeled scenario. Each contains:
  - `description.md` — human prose describing the change.
  - `modified/<relative path>` — the replacement content for one (or more) files. Copy these over the baseline to simulate the change.
  - `expected.json` — the set of directories T2's impact analysis should surface.

## Dependency topology (baseline)

```
src/core/math.ts        exports: add, multiply
src/core/strings.ts     exports: capitalize
src/commands/compute.ts imports: math.add          (uses add)
src/commands/format.ts  imports: strings.capitalize (uses capitalize)
src/mcp/server.ts       imports: compute           (uses compute.runCompute)
```

Reverse-reference edges (derived from T1 index):

- `math.add` ← used by `src/commands/compute.ts`
- `math.multiply` ← (no consumers)
- `strings.capitalize` ← used by `src/commands/format.ts`
- `compute.runCompute` ← used by `src/mcp/server.ts`

## Running a scenario

1. Copy `mini-project/` to a temp dir.
2. Build the T1 index over the temp dir.
3. Apply the scenario: overlay every file in `scenarios/<NN>/modified/` onto the temp tree.
4. Run `context impact` (or call the `impact()` library function) with the modified file(s) as the seed.
5. Compare actual affected directories against `expected.json.expected_impact_directories`.

## Acceptance targets (per T2 plan)

- Precision ≥ 0.90 (few false positives — don't flag dirs that aren't actually affected).
- Recall ≥ 0.70 (catch most actually-affected dirs).

## v1 caveats

- Impact is computed over the **import-bound reference graph** from T1. Unbound dynamic patterns are invisible.
- Impact is **directory-level**, not file-level or symbol-level, in this fixture's expectations.
- Symbols added but not referenced anywhere produce zero impact (no existing consumers). This is the correct answer, not a bug.
