#!/usr/bin/env bash
set -euo pipefail

# E2E smoke test: packs the npm artifact, installs it in a temp directory,
# and runs real CLI commands to verify the package works as a consumer would use it.

echo "=== E2E Smoke Test ==="

# --- Setup ---
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TMPDIR_BASE="$(mktemp -d)"
NPM_CACHE_DIR="$TMPDIR_BASE/npm-cache"
TARBALL=""

cleanup() {
  echo "Cleaning up..."
  rm -rf "$TMPDIR_BASE"
  [ -n "$TARBALL" ] && rm -f "$TARBALL"
}
trap cleanup EXIT

# --- Pack ---
echo "1. Packing npm artifact..."
cd "$PROJECT_ROOT"
mkdir -p "$NPM_CACHE_DIR"
TARBALL=$(npm pack --cache "$NPM_CACHE_DIR" --pack-destination "$TMPDIR_BASE" 2>&1 | tail -1)
TARBALL="$TMPDIR_BASE/$TARBALL"

if [ ! -f "$TARBALL" ]; then
  echo "FAIL: npm pack did not produce a tarball"
  exit 1
fi
echo "   Tarball: $TARBALL"

# --- Install ---
echo "2. Installing tarball in temp directory..."
INSTALL_DIR="$TMPDIR_BASE/consumer"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

# Create a minimal package.json so npm install works
cat > package.json <<'PKGJSON'
{ "name": "e2e-consumer", "version": "1.0.0", "private": true }
PKGJSON

npm install --cache "$NPM_CACHE_DIR" "$TARBALL" --save 2>&1
CONTEXT_BIN="$INSTALL_DIR/node_modules/.bin/context"

if [ ! -f "$CONTEXT_BIN" ]; then
  echo "FAIL: context binary not found at $CONTEXT_BIN"
  exit 1
fi
echo "   Binary: $CONTEXT_BIN"

# --- Create fixture project ---
echo "3. Creating fixture project..."
FIXTURE_DIR="$TMPDIR_BASE/fixture"
mkdir -p "$FIXTURE_DIR/src"
cat > "$FIXTURE_DIR/package.json" <<'FIXTURE_PKG'
{ "name": "test-project", "version": "1.0.0" }
FIXTURE_PKG
cat > "$FIXTURE_DIR/src/index.ts" <<'FIXTURE_SRC'
export function hello(): string { return "world"; }
FIXTURE_SRC
cat > "$FIXTURE_DIR/.context.config.yaml" <<'FIXTURE_CFG'
provider: anthropic
min_tokens: 0
FIXTURE_CFG

# --- Run CLI commands ---
echo "4. Running CLI commands..."

# 4a. context init (static mode is default, no --llm needed)
echo "   4a. context init --no-agents"
"$CONTEXT_BIN" init --no-agents --path "$FIXTURE_DIR" 2>&1
if [ ! -f "$FIXTURE_DIR/.context.yaml" ]; then
  echo "FAIL: context init did not create .context.yaml"
  exit 1
fi
echo "       .context.yaml created"

# 4b. context status
echo "   4b. context status"
STATUS_OUT=$("$CONTEXT_BIN" status --path "$FIXTURE_DIR" 2>&1)
if ! echo "$STATUS_OUT" | grep -qiE "fresh|tracked|stale"; then
  echo "FAIL: context status output unexpected: $STATUS_OUT"
  exit 1
fi
echo "       Output contains freshness info"

# 4c. context validate
echo "   4c. context validate"
"$CONTEXT_BIN" validate --path "$FIXTURE_DIR" >/dev/null 2>&1
echo "       Validation passed (exit 0)"

# 4d. context show
echo "   4d. context show ."
SHOW_OUT=$(cd "$FIXTURE_DIR" && "$CONTEXT_BIN" show . 2>&1)
if ! echo "$SHOW_OUT" | grep -q "version:"; then
  echo "FAIL: context show output missing 'version:': $SHOW_OUT"
  exit 1
fi
echo "       Output contains version:"

# 4e. Schema file check
echo "   4e. Schema file accessibility"
SCHEMA_FILE="$INSTALL_DIR/node_modules/autocontext/.context.schema.json"
if [ ! -f "$SCHEMA_FILE" ]; then
  echo "FAIL: Schema file not found at $SCHEMA_FILE"
  exit 1
fi
# Verify it's valid JSON with $id
if ! node -e "const s = require('$SCHEMA_FILE'); if (!s['\$id']) process.exit(1);" 2>/dev/null; then
  echo "FAIL: Schema file missing \$id field"
  exit 1
fi
echo "       .context.schema.json accessible with \$id"

echo ""
echo "=== All E2E checks passed ==="
