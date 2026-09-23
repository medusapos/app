#!/usr/bin/env bash
set -euo pipefail

dist_dir=$1
js_count=0
failed=0
while IFS= read -r -d '' file; do
  [[ $file != *.js ]] || js_count=$((js_count + 1))
  if matches=$(LC_ALL=C grep -aEo 'sk_[A-Za-z0-9]{16,}|EXPO_PUBLIC_[A-Z0-9_]*KEY' "$file"); then
    while IFS= read -r match; do
      printf '%s: forbidden bundle content: %.12s...\n' "$file" "$match" >&2
    done <<< "$matches"
    failed=1
  fi
done < <(find "$dist_dir" -type f \( -name '*.js' -o -name '*.html' \) -print0)

if (( js_count == 0 )); then
  printf 'web bundle check failed: no .js files found in %s\n' "$dist_dir" >&2
  exit 1
fi
if (( failed )); then
  exit 1
fi
printf 'web bundle ok: %s js files checked\n' "$js_count"
