#!/bin/bash
# Usage: ./run.sh bitbucket [test...]
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

vcs=${1:?usage: ./run.sh bitbucket [test...]}
shift
set -a
. "${ENV_FILE:-.env}"
set +a

. ./lib.sh
. "./$vcs/vcs.sh"
. "./$vcs/tests.sh"

tests=("$@")
[ $# -gt 0 ] || mapfile -t tests < <(declare -F | sed -n 's/^declare -f test_//p')

trap 'vcs_teardown; rm -rf "$WORK"' EXIT
vcs_setup

failed=0
for t in "${tests[@]}"; do
  echo "== $t"
  # Not in a condition, otherwise set -e would be ignored inside of it.
  set +e
  (set -e; trap stop EXIT; "test_$t") 2>&1 | sed 's/^/   /'
  code=${PIPESTATUS[0]}
  set -e
  case $code in
    0) echo "   PASS" ;;
    "$SKIPPED") echo "   SKIP" ;;
    *) echo "   FAIL"; failed=$((failed + 1)) ;;
  esac
done
echo "$failed failed, out of ${#tests[@]}"
[ "$failed" -eq 0 ]
