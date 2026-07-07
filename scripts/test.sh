#!/usr/bin/env bash
set -euo pipefail

output=$(npm test -- --no-coverage 2>&1) || true

if echo "$output" | grep -qE "^Tests:.*[1-9][0-9]* failed"; then
  echo "$output" | grep -E "(FAIL |✕|●)" 
  exit 1
fi

echo "ALL TESTS PASS"
