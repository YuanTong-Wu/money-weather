#!/usr/bin/env python3
"""Offline contract/privacy tests; does not launch a browser or write fixtures."""

import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import create_demo as demo


class DemoTests(unittest.TestCase):
    def build(self, days):
        # A regression that starts reading real files, making a network request,
        # or invoking an updater/model must fail even on a networked machine.
        with (
            patch("builtins.open", side_effect=AssertionError("unexpected file read")),
            patch.object(Path, "open", side_effect=AssertionError("unexpected path read")),
            patch.object(socket, "socket", side_effect=AssertionError("network is forbidden")),
            patch.object(subprocess, "Popen", side_effect=AssertionError("subprocess is forbidden")),
        ):
            documents = demo.build_documents(days)
            demo.validate_documents(documents, days)
            return documents, demo.encode_documents(documents, days)

    def test_repeatable_bytes_and_manifest_for_both_windows(self):
        for days in (32, 64):
            with self.subTest(days=days):
                documents, files = self.build(days)
                self.assertEqual(files, self.build(days)[1])
                self.assertEqual(len(documents["meta.json"]["dates"]), days)
                manifest = json.loads(files["manifest.json"])
                self.assertEqual(set(files) - {"manifest.json"}, set(manifest["files"]))
                for name, entry in manifest["files"].items():
                    self.assertEqual(entry["sha256"], hashlib.sha256(files[name]).hexdigest())
                    self.assertEqual(entry["bytes"], len(files[name]))

    def test_exactly_synthetic_universe_and_complete_navigation(self):
        documents, files = self.build(64)
        self.assertEqual({name for name in files if name.startswith("stocks/")}, {f"stocks/{ticker}.json" for ticker in demo.TICKERS})
        search = documents["search.json"]
        self.assertEqual(len(search), 10)
        for entry in search:
            path = entry["pathIds"]
            node = documents["tree.json"]
            self.assertEqual(path[0], node["id"])
            for node_id in path[1:]:
                node = next(child for child in node["children"] if child["id"] == node_id)
            if entry["kind"] == "stock":
                self.assertIn(entry["ticker"], demo.TICKERS)
                stock = documents[f"stocks/{entry['ticker']}.json"]
                self.assertEqual(stock["paths"], [path])
            else:
                self.assertIn(f"maps/{entry['id']}.json", documents)
        for filename, document in documents.items():
            if filename.endswith(".json"):
                rows = document if isinstance(document, list) else [document]
                for row in rows:
                    self.assertIs(row["sample"], True)
                    self.assertTrue(row["name"].startswith(demo.LABEL))
                    self.assertTrue(row["desc"].startswith(demo.LABEL))

    def test_history_and_rollups_match_each_day(self):
        for days in (32, 64):
            with self.subTest(days=days):
                documents, _ = self.build(days)
                world = documents["maps/world.json"]
                for region_id, *_ in demo.REGIONS:
                    region = documents[f"maps/{region_id}.json"]
                    for key in demo.SERIES_KEYS:
                        self.assertEqual(world["children"][region_id][key], region["self"][key])
                    for day in range(days):
                        self.assertAlmostEqual(region["self"]["flow"][day], sum(series["flow"][day] for series in region["children"].values()), places=5)
                        self.assertAlmostEqual(region["self"]["dv"][day], sum(series["dv"][day] for series in region["children"].values()), places=5)
                self.assertTrue(any(x > 0 for x in world["self"]["flow"]))
                self.assertTrue(any(x < 0 for x in world["self"]["flow"]))

    def test_no_model_answers_real_money_or_fabricated_performance(self):
        documents, files = self.build(32)
        self.assertEqual(documents["holdings.json"]["holdings"], [])
        self.assertEqual(documents["meta.json"]["atmosphere"], [])
        self.assertFalse(any(name.startswith(("why/", "scenarios/", "flows/")) for name in files))
        self.assertNotIn("claude_usage.json", files)
        self.assertNotIn("heartbeat.json", files)
        for ticker in demo.TICKERS:
            stock = documents[f"stocks/{ticker}.json"]
            self.assertNotIn("realFlow", stock)
            self.assertNotIn("holding", stock)
            self.assertNotIn("intraday", stock)
            self.assertIsNone(stock["facts"]["ret60"])
            self.assertIsNone(stock["facts"]["high52"])
            self.assertIsNone(stock["facts"]["low52"])

    def test_rejects_unsupported_window_and_unsafe_output_path(self):
        for days in (0, 31, 33, 252):
            with self.assertRaises(ValueError):
                demo.build_documents(days)
        for path in ("../private.json", "/tmp/demo.json", "maps/../../private.json"):
            with self.assertRaises(ValueError):
                demo.safe_target(path)


if __name__ == "__main__":
    unittest.main(verbosity=2)
