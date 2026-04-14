# 03 — Add a new export

Add `subtract` to `src/core/math.ts`. No file references it yet.

**Why it should NOT propagate:** adding a new public symbol doesn't break existing consumers. The reverse-reference graph has no edges for `subtract` (it didn't exist). Zero impact.

**Expected impact directories:** none.
