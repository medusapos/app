#!/usr/bin/env bash
set -euo pipefail

temp_dir=$(mktemp -d)
trap 'rm -rf "$temp_dir"' EXIT
check="$(dirname "${BASH_SOURCE[0]}")/check-web-bundle.sh"
dist="$temp_dir/dist"
mkdir "$dist"
printf 'console.log("clean");\n' > "$dist/x.js"

rc=0
bash "$check" "$dist" > "$temp_dir/out" 2> "$temp_dir/err" || rc=$?
if (( rc != 0 )); then
  printf 'T1: clean JS failed (exit %s)\n' "$rc" >&2
  exit 1
fi

: > "$dist/x.js.map"
rc=0
bash "$check" "$dist" > "$temp_dir/out" 2> "$temp_dir/err" || rc=$?
if (( rc != 1 )) || ! grep -Fq 'x.js.map' "$temp_dir/err"; then
  printf 'T2: source map not reported (exit %s)\n' "$rc" >&2
  exit 1
fi

rm "$dist/x.js.map"
printf 'console.log("clean");\n//# sourceMappingURL=x.js.map\n' > "$dist/x.js"
rc=0
bash "$check" "$dist" > "$temp_dir/out" 2> "$temp_dir/err" || rc=$?
if (( rc != 1 )); then
  printf 'T3: sourceMappingURL did not fail (exit %s)\n' "$rc" >&2
  exit 1
fi

mkdir "$temp_dir/empty"
rc=0
bash "$check" "$temp_dir/empty" > "$temp_dir/out" 2> "$temp_dir/err" || rc=$?
if (( rc != 1 )); then
  printf 'T4: empty dist did not fail (exit %s)\n' "$rc" >&2
  exit 1
fi

printf 'ok\n'
