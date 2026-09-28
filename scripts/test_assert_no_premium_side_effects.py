import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("assert-no-premium-side-effects.py")
PREMIUM_KEY = "sha512-fixture\trxdb-premium@16.21.1"


class AssertNoPremiumSideEffectsTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.store = Path(temporary.name)

    def sqlite_store(self, key, data):
        with sqlite3.connect(self.store / "index.db") as connection:
            connection.execute(
                "CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID"
            )
            connection.execute("INSERT INTO package_index VALUES (?, ?)", (key, data))

    def run_assertion(self):
        return subprocess.run(
            [sys.executable, str(SCRIPT)],
            env={**os.environ, "PNPM_STORE_DIR_OVERRIDE": str(self.store), "ASSERT_SKIP_PNPM_CONFIG": "1"},
            capture_output=True,
            text=True,
        )

    def test_sqlite_side_effects_fail_and_print_key(self):
        self.sqlite_store(PREMIUM_KEY, b"\x00sideEffects\xff")
        result = self.run_assertion()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(PREMIUM_KEY, result.stdout + result.stderr)

    def test_sqlite_without_side_effects_passes(self):
        self.sqlite_store(PREMIUM_KEY, b"\x00files\xff")
        result = self.run_assertion()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "Checked index.db: inspected 1 rxdb-premium rows\n")

    def test_sqlite_without_premium_fails(self):
        self.sqlite_store("sha512-fixture\tanother-package@1.0.0", b"files")
        result = self.run_assertion()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("rxdb-premium not found in the store index", result.stderr)

    def test_unrecognised_layout_fails(self):
        result = self.run_assertion()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"unrecognised pnpm store layout at {self.store}", result.stderr)

    def test_legacy_side_effects_fail(self):
        index = self.store / "index" / "nested"
        index.mkdir(parents=True)
        entry = index / "premium.json"
        entry.write_text(json.dumps({"name": "rxdb-premium", "build": {"sideEffects": {}}}))
        result = self.run_assertion()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(str(entry), result.stdout + result.stderr)

    def test_corrupt_sqlite_does_not_fall_back_to_legacy(self):
        (self.store / "index.db").write_bytes(b"invalid SQLite database")
        (self.store / "index").mkdir()
        (self.store / "index" / "premium.json").write_text('{"name": "rxdb-premium"}')
        self.assertNotEqual(self.run_assertion().returncode, 0)

    def test_non_blob_sqlite_data_fails(self):
        self.sqlite_store(PREMIUM_KEY, "files")
        self.assertNotEqual(self.run_assertion().returncode, 0)


if __name__ == "__main__":
    unittest.main()
