#!/usr/bin/env bash
# Vercel install step, named in apps/expo/vercel.json.
# Fetch TallyUI for the root package.json file:../tallyui overrides.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# The TallyUI ref lives in .github/workflows/ci.yml.
ref=$(sed -n 's/^  TALLYUI_REF: *//p' "$repo_root/.github/workflows/ci.yml")
if [[ ! "$ref" =~ ^[0-9a-f]{40}$ ]]; then
  printf 'error: TALLYUI_REF not found in .github/workflows/ci.yml\n' >&2
  exit 1
fi
target="$(dirname "$repo_root")/tallyui"

if [[ -e "$target" ]]; then
  printf 'error: TallyUI target already exists: %s\n' "$target" >&2
  exit 1
fi

mkdir "$target"
curl -fsSL "https://codeload.github.com/TallyUI/tallyui/tar.gz/$ref" | tar -xz --strip-components=1 -C "$target"

cd "$repo_root"
pnpm install --frozen-lockfile
