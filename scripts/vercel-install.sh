#!/usr/bin/env bash
# Vercel install step, named in apps/expo/vercel.json.
# Install the locked npm dependencies from the repo root.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

cd "$repo_root"
pnpm install --frozen-lockfile
