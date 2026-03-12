#!/usr/bin/env bash
# verify.sh — smoke test for doubt-gate hook
# Pipes fixtures through the hook and validates structured JSON output.
# Exit 0 = all checks pass. Non-zero = failure with structured diagnostics.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK="$ROOT/hooks/doubt-gate.ts"
FIXTURES="$ROOT/test/fixtures"

pass=0
fail=0
total=0

result_json() {
  local test_name="$1" status="$2" detail="$3"
  node -e "process.stdout.write(JSON.stringify({test:process.argv[1],status:process.argv[2],detail:process.argv[3]})+'\n')" "$test_name" "$status" "$detail"
}

assert_json_block() {
  local name="$1" fixture="$2"
  total=$((total + 1))

  output=$(bun run "$HOOK" < "$fixture" 2>/dev/null || true)

  if [ -z "$output" ]; then
    fail=$((fail + 1))
    result_json "$name" "FAIL" "expected JSON block output, got empty"
    return 1
  fi

  # Validate it's parseable JSON with decision=block
  if echo "$output" | node -e '
    const d = JSON.parse(require("fs").readFileSync("/dev/stdin","utf8"));
    if (d.decision !== "block") process.exit(1);
    if (typeof d.reason !== "string" || d.reason.length === 0) process.exit(1);
  ' 2>/dev/null; then
    pass=$((pass + 1))
    result_json "$name" "PASS" "got decision=block with reason"
    return 0
  else
    fail=$((fail + 1))
    result_json "$name" "FAIL" "output is not valid block JSON: $output"
    return 1
  fi
}

assert_no_block() {
  local name="$1" fixture="$2"
  total=$((total + 1))

  output=$(bun run "$HOOK" < "$fixture" 2>/dev/null || true)

  if [ -z "$output" ]; then
    pass=$((pass + 1))
    result_json "$name" "PASS" "no output (allow)"
    return 0
  else
    fail=$((fail + 1))
    result_json "$name" "FAIL" "expected no output, got: $output"
    return 1
  fi
}

# --- Test cases ---

# Doubtful fixtures should produce a block decision
assert_json_block "doubtful-1" "$FIXTURES/doubtful-1.json" || true
assert_json_block "doubtful-2" "$FIXTURES/doubtful-2.json" || true

# Clean fixture should produce no output (allow)
assert_no_block "clean-1" "$FIXTURES/clean-1.json" || true

# Active guard fixture should produce no output (allow despite doubt keywords)
assert_no_block "active-guard" "$FIXTURES/active-guard.json" || true

# --- Summary ---
node -e "process.stdout.write(JSON.stringify({suite:'verify.sh',total:+process.argv[1],pass:+process.argv[2],fail:+process.argv[3]})+'\n')" "$total" "$pass" "$fail"

if [ "$fail" -gt 0 ]; then
  exit 1
fi
exit 0
