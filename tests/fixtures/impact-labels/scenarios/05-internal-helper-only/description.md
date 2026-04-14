# 05 — Add a non-exported internal helper

Add a private (non-exported) helper function `_clamp` to `src/core/math.ts`. No public surface changes.

**Expected impact directories:** none.

The semantic fingerprint of `src/core/math.ts` should not change (internal-only changes don't alter the export surface hashed by T2). `context impact` should return an empty set. This is the critical "cosmetic vs semantic" test — fingerprint-only systems would mark the file stale, but impact analysis correctly sees no downstream change.
