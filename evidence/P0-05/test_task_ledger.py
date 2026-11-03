#!/usr/bin/env python3
"""
Unit and integration tests for Task P0-05:
- SQLite WAL task ledger (.agy/state.sqlite) with 8 required tables
- Atomic task claiming, dependency checks, non-overlapping file_claims, lease_epoch fencing
- Worktree policy enforcement (.worktrees/<task-id>-<run-id>, agy/<task-id>-<slug>, no destructive git commands)
- Evidence template rendering and validation per docs/AGENTS.md
- Synthetic crash/reboot recovery (dirty worktree preservation, live worker reattachment,
  dead worker reclamation with incremented fence, in-flight command NOT_RUN marking,
  2-attempt circuit breaker, SQLite backup API + durable events.jsonl replay)
- Credential & secret redaction across SQLite pages, status.json, and events.jsonl
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

LEDGER_MODULE_PATH = Path(__file__).resolve().with_name("task_ledger.py")
spec = importlib.util.spec_from_file_location("p0_05_task_ledger", LEDGER_MODULE_PATH)
assert spec and spec.loader
tl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tl)

REPO_ROOT = Path(__file__).resolve().parents[2]


class TaskLedgerSchemaAndBootstrapTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.agy_dir = self.root / ".agy"
        self.now = datetime(2026, 11, 2, 14, 0, 0, tzinfo=timezone.utc)
        self.ledger = tl.TaskLedger(
            agy_dir=self.agy_dir,
            boot_id="boot-test-01",
            supervisor_pid=1234,
            supervisor_run_id="sup-test-01",
        )

    def tearDown(self) -> None:
        self.ledger.close()
        self.tmp.cleanup()

    def test_required_tables_and_wal_mode(self) -> None:
        info = self.ledger.verify_integrity()
        self.assertEqual(info["integrity_check"], "ok")
        self.assertEqual(info["journal_mode"].lower(), "wal")
        self.assertTrue(info["required_tables_present"])
        for tbl in (
            "tasks",
            "dependencies",
            "leases",
            "file_claims",
            "runs",
            "evidence",
            "reviews",
            "events",
        ):
            self.assertIn(tbl, info["tables"])

    def test_singleton_supervisor_lock_prevents_concurrent_writer(self) -> None:
        with self.assertRaises(tl.LedgerError):
            tl.TaskLedger(agy_dir=self.agy_dir, boot_id="boot-test-02")

    def test_materialize_52_tasks_and_reconcile_bootstrap(self) -> None:
        summary = self.ledger.materialize_from_backlog(
            repo_root=REPO_ROOT,
            completed_bootstrap_tasks={
                "P0-01": {
                    "base_commit": "aaac0a6ecd464bf3f4798e18c94a003fb6ef0487",
                    "tested_commit": "ace8777",
                    "report_path": "evidence/P0-01/report.md",
                },
                "P0-02": {
                    "base_commit": "eea986e879b70920c0a3c2c5579545ee3f509882",
                    "tested_commit": "3361b41183cbd7370ccef6012902f090292e5691",
                    "report_path": "evidence/P0-02/report.md",
                },
                "P0-04": {
                    "base_commit": "c3ff673791ac383c003bdbe6490e6ac4b007f066",
                    "tested_commit": "131641971c28d7370ccef6012902f090292e5691"[:40],
                    "report_path": "evidence/P0-04/report.md",
                },
            },
            now=self.now,
        )
        self.assertEqual(summary["total_tasks"], 52)
        self.assertEqual(self.ledger.get_task("P0-01")["state"], "done")
        self.assertEqual(self.ledger.get_task("P0-02")["state"], "done")
        self.assertEqual(self.ledger.get_task("P0-04")["state"], "done")
        # With P0-01 and P0-04 done, P0-03 and P0-05 must be promoted to 'ready'
        self.assertEqual(self.ledger.get_task("P0-03")["state"], "ready")
        self.assertEqual(self.ledger.get_task("P0-05")["state"], "ready")
        # P1-01 still waits on P0-05 -> remains 'planned'
        self.assertEqual(self.ledger.get_task("P1-01")["state"], "planned")

    def test_dag_cycle_detection_rejects_cycle(self) -> None:
        self.ledger.register_task(
            task_id="SYNTH-01",
            stream="A",
            phase="P0",
            dependencies=["SYNTH-02"],
            allowed_paths=["evidence/SYNTH-01/"],
            base_commit="aaac0a6",
            acceptance_ref="synthetic",
            now=self.now,
        )
        with self.assertRaises(tl.DagCycleError):
            self.ledger.register_task(
                task_id="SYNTH-02",
                stream="A",
                phase="P0",
                dependencies=["SYNTH-01"],
                allowed_paths=["evidence/SYNTH-02/"],
                base_commit="aaac0a6",
                acceptance_ref="synthetic",
                now=self.now,
            )


class ClaimFencingAndLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.agy_dir = self.root / ".agy"
        self.now = datetime(2026, 11, 2, 14, 0, 0, tzinfo=timezone.utc)
        self.ledger = tl.TaskLedger(agy_dir=self.agy_dir, boot_id="boot-01")

        # Register two independent ready tasks and one task with overlapping allowed_paths
        self.ledger.register_task(
            task_id="SYNTH-01",
            stream="B",
            phase="P1",
            dependencies=["DOC-001"],
            allowed_paths=["packages/renderers/", "evidence/SYNTH-01/"],
            base_commit="704e03ef5410f94116d3652f5671d7afb7ef2b95",
            acceptance_ref="docs/IMPLEMENTATION_PLAN.md: SYNTH-01",
            now=self.now,
        )
        self.ledger.register_task(
            task_id="SYNTH-02",
            stream="B",
            phase="P1",
            dependencies=["DOC-001"],
            allowed_paths=["packages/renderers/chromium/", "evidence/SYNTH-02/"],
            base_commit="704e03ef5410f94116d3652f5671d7afb7ef2b95",
            acceptance_ref="docs/IMPLEMENTATION_PLAN.md: SYNTH-02",
            now=self.now,
        )
        self.ledger.register_task(
            task_id="SYNTH-03",
            stream="A",
            phase="P1",
            dependencies=["SYNTH-01"],
            allowed_paths=["packages/schemas/", "evidence/SYNTH-03/"],
            base_commit="704e03ef5410f94116d3652f5671d7afb7ef2b95",
            acceptance_ref="docs/IMPLEMENTATION_PLAN.md: SYNTH-03",
            now=self.now,
        )

    def tearDown(self) -> None:
        self.ledger.close()
        self.tmp.cleanup()

    def test_atomic_claim_and_overlapping_file_claims_blocked(self) -> None:
        claimed = self.ledger.claim_task(
            task_id="SYNTH-01",
            owner="worker-1",
            repo_root=self.root,
            run_id="run-01",
            now=self.now,
        )
        self.assertEqual(claimed["state"], "claimed")
        self.assertEqual(claimed["lease_epoch"], 1)
        self.assertEqual(claimed["attempts"], 1)

        # SYNTH-02 overlaps packages/renderers/ -> must fail with FileClaimConflictError
        with self.assertRaises(tl.FileClaimConflictError):
            self.ledger.claim_task(
                task_id="SYNTH-02",
                owner="worker-2",
                repo_root=self.root,
                run_id="run-02",
                now=self.now,
            )

        # SYNTH-03 is still 'planned' waiting on SYNTH-01 -> cannot be claimed
        with self.assertRaises(tl.LedgerError):
            self.ledger.claim_task(
                task_id="SYNTH-03",
                owner="worker-3",
                repo_root=self.root,
                run_id="run-03",
                now=self.now,
            )

    def test_stale_lease_epoch_and_definition_of_done_gates(self) -> None:
        self.ledger.claim_task(
            task_id="SYNTH-01",
            owner="worker-1",
            repo_root=self.root,
            run_id="run-01",
            now=self.now,
        )
        self.ledger.transition_task(
            task_id="SYNTH-01",
            run_id="run-01",
            lease_epoch=1,
            to_state="running",
            now=self.now + timedelta(seconds=5),
        )

        # Wrong run_id or wrong lease_epoch must raise StaleLeaseFenceError
        with self.assertRaises(tl.StaleLeaseFenceError):
            self.ledger.worker_heartbeat(
                task_id="SYNTH-01",
                run_id="run-stale",
                lease_epoch=1,
                now=self.now + timedelta(seconds=10),
            )
        with self.assertRaises(tl.StaleLeaseFenceError):
            self.ledger.transition_task(
                task_id="SYNTH-01",
                run_id="run-01",
                lease_epoch=0,
                to_state="verifying",
                now=self.now + timedelta(seconds=10),
            )

        # Transition running -> verifying -> review
        self.ledger.transition_task(
            task_id="SYNTH-01",
            run_id="run-01",
            lease_epoch=1,
            to_state="verifying",
            now=self.now + timedelta(seconds=15),
        )
        self.ledger.transition_task(
            task_id="SYNTH-01",
            run_id="run-01",
            lease_epoch=1,
            to_state="review",
            head_commit="1111111111111111111111111111111111111111",
            now=self.now + timedelta(seconds=20),
        )

        # Cannot transition review -> done without passing evidence and approved review
        with self.assertRaises(tl.LedgerError):
            self.ledger.transition_task(
                task_id="SYNTH-01",
                run_id="run-01",
                lease_epoch=1,
                to_state="done",
                head_commit="1111111111111111111111111111111111111111",
                now=self.now + timedelta(seconds=25),
            )

        self.ledger.record_evidence(
            task_id="SYNTH-01",
            run_id="run-01",
            lease_epoch=1,
            base_commit="704e03ef5410f94116d3652f5671d7afb7ef2b95",
            tested_commit="1111111111111111111111111111111111111111",
            report_path="evidence/SYNTH-01/report.md",
            artifact_paths=["evidence/SYNTH-01/report.md"],
            commands=[{"command": "python3 scripts/validate_repo.py", "exit_code": 0}],
            result="PASS",
            sha256="a" * 64,
            now=self.now + timedelta(seconds=26),
        )

        # Still cannot mark done before reviewer approval
        with self.assertRaises(tl.LedgerError):
            self.ledger.transition_task(
                task_id="SYNTH-01",
                run_id="run-01",
                lease_epoch=1,
                to_state="done",
                head_commit="1111111111111111111111111111111111111111",
                now=self.now + timedelta(seconds=27),
            )

        # Record independent review for exact tested commit -> now review -> done succeeds and unlocks SYNTH-03!
        self.ledger.record_review(
            task_id="SYNTH-01",
            reviewed_commit="1111111111111111111111111111111111111111",
            reviewer="independent-reviewer-slot",
            decision="approved",
            notes="Verified acceptance criteria and evidence",
            run_id="run-01",
            now=self.now + timedelta(seconds=28),
        )
        done_task = self.ledger.transition_task(
            task_id="SYNTH-01",
            run_id="run-01",
            lease_epoch=1,
            to_state="done",
            actor="supervisor",
            head_commit="1111111111111111111111111111111111111111",
            now=self.now + timedelta(seconds=30),
        )
        self.assertEqual(done_task["state"], "done")
        self.assertEqual(self.ledger.get_task("SYNTH-03")["state"], "ready")

    def test_circuit_breaker_blocks_after_two_identical_failures(self) -> None:
        # Attempt 1 fails with signature 'compile_err_ts2322' -> requeues to 'ready'
        self.ledger.claim_task(
            task_id="SYNTH-01",
            owner="worker-1",
            repo_root=self.root,
            run_id="run-fail-1",
            now=self.now,
        )
        after_first = self.ledger.record_attempt_failure(
            task_id="SYNTH-01",
            run_id="run-fail-1",
            lease_epoch=1,
            failure_signature="compile_err_ts2322",
            reason="Type mismatch in renderer interface",
            now=self.now + timedelta(seconds=30),
        )
        self.assertEqual(after_first["state"], "ready")
        self.assertIsNone(after_first["blocker"])

        # Attempt 2 fails with the same signature -> circuit breaker transitions to 'blocked'
        self.ledger.claim_task(
            task_id="SYNTH-01",
            owner="worker-1",
            repo_root=self.root,
            run_id="run-fail-2",
            now=self.now + timedelta(seconds=60),
        )
        after_second = self.ledger.record_attempt_failure(
            task_id="SYNTH-01",
            run_id="run-fail-2",
            lease_epoch=2,
            failure_signature="compile_err_ts2322",
            reason="Type mismatch in renderer interface",
            now=self.now + timedelta(seconds=90),
        )
        self.assertEqual(after_second["state"], "blocked")
        self.assertIsNotNone(after_second["blocker"])
        self.assertIn("Repeated failure", after_second["blocker"]["reason"])
        self.assertEqual(after_second["blocker"]["owner"], "supervisor")


class WorktreePolicyAndEvidenceTemplateTests(unittest.TestCase):
    def test_worktree_assignment_and_forbidden_git_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_str:
            root = Path(tmp_str)
            valid = tl.WorktreePolicy.validate_worktree_assignment(
                repo_root=root,
                task_id="P0-05",
                worktree_path=".worktrees/p0-05-run01",
                branch_name="agy/p0-05-ledger",
            )
            self.assertEqual(valid["worktree_rel"], ".worktrees/p0-05-run01")
            self.assertEqual(valid["branch"], "agy/p0-05-ledger")

            # Editing main or root checkout is forbidden
            with self.assertRaises(tl.WorktreePolicyError):
                tl.WorktreePolicy.validate_worktree_assignment(
                    repo_root=root,
                    task_id="P0-05",
                    worktree_path=".",
                    branch_name="agy/p0-05-ledger",
                )
            with self.assertRaises(tl.WorktreePolicyError):
                tl.WorktreePolicy.validate_worktree_assignment(
                    repo_root=root,
                    task_id="P0-05",
                    worktree_path=".worktrees/p0-05-run01",
                    branch_name="main",
                )

            # Destructive git commands are blocked
            for bad_cmd in (
                "git reset --hard HEAD~1",
                "git clean -fdx",
                "git checkout --force main",
                "git push --force origin agy/p0-05",
                "git branch -D agy/p0-05",
            ):
                with self.assertRaises(tl.WorktreePolicyError):
                    tl.WorktreePolicy.validate_git_command(bad_cmd)

            # Safe git commands pass
            tl.WorktreePolicy.validate_git_command("git status --short")
            tl.WorktreePolicy.validate_git_command("git diff --check")

    def test_dirty_worktree_cannot_be_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_str:
            wt = Path(tmp_str)
            subprocess.run(["git", "init", "-q"], cwd=str(wt), check=True)
            self.assertTrue(tl.WorktreePolicy.check_worktree_clean_before_remove(wt))
            (wt / "untracked.txt").write_text("preserve me\n", encoding="utf-8")
            with self.assertRaises(tl.WorktreePolicyError):
                tl.WorktreePolicy.check_worktree_clean_before_remove(wt)

    def test_file_scope_verification(self) -> None:
        in_scope, out_scope = tl.WorktreePolicy.verify_changed_files_in_scope(
            changed_files=["evidence/P0-05/report.md", "docs/AGENTS.md", "packages/api/index.ts"],
            allowed_paths=["evidence/P0-05/", "docs/"],
        )
        self.assertEqual(in_scope, ["evidence/P0-05/report.md", "docs/AGENTS.md"])
        self.assertEqual(out_scope, ["packages/api/index.ts"])

    def test_evidence_template_validator(self) -> None:
        # Existing P0-01 and P0-04 reports must validate cleanly
        p01_text = (REPO_ROOT / "evidence/P0-01/report.md").read_text(encoding="utf-8")
        res01 = tl.EvidenceValidator.validate_report_markdown(p01_text, expected_task_id="P0-01")
        self.assertTrue(res01["valid"])
        self.assertEqual(res01["result"], "PASS")

        p04_text = (REPO_ROOT / "evidence/P0-04/report.md").read_text(encoding="utf-8")
        res04 = tl.EvidenceValidator.validate_report_markdown(p04_text, expected_task_id="P0-04")
        self.assertTrue(res04["valid"])
        self.assertEqual(res04["result"], "PASS")

        p05_text = (REPO_ROOT / "evidence/P0-05/report.md").read_text(encoding="utf-8")
        res05 = tl.EvidenceValidator.validate_report_markdown(p05_text, expected_task_id="P0-05")
        self.assertTrue(res05["valid"])
        self.assertEqual(res05["result"], "PASS")

        tpl_text = (REPO_ROOT / "evidence/P0-05/evidence-template.md").read_text(encoding="utf-8")
        res_tpl = tl.EvidenceValidator.validate_report_markdown(tpl_text, expected_task_id="P2-03")
        self.assertTrue(res_tpl["valid"])

        # Render a fresh block and validate
        rendered = tl.EvidenceValidator.render_template(
            task_id="P0-05",
            base_commit="704e03ef5410f94116d3652f5671d7afb7ef2b95",
            tested_commit="704e03ef5410f94116d3652f5671d7afb7ef2b95",
            environment="Linux x86_64, Python 3.12",
            command="python3 scripts/validate_repo.py",
            result="PASS",
            exit_code=0,
            utc_started="2026-11-02T14:00:00Z",
            duration="0.9s",
            artifacts=[{"path": "evidence/P0-05/report.md", "sha256": hashlib.sha256(b"demo").hexdigest()}],
            acceptance_mapping=[("Ledger schema", "PASS")],
        )
        md_doc = f"# Evidence report — Task P0-05\n\n```text\n{rendered}\n```\n"
        parsed = tl.EvidenceValidator.validate_report_markdown(md_doc, expected_task_id="P0-05")
        self.assertTrue(parsed["valid"])

        # PASS with exit code 1 must fail validation
        bad_md = md_doc.replace("0 / 2026-11-02T14:00:00Z", "1 / 2026-11-02T14:00:00Z")
        with self.assertRaises(tl.EvidenceValidationError):
            tl.EvidenceValidator.validate_report_markdown(bad_md, expected_task_id="P0-05")


class SyntheticRecoveryAndCredentialRedactionTests(unittest.TestCase):
    def test_synthetic_recovery_drill_and_zero_credential_leaks(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_str:
            out_json = Path(tmp_str) / "drill-output.json"
            summary = tl.run_synthetic_recovery_drill(repo_root=REPO_ROOT, output_json_path=out_json)
            self.assertTrue(out_json.is_file())

            post = summary["synthetic_recovery_drill"]["post_recovery_verification"]
            self.assertTrue(post["orphaned_task_reclaimed_to_ready"])
            self.assertEqual(post["orphaned_task_fenced_epoch"], 2)
            self.assertTrue(post["uncommitted_worktree_edits_preserved"])
            self.assertTrue(post["live_task_reattached_running"])
            self.assertTrue(post["stale_worker_write_rejected"])
            self.assertTrue(post["fresh_worker_reclaim_succeeded"])
            self.assertEqual(post["fresh_worker_new_lease_epoch"], 3)

            replay = summary["synthetic_recovery_drill"]["backup_restore_and_event_replay"]
            self.assertEqual(replay["restored_integrity_check"], "ok")
            self.assertTrue(replay["no_invented_done_states"])

            audit = summary["credential_redaction_audit"]
            self.assertTrue(audit["zero_credential_leak_verified"])
            self.assertEqual(audit["leaks_found_count"], 0)

    def test_reconcile_crashed_worker_with_existing_passing_evidence_to_review(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_str:
            root = Path(tmp_str)
            now = datetime(2026, 11, 2, 14, 0, 0, tzinfo=timezone.utc)
            with tl.TaskLedger(agy_dir=root / ".agy", boot_id="boot-1") as ledger:
                ledger.register_task(
                    task_id="SYNTH-01",
                    stream="B",
                    phase="P1",
                    dependencies=["DOC-001"],
                    allowed_paths=["evidence/SYNTH-01/"],
                    base_commit="704e03e",
                    acceptance_ref="synthetic",
                    now=now,
                )
                ledger.claim_task(
                    task_id="SYNTH-01",
                    owner="worker-a",
                    repo_root=root,
                    run_id="run-a",
                    boot_id="boot-1",
                    worker_pid=4444,
                    process_start_time=100,
                    now=now,
                )
                ledger.transition_task(
                    task_id="SYNTH-01",
                    run_id="run-a",
                    lease_epoch=1,
                    to_state="running",
                    now=now + timedelta(seconds=5),
                )
                ledger.transition_task(
                    task_id="SYNTH-01",
                    run_id="run-a",
                    lease_epoch=1,
                    to_state="verifying",
                    head_commit="2222222222222222222222222222222222222222",
                    now=now + timedelta(seconds=10),
                )
                ledger.record_evidence(
                    task_id="SYNTH-01",
                    run_id="run-a",
                    lease_epoch=1,
                    base_commit="704e03e",
                    tested_commit="2222222222222222222222222222222222222222",
                    report_path="evidence/SYNTH-01/report.md",
                    artifact_paths=["evidence/SYNTH-01/report.md"],
                    commands=[{"command": "python3 scripts/validate_repo.py", "exit_code": 0}],
                    result="PASS",
                    sha256="b" * 64,
                    now=now + timedelta(seconds=20),
                )

            # Reboot on boot-2 after worker crashed right after recording evidence
            with tl.TaskLedger(agy_dir=root / ".agy", boot_id="boot-2") as ledger2:
                rec = ledger2.recover_after_crash_or_reboot(
                    repo_root=root,
                    live_processes=set(),
                    now=now + timedelta(minutes=15),
                )
                self.assertEqual(len(rec["reconciled_to_review"]), 1)
                task_after = ledger2.get_task("SYNTH-01")
                self.assertEqual(task_after["state"], "review")
                self.assertEqual(task_after["lease_epoch"], 2)


if __name__ == "__main__":
    unittest.main()
