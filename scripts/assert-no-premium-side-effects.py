import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys

# A restored setup-node store cache could contain the decrypted rxdb-premium build.
if os.environ.get("SETUP_NODE_CACHE_HIT") == "true":
    sys.exit("setup-node restored a package-manager store cache; caching must be disabled")

override = os.environ.get("PNPM_STORE_DIR_OVERRIDE")
# Tests bypass pnpm config only with PNPM_STORE_DIR_OVERRIDE and ASSERT_SKIP_PNPM_CONFIG=1.
if not (override is not None and os.environ.get("ASSERT_SKIP_PNPM_CONFIG") == "1"):
    if subprocess.check_output(["pnpm", "config", "get", "side-effects-cache"], text=True).strip() != "false":
        sys.exit("pnpm side-effects-cache must be false")
store = Path(override if override is not None else subprocess.check_output(["pnpm", "store", "path"], text=True).strip())
entries = []
layout = "index.db" if (store / "index.db").exists() else "index"
if layout == "index.db":
    with sqlite3.connect(f"file:{store / layout}?mode=ro", uri=True) as connection:
        entries = connection.execute(
            "SELECT key, instr(data, CAST('sideEffects' AS BLOB)) > 0 OR typeof(data) != 'blob' "
            "FROM package_index WHERE instr(key, 'rxdb-premium@') > 0"
        ).fetchall()
elif (store / layout).is_dir():
    for root, _, files in os.walk(store / layout, onerror=sys.exit):
        for file in (Path(root) / name for name in files if name.endswith(".json")):
            contents = file.read_text()
            data = json.loads(contents)
            if not isinstance(data, dict):
                sys.exit(f"invalid package index JSON: {file}")
            if "rxdb-premium" in contents:
                entries.append((str(file), '"sideEffects":' in json.dumps(data)))
else:
    sys.exit(f"unrecognised pnpm store layout at {store}")
if not entries:
    sys.exit("rxdb-premium not found in the store index")
offenders = [key for key, side_effects in entries if side_effects]
if offenders:
    sys.exit("rxdb-premium side-effects cache or invalid data entries:\n" + "\n".join(offenders))
print(f"Checked {layout}: inspected {len(entries)} rxdb-premium rows")
