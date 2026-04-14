# 01 — Change signature of a used export

Change `add(a, b)` in `src/core/math.ts` to require a third argument.

**Why it should propagate:** `add` is referenced by `src/commands/compute.ts`, and `compute.runCompute` is transitively referenced by `src/mcp/server.ts`.

**Expected impact directories:** `src/commands`, `src/mcp`.
