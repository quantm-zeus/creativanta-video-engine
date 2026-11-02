#!/usr/bin/env python3
"""Regression tests: durable scheduler, refusal of fake completion, CI gates."""
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

SRC = Path(__file__).resolve().parents[1] / "supervisor.py"
spec = importlib.util.spec_from_file_location("video_supervisor", SRC)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
REPO = SRC.parents[2]


class PureTests(unittest.TestCase):
    def test_catalog_and_plan_agree(self):
        tasks = m.load_catalog(REPO)
        self.assertEqual(len(tasks), 52)
        self.assertEqual(tasks["P0-02"]["dependencies"], ["P0-01"])
        self.assertIn("P0-05", tasks["P1-01"]["dependencies"])

    def test_dependency_requires_integrated(self):
        self.assertTrue(m.can_run(["P0-01"], {"P0-01": m.DONE}))
        for state in ("RUNNING", "CI_PENDING", "REVIEW_REQUIRED", "BLOCKED", "PENDING"):
            self.assertFalse(m.can_run(["P0-01"], {"P0-01": state}))

    def test_ci_fails_closed(self):
        self.assertEqual(m.ci_verdict([]), "pending")
        good = {"name": "Validate Video Engine", "status": "COMPLETED", "conclusion": "SUCCESS"}
        self.assertEqual(m.ci_verdict([good]), "pass")
        self.assertEqual(m.ci_verdict([{"name":"Other","status":"COMPLETED","conclusion":"SUCCESS"}]),"pending")
        self.assertEqual(m.ci_verdict([good, {"name":"Other","status":"COMPLETED","conclusion":"FAILURE"}]), "failed")
        self.assertEqual(m.ci_verdict([{"name":"Validate Video Engine","status":"IN_PROGRESS"}]), "pending")

    def test_evidence_must_be_fresh_and_valid(self):
        with tempfile.TemporaryDirectory() as root:
            p = Path(root) / "result.json"
            self.assertIsNone(m.valid_result(p, time.time()))
            p.write_text(json.dumps({"status": "implemented_local", "checks": [{"command": "true", "exit_code": 0, "result": "PASS"}]}))
            self.assertIsNone(m.valid_result(p, time.time() + 100))
            self.assertIsNotNone(m.valid_result(p, time.time() - 5))
            p.write_text(json.dumps({"status": "ACCEPTED", "checks": []}))
            self.assertIsNone(m.valid_result(p, time.time() - 5))

    def test_bounded_retry(self):
        self.assertEqual(m.retry_delay(1), 40)
        self.assertLessEqual(m.retry_delay(100), 1800)
        self.assertIn("auto-denied", m.DENIAL_MARKERS)


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cfg_path = Path(self.tmp.name) / "config.json"
        self.cfg_path.write_text(json.dumps({
            "repository": str(REPO), "state_dir": str(Path(self.tmp.name) / "data"),
            "max_attempts_per_task": 3, "max_concurrent": 1,
            "max_runs_per_24h": 12, "interval_seconds": 25,
        }))
        self.s = m.Supervisor(self.cfg_path)

    def tearDown(self):
        self.s.db.close()
        self.s.lock.close()
        self.tmp.cleanup()

    def test_bootstrap_only_verified_task(self):
        rows = self.s.records()
        self.assertEqual(rows["P0-01"]["state"], m.DONE)
        self.assertEqual(rows["P0-02"]["state"], "PENDING")
        self.assertEqual(len(rows), 52)

    def test_next_task_dispatches_without_user_chat(self):
        seen = []
        def mock_launch(key):
            seen.append(key)
            self.s.update(key, state="RUNNING")
        with patch.object(self.s, "launch", side_effect=mock_launch):
            self.s.dispatch()
        self.assertEqual(seen, ["P0-02"])

    def test_restart_recovers_orphan(self):
        self.s.update("P0-02", state="RUNNING", attempts=1)
        self.s.db.close()
        self.s.lock.close()
        second = m.Supervisor(self.cfg_path)
        self.s = second
        self.assertEqual(second.records()["P0-02"]["state"], "RETRY")

    def test_zero_exit_permission_denied_is_not_success(self):
        self.s.update("P0-02", state="RUNNING", attempts=1)
        log = Path(self.tmp.name) / "attempt.log"
        log.write_text("jetski: no output produced — tool auto-denied")
        class FakeProcess:
            returncode = 0
        self.s.finish("P0-02", FakeProcess(), int(time.time()), log)
        self.assertEqual(self.s.records()["P0-02"]["state"], "RETRY")

    def test_status_snapshot_and_health(self):
        self.s.snapshot()
        status = json.loads((Path(self.tmp.name) / "data" / "status.json").read_text())
        self.assertEqual(status["counts"][m.DONE], 1)
        self.assertEqual(len(status["tasks"]), 52)


if __name__ == "__main__":
    unittest.main()
