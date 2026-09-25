#!/usr/bin/env bash
# Fails closed: a forbidden match, an unreadable file (any grep exit but 0 or 1) or a failed find fails the check.
set -euo pipefail

dist_dir=$1
app_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../apps/expo" && pwd)"
js_count=0
failed=0
# Bundle: the marker of apps/expo/lib/e2e-debug.ts's exposing branch, which a production export folds away.
# sk_…, EXPO_PUBLIC_*KEY and __medusapos… (the E2E hook names) are extra defences.
bundle_pattern='medusapos-e2e-debug-hook|sk_[A-Za-z0-9]{16,}|EXPO_PUBLIC_[A-Z0-9_]*KEY|__medusapos[A-Za-z]+'
# Source: only lib/e2e-debug.ts may write an E2E hook to window, so app source outside it and its tests must not
# contain __medusapos or a single-line write to a window property, plain or cast (`window.x =`, `(window as …).x =`,
# `window[k] =`, Object.assign(window, …)). False positives are acceptable, misses are not.
prop='(\.[A-Za-z_$][A-Za-z0-9_$]*|\[[^]]*\]) *[-+*/%&|^?]*=([^=]|$)'
source_pattern="__medusapos|window$prop|\\(window as .*\\)$prop|Object\\.(assign|define[A-Za-z]+)\\( *window"

# scan PATTERN FILE: prints matches (masking secrets) and sets failed; a grep error fails naming the file.
scan() {
  local rc=0 matches match
  matches=$(LC_ALL=C grep -aEo "$1" "$2") || rc=$?
  if (( rc == 1 )); then return 0; fi
  failed=1
  if (( rc != 0 )); then printf '%s: unreadable (grep exit %s), cannot prove it clean\n' "$2" "$rc" >&2; return 0; fi
  while IFS= read -r match; do
    case $match in sk_* | EXPO_PUBLIC_*) match="${match:0:12}..." ;; esac
    printf '%s: forbidden content: %s\n' "$2" "$match" >&2
  done <<< "$matches"
}
files=$(mktemp)
trap 'rm -f "$files"' EXIT
find "$dist_dir" -type f \( -name '*.js' -o -name '*.html' \) -print0 > "$files"
while IFS= read -r -d '' file; do
  [[ $file != *.js ]] || js_count=$((js_count + 1))
  scan "$bundle_pattern" "$file"
done < "$files"
find "$app_dir/app" "$app_dir/components" "$app_dir/lib" -type f -name '*.[jt]s*' ! -name '*.test.*' \
  ! -path "$app_dir/lib/e2e-debug.ts" -print0 > "$files"
while IFS= read -r -d '' file; do
  scan "$source_pattern" "$file"
done < "$files"

if (( js_count == 0 )); then
  printf 'web bundle check failed: no .js files found in %s\n' "$dist_dir" >&2
  exit 1
fi
if (( failed )); then
  exit 1
fi
printf 'web bundle ok: %s js files checked\n' "$js_count"
