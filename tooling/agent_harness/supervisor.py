#!/usr/bin/env python3
"""Independent Video Engine AGY supervisor. Staging-only, evidence-gated.

The scheduler is a distinct bootstrap/operator service; task P0-05 remains
unaccepted until its own implementation acceptance and review are complete.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import fcntl
import json
import logging
import os
from pathlib import Path
import re
import signal
import sqlite3
import subprocess
import sys
import threading
import time
import uuid

LOG = logging.getLogger("video-engine.harness")
REPO_NAME = "quantm-zeus/creativanta-video-engine"
DONE = "INTEGRATED"
ID_PATTERN = re.compile(r"^P[0-9]+-[0-9]{2}$")
DENIAL_MARKERS = ("auto-denied", "permission that headless mode cannot prompt",
                  "no output produced", "tool required the \"command\" permission")
HUMAN_REVIEW = {"P2-05", "P6-04", "P6-05", "P7-05", "P8-04", "P9-05"}
CI_GATE = "Validate Video Engine"


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def execute(args, cwd=None, timeout=90, check=True):
    result = subprocess.run(args, cwd=str(cwd) if cwd else None, text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, stdin=subprocess.DEVNULL)
    if check and result.returncode:
        raise RuntimeError("%s exit=%d: %s" %
                           (args[0], result.returncode, result.stderr[-350:]))
    return result.stdout.strip()


def retry_delay(attempt):
    return min(1800, 40 * (2 ** min(max(0, attempt - 1), 6)))


def can_run(deps, statuses):
    return all(statuses.get(dep) == DONE for dep in deps)


def ci_verdict(checks):
    if not checks:
        return "pending"
    gate_ok = False
    for check in checks:
        status = str(check.get("status") or "").upper()
        conclusion = str(check.get("conclusion") or "").upper()
        if status != "COMPLETED":
            return "pending"
        if conclusion in {"FAILURE", "TIMED_OUT", "CANCELLED",
                          "ACTION_REQUIRED", "STARTUP_FAILURE"}:
            return "failed"
        if conclusion not in {"SUCCESS", "NEUTRAL", "SKIPPED"}:
            return "pending"
        if check.get("name") == CI_GATE and conclusion == "SUCCESS":
            gate_ok = True
    return "pass" if gate_ok else "pending"


def valid_result(path, started_at):
    try:
        if path.stat().st_mtime + 1 < started_at:
            return None
        data = json.loads(path.read_text())
        if data.get("status") not in {"implemented_local", "partial", "blocked"}:
            return None
        checks = data.get("checks")
        if not isinstance(checks, list):
            return None
        if data["status"] == "implemented_local" and not checks:
            return None
        return data
    except (OSError, ValueError, TypeError, KeyError):
        return None


def parse_plan(repo):
    output = {}
    source = (repo / "docs/IMPLEMENTATION_PLAN.md").read_text()
    for line in source.splitlines():
        if not line.startswith("| P"):
            continue
        fields = [x.strip() for x in line.split("|")[1:-1]]
        if len(fields) != 3:
            continue
        match = re.match(r"^(P[0-9]+-[0-9]{2})\s*/\s*(.+)$", fields[0])
        if match:
            output[match.group(1)] = {
                "stream": match.group(2),
                "acceptance": fields[2],
            }
    return output


def load_catalog(repo):
    raw = json.loads((repo / "evidence/P0-01/backlog.json").read_text())
    plan = parse_plan(repo)
    tasks = {}
    for entry in raw["tasks"]:
        task_id = entry["task_id"]
        if not ID_PATTERN.fullmatch(task_id):
            raise ValueError("Unsafe task ID")
        if task_id not in plan:
            raise ValueError("Task missing plan row: " + task_id)
        dependencies = [dep for dep in entry["dependencies"] if dep != "DOC-001"]
        if task_id in tasks:
            raise ValueError("Duplicate task: " + task_id)
        tasks[task_id] = {
            "id": task_id,
            "phase": entry["phase"],
            "stream": plan[task_id]["stream"],
            "acceptance": plan[task_id]["acceptance"],
            "dependencies": dependencies,
            "allowed_paths": entry.get("allowed_paths", []),
        }
    if len(tasks) != 52 or set(tasks) != set(plan):
        raise ValueError("Unexpected task inventory: expected 52")
    for task in tasks.values():
        if any(x not in tasks for x in task["dependencies"]):
            raise ValueError("Unknown dependency in " + task["id"])
    return tasks


class Supervisor:
    def __init__(self, cfg_file):
        self.cfg_path = Path(cfg_file)
        self.cfg = json.loads(self.cfg_path.read_text())
        self.repo = Path(self.cfg["repository"]).resolve()
        self.data = Path(self.cfg["state_dir"])
        self.worktrees = self.repo / ".worktrees"
        self.data.mkdir(parents=True, exist_ok=True)
        self.worktrees.mkdir(parents=True, exist_ok=True)
        (self.data / "logs").mkdir(exist_ok=True)
        (self.data / "results").mkdir(exist_ok=True)
        self.lock = (self.data / "supervisor.lock").open("a+")
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.db = sqlite3.connect(self.data / "state.sqlite3", timeout=30)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("""CREATE TABLE IF NOT EXISTS tasks(
            id TEXT PRIMARY KEY, state TEXT NOT NULL, deps TEXT NOT NULL,
            attempts INTEGER DEFAULT 0, retry_after INTEGER DEFAULT 0,
            started_at INTEGER DEFAULT 0, updated_at INTEGER DEFAULT 0,
            branch TEXT, workspace TEXT, base_sha TEXT, sha TEXT, pr INTEGER,
            error TEXT DEFAULT '', log_path TEXT, run_id TEXT)""")
        self.db.execute("""CREATE TABLE IF NOT EXISTS events(
            ts INTEGER, task_id TEXT, action TEXT, detail TEXT)""")
        self.db.commit()
        self.catalog = load_catalog(self.repo)
        self.active = {}
        self.stop = False
        self.bootstrap()
        self.recover_orphaned()

    def event(self, task, action, detail=""):
        self.db.execute("INSERT INTO events VALUES (?,?,?,?)",
                        (int(time.time()), task, action, str(detail)[:450]))
        self.db.commit()
        LOG.info("%s %s %s", task, action, str(detail)[:160])

    def update(self, task, **fields):
        fields["updated_at"] = int(time.time())
        clause = ", ".join(k + "=?" for k in fields)
        self.db.execute("UPDATE tasks SET " + clause + " WHERE id=?",
                        tuple(fields.values()) + (task,))
        self.db.commit()

    def records(self):
        return {x["id"]: dict(x) for x in
                self.db.execute("SELECT * FROM tasks")}

    def bootstrap(self):
        for task in self.catalog.values():
            key = task["id"]
            if key == "P0-01":
                # Independently verified and pushed bootstrap commit ace8777.
                execute(["git", "cat-file", "-e", "ace8777^{commit}"], self.repo)
                if not (self.repo / "evidence/P0-01/report.md").is_file():
                    raise ValueError("P0-01 acceptance evidence missing")
                execute(["python3", "scripts/validate_repo.py"], self.repo)
            self.db.execute("""INSERT OR IGNORE INTO tasks(id,state,deps,updated_at)
                 VALUES(?,?,?,?)""",
                (key, DONE if key == "P0-01" else "PENDING",
                 json.dumps(task["dependencies"]), int(time.time())))
        self.db.commit()

    def recover_orphaned(self):
        for row in self.records().values():
            if row["state"] == "RUNNING":
                self.update(row["id"], state="RETRY", retry_after=int(time.time()) + 45,
                            error="Supervisor/container restarted; prior worktree preserved")
                self.event(row["id"], "RECOVERED", "Agent process lost on restart")

    def staging(self):
        if self.cfg.get("integration_branch") != "staging":
            raise ValueError("Only nonproduction staging branch is supported")
        execute(["git", "fetch", "-q", "origin", "main"], self.repo, timeout=90)
        if not execute(["git", "ls-remote", "--heads", "origin", "staging"],
                       self.repo, timeout=60):
            execute(["git", "push", "origin",
                     "origin/main:refs/heads/staging"], self.repo, timeout=90)
            self.event("SYSTEM", "STAGING_CREATED", "from main")
        execute(["git", "fetch", "-q", "origin", "staging"], self.repo, timeout=90)

    def worktree(self, task_id):
        row = self.records()[task_id]
        if row["workspace"]:
            work = Path(row["workspace"])
            if work.is_dir() and (work / ".git").exists():
                return work
            raise RuntimeError("Prior worktree path missing; manual recovery required")
        self.staging()
        branch = "agy/" + task_id.lower()
        dest = self.worktrees / task_id.lower()
        if dest.exists():
            raise RuntimeError("Untracked destination exists: " + str(dest))
        base = execute(["git", "rev-parse", "origin/staging"], self.repo)
        execute(["git", "worktree", "add", "-b", branch, str(dest),
                 "origin/staging"], self.repo, timeout=80)
        self.update(task_id, branch=branch, workspace=str(dest), base_sha=base)
        return dest

    def prompt(self, task_id, result_file):
        task = self.catalog[task_id]
        previous = self.records()[task_id]["error"]
        return (
            "You are AGY worker for PRIVATE independent creativanta-video-engine task " + task_id +
            ". WORKTREE: " + str(self.records()[task_id]["workspace"]) + "\n"
            "ONLY change files inside this dedicated worktree. Do not modify neighboring "
            "repos, parent checkout, production, Docker host services, credentials, or other projects. "
            "Do not install unreviewed third-party code or run untrusted user-supplied video JS. "
            "No GPU AI-video models or paid AI-video API. No production deployment.\n"
            "Mandatory reading: AGENTS.md, docs/AGENTS.md, docs/IMPLEMENTATION_PLAN.md, "
            "docs/SECURITY.md, docs/TESTING.md, docs/SCENE-SPEC.md, docs/API.md.\n"
            "Scope/task: " + task_id + " / " + task["stream"] + " / " +
            task["phase"] + "\nAcceptance: " + task["acceptance"] + "\n"
            "Allowed paths from bootstrap snapshot: " +
            json.dumps(task["allowed_paths"], ensure_ascii=False) + "\n"
            "You must implement real task deliverables, not just describe a plan. "
            "Record evidence/evidence references under evidence/" + task_id + "/report.md, "
            "with actual test commands, exit statuses, and pending external gates. "
            "Do not falsely report video rendering, CI, or human/security/legal review. "
            "Preserve existing changes; use versioned source and appropriate git commits. "
            "DO NOT push, merge or create PR: supervisor will handle staging-only GitHub integration. "
            "No editing main. End with clean worktree + meaningful local commit if checks pass. "
            "If partial, preserve work and report partial; don't mark done. "
            "Run python3 scripts/validate_repo.py and relevant tests. "
            "Never disable failing tests/CI to obtain a pass.\n"
            "After work WRITE valid JSON at " + str(result_file) +
            ' with keys: status ("implemented_local"|"partial"|"blocked"), '
            'checks (array of {command, exit_code, result}), '
            'external_gates (array), remaining_scope (array), notes (string). '
            "Only implemented_local if acceptance met and real checks passed. "
            "Review report must be present in worktree and committed.\n"
            "If previous issue mentions CI, PR or merge conflict: inspect PR checks, "
            "fetch current staging, fix actual failing code and rerun relevant tests. "
            "Never bypass, disable or rename the CI gate. "
            "No new commits or missing proof means no progress.\\n"
            "Previous issue, if any: " + str(previous or "none")[:600] + "\n"
            "When complete, end your single AGY session. The supervisor dispatches the next task."
        )

    def launch(self, task_id):
        work = self.worktree(task_id)
        row = self.records()[task_id]
        results = self.data / "results" / (task_id + ".json")
        results.unlink(missing_ok=True)
        model = self.cfg["models"]["complex"] if task_id in {
            "P0-04", "P0-05", "P1-04", "P3-01", "P4-01", "P4-02",
            "P4-03", "P6-04", "P7-01", "P7-04", "P7-05"} else self.cfg["models"]["regular"]
        settings = {"permissions": {"allow": [
            "command(*)", "write_file(*)", "edit_file(*)",
            "apply_patch(*)", "create_directory(*)"]}}
        args = ["agy", "--model", model, "--settings", json.dumps(settings),
                "--print-timeout", "0s", "--print", self.prompt(task_id, results)]
        logfile = self.data / "logs" / (task_id + "-attempt-" + str(row["attempts"] + 1) + ".log")
        with logfile.open("w") as f:
            process = subprocess.Popen(args, cwd=work, stdin=subprocess.DEVNULL,
                                       stdout=f, stderr=subprocess.STDOUT,
                                       start_new_session=True)
        started = int(time.time())
        self.active[task_id] = (process, started, logfile)
        self.update(task_id, state="RUNNING", started_at=started,
                    attempts=row["attempts"] + 1, retry_after=0,
                    run_id=str(uuid.uuid4()), log_path=str(logfile))
        self.event(task_id, "STARTED", "pid=%d model=%s" % (process.pid, model))

    def retry(self, task_id, why):
        row = self.records()[task_id]
        if row["attempts"] >= self.cfg["max_attempts_per_task"]:
            self.update(task_id, state="BLOCKED", error=str(why)[:420])
            self.event(task_id, "BLOCKED", why)
        else:
            delay = retry_delay(row["attempts"])
            self.update(task_id, state="RETRY", retry_after=int(time.time()) + delay,
                        error=str(why)[:420])
            self.event(task_id, "RETRY", why)

    def finish(self, task_id, process, started, log):
        output = log.read_text(errors="replace")[-15000:] if log.exists() else ""
        if process.returncode:
            self.retry(task_id, "AGY exit %d (see %s)" %
                       (process.returncode, log.name))
            return
        if any(x in output.lower() for x in DENIAL_MARKERS):
            self.retry(task_id, "AGY tool was denied or returned no usable output")
            return
        row = self.records()[task_id]
        work = Path(row["workspace"])
        result = valid_result(self.data / "results" / (task_id + ".json"), started)
        if result is None:
            self.retry(task_id, "Missing or invalid fresh structured evidence")
            return
        sha = execute(["git", "rev-parse", "HEAD"], work)
        count = int(execute(["git", "rev-list", "--count", row["base_sha"] + "..HEAD"], work))
        dirty = execute(["git", "status", "--porcelain"], work)
        if count < 1 or dirty:
            self.retry(task_id, "No committed changes or dirty worktree (ahead=%d)" % count)
            return
        if row["sha"] and sha == row["sha"]:
            self.retry(task_id, "No new commit after previous CI/review feedback")
            return
        if not (work / "evidence" / task_id / "report.md").is_file():
            self.retry(task_id, "Missing committed evidence report")
            return
        if result["status"] == "blocked":
            self.update(task_id, state="BLOCKED", sha=sha,
                        error=str(result.get("notes", "external blocker"))[:420])
            self.event(task_id, "BLOCKED", "Worker reported blocking gate")
            return
        if result["status"] == "partial":
            self.retry(task_id, "Worker delivered partial scope: " +
                       str(result.get("notes", ""))[:190])
            return
        if not all(isinstance(x, dict) and x.get("exit_code") == 0
                   and x.get("command") for x in result["checks"]):
            self.retry(task_id, "Checks missing actual passing command/exit_code pairs")
            return
        execute(["git", "diff", "--check", row["base_sha"], "HEAD"], work)
        execute(["python3", "scripts/validate_repo.py"], work, timeout=60)
        execute(["git", "push", "origin", "HEAD:refs/heads/" + row["branch"]],
                work, timeout=140)
        pr = self.ensure_pr(task_id, row["branch"])
        self.update(task_id, state="CI_PENDING", sha=sha, pr=pr, error="",
                    retry_after=int(time.time()) + 30)
        self.event(task_id, "PR_OPENED", "PR #%s" % pr)

    def ensure_pr(self, task_id, branch):
        args = ["gh", "pr", "list", "-R", REPO_NAME, "--head", branch,
                "--state", "open", "--json", "number"]
        existing = json.loads(execute(args, self.repo))
        if existing:
            return int(existing[0]["number"])
        title = "%s: %s" % (task_id, self.catalog[task_id]["acceptance"][:100])
        body = ("Automatic AGY candidate, task %s. CI-gated staging only; "
                "not production or legal/security approval.\\n"
                "Acceptance: %s\\n"
                "Review evidence at evidence/%s/report.md.") % (
                    task_id, self.catalog[task_id]["acceptance"], task_id)
        execute(["gh", "pr", "create", "-R", REPO_NAME,
                 "--base", "staging", "--head", branch,
                 "--title", title[:240], "--body", body],
                self.repo, timeout=100)
        found = json.loads(execute(args, self.repo))
        if not found:
            raise RuntimeError("PR create did not return an open PR")
        return int(found[0]["number"])

    def reconcile_pr(self, task_id):
        row = self.records()[task_id]
        if row["retry_after"] > time.time():
            return
        try:
            data = json.loads(execute(
                ["gh", "pr", "view", str(row["pr"]), "-R", REPO_NAME,
                 "--json", "state,baseRefName,mergeable,isDraft,statusCheckRollup"],
                self.repo, timeout=60))
        except Exception as err:
            self.update(task_id, retry_after=int(time.time()) + 60,
                        error="GitHub unavailable: " + str(err)[:170])
            return
        if data.get("baseRefName") != "staging":
            self.update(task_id, state="BLOCKED", error="PR base changed outside staging")
            return
        if data.get("state") == "MERGED":
            self.update(task_id, state=DONE, error="")
            self.event(task_id, DONE, "Merged staging")
            return
        if data.get("state") != "OPEN" or data.get("isDraft"):
            self.update(task_id, state="BLOCKED", error="PR closed or draft")
            return
        if data.get("mergeable") == "CONFLICTING":
            self.retry(task_id, "PR #" + str(row["pr"]) +
                       " conflicts with staging. Merge origin/staging in task worktree, "
                       "resolve carefully, rerun checks and push. Do not force-push.")
            return
        checks = data.get("statusCheckRollup") or []
        verdict = ci_verdict(checks)
        if verdict == "failed":
            self.retry(task_id, "GitHub CI failed for PR #" + str(row["pr"]) +
                       ". Inspect gh pr checks and gh run view --log-failed; "
                       "fix actual failure, run tests, commit new changes.")
            return
        opened = self.db.execute(
            "SELECT MAX(ts) FROM events WHERE task_id=? AND action='PR_OPENED'",
            (task_id,)).fetchone()[0] or row["started_at"]
        elapsed = time.time() - opened
        if not checks and elapsed > self.cfg.get("ci_missing_checks_timeout_seconds", 900):
            self.retry(task_id, "No GitHub CI checks triggered for PR #" + str(row["pr"]) +
                       ". Investigate workflow scope/path/trigger and update feature branch.")
            return
        if elapsed > self.cfg.get("ci_timeout_seconds", 10800):
            self.retry(task_id, "CI remains pending beyond timeout for PR #" + str(row["pr"]) +
                       ". Inspect GitHub runners and workflow before retrying.")
            return
        if verdict != "pass" or data.get("mergeable") == "UNKNOWN":
            self.update(task_id, retry_after=int(time.time()) + 45)
            return
        if data.get("mergeable") != "MERGEABLE":
            self.retry(task_id, "Unexpected PR mergeability: " + str(data.get("mergeable")))
            return
        if task_id in HUMAN_REVIEW:
            self.update(task_id, state="REVIEW_REQUIRED",
                        error="Human/security/legal acceptance required")
            self.event(task_id, "REVIEW_REQUIRED", "CI passed; manual approval needed")
            return
        execute(["gh", "pr", "merge", str(row["pr"]), "-R", REPO_NAME, "--merge"],
                self.repo, timeout=120)
        self.update(task_id, state=DONE, error="")
        self.event(task_id, DONE, "CI passed and merged to staging")

    def poll_workers(self):
        for task_id, (process, started, log) in list(self.active.items()):
            code = process.poll()
            if code is None and time.time() - started > self.cfg["max_agent_minutes"] * 60:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait(timeout=10)
                code = process.returncode
            if code is None:
                continue
            self.active.pop(task_id)
            try:
                self.finish(task_id, process, started, log)
            except Exception as error:
                self.retry(task_id, "Verification failed: " + str(error)[:230])

    def dispatch(self):
        if self.cfg.get("paused", False):
            return
        now = int(time.time())
        runs_today = self.db.execute(
            "SELECT COUNT(*) FROM events WHERE action='STARTED' AND ts>=?",
            (now - 86400,)).fetchone()[0]
        allowed = min(self.cfg["max_concurrent"] - len(self.active),
                      self.cfg["max_runs_per_24h"] - runs_today)
        if allowed <= 0:
            return
        rows = self.records()
        statuses = {k: v["state"] for k, v in rows.items()}
        for task_id in self.catalog:
            if allowed <= 0:
                break
            row = rows[task_id]
            if row["state"] not in {"PENDING", "RETRY"} or row["retry_after"] > now:
                continue
            if not can_run(self.catalog[task_id]["dependencies"], statuses):
                continue
            try:
                self.launch(task_id)
            except Exception as error:
                self.retry(task_id, "Launch failed: " + str(error)[:250])
            allowed -= 1

    def snapshot(self):
        rows = self.records()
        counts = Counter(row["state"] for row in rows.values())
        status = {
            "heartbeat": utc_now(), "heartbeat_epoch": int(time.time()),
            "supervisor_pid": os.getpid(),
            "running": sorted(self.active), "counts": dict(counts),
            "tasks": [{
                "id": k, "state": v["state"], "attempts": v["attempts"],
                "dependencies": json.loads(v["deps"]),
                "sha": v["sha"], "pr": v["pr"], "error": v["error"][:250],
                "workspace": v["workspace"], "log": v["log_path"]
            } for k, v in rows.items()]
        }
        target = self.data / "status.json"
        tmp = self.data / "status.tmp"
        tmp.write_text(json.dumps(status, ensure_ascii=False, indent=2) + "\n")
        tmp.replace(target)

    def tick(self):
        self.cfg = json.loads(self.cfg_path.read_text())
        self.poll_workers()
        for row in self.records().values():
            if row["state"] == "CI_PENDING":
                self.reconcile_pr(row["id"])
        self.dispatch()
        self.snapshot()

    def run(self, once=False):
        self.staging()
        self.last_tick_at = time.monotonic()
        def watchdog():
            while not self.stop:
                if time.monotonic() - self.last_tick_at > 210:
                    LOG.critical("Scheduler heartbeat stalled; exiting for Docker restart")
                    os._exit(70)
                time.sleep(12)
        threading.Thread(target=watchdog, name="heartbeat-watchdog", daemon=True).start()
        def interrupt(*_):
            self.stop = True
        signal.signal(signal.SIGTERM, interrupt)
        signal.signal(signal.SIGINT, interrupt)
        failures = 0
        self.event("SYSTEM", "STARTED", "Video Engine supervisor; staging only")
        while not self.stop:
            try:
                self.tick()
                self.last_tick_at = time.monotonic()
                failures = 0
            except Exception:
                failures += 1
                LOG.exception("Failed scheduler tick %d", failures)
                if failures >= 8:
                    raise RuntimeError("Repeated tick errors; let Docker restart supervisor")
            if once:
                break
            time.sleep(max(10, int(self.cfg["interval_seconds"])))
        for task_id, (process, _, _) in self.active.items():
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                self.event(task_id, "INTERRUPTED", "Supervisor stopping")
        self.snapshot()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("run", "once", "status", "health"))
    parser.add_argument("--config", default=str(Path(__file__).with_name("config.json")))
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO,
                        format="%(asctime)s %(levelname)s %(message)s")
    if args.action in {"status", "health"}:
        cfg = json.loads(Path(args.config).read_text())
        path = Path(cfg["state_dir"]) / "status.json"
        if not path.is_file():
            print("NOT_STARTED")
            return 2
        data = json.loads(path.read_text())
        if args.action == "health":
            age = time.time() - data["heartbeat_epoch"]
            if age > 150 or age < -20:
                print("STALE_HEARTBEAT age=%s" % int(age))
                return 3
            print("HEALTHY")
            return 0
        print(json.dumps({
            "heartbeat": data["heartbeat"], "running": data["running"],
            "counts": data["counts"], "pending": [
                {"id": x["id"], "state": x["state"], "attempts": x["attempts"],
                 "pr": x["pr"], "error": x["error"]}
                for x in data["tasks"]
                if x["state"] not in {"INTEGRATED", "PENDING"}
            ]
        }, ensure_ascii=False, indent=2))
        return 0
    runner = Supervisor(args.config)
    runner.run(once=args.action == "once")
    return 0


if __name__ == "__main__":
    sys.exit(main())
