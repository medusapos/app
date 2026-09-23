#!/usr/bin/env bash
# Vercel install step, named in apps/expo/vercel.json.
# Fetch TallyUI for the root package.json file:../tallyui overrides.
set -euo pipefail

# Keep equal to TALLYUI_REF in .github/workflows/ci.yml.
TALLYUI_REF=3996453ef752f246167075d06ca3dcda0b3098fd

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
target="$(dirname "$repo_root")/tallyui"

if [[ -e "$target" ]]; then
  printf 'error: TallyUI target already exists: %s\n' "$target" >&2
  exit 1
fi

mkdir "$target"
curl -fsSL "https://codeload.github.com/TallyUI/tallyui/tar.gz/$TALLYUI_REF" | tar -xz --strip-components=1 -C "$target"

cd "$repo_root"
pnpm install --frozen-lockfile
