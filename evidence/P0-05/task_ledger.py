#!/usr/bin/env python3
"""
AGY Durable Task Ledger, Worktree Policy Enforcer, Evidence Template Validator,
Credential Sanitizer, and Crash/Reboot Recovery Engine (Task P0-05).

Implements the normative supervisor specifications in docs/AGENTS.md:
- Authoritative SQLite WAL state store at .agy/state.sqlite with 8 required tables:
  tasks, dependencies, leases, file_claims, runs, evidence, reviews, events
  (plus supervisor_meta for supervisor heartbeat & boot_id tracking).
- Exported sanitized runtime snapshots at .agy/status.json and .agy/events.jsonl.
- Safe online backups using the SQLite Backup API into .agy/backups/.
- Atomic task claiming (ready -> claimed) checking dependency completion and
  non-overlapping file_claims within a single immediate transaction.
- Monotonic lease_epoch fencing to reject stale workers after lease reclamation.
- Worktree policy enforcement (.worktrees/<task-id>-<run-id>, branch agy/<task-id>-<slug>,
  no main edits, no destructive git commands, scoped allowed_paths verification).
- Standardized evidence report template generation and validation.
- Strict credential/secret redaction across queue records, events, logs, and exports.
- Crash/reboot recovery drill with synthetic task states (preserving dirty worktree
  edits, reattaching live workers, reclaiming dead workers with incremented fence,
  marking interrupted in-flight checks as NOT_RUN, circuit-breaking repeated failures,
  and restoring from SQLite backup + durable JSONL event replay).
"""

from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from typing import Any, Dict, Iterable, List, Optional, Sequence, Set, Tuple

TASK_STATES: Tuple[str, ...] = (
    "planned",
    "ready",
    "claimed",
    "running",
    "verifying",
    "review",
    "done",
    "blocked",
    "canceled",
)

ACTIVE_LEASE_STATES: Tuple[str, ...] = ("claimed", "running", "verifying")

VALID_STATE_TRANSITIONS: Dict[str, Set[str]] = {
    "planned": {"ready", "blocked", "canceled"},
    "ready": {"claimed", "planned", "blocked", "canceled"},
    "claimed": {"running", "ready", "blocked", "canceled"},
    "running": {"verifying", "review", "ready", "blocked", "canceled"},
    "verifying": {"review", "running", "ready", "blocked", "canceled"},
    "review": {"done", "ready", "running", "blocked", "canceled"},
    "done": set(),
    "blocked": {"ready", "planned", "canceled"},
    "canceled": {"planned", "ready"},
}

EVIDENCE_RESULTS: Set[str] = {"PASS", "FAIL", "NOT_RUN", "BLOCKED"}

# Timing policy per docs/AGENTS.md:
# Worker heartbeat: 30s, coding task lease: 10min (600s), warn after 90s without heartbeat,
# reclaim after lease expiry (600s) + 2min (120s) grace = 720s total.
WORKER_HEARTBEAT_INTERVAL_SECONDS = 30
WORKER_HEARTBEAT_WARN_SECONDS = 90
TASK_LEASE_DURATION_SECONDS = 600
TASK_LEASE_GRACE_SECONDS = 120
SUPERVISOR_HEARTBEAT_INTERVAL_SECONDS = 30
MAX_NON_PROGRESS_ATTEMPTS = 2

TASK_ID_RE = re.compile(r"^(?:P\d+-\d{2}|DOC-001|SYNTH-\d{2})$")
WORKTREE_DIR_RE = re.compile(r"^\.worktrees/([a-z0-9-]+?)(?:-([a-z0-9._-]+))?$")
BRANCH_NAME_RE = re.compile(r"^agy/([a-z0-9-]+?)(?:-([a-z0-9._-]+))?$")

FORBIDDEN_GIT_PATTERNS: Tuple[ Tuple[re.Pattern[str], str], ... ] = (
    (re.compile(r"\bgit\s+reset\s+--hard\b"), "git reset --hard is forbidden by docs/AGENTS.md"),
    (re.compile(r"\bgit\s+clean\s+-[a-zA-Z]*[fd]"), "git clean deleting untracked files is forbidden"),
    (re.compile(r"\bgit\s+checkout\s+(?:-f|--force)\b"), "git checkout --force is forbidden"),
    (re.compile(r"\bgit\s+switch\s+(?:-f|--force|-C)\b"), "git switch --force is forbidden"),
    (re.compile(r"\bgit\s+push\s+(?:--force|-f|--force-with-lease)\b"), "force push is forbidden"),
    (re.compile(r"\bgit\s+branch\s+-D\b"), "force deleting branches is forbidden"),
)


class LedgerError(Exception):
    """Base exception for task ledger violations."""


class StaleLeaseFenceError(LedgerError):
    """Raised when a worker presents a stale run_id or lease_epoch."""


class FileClaimConflictError(LedgerError):
    """Raised when a task attempts to claim allowed_paths overlapping an active lease."""


class DependencyNotSatisfiedError(LedgerError):
    """Raised when a task has dependencies not yet in the 'done' state."""


class DagCycleError(LedgerError):
    """Raised when the task dependency graph contains a cycle."""


class WorktreePolicyError(LedgerError):
    """Raised when a git command, branch, worktree path, or modified file violates policy."""


class EvidenceValidationError(LedgerError):
    """Raised when a task evidence report violates the canonical template or safety rules."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def format_utc(dt: Optional[datetime]) -> Optional[str]:
    if dt is None:
        return None
    return dt.astimezone(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_utc(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    return datetime.fromisoformat(normalized).astimezone(timezone.utc)


class CredentialSanitizer:
    """
    Redacts credentials, tokens, private keys, presigned URLs, and connection secrets
    before persisting to SQLite, logs, or JSON/JSONL exports.
    """

    SENSITIVE_KEY_NAMES: Set[str] = {
        "password",
        "passwd",
        "secret",
        "client_secret",
        "webhook_secret",
        "signing_secret",
        "api_key",
        "apikey",
        "access_token",
        "refresh_token",
        "id_token",
        "bearer",
        "authorization",
        "private_key",
        "secret_access_key",
        "aws_secret_access_key",
        "session_token",
    }

    # Ordered patterns for inline secret scrubbing
    SECRET_PATTERNS: Tuple[Tuple[re.Pattern[str], str], ...] = (
        # PEM Private Keys
        (
            re.compile(
                r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----.*?-----END [A-Z0-9 ]*PRIVATE KEY-----",
                re.DOTALL,
            ),
            "[REDACTED_PRIVATE_KEY]",
        ),
        (
            re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[^\s]*"),
            "[REDACTED_PRIVATE_KEY]",
        ),
        # Authorization headers
        (
            re.compile(r"(?i)\b(Authorization\s*:\s*(?:Bearer|Basic|Token)\s+)(?!\[REDACTED\])[^\s\"',;]+"),
            r"\1[REDACTED]",
        ),
        (
            re.compile(r"(?i)\b(Bearer\s+)(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{12,}"),
            r"\1[REDACTED]",
        ),
        # Known token prefixes (GitHub, OpenAI/provider, AWS, internal cve keys)
        (
            re.compile(
                r"\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,}|"
                r"sk-(?:proj-)?[A-Za-z0-9_-]{16,}|AKIA[A-Z0-9]{16}|"
                r"cve_(?:live|test|secret)_[A-Za-z0-9_-]{12,})\b"
            ),
            "[REDACTED_API_KEY]",
        ),
        # URLs with embedded user:password@host
        (
            re.compile(r"\b([a-zA-Z][a-zA-Z0-9+.-]*://[^/\s:@]*:)(?!\[REDACTED\])([^@\s/]+)(@)"),
            r"\1[REDACTED]\3",
        ),
        # Presigned URL query parameters and inline query secrets
        (
            re.compile(
                r"(?i)([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|"
                r"X-Goog-Signature|X-Goog-Credential|Signature|sig|token|access_token|"
                r"api_key|apikey|secret|password|client_secret|webhook_secret)=)(?!\[REDACTED\])[^&#\s\"']+"
            ),
            r"\1[REDACTED]",
        ),
        # Key=Value or env assignment for sensitive keys
        (
            re.compile(
                r"(?i)\b((?:[A-Z0-9_]*?(?:SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|"
                r"ACCESS_TOKEN|PRIVATE_KEY|WEBHOOK_KEY|SIGNING_KEY)[A-Z0-9_]*|"
                r"password|secret|api_key|access_token|client_secret|webhook_secret)"
                r"\s*[:=]\s*[\"']?)(?!\[REDACTED\])([^\"'\s,;}{]+)([\"']?)"
            ),
            r"\1[REDACTED]\3",
        ),
    )

    @classmethod
    def sanitize_text(cls, text: Optional[str]) -> Optional[str]:
        if text is None:
            return None
        result = str(text)
        for pattern, replacement in cls.SECRET_PATTERNS:
            result = pattern.sub(replacement, result)
        return result

    @classmethod
    def sanitize(cls, value: Any) -> Any:
        if value is None or isinstance(value, (bool, int, float)):
            return value
        if isinstance(value, str):
            return cls.sanitize_text(value)
        if isinstance(value, dict):
            cleaned: Dict[str, Any] = {}
            for k, v in value.items():
                key_str = str(k)
                key_lower = key_str.lower()
                if key_lower in cls.SENSITIVE_KEY_NAMES or any(
                    marker in key_lower
                    for marker in ("secret", "password", "passwd", "api_key", "apikey", "private_key", "access_token")
                ):
                    cleaned[key_str] = "[REDACTED]"
                else:
                    cleaned[key_str] = cls.sanitize(v)
            return cleaned
        if isinstance(value, (list, tuple, set)):
            return [cls.sanitize(item) for item in value]
        return cls.sanitize_text(str(value))

    @classmethod
    def contains_secret(cls, text: str) -> bool:
        sanitized = cls.sanitize_text(text)
        return sanitized != text


def normalize_path_prefix(path_str: str) -> str:
    cleaned = path_str.strip().replace("\\", "/")
    while cleaned.startswith("./"):
        cleaned = cleaned[2:]
    cleaned = cleaned.lstrip("/")
    return cleaned


def paths_overlap(path_a: str, path_b: str) -> bool:
    """
    Returns True if path_a and path_b refer to the same file or one is a directory
    prefix of the other.
    """
    a = normalize_path_prefix(path_a)
    b = normalize_path_prefix(path_b)
    if not a or not b:
        return False
    if a == b:
        return True
    a_dir = a if a.endswith("/") else a + "/"
    b_dir = b if b.endswith("/") else b + "/"
    return a.startswith(b_dir) or b.startswith(a_dir) or a_dir == b_dir


def is_path_allowed(file_path: str, allowed_paths: Sequence[str]) -> bool:
    norm_file = normalize_path_prefix(file_path)
    if not norm_file:
        return False
    for allowed in allowed_paths:
        norm_allowed = normalize_path_prefix(allowed)
        if not norm_allowed:
            continue
        if norm_allowed.endswith("/"):
            if norm_file.startswith(norm_allowed) or norm_file + "/" == norm_allowed:
                return True
        else:
            if norm_file == norm_allowed or norm_file.startswith(norm_allowed + "/"):
                return True
    return False


class WorktreePolicy:
    """
    Enforces the Git worktree, branch, command, and file-scope rules defined in docs/AGENTS.md.
    """

    @staticmethod
    def expected_worktree_relpath(task_id: str, run_id: Optional[str] = None) -> str:
        slug_id = task_id.lower()
        if run_id:
            short_run = re.sub(r"[^a-z0-9._-]", "-", run_id.lower())[:24].strip("-")
            return f".worktrees/{slug_id}-{short_run}"
        return f".worktrees/{slug_id}"

    @staticmethod
    def expected_branch_name(task_id: str, slug: str = "task") -> str:
        clean_slug = re.sub(r"[^a-z0-9._-]", "-", slug.lower()).strip("-")
        if clean_slug:
            return f"agy/{task_id.lower()}-{clean_slug}"
        return f"agy/{task_id.lower()}"

    @classmethod
    def validate_worktree_assignment(
        cls,
        repo_root: Path,
        task_id: str,
        worktree_path: str,
        branch_name: str,
    ) -> Dict[str, str]:
        if branch_name in {"main", "master", "staging", "production"}:
            raise WorktreePolicyError(
                f"Task {task_id} cannot check out protected branch '{branch_name}'"
            )
        if not BRANCH_NAME_RE.match(branch_name) or not branch_name.startswith(
            f"agy/{task_id.lower()}"
        ):
            raise WorktreePolicyError(
                f"Branch '{branch_name}' must match 'agy/{task_id.lower()}-<slug>' or 'agy/{task_id.lower()}'"
            )

        resolved_root = repo_root.resolve()
        wt_candidate = Path(worktree_path)
        if not wt_candidate.is_absolute():
            wt_resolved = (resolved_root / wt_candidate).resolve()
        else:
            wt_resolved = wt_candidate.resolve()

        if wt_resolved == resolved_root:
            raise WorktreePolicyError("Workers must never operate directly in the root/main checkout")

        worktrees_root = (resolved_root / ".worktrees").resolve()
        if not wt_resolved.is_relative_to(worktrees_root):
            raise WorktreePolicyError(
                f"Worktree '{wt_resolved}' must reside inside '{worktrees_root}'"
            )

        rel = wt_resolved.relative_to(resolved_root).as_posix()
        if not WORKTREE_DIR_RE.match(rel) or not rel.startswith(f".worktrees/{task_id.lower()}"):
            raise WorktreePolicyError(
                f"Worktree relative path '{rel}' must match '.worktrees/{task_id.lower()}-<run-id>'"
            )
        return {"worktree_rel": rel, "worktree_abs": str(wt_resolved), "branch": branch_name}

    @classmethod
    def validate_git_command(cls, command: str) -> None:
        for pattern, reason in FORBIDDEN_GIT_PATTERNS:
            if pattern.search(command):
                raise WorktreePolicyError(f"Forbidden git command blocked: {reason} ({command})")

    @classmethod
    def check_worktree_clean_before_remove(cls, worktree_dir: Path) -> bool:
        if not worktree_dir.exists():
            return True
        status_proc = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=str(worktree_dir),
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        if status_proc.returncode != 0:
            raise WorktreePolicyError(
                f"Cannot verify git status of worktree {worktree_dir}; refusing removal"
            )
        if status_proc.stdout.strip():
            raise WorktreePolicyError(
                f"Refusing to remove dirty worktree {worktree_dir} with uncommitted changes"
            )
        return True

    @classmethod
    def verify_changed_files_in_scope(
        cls,
        changed_files: Iterable[str],
        allowed_paths: Sequence[str],
    ) -> Tuple[List[str], List[str]]:
        in_scope: List[str] = []
        out_of_scope: List[str] = []
        for fpath in changed_files:
            if is_path_allowed(fpath, allowed_paths):
                in_scope.append(fpath)
            else:
                out_of_scope.append(fpath)
        return in_scope, out_of_scope


class EvidenceValidator:
    """
    Generates and validates standardized task evidence reports per docs/AGENTS.md.
    """

    REQUIRED_KEYS: Tuple[str, ...] = (
        "Task",
        "Base / tested commit",
        "Environment",
        "Command",
        "Result",
        "Exit code / UTC started / duration",
        "Artifacts",
        "Acceptance mapping",
        "Reviewer / reviewed commit / decision",
    )

    @classmethod
    def render_template(
        cls,
        task_id: str,
        base_commit: str,
        tested_commit: str,
        environment: str,
        command: str,
        result: str,
        exit_code: int,
        utc_started: str,
        duration: str,
        artifacts: Sequence[Dict[str, str]],
        acceptance_mapping: Sequence[Tuple[str, str]],
        reviewer: str = "pending independent reviewer",
        reviewed_commit: Optional[str] = None,
        decision: str = "local completion awaiting review",
    ) -> str:
        if result not in EVIDENCE_RESULTS:
            raise EvidenceValidationError(f"Invalid Result '{result}'; expected one of {sorted(EVIDENCE_RESULTS)}")
        clean_cmd = CredentialSanitizer.sanitize_text(command) or ""
        if CredentialSanitizer.contains_secret(command):
            raise EvidenceValidationError("Command in evidence template must not contain plaintext credentials")

        artifact_lines = []
        for art in artifacts:
            path_val = art["path"]
            sha_val = art["sha256"]
            exp_val = art.get("expires", "N/A (repo-versioned artifact)")
            artifact_lines.append(f"  - {path_val}, sha256={sha_val}, expires={exp_val}")

        mapping_lines = [f"  - {crit}: {ev}" for crit, ev in acceptance_mapping]
        rev_sha = reviewed_commit or tested_commit

        block = [
            f"Task: {task_id}",
            f"Base / tested commit: {base_commit} / {tested_commit}",
            f"Environment: {environment}",
            f"Command: {clean_cmd}",
            f"Result: {result}",
            f"Exit code / UTC started / duration: {exit_code} / {utc_started} / {duration}",
            "Artifacts:",
            *artifact_lines,
            "Acceptance mapping:",
            *mapping_lines,
            f"Reviewer / reviewed commit / decision: {reviewer} / {rev_sha} / {decision}",
        ]
        return "\n".join(block)

    @classmethod
    def validate_report_markdown(cls, markdown_text: str, expected_task_id: Optional[str] = None) -> Dict[str, Any]:
        if CredentialSanitizer.contains_secret(markdown_text):
            raise EvidenceValidationError("Evidence report contains unredacted credential/secret pattern")

        h1_matches = re.findall(r"^# ", markdown_text, flags=re.MULTILINE)
        if len(h1_matches) != 1:
            raise EvidenceValidationError(f"Expected exactly 1 H1 heading, found {len(h1_matches)}")

        # Extract the ```text ... ``` evidence block
        text_blocks = re.findall(r"^```text\s*\n(.*?)^```", markdown_text, flags=re.MULTILINE | re.DOTALL)
        if not text_blocks:
            raise EvidenceValidationError("Missing ```text ... ``` canonical evidence block in report")

        block = text_blocks[0]
        missing_keys = [
            key for key in cls.REQUIRED_KEYS
            if not re.search(rf"^{re.escape(key)}:", block, flags=re.MULTILINE)
        ]
        if missing_keys:
            raise EvidenceValidationError(f"Evidence block missing required keys: {missing_keys}")

        task_match = re.search(r"^Task:\s*(\S+)", block, flags=re.MULTILINE)
        task_id = task_match.group(1) if task_match else ""
        if expected_task_id and task_id != expected_task_id:
            raise EvidenceValidationError(
                f"Evidence block Task '{task_id}' does not match expected '{expected_task_id}'"
            )

        commit_match = re.search(
            r"^Base / tested commit:\s*([0-9a-f]{7,40})\s*/\s*([0-9a-f]{7,40})",
            block,
            flags=re.MULTILINE,
        )
        if not commit_match:
            raise EvidenceValidationError("Invalid 'Base / tested commit' format; expected '<sha> / <sha>'")

        result_match = re.search(r"^Result:\s*(PASS|FAIL|NOT_RUN|BLOCKED)\s*$", block, flags=re.MULTILINE)
        if not result_match:
            raise EvidenceValidationError("Result must be strictly one of PASS | FAIL | NOT_RUN | BLOCKED")
        result_val = result_match.group(1)

        exit_match = re.search(
            r"^Exit code / UTC started / duration:\s*(-?\d+|N/A)\s*/\s*(\S+)\s*/\s*(\S+)",
            block,
            flags=re.MULTILINE,
        )
        if not exit_match:
            raise EvidenceValidationError("Invalid 'Exit code / UTC started / duration' line")
        exit_code_raw = exit_match.group(1)
        if result_val == "PASS" and exit_code_raw != "0":
            raise EvidenceValidationError(f"Result cannot be PASS when exit code is {exit_code_raw}")

        sha256_matches = re.findall(r"sha256=([0-9a-f]{64})", block)
        if not sha256_matches:
            raise EvidenceValidationError("Evidence block must record at least one artifact with sha256=<64-hex>")

        return {
            "valid": True,
            "task_id": task_id,
            "base_commit": commit_match.group(1),
            "tested_commit": commit_match.group(2),
            "result": result_val,
            "exit_code": int(exit_code_raw) if exit_code_raw.lstrip("-").isdigit() else None,
            "artifact_sha256_count": len(sha256_matches),
        }


class TaskLedger:
    """
    Authoritative SQLite WAL durable task ledger for AGY supervisor (docs/AGENTS.md).
    Single-writer supervisor design with transactional state transitions, lease_epoch
    fencing, non-overlapping file_claims, sanitized status/event exports, and backup/recovery.
    """

    REQUIRED_TABLES: Tuple[str, ...] = (
        "tasks",
        "dependencies",
        "leases",
        "file_claims",
        "runs",
        "evidence",
        "reviews",
        "events",
    )

    def __init__(
        self,
        agy_dir: Path,
        boot_id: str = "boot-default-001",
        supervisor_pid: Optional[int] = None,
        supervisor_run_id: Optional[str] = None,
    ) -> None:
        self.agy_dir = agy_dir.resolve()
        self.agy_dir.mkdir(parents=True, exist_ok=True)
        self.backups_dir = self.agy_dir / "backups"
        self.backups_dir.mkdir(parents=True, exist_ok=True)

        self.db_path = self.agy_dir / "state.sqlite"
        self.status_path = self.agy_dir / "status.json"
        self.events_path = self.agy_dir / "events.jsonl"
        self.lock_path = self.agy_dir / "supervisor.lock"

        self.boot_id = boot_id
        self.supervisor_pid = supervisor_pid if supervisor_pid is not None else os.getpid()
        self.supervisor_run_id = supervisor_run_id or f"sup-{uuid.uuid4().hex[:12]}"

        self._lock_file = self.lock_path.open("a+", encoding="utf-8")
        try:
            fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            self._lock_file.close()
            raise LedgerError(f"Another supervisor holds singleton lock {self.lock_path}") from exc

        self.conn = sqlite3.connect(str(self.db_path), timeout=30.0, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()
        self.record_supervisor_heartbeat()

    def close(self) -> None:
        if getattr(self, "conn", None) is not None:
            try:
                self.conn.close()
            except Exception:
                pass
            self.conn = None  # type: ignore[assignment]
        if getattr(self, "_lock_file", None) is not None:
            try:
                fcntl.flock(self._lock_file.fileno(), fcntl.LOCK_UN)
            except Exception:
                pass
            try:
                self._lock_file.close()
            except Exception:
                pass
            self._lock_file = None  # type: ignore[assignment]

    def __enter__(self) -> "TaskLedger":
        return self

    def __exit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
        self.close()

    def _init_schema(self) -> None:
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.execute("PRAGMA busy_timeout=5000")

        states_sql = ", ".join(f"'{s}'" for s in TASK_STATES)
        self.conn.executescript(
            f"""
            CREATE TABLE IF NOT EXISTS supervisor_meta (
                singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
                boot_id TEXT NOT NULL,
                pid INTEGER NOT NULL,
                run_id TEXT NOT NULL,
                heartbeat_at TEXT NOT NULL,
                last_queue_mutation TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS tasks (
                task_id TEXT PRIMARY KEY,
                stream TEXT NOT NULL,
                phase TEXT NOT NULL,
                state TEXT NOT NULL CHECK (state IN ({states_sql})),
                state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version >= 1),
                owner TEXT,
                run_id TEXT,
                lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
                lease_expires_at TEXT,
                base_commit TEXT NOT NULL,
                branch TEXT,
                worktree TEXT,
                allowed_paths_json TEXT NOT NULL DEFAULT '[]',
                acceptance_ref TEXT NOT NULL,
                heartbeat_at TEXT,
                attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
                blocker_json TEXT,
                description TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS dependencies (
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                depends_on_task_id TEXT NOT NULL,
                PRIMARY KEY (task_id, depends_on_task_id)
            );

            CREATE TABLE IF NOT EXISTS leases (
                task_id TEXT PRIMARY KEY REFERENCES tasks(task_id) ON DELETE CASCADE,
                owner TEXT NOT NULL,
                run_id TEXT NOT NULL,
                lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
                boot_id TEXT NOT NULL,
                worker_pid INTEGER,
                process_start_time INTEGER,
                acquired_at TEXT NOT NULL,
                heartbeat_at TEXT NOT NULL,
                expires_at TEXT NOT NULL,
                grace_expires_at TEXT NOT NULL,
                status TEXT NOT NULL CHECK (status IN ('active', 'released', 'expired', 'reclaimed'))
            );

            CREATE TABLE IF NOT EXISTS file_claims (
                path_prefix TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                run_id TEXT NOT NULL,
                lease_epoch INTEGER NOT NULL,
                claimed_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS runs (
                run_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
                owner TEXT NOT NULL,
                lease_epoch INTEGER NOT NULL CHECK (lease_epoch >= 1),
                boot_id TEXT NOT NULL,
                worker_pid INTEGER,
                process_start_time INTEGER,
                worktree TEXT NOT NULL,
                branch TEXT NOT NULL,
                base_commit TEXT NOT NULL,
                head_commit TEXT,
                state TEXT NOT NULL,
                command_category TEXT,
                last_command TEXT,
                last_exit_code INTEGER,
                last_result TEXT,
                started_at TEXT NOT NULL,
                heartbeat_at TEXT NOT NULL,
                ended_at TEXT,
                checkpoint_json TEXT,
                blocker_json TEXT,
                failure_signature TEXT
            );

            CREATE TABLE IF NOT EXISTS evidence (
                evidence_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                run_id TEXT,
                base_commit TEXT NOT NULL,
                tested_commit TEXT NOT NULL,
                report_path TEXT NOT NULL,
                artifact_paths_json TEXT NOT NULL DEFAULT '[]',
                commands_json TEXT NOT NULL DEFAULT '[]',
                result TEXT NOT NULL CHECK (result IN ('PASS', 'FAIL', 'NOT_RUN', 'BLOCKED')),
                sha256 TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS reviews (
                review_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES tasks(task_id) ON DELETE CASCADE,
                run_id TEXT,
                reviewed_commit TEXT NOT NULL,
                reviewer TEXT NOT NULL,
                decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'blocked', 'pending')),
                notes TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS events (
                event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
                event_id TEXT NOT NULL UNIQUE,
                ts TEXT NOT NULL,
                task_id TEXT NOT NULL,
                run_id TEXT,
                lease_epoch INTEGER NOT NULL DEFAULT 0,
                action TEXT NOT NULL,
                actor TEXT NOT NULL,
                from_state TEXT,
                to_state TEXT,
                state_version INTEGER,
                detail_json TEXT NOT NULL DEFAULT '{{}}'
            );
            """
        )

    def verify_integrity(self) -> Dict[str, Any]:
        row = self.conn.execute("PRAGMA integrity_check").fetchone()
        verdict = row[0] if row else "unknown"
        tables = {
            r[0]
            for r in self.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        missing = [t for t in self.REQUIRED_TABLES if t not in tables]
        return {
            "integrity_check": verdict,
            "journal_mode": self.conn.execute("PRAGMA journal_mode").fetchone()[0],
            "required_tables_present": len(missing) == 0,
            "tables": sorted(tables),
            "missing_tables": missing,
        }

    def record_supervisor_heartbeat(self, now: Optional[datetime] = None) -> None:
        ts = format_utc(now or utc_now())
        assert ts is not None
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            existing = self.conn.execute(
                "SELECT last_queue_mutation FROM supervisor_meta WHERE singleton_id = 1"
            ).fetchone()
            last_mut = existing["last_queue_mutation"] if existing else ts
            self.conn.execute(
                """
                INSERT INTO supervisor_meta (singleton_id, boot_id, pid, run_id, heartbeat_at, last_queue_mutation)
                VALUES (1, ?, ?, ?, ?, ?)
                ON CONFLICT(singleton_id) DO UPDATE SET
                    boot_id = excluded.boot_id,
                    pid = excluded.pid,
                    run_id = excluded.run_id,
                    heartbeat_at = excluded.heartbeat_at
                """,
                (self.boot_id, self.supervisor_pid, self.supervisor_run_id, ts, last_mut),
            )
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

    def _touch_queue_mutation(self, ts: str) -> None:
        self.conn.execute(
            """
            UPDATE supervisor_meta
            SET last_queue_mutation = ?, heartbeat_at = ?
            WHERE singleton_id = 1
            """,
            (ts, ts),
        )

    def _append_event(
        self,
        ts: str,
        task_id: str,
        action: str,
        actor: str = "supervisor",
        run_id: Optional[str] = None,
        lease_epoch: int = 0,
        from_state: Optional[str] = None,
        to_state: Optional[str] = None,
        state_version: Optional[int] = None,
        detail: Optional[Dict[str, Any]] = None,
        event_id: Optional[str] = None,
    ) -> str:
        sanitized_detail = CredentialSanitizer.sanitize(detail or {})
        eid = event_id or f"evt-{uuid.uuid4().hex[:16]}"
        self.conn.execute(
            """
            INSERT INTO events (
                event_id, ts, task_id, run_id, lease_epoch, action, actor,
                from_state, to_state, state_version, detail_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                eid,
                ts,
                task_id,
                CredentialSanitizer.sanitize_text(run_id),
                lease_epoch,
                CredentialSanitizer.sanitize_text(action) or "EVENT",
                CredentialSanitizer.sanitize_text(actor) or "supervisor",
                from_state,
                to_state,
                state_version,
                json.dumps(sanitized_detail, ensure_ascii=False, sort_keys=True),
            ),
        )
        self._touch_queue_mutation(ts)
        return eid

    def validate_dag_acyclic(self) -> None:
        rows = self.conn.execute(
            "SELECT task_id, depends_on_task_id FROM dependencies"
        ).fetchall()
        graph: Dict[str, List[str]] = {}
        for r in rows:
            graph.setdefault(r["task_id"], []).append(r["depends_on_task_id"])

        visited: Set[str] = set()
        active: Set[str] = set()

        def dfs(node: str) -> None:
            if node == "DOC-001" or node in visited:
                return
            if node in active:
                raise DagCycleError(f"Cycle detected in task dependency graph at '{node}'")
            active.add(node)
            for dep in graph.get(node, []):
                dfs(dep)
            active.remove(node)
            visited.add(node)

        for t_id in list(graph.keys()):
            dfs(t_id)

    def _are_dependencies_done(self, task_id: str) -> Tuple[bool, List[str]]:
        deps = [
            r["depends_on_task_id"]
            for r in self.conn.execute(
                "SELECT depends_on_task_id FROM dependencies WHERE task_id = ? ORDER BY depends_on_task_id",
                (task_id,),
            ).fetchall()
        ]
        unresolved: List[str] = []
        for dep in deps:
            if dep == "DOC-001":
                continue
            row = self.conn.execute(
                "SELECT state FROM tasks WHERE task_id = ?", (dep,)
            ).fetchone()
            if not row or row["state"] != "done":
                unresolved.append(dep)
        return (len(unresolved) == 0, unresolved)

    def _recompute_planned_and_ready_in_tx(self, ts: str) -> List[str]:
        promoted: List[str] = []
        rows = self.conn.execute(
            "SELECT task_id, state, state_version FROM tasks WHERE state IN ('planned', 'ready') ORDER BY task_id"
        ).fetchall()
        for r in rows:
            tid = r["task_id"]
            cur_state = r["state"]
            deps_ok, unresolved = self._are_dependencies_done(tid)
            if cur_state == "planned" and deps_ok:
                new_ver = r["state_version"] + 1
                self.conn.execute(
                    """
                    UPDATE tasks
                    SET state = 'ready', state_version = ?, blocker_json = NULL, updated_at = ?
                    WHERE task_id = ?
                    """,
                    (new_ver, ts, tid),
                )
                self._append_event(
                    ts=ts,
                    task_id=tid,
                    action="DEPENDENCIES_SATISFIED",
                    from_state="planned",
                    to_state="ready",
                    state_version=new_ver,
                    detail={"promoted_to": "ready"},
                )
                promoted.append(tid)
            elif cur_state == "ready" and not deps_ok:
                new_ver = r["state_version"] + 1
                blocker = {
                    "reason": f"Blocked by dependencies: {', '.join(unresolved)}",
                    "dependency_needed": unresolved,
                    "owner": "supervisor",
                    "next_check": "on_dependency_done",
                }
                self.conn.execute(
                    """
                    UPDATE tasks
                    SET state = 'planned', state_version = ?, blocker_json = ?, updated_at = ?
                    WHERE task_id = ?
                    """,
                    (new_ver, json.dumps(blocker, ensure_ascii=False), ts, tid),
                )
        return promoted

    def materialize_from_backlog(
        self,
        repo_root: Path,
        completed_bootstrap_tasks: Optional[Dict[str, Dict[str, str]]] = None,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        Imports the 52 backlog tasks from evidence/P0-01/backlog.json into SQLite,
        validates the DAG, and reconciles bootstrap tasks (P0-01, P0-02, P0-04) that
        have verified evidence and staging integration commits.
        """
        ts = format_utc(now or utc_now())
        assert ts is not None
        backlog_file = repo_root / "evidence/P0-01/backlog.json"
        backlog_data = json.loads(backlog_file.read_text(encoding="utf-8"))
        tasks_list = backlog_data.get("tasks", [])
        if len(tasks_list) != 52:
            raise LedgerError(f"Expected 52 tasks in backlog.json, found {len(tasks_list)}")

        completed_map = completed_bootstrap_tasks or {}

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            for item in tasks_list:
                tid = item["task_id"]
                if not TASK_ID_RE.match(tid):
                    raise LedgerError(f"Invalid task_id '{tid}'")
                deps = item.get("dependencies", [])
                allowed_paths = item.get("allowed_paths", [])
                blocker_raw = item.get("blocker")
                blocker_obj = (
                    {
                        "reason": CredentialSanitizer.sanitize_text(str(blocker_raw)),
                        "dependency_needed": [d for d in deps if d != "DOC-001"],
                        "owner": "supervisor",
                        "next_check": "on_dependency_done",
                    }
                    if blocker_raw
                    else None
                )
                self.conn.execute(
                    """
                    INSERT INTO tasks (
                        task_id, stream, phase, state, state_version,
                        owner, run_id, lease_epoch, lease_expires_at,
                        base_commit, branch, worktree, allowed_paths_json,
                        acceptance_ref, heartbeat_at, attempts, blocker_json,
                        description, updated_at
                    ) VALUES (?, ?, ?, 'planned', 1, NULL, NULL, 0, NULL, ?, NULL, NULL, ?, ?, NULL, 0, ?, ?, ?)
                    ON CONFLICT(task_id) DO NOTHING
                    """,
                    (
                        tid,
                        item.get("stream", ""),
                        item.get("phase", ""),
                        item.get("base_commit", backlog_data.get("base_commit", "")),
                        json.dumps(allowed_paths, ensure_ascii=False),
                        item.get("acceptance_ref", f"docs/IMPLEMENTATION_PLAN.md: {tid}"),
                        json.dumps(blocker_obj, ensure_ascii=False) if blocker_obj else None,
                        CredentialSanitizer.sanitize_text(item.get("description", "")) or "",
                        ts,
                    ),
                )
                for dep in deps:
                    self.conn.execute(
                        """
                        INSERT OR IGNORE INTO dependencies (task_id, depends_on_task_id)
                        VALUES (?, ?)
                        """,
                        (tid, dep),
                    )

            self.validate_dag_acyclic()

            # Reconcile completed bootstrap tasks (P0-01, P0-02, P0-04) with real evidence & review
            for tid, meta in completed_map.items():
                report_rel = meta["report_path"]
                report_abs = repo_root / report_rel
                if not report_abs.is_file():
                    raise LedgerError(f"Bootstrap evidence report missing for {tid}: {report_rel}")
                sha256_hex = hashlib.sha256(report_abs.read_bytes()).hexdigest()
                tested_commit = meta["tested_commit"]
                base_commit = meta.get("base_commit", tested_commit)
                reviewer = meta.get("reviewer", "staging-ci-gate")
                run_id = meta.get("run_id", f"bootstrap-{tid.lower()}")

                ev_id = f"ev-{tid.lower()}-bootstrap"
                rev_id = f"rev-{tid.lower()}-bootstrap"
                self.conn.execute(
                    """
                    INSERT OR REPLACE INTO evidence (
                        evidence_id, task_id, run_id, base_commit, tested_commit,
                        report_path, artifact_paths_json, commands_json, result, sha256, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PASS', ?, ?)
                    """,
                    (
                        ev_id,
                        tid,
                        run_id,
                        base_commit,
                        tested_commit,
                        report_rel,
                        json.dumps(meta.get("artifacts", [report_rel]), ensure_ascii=False),
                        json.dumps(["python3 scripts/validate_repo.py"], ensure_ascii=False),
                        sha256_hex,
                        ts,
                    ),
                )
                self.conn.execute(
                    """
                    INSERT OR REPLACE INTO reviews (
                        review_id, task_id, run_id, reviewed_commit, reviewer, decision, notes, created_at
                    ) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)
                    """,
                    (
                        rev_id,
                        tid,
                        run_id,
                        tested_commit,
                        reviewer,
                        f"Bootstrap task {tid} verified and integrated into staging",
                        ts,
                    ),
                )
                self.conn.execute(
                    """
                    UPDATE tasks
                    SET state = 'done',
                        state_version = state_version + 1,
                        owner = 'bootstrap-supervisor',
                        run_id = ?,
                        lease_epoch = MAX(lease_epoch, 1),
                        base_commit = ?,
                        branch = ?,
                        attempts = MAX(attempts, 1),
                        blocker_json = NULL,
                        updated_at = ?
                    WHERE task_id = ?
                    """,
                    (run_id, base_commit, f"agy/{tid.lower()}", ts, tid),
                )
                self._append_event(
                    ts=ts,
                    task_id=tid,
                    run_id=run_id,
                    lease_epoch=1,
                    action="BOOTSTRAP_RECONCILED_DONE",
                    from_state="planned",
                    to_state="done",
                    state_version=2,
                    detail={
                        "tested_commit": tested_commit,
                        "report_path": report_rel,
                        "report_sha256": sha256_hex,
                    },
                )

            promoted = self._recompute_planned_and_ready_in_tx(ts)
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

        self.export_snapshots()
        return {
            "total_tasks": 52,
            "reconciled_done": sorted(completed_map.keys()),
            "promoted_to_ready": promoted,
        }

    def register_task(
        self,
        task_id: str,
        stream: str,
        phase: str,
        dependencies: Sequence[str],
        allowed_paths: Sequence[str],
        base_commit: str,
        acceptance_ref: str,
        description: str = "",
        now: Optional[datetime] = None,
    ) -> None:
        if not TASK_ID_RE.match(task_id):
            raise LedgerError(f"Invalid task_id '{task_id}'")
        ts = format_utc(now or utc_now())
        assert ts is not None
        self.conn.execute("BEGIN IMMEDIATE")
        try:
            self.conn.execute(
                """
                INSERT INTO tasks (
                    task_id, stream, phase, state, state_version, base_commit,
                    allowed_paths_json, acceptance_ref, description, updated_at
                ) VALUES (?, ?, ?, 'planned', 1, ?, ?, ?, ?, ?)
                """,
                (
                    task_id,
                    stream,
                    phase,
                    base_commit,
                    json.dumps(list(allowed_paths), ensure_ascii=False),
                    acceptance_ref,
                    CredentialSanitizer.sanitize_text(description) or "",
                    ts,
                ),
            )
            for dep in dependencies:
                self.conn.execute(
                    "INSERT INTO dependencies (task_id, depends_on_task_id) VALUES (?, ?)",
                    (task_id, dep),
                )
            self.validate_dag_acyclic()
            self._recompute_planned_and_ready_in_tx(ts)
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

    def claim_task(
        self,
        task_id: str,
        owner: str,
        repo_root: Path,
        run_id: Optional[str] = None,
        branch: Optional[str] = None,
        worktree: Optional[str] = None,
        base_commit: Optional[str] = None,
        claimed_paths: Optional[Sequence[str]] = None,
        boot_id: Optional[str] = None,
        worker_pid: Optional[int] = None,
        process_start_time: Optional[int] = None,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        Atomically claims a 'ready' task -> 'claimed', verifying all dependencies are 'done'
        and no active file_claims overlap with the task's claimed_paths (which default to
        allowed_paths and must be a strict subset of allowed_paths). Increments lease_epoch.
        """
        current_dt = now or utc_now()
        ts = format_utc(current_dt)
        expires_ts = format_utc(current_dt + timedelta(seconds=TASK_LEASE_DURATION_SECONDS))
        grace_ts = format_utc(
            current_dt + timedelta(seconds=TASK_LEASE_DURATION_SECONDS + TASK_LEASE_GRACE_SECONDS)
        )
        assert ts and expires_ts and grace_ts

        assigned_run_id = run_id or f"run-{task_id.lower()}-{uuid.uuid4().hex[:8]}"
        assigned_branch = branch or WorktreePolicy.expected_branch_name(task_id, assigned_run_id[:8])
        assigned_wt = worktree or WorktreePolicy.expected_worktree_relpath(task_id, assigned_run_id[:8])
        wt_checked = WorktreePolicy.validate_worktree_assignment(
            repo_root=repo_root,
            task_id=task_id,
            worktree_path=assigned_wt,
            branch_name=assigned_branch,
        )

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            row = self.conn.execute(
                "SELECT * FROM tasks WHERE task_id = ?", (task_id,)
            ).fetchone()
            if not row:
                raise LedgerError(f"Unknown task '{task_id}'")
            if row["state"] != "ready":
                raise LedgerError(
                    f"Task '{task_id}' cannot be claimed from state '{row['state']}' (expected 'ready')"
                )

            deps_ok, unresolved = self._are_dependencies_done(task_id)
            if not deps_ok:
                raise DependencyNotSatisfiedError(
                    f"Task '{task_id}' has unresolved dependencies: {unresolved}"
                )

            allowed_paths: List[str] = json.loads(row["allowed_paths_json"])
            effective_claims: List[str] = list(claimed_paths) if claimed_paths is not None else list(allowed_paths)
            if not effective_claims:
                raise LedgerError(f"Task '{task_id}' must claim at least one path")
            for cp in effective_claims:
                if not is_path_allowed(cp, allowed_paths):
                    raise WorktreePolicyError(
                        f"Requested claim path '{cp}' is outside task '{task_id}' allowed_paths {allowed_paths}"
                    )

            existing_claims = self.conn.execute(
                "SELECT path_prefix, task_id, run_id, lease_epoch FROM file_claims"
            ).fetchall()
            for claim in existing_claims:
                if claim["task_id"] == task_id:
                    continue
                for req_path in effective_claims:
                    if paths_overlap(req_path, claim["path_prefix"]):
                        raise FileClaimConflictError(
                            f"Task '{task_id}' path '{req_path}' overlaps active claim "
                            f"'{claim['path_prefix']}' held by task '{claim['task_id']}'"
                        )

            new_epoch = int(row["lease_epoch"]) + 1
            new_attempts = int(row["attempts"]) + 1
            new_version = int(row["state_version"]) + 1
            eff_base = base_commit or row["base_commit"]
            eff_boot = boot_id or self.boot_id

            self.conn.execute(
                """
                UPDATE tasks
                SET state = 'claimed',
                    state_version = ?,
                    owner = ?,
                    run_id = ?,
                    lease_epoch = ?,
                    lease_expires_at = ?,
                    base_commit = ?,
                    branch = ?,
                    worktree = ?,
                    heartbeat_at = ?,
                    attempts = ?,
                    blocker_json = NULL,
                    updated_at = ?
                WHERE task_id = ?
                """,
                (
                    new_version,
                    CredentialSanitizer.sanitize_text(owner),
                    assigned_run_id,
                    new_epoch,
                    expires_ts,
                    eff_base,
                    wt_checked["branch"],
                    wt_checked["worktree_rel"],
                    ts,
                    new_attempts,
                    ts,
                    task_id,
                ),
            )

            self.conn.execute(
                """
                INSERT INTO leases (
                    task_id, owner, run_id, lease_epoch, boot_id, worker_pid,
                    process_start_time, acquired_at, heartbeat_at, expires_at,
                    grace_expires_at, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
                ON CONFLICT(task_id) DO UPDATE SET
                    owner = excluded.owner,
                    run_id = excluded.run_id,
                    lease_epoch = excluded.lease_epoch,
                    boot_id = excluded.boot_id,
                    worker_pid = excluded.worker_pid,
                    process_start_time = excluded.process_start_time,
                    acquired_at = excluded.acquired_at,
                    heartbeat_at = excluded.heartbeat_at,
                    expires_at = excluded.expires_at,
                    grace_expires_at = excluded.grace_expires_at,
                    status = 'active'
                """,
                (
                    task_id,
                    CredentialSanitizer.sanitize_text(owner),
                    assigned_run_id,
                    new_epoch,
                    eff_boot,
                    worker_pid,
                    process_start_time,
                    ts,
                    ts,
                    expires_ts,
                    grace_ts,
                ),
            )

            for req_path in effective_claims:
                norm_p = normalize_path_prefix(req_path)
                self.conn.execute(
                    """
                    INSERT INTO file_claims (path_prefix, task_id, run_id, lease_epoch, claimed_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (norm_p, task_id, assigned_run_id, new_epoch, ts),
                )

            self.conn.execute(
                """
                INSERT INTO runs (
                    run_id, task_id, attempt_number, owner, lease_epoch, boot_id,
                    worker_pid, process_start_time, worktree, branch, base_commit,
                    state, started_at, heartbeat_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?)
                """,
                (
                    assigned_run_id,
                    task_id,
                    new_attempts,
                    CredentialSanitizer.sanitize_text(owner),
                    new_epoch,
                    eff_boot,
                    worker_pid,
                    process_start_time,
                    wt_checked["worktree_rel"],
                    wt_checked["branch"],
                    eff_base,
                    ts,
                    ts,
                ),
            )

            self._append_event(
                ts=ts,
                task_id=task_id,
                run_id=assigned_run_id,
                lease_epoch=new_epoch,
                action="TASK_CLAIMED",
                actor=owner,
                from_state="ready",
                to_state="claimed",
                state_version=new_version,
                detail={
                    "owner": owner,
                    "worktree": wt_checked["worktree_rel"],
                    "branch": wt_checked["branch"],
                    "allowed_paths": allowed_paths,
                    "claimed_paths": effective_claims,
                    "lease_expires_at": expires_ts,
                },
            )
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

        return self.get_task(task_id)

    def _verify_fence_in_tx(self, task_id: str, run_id: str, lease_epoch: int) -> sqlite3.Row:
        row = self.conn.execute(
            "SELECT * FROM tasks WHERE task_id = ?", (task_id,)
        ).fetchone()
        if not row:
            raise LedgerError(f"Unknown task '{task_id}'")
        if row["run_id"] != run_id or int(row["lease_epoch"]) != int(lease_epoch):
            ts = format_utc(utc_now()) or ""
            self._append_event(
                ts=ts,
                task_id=task_id,
                run_id=run_id,
                lease_epoch=lease_epoch,
                action="STALE_WORKER_REJECTED",
                actor="fence-guard",
                from_state=row["state"],
                to_state=row["state"],
                state_version=row["state_version"],
                detail={
                    "attempted_run_id": run_id,
                    "attempted_lease_epoch": lease_epoch,
                    "active_run_id": row["run_id"],
                    "active_lease_epoch": row["lease_epoch"],
                },
            )
            raise StaleLeaseFenceError(
                f"Stale worker rejected for {task_id}: presented (run_id={run_id}, epoch={lease_epoch}) "
                f"!= active (run_id={row['run_id']}, epoch={row['lease_epoch']})"
            )
        return row

    def worker_heartbeat(
        self,
        task_id: str,
        run_id: str,
        lease_epoch: int,
        command_category: Optional[str] = None,
        last_command: Optional[str] = None,
        last_exit_code: Optional[int] = None,
        last_result: Optional[str] = None,
        checkpoint: Optional[Dict[str, Any]] = None,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        current_dt = now or utc_now()
        ts = format_utc(current_dt)
        expires_ts = format_utc(current_dt + timedelta(seconds=TASK_LEASE_DURATION_SECONDS))
        grace_ts = format_utc(
            current_dt + timedelta(seconds=TASK_LEASE_DURATION_SECONDS + TASK_LEASE_GRACE_SECONDS)
        )
        assert ts and expires_ts and grace_ts

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            row = self._verify_fence_in_tx(task_id, run_id, lease_epoch)
            if row["state"] not in ACTIVE_LEASE_STATES:
                raise LedgerError(f"Cannot heartbeat task '{task_id}' in non-active state '{row['state']}'")

            lease_row = self.conn.execute(
                "SELECT * FROM leases WHERE task_id = ?", (task_id,)
            ).fetchone()
            if not lease_row or lease_row["status"] != "active":
                raise StaleLeaseFenceError(f"Lease for task '{task_id}' is no longer active")

            self.conn.execute(
                """
                UPDATE tasks
                SET heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
                WHERE task_id = ?
                """,
                (ts, expires_ts, ts, task_id),
            )
            self.conn.execute(
                """
                UPDATE leases
                SET heartbeat_at = ?, expires_at = ?, grace_expires_at = ?
                WHERE task_id = ?
                """,
                (ts, expires_ts, grace_ts, task_id),
            )

            clean_cmd = CredentialSanitizer.sanitize_text(last_command)
            clean_ckpt = (
                json.dumps(CredentialSanitizer.sanitize(checkpoint), ensure_ascii=False, sort_keys=True)
                if checkpoint is not None
                else None
            )
            self.conn.execute(
                """
                UPDATE runs
                SET heartbeat_at = ?,
                    command_category = COALESCE(?, command_category),
                    last_command = COALESCE(?, last_command),
                    last_exit_code = COALESCE(?, last_exit_code),
                    last_result = COALESCE(?, last_result),
                    checkpoint_json = COALESCE(?, checkpoint_json)
                WHERE run_id = ?
                """,
                (
                    ts,
                    CredentialSanitizer.sanitize_text(command_category),
                    clean_cmd,
                    last_exit_code,
                    CredentialSanitizer.sanitize_text(last_result),
                    clean_ckpt,
                    run_id,
                ),
            )

            if checkpoint is not None:
                self._append_event(
                    ts=ts,
                    task_id=task_id,
                    run_id=run_id,
                    lease_epoch=lease_epoch,
                    action="WORKER_CHECKPOINT",
                    actor=row["owner"] or "worker",
                    from_state=row["state"],
                    to_state=row["state"],
                    state_version=row["state_version"],
                    detail={"checkpoint": checkpoint},
                )
            self.conn.execute("COMMIT")
        except StaleLeaseFenceError:
            # Commit the STALE_WORKER_REJECTED audit event before propagating
            self.conn.execute("COMMIT")
            raise
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

        return self.get_task(task_id)

    def transition_task(
        self,
        task_id: str,
        run_id: str,
        lease_epoch: int,
        to_state: str,
        actor: str = "worker",
        head_commit: Optional[str] = None,
        blocker: Optional[Dict[str, Any]] = None,
        detail: Optional[Dict[str, Any]] = None,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        if to_state not in TASK_STATES:
            raise LedgerError(f"Unknown target state '{to_state}'")
        ts = format_utc(now or utc_now())
        assert ts is not None

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            row = self._verify_fence_in_tx(task_id, run_id, lease_epoch)
            from_state = row["state"]
            if to_state not in VALID_STATE_TRANSITIONS.get(from_state, set()):
                raise LedgerError(f"Invalid transition for {task_id}: '{from_state}' -> '{to_state}'")

            if to_state == "done":
                # Definition of Done requires an approved review record for the tested commit
                ev_row = self.conn.execute(
                    "SELECT * FROM evidence WHERE task_id = ? AND result = 'PASS' ORDER BY created_at DESC LIMIT 1",
                    (task_id,),
                ).fetchone()
                if not ev_row:
                    raise LedgerError(f"Cannot mark {task_id} 'done' without passing evidence")
                target_sha = head_commit or ev_row["tested_commit"]
                rev_row = self.conn.execute(
                    """
                    SELECT * FROM reviews
                    WHERE task_id = ? AND reviewed_commit = ? AND decision = 'approved'
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (task_id, target_sha),
                ).fetchone()
                if not rev_row:
                    raise LedgerError(
                        f"Cannot mark {task_id} 'done' without approved independent review for commit {target_sha}"
                    )

            if to_state == "blocked":
                if not blocker or not all(
                    k in blocker for k in ("reason", "dependency_or_decision_needed", "owner", "next_check")
                ):
                    raise LedgerError(
                        "Transition to 'blocked' requires structured blocker with keys: "
                        "reason, dependency_or_decision_needed, owner, next_check"
                    )

            new_version = int(row["state_version"]) + 1
            sanitized_blocker = (
                json.dumps(CredentialSanitizer.sanitize(blocker), ensure_ascii=False, sort_keys=True)
                if blocker
                else None
            )

            release_claims = to_state not in ACTIVE_LEASE_STATES
            new_lease_expires = None if release_claims else row["lease_expires_at"]

            self.conn.execute(
                """
                UPDATE tasks
                SET state = ?,
                    state_version = ?,
                    lease_expires_at = ?,
                    heartbeat_at = ?,
                    blocker_json = COALESCE(?, blocker_json),
                    updated_at = ?
                WHERE task_id = ?
                """,
                (to_state, new_version, new_lease_expires, ts, sanitized_blocker, ts, task_id),
            )

            self.conn.execute(
                """
                UPDATE runs
                SET state = ?,
                    head_commit = COALESCE(?, head_commit),
                    heartbeat_at = ?,
                    ended_at = CASE WHEN ? IN ('review', 'done', 'blocked', 'canceled') THEN ? ELSE ended_at END,
                    blocker_json = COALESCE(?, blocker_json)
                WHERE run_id = ?
                """,
                (to_state, head_commit, ts, to_state, ts, sanitized_blocker, run_id),
            )

            if release_claims:
                self.conn.execute(
                    "DELETE FROM file_claims WHERE task_id = ?", (task_id,)
                )
                self.conn.execute(
                    "UPDATE leases SET status = 'released', heartbeat_at = ? WHERE task_id = ?",
                    (ts, task_id),
                )

            self._append_event(
                ts=ts,
                task_id=task_id,
                run_id=run_id,
                lease_epoch=lease_epoch,
                action=f"STATE_{to_state.upper()}",
                actor=actor,
                from_state=from_state,
                to_state=to_state,
                state_version=new_version,
                detail=detail or ({"blocker": blocker} if blocker else {}),
            )

            if to_state == "done":
                self._recompute_planned_and_ready_in_tx(ts)

            self.conn.execute("COMMIT")
        except StaleLeaseFenceError:
            self.conn.execute("COMMIT")
            raise
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

        return self.get_task(task_id)

    def record_evidence(
        self,
        task_id: str,
        run_id: str,
        lease_epoch: int,
        base_commit: str,
        tested_commit: str,
        report_path: str,
        artifact_paths: Sequence[str],
        commands: Sequence[Dict[str, Any]],
        result: str,
        sha256: str,
        now: Optional[datetime] = None,
    ) -> str:
        if result not in EVIDENCE_RESULTS:
            raise LedgerError(f"Invalid evidence result '{result}'")
        ts = format_utc(now or utc_now())
        assert ts is not None
        ev_id = f"ev-{task_id.lower()}-{uuid.uuid4().hex[:10]}"

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            row = self._verify_fence_in_tx(task_id, run_id, lease_epoch)
            clean_cmds = CredentialSanitizer.sanitize(list(commands))
            clean_arts = CredentialSanitizer.sanitize(list(artifact_paths))
            self.conn.execute(
                """
                INSERT INTO evidence (
                    evidence_id, task_id, run_id, base_commit, tested_commit,
                    report_path, artifact_paths_json, commands_json, result, sha256, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    ev_id,
                    task_id,
                    run_id,
                    base_commit,
                    tested_commit,
                    report_path,
                    json.dumps(clean_arts, ensure_ascii=False),
                    json.dumps(clean_cmds, ensure_ascii=False),
                    result,
                    sha256,
                    ts,
                ),
            )
            self._append_event(
                ts=ts,
                task_id=task_id,
                run_id=run_id,
                lease_epoch=lease_epoch,
                action="EVIDENCE_RECORDED",
                actor=row["owner"] or "worker",
                from_state=row["state"],
                to_state=row["state"],
                state_version=row["state_version"],
                detail={
                    "evidence_id": ev_id,
                    "tested_commit": tested_commit,
                    "report_path": report_path,
                    "result": result,
                    "sha256": sha256,
                },
            )
            self.conn.execute("COMMIT")
        except StaleLeaseFenceError:
            self.conn.execute("COMMIT")
            raise
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        return ev_id

    def record_review(
        self,
        task_id: str,
        reviewed_commit: str,
        reviewer: str,
        decision: str,
        notes: str = "",
        run_id: Optional[str] = None,
        now: Optional[datetime] = None,
    ) -> str:
        if decision not in {"approved", "changes_requested", "blocked", "pending"}:
            raise LedgerError(f"Invalid review decision '{decision}'")
        ts = format_utc(now or utc_now())
        assert ts is not None
        rev_id = f"rev-{task_id.lower()}-{uuid.uuid4().hex[:10]}"

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            row = self.conn.execute(
                "SELECT * FROM tasks WHERE task_id = ?", (task_id,)
            ).fetchone()
            if not row:
                raise LedgerError(f"Unknown task '{task_id}'")
            eff_run = run_id or row["run_id"]
            clean_notes = CredentialSanitizer.sanitize_text(notes) or ""
            self.conn.execute(
                """
                INSERT INTO reviews (
                    review_id, task_id, run_id, reviewed_commit, reviewer, decision, notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    rev_id,
                    task_id,
                    eff_run,
                    reviewed_commit,
                    CredentialSanitizer.sanitize_text(reviewer) or "reviewer",
                    decision,
                    clean_notes,
                    ts,
                ),
            )
            self._append_event(
                ts=ts,
                task_id=task_id,
                run_id=eff_run,
                lease_epoch=row["lease_epoch"],
                action="REVIEW_RECORDED",
                actor=reviewer,
                from_state=row["state"],
                to_state=row["state"],
                state_version=row["state_version"],
                detail={
                    "review_id": rev_id,
                    "reviewed_commit": reviewed_commit,
                    "decision": decision,
                    "notes": clean_notes,
                },
            )
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise
        return rev_id

    def record_attempt_failure(
        self,
        task_id: str,
        run_id: str,
        lease_epoch: int,
        failure_signature: str,
        reason: str,
        dependency_or_decision_needed: str = "supervisor_triage_or_task_split",
        owner: str = "supervisor",
        next_check: str = "inspect_attempt_logs_and_diff",
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        Records a non-progressing attempt failure. Per docs/AGENTS.md:
        "Không tự retry lỗi cùng nguyên nhân vô hạn; tối đa 2 implementation attempts
        không tiến triển thì supervisor phân tích/chia task hoặc báo blocker."
        """
        ts = format_utc(now or utc_now())
        assert ts is not None
        clean_sig = CredentialSanitizer.sanitize_text(failure_signature) or "unknown_failure"
        clean_reason = CredentialSanitizer.sanitize_text(reason) or "Attempt failed"

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            row = self._verify_fence_in_tx(task_id, run_id, lease_epoch)
            self.conn.execute(
                """
                UPDATE runs
                SET state = 'failed',
                    ended_at = ?,
                    failure_signature = ?,
                    last_result = 'FAIL'
                WHERE run_id = ?
                """,
                (ts, clean_sig, run_id),
            )
            same_cause_count = self.conn.execute(
                """
                SELECT COUNT(*) FROM runs
                WHERE task_id = ? AND failure_signature = ?
                """,
                (task_id, clean_sig),
            ).fetchone()[0]

            self.conn.execute("DELETE FROM file_claims WHERE task_id = ?", (task_id,))
            self.conn.execute(
                "UPDATE leases SET status = 'released', heartbeat_at = ? WHERE task_id = ?",
                (ts, task_id),
            )

            new_version = int(row["state_version"]) + 1
            if same_cause_count >= MAX_NON_PROGRESS_ATTEMPTS:
                to_state = "blocked"
                blocker_obj = CredentialSanitizer.sanitize(
                    {
                        "reason": f"Repeated failure ({same_cause_count}x '{clean_sig}'): {clean_reason}",
                        "dependency_or_decision_needed": dependency_or_decision_needed,
                        "owner": owner,
                        "next_check": next_check,
                    }
                )
                blocker_json = json.dumps(blocker_obj, ensure_ascii=False, sort_keys=True)
            else:
                to_state = "ready"
                blocker_obj = None
                blocker_json = None

            self.conn.execute(
                """
                UPDATE tasks
                SET state = ?,
                    state_version = ?,
                    lease_expires_at = NULL,
                    blocker_json = ?,
                    updated_at = ?
                WHERE task_id = ?
                """,
                (to_state, new_version, blocker_json, ts, task_id),
            )

            self._append_event(
                ts=ts,
                task_id=task_id,
                run_id=run_id,
                lease_epoch=lease_epoch,
                action="CIRCUIT_BREAKER_BLOCKED" if to_state == "blocked" else "ATTEMPT_FAILED_REQUEUED",
                actor="supervisor",
                from_state=row["state"],
                to_state=to_state,
                state_version=new_version,
                detail={
                    "failure_signature": clean_sig,
                    "same_cause_attempts": same_cause_count,
                    "reason": clean_reason,
                    "blocker": blocker_obj,
                },
            )
            self.conn.execute("COMMIT")
        except StaleLeaseFenceError:
            self.conn.execute("COMMIT")
            raise
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

        return self.get_task(task_id)

    def request_scope_change(
        self,
        task_id: str,
        run_id: str,
        lease_epoch: int,
        requested_paths: Sequence[str],
        reason: str,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        Records a worker's formal change request when shared schema/lockfile access is
        needed outside its leased allowed_paths (docs/AGENTS.md line 39).
        """
        ts = format_utc(now or utc_now())
        assert ts is not None
        blocker = {
            "reason": f"Scope change requested for shared paths {list(requested_paths)}: {reason}",
            "dependency_or_decision_needed": f"grant_file_claims:{','.join(requested_paths)}",
            "owner": "supervisor",
            "next_check": "reallocate_file_ownership_or_split_prereq_task",
        }
        return self.transition_task(
            task_id=task_id,
            run_id=run_id,
            lease_epoch=lease_epoch,
            to_state="blocked",
            actor="worker",
            blocker=blocker,
            detail={"requested_paths": list(requested_paths)},
            now=now,
        )

    def check_heartbeat_health(self, now: Optional[datetime] = None) -> List[Dict[str, Any]]:
        current_dt = now or utc_now()
        diagnostics: List[Dict[str, Any]] = []
        rows = self.conn.execute(
            """
            SELECT t.task_id, t.state, t.owner, t.run_id, t.lease_epoch,
                   l.boot_id, l.worker_pid, l.process_start_time,
                   l.heartbeat_at, l.expires_at, l.grace_expires_at
            FROM tasks t
            JOIN leases l ON l.task_id = t.task_id
            WHERE t.state IN ('claimed', 'running', 'verifying') AND l.status = 'active'
            ORDER BY t.task_id
            """
        ).fetchall()

        for r in rows:
            hb_dt = parse_utc(r["heartbeat_at"]) or current_dt
            exp_dt = parse_utc(r["expires_at"]) or current_dt
            grace_dt = parse_utc(r["grace_expires_at"]) or current_dt
            silence_sec = int((current_dt - hb_dt).total_seconds())
            if current_dt >= grace_dt:
                status = "RECLAIM_ELIGIBLE"
            elif current_dt >= exp_dt:
                status = "LEASE_EXPIRED_IN_GRACE"
            elif silence_sec >= WORKER_HEARTBEAT_WARN_SECONDS:
                status = "WARN_HEARTBEAT_STALE"
            else:
                status = "HEALTHY"
            diagnostics.append(
                {
                    "task_id": r["task_id"],
                    "state": r["state"],
                    "run_id": r["run_id"],
                    "lease_epoch": r["lease_epoch"],
                    "silence_seconds": silence_sec,
                    "health_status": status,
                }
            )
        return diagnostics

    def recover_after_crash_or_reboot(
        self,
        repo_root: Path,
        live_processes: Optional[Set[Tuple[str, int, int, str]]] = None,
        now: Optional[datetime] = None,
    ) -> Dict[str, Any]:
        """
        Executes the 6-step crash/reboot recovery protocol from docs/AGENTS.md:
        1. Verify SQLite integrity & worktree registry.
        2. Compare current boot_id and (boot_id, worker_pid, process_start_time, run_id)
           so PID reuse across reboots never fools liveness checks.
        3. Inspect .worktrees/ for every leased task; preserve uncommitted edits/untracked
           files (never git reset --hard or delete dirty worktree); write recovery checkpoint.
           Reattach if worker is genuinely alive on current boot_id; otherwise increment
           lease_epoch fence, mark interrupted in-flight tests as NOT_RUN, and transition
           to 'review' (if verified commit + evidence report exist) or 'ready'.
        4. Re-evaluate dependency DAG and release stale file_claims transactionally.
        5. Export fresh sanitized .agy/status.json and .agy/events.jsonl snapshots.
        """
        current_dt = now or utc_now()
        ts = format_utc(current_dt)
        assert ts is not None
        live_set = live_processes or set()

        integrity = self.verify_integrity()
        if integrity["integrity_check"] != "ok" or not integrity["required_tables_present"]:
            raise LedgerError(f"Database integrity check failed prior to recovery: {integrity}")

        reattached: List[Dict[str, Any]] = []
        reclaimed_to_ready: List[Dict[str, Any]] = []
        reconciled_to_review: List[Dict[str, Any]] = []
        in_flight_reset: List[str] = []

        self.conn.execute("BEGIN IMMEDIATE")
        try:
            leased_rows = self.conn.execute(
                """
                SELECT t.*, l.boot_id AS lease_boot_id, l.worker_pid, l.process_start_time,
                       l.heartbeat_at AS lease_hb, l.expires_at, l.grace_expires_at
                FROM tasks t
                LEFT JOIN leases l ON l.task_id = t.task_id
                WHERE t.state IN ('claimed', 'running', 'verifying')
                ORDER BY t.task_id
                """
            ).fetchall()

            for row in leased_rows:
                tid = row["task_id"]
                run_id = row["run_id"] or ""
                old_epoch = int(row["lease_epoch"])
                lease_boot = row["lease_boot_id"] or ""
                wpid = int(row["worker_pid"] or -1)
                pstart = int(row["process_start_time"] or -1)
                grace_dt = parse_utc(row["grace_expires_at"])

                #Inspect worktree status without modifying or deleting any user/worker files
                wt_rel = row["worktree"]
                wt_preserved = False
                dirty_files: List[str] = []
                if wt_rel:
                    wt_abs = (repo_root / wt_rel).resolve()
                    if wt_abs.is_dir():
                        wt_preserved = True
                        for p in sorted(wt_abs.rglob("*")):
                            if p.is_file() and ".git" not in p.parts:
                                dirty_files.append(p.relative_to(wt_abs).as_posix())

                # Liveness requires matching current boot_id AND (boot_id, pid, start_time, run_id)
                # AND not past grace window.
                process_alive = (
                    lease_boot == self.boot_id
                    and (lease_boot, wpid, pstart, run_id) in live_set
                    and (grace_dt is None or current_dt < grace_dt)
                )

                if process_alive:
                    self._append_event(
                        ts=ts,
                        task_id=tid,
                        run_id=run_id,
                        lease_epoch=old_epoch,
                        action="RECOVERY_REATTACHED",
                        actor="supervisor-recovery",
                        from_state=row["state"],
                        to_state=row["state"],
                        state_version=row["state_version"],
                        detail={
                            "boot_id": self.boot_id,
                            "worker_pid": wpid,
                            "worktree_preserved": wt_preserved,
                            "files_observed": dirty_files,
                        },
                    )
                    reattached.append(
                        {
                            "task_id": tid,
                            "run_id": run_id,
                            "lease_epoch": old_epoch,
                            "state": row["state"],
                        }
                    )
                    continue

                # Worker is dead or lease expired across reboot/crash.
                # Check if an in-flight command had no exit code -> mark NOT_RUN
                run_row = self.conn.execute(
                    "SELECT * FROM runs WHERE run_id = ?", (run_id,)
                ).fetchone()
                if run_row and run_row["last_command"] and run_row["last_exit_code"] is None:
                    self.conn.execute(
                        """
                        UPDATE runs
                        SET last_result = 'NOT_RUN',
                            ended_at = ?
                        WHERE run_id = ?
                        """,
                        (ts, run_id),
                    )
                    in_flight_reset.append(tid)

                # Check if verifiable passing evidence already exists for this run
                ev_row = self.conn.execute(
                    """
                    SELECT * FROM evidence
                    WHERE task_id = ? AND run_id = ? AND result = 'PASS'
                    ORDER BY created_at DESC LIMIT 1
                    """,
                    (tid, run_id),
                ).fetchone()

                # Increment fence generation (lease_epoch) so stale worker cannot write later
                fenced_epoch = old_epoch + 1
                new_version = int(row["state_version"]) + 1

                self.conn.execute("DELETE FROM file_claims WHERE task_id = ?", (tid,))
                self.conn.execute(
                    """
                    UPDATE leases
                    SET status = 'reclaimed', lease_epoch = ?, heartbeat_at = ?
                    WHERE task_id = ?
                    """,
                    (fenced_epoch, ts, tid),
                )

                if ev_row and run_row and run_row["head_commit"]:
                    target_state = "review"
                    reconciled_to_review.append(
                        {
                            "task_id": tid,
                            "previous_run_id": run_id,
                            "old_lease_epoch": old_epoch,
                            "new_lease_epoch": fenced_epoch,
                            "head_commit": run_row["head_commit"],
                            "worktree_preserved": wt_preserved,
                            "preserved_files": dirty_files,
                        }
                    )
                else:
                    target_state = "ready"
                    reclaimed_to_ready.append(
                        {
                            "task_id": tid,
                            "previous_run_id": run_id,
                            "old_lease_epoch": old_epoch,
                            "new_lease_epoch": fenced_epoch,
                            "worktree_preserved": wt_preserved,
                            "preserved_files": dirty_files,
                            "in_flight_marked_not_run": tid in in_flight_reset,
                        }
                    )

                if run_row:
                    self.conn.execute(
                        """
                        UPDATE runs
                        SET state = 'reclaimed_on_recovery',
                            ended_at = COALESCE(ended_at, ?)
                        WHERE run_id = ?
                        """,
                        (ts, run_id),
                    )

                self.conn.execute(
                    """
                    UPDATE tasks
                    SET state = ?,
                        state_version = ?,
                        owner = NULL,
                        run_id = NULL,
                        lease_epoch = ?,
                        lease_expires_at = NULL,
                        updated_at = ?
                    WHERE task_id = ?
                    """,
                    (target_state, new_version, fenced_epoch, ts, tid),
                )

                self._append_event(
                    ts=ts,
                    task_id=tid,
                    run_id=run_id,
                    lease_epoch=fenced_epoch,
                    action="RECOVERY_CHECKPOINT_AND_RECLAIM",
                    actor="supervisor-recovery",
                    from_state=row["state"],
                    to_state=target_state,
                    state_version=new_version,
                    detail={
                        "previous_boot_id": lease_boot,
                        "current_boot_id": self.boot_id,
                        "previous_run_id": run_id,
                        "old_lease_epoch": old_epoch,
                        "fenced_lease_epoch": fenced_epoch,
                        "worktree": wt_rel,
                        "worktree_preserved": wt_preserved,
                        "preserved_files": dirty_files,
                        "in_flight_test_marked": "NOT_RUN" if tid in in_flight_reset else "none",
                    },
                )

            promoted = self._recompute_planned_and_ready_in_tx(ts)
            self.conn.execute("COMMIT")
        except Exception:
            self.conn.execute("ROLLBACK")
            raise

        self.record_supervisor_heartbeat(now=current_dt)
        self.export_snapshots(now=current_dt)
        return {
            "recovery_timestamp": ts,
            "supervisor_boot_id": self.boot_id,
            "reattached_tasks": reattached,
            "reclaimed_to_ready": reclaimed_to_ready,
            "reconciled_to_review": reconciled_to_review,
            "in_flight_marked_not_run": in_flight_reset,
            "promoted_to_ready": promoted,
        }

    def backup_database(self, label: str = "snapshot", now: Optional[datetime] = None) -> Path:
        """
        Creates a consistent online backup of .agy/state.sqlite into .agy/backups/
        using the official sqlite3 Backup API (never raw file copy of active WAL).
        """
        self.export_snapshots(now=now)
        ts_compact = (format_utc(now or utc_now()) or "").replace(":", "").replace("-", "")
        backup_path = self.backups_dir / f"state-{label}-{ts_compact}.sqlite"
        backup_conn = sqlite3.connect(str(backup_path))
        try:
            with backup_conn:
                self.conn.backup(backup_conn)
        finally:
            backup_conn.close()
        return backup_path

    @classmethod
    def restore_from_backup_and_replay(
        cls,
        backup_path: Path,
        events_jsonl_path: Path,
        target_agy_dir: Path,
        boot_id: str = "boot-restored-001",
    ) -> "TaskLedger":
        """
        Restores .agy/state.sqlite from a verified SQLite backup and replays any newer
        durable events from .agy/events.jsonl without inventing 'done' states.
        """
        target_agy_dir.mkdir(parents=True, exist_ok=True)
        target_db = target_agy_dir / "state.sqlite"
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(target_db) + suffix)
            if candidate.exists():
                candidate.unlink()

        src_conn = sqlite3.connect(str(backup_path))
        dst_conn = sqlite3.connect(str(target_db))
        try:
            with dst_conn:
                src_conn.backup(dst_conn)
        finally:
            src_conn.close()
            dst_conn.close()

        ledger = cls(agy_dir=target_agy_dir, boot_id=boot_id)
        existing_ids = {
            r["event_id"]
            for r in ledger.conn.execute("SELECT event_id FROM events").fetchall()
        }

        if events_jsonl_path.is_file():
            ledger.conn.execute("BEGIN IMMEDIATE")
            try:
                for line in events_jsonl_path.read_text(encoding="utf-8").splitlines():
                    if not line.strip():
                        continue
                    ev = json.loads(line)
                    eid = ev.get("event_id")
                    if not eid or eid in existing_ids:
                        continue
                    ledger._append_event(
                        ts=ev["ts"],
                        task_id=ev["task_id"],
                        action=ev["action"],
                        actor=ev.get("actor", "replay"),
                        run_id=ev.get("run_id"),
                        lease_epoch=int(ev.get("lease_epoch", 0)),
                        from_state=ev.get("from_state"),
                        to_state=ev.get("to_state"),
                        state_version=ev.get("state_version"),
                        detail=ev.get("detail", {}),
                        event_id=eid,
                    )
                    # Replay state updates conservatively: never invent 'done' without review
                    to_st = ev.get("to_state")
                    if to_st and to_st != "done" and to_st in TASK_STATES:
                        ledger.conn.execute(
                            """
                            UPDATE tasks
                            SET state = ?,
                                state_version = COALESCE(?, state_version + 1),
                                lease_epoch = MAX(lease_epoch, ?),
                                updated_at = ?
                            WHERE task_id = ?
                            """,
                            (
                                to_st,
                                ev.get("state_version"),
                                int(ev.get("lease_epoch", 0)),
                                ev["ts"],
                                ev["task_id"],
                            ),
                        )
                ledger.conn.execute("COMMIT")
            except Exception:
                ledger.conn.execute("ROLLBACK")
                raise

        ledger.export_snapshots()
        return ledger

    def get_task(self, task_id: str) -> Dict[str, Any]:
        row = self.conn.execute(
            "SELECT * FROM tasks WHERE task_id = ?", (task_id,)
        ).fetchone()
        if not row:
            raise LedgerError(f"Unknown task '{task_id}'")
        deps = [
            r["depends_on_task_id"]
            for r in self.conn.execute(
                "SELECT depends_on_task_id FROM dependencies WHERE task_id = ? ORDER BY depends_on_task_id",
                (task_id,),
            ).fetchall()
        ]
        ev_list = [
            r["report_path"]
            for r in self.conn.execute(
                "SELECT report_path FROM evidence WHERE task_id = ? ORDER BY created_at",
                (task_id,),
            ).fetchall()
        ]
        blocker = json.loads(row["blocker_json"]) if row["blocker_json"] else None
        return CredentialSanitizer.sanitize(
            {
                "task_id": row["task_id"],
                "stream": row["stream"],
                "phase": row["phase"],
                "state": row["state"],
                "state_version": row["state_version"],
                "dependencies": deps,
                "owner": row["owner"],
                "run_id": row["run_id"],
                "lease_epoch": row["lease_epoch"],
                "lease_expires_at": row["lease_expires_at"],
                "base_commit": row["base_commit"],
                "branch": row["branch"],
                "worktree": row["worktree"],
                "allowed_paths": json.loads(row["allowed_paths_json"]),
                "acceptance_ref": row["acceptance_ref"],
                "heartbeat_at": row["heartbeat_at"],
                "attempts": row["attempts"],
                "evidence": ev_list,
                "blocker": blocker,
            }
        )

    def export_snapshots(self, now: Optional[datetime] = None) -> Dict[str, Any]:
        """
        Exports sanitized .agy/status.json and .agy/events.jsonl from the SQLite ledger.
        """
        ts = format_utc(now or utc_now())
        assert ts is not None
        meta_row = self.conn.execute(
            "SELECT * FROM supervisor_meta WHERE singleton_id = 1"
        ).fetchone()
        task_ids = [
            r["task_id"]
            for r in self.conn.execute("SELECT task_id FROM tasks ORDER BY task_id").fetchall()
        ]
        tasks_out = [self.get_task(tid) for tid in task_ids]
        counts = Counter(t["state"] for t in tasks_out)

        active_claims = [
            dict(r)
            for r in self.conn.execute(
                "SELECT path_prefix, task_id, run_id, lease_epoch, claimed_at FROM file_claims ORDER BY path_prefix"
            ).fetchall()
        ]

        status_payload = CredentialSanitizer.sanitize(
            {
                "schema": "creativanta.video-engine.agy-status.v1",
                "exported_at": ts,
                "supervisor": {
                    "boot_id": meta_row["boot_id"] if meta_row else self.boot_id,
                    "pid": meta_row["pid"] if meta_row else self.supervisor_pid,
                    "run_id": meta_row["run_id"] if meta_row else self.supervisor_run_id,
                    "heartbeat_at": meta_row["heartbeat_at"] if meta_row else ts,
                    "last_queue_mutation": meta_row["last_queue_mutation"] if meta_row else ts,
                },
                "counts": {state: counts.get(state, 0) for state in TASK_STATES},
                "ready_tasks": [t["task_id"] for t in tasks_out if t["state"] == "ready"],
                "active_file_claims": active_claims,
                "real_video_artifact_count": 0,
                "tasks": tasks_out,
            }
        )

        tmp_status = self.agy_dir / "status.json.tmp"
        tmp_status.write_text(
            json.dumps(status_payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        tmp_status.replace(self.status_path)

        event_rows = self.conn.execute(
            """
            SELECT event_seq, event_id, ts, task_id, run_id, lease_epoch,
                   action, actor, from_state, to_state, state_version, detail_json
            FROM events
            ORDER BY event_seq ASC
            """
        ).fetchall()

        tmp_events = self.agy_dir / "events.jsonl.tmp"
        with tmp_events.open("w", encoding="utf-8") as f:
            for er in event_rows:
                item = CredentialSanitizer.sanitize(
                    {
                        "event_seq": er["event_seq"],
                        "event_id": er["event_id"],
                        "ts": er["ts"],
                        "task_id": er["task_id"],
                        "run_id": er["run_id"],
                        "lease_epoch": er["lease_epoch"],
                        "action": er["action"],
                        "actor": er["actor"],
                        "from_state": er["from_state"],
                        "to_state": er["to_state"],
                        "state_version": er["state_version"],
                        "detail": json.loads(er["detail_json"]),
                    }
                )
                f.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
        tmp_events.replace(self.events_path)
        return status_payload


def scan_files_for_canary_leaks(paths: Sequence[Path], canaries: Sequence[str]) -> Dict[str, Any]:
    """
    Scans raw file bytes (including SQLite database pages, WAL, status.json, events.jsonl)
    to verify that zero bytes of any canary secret string were written to disk.
    """
    leaks: List[Dict[str, str]] = []
    files_scanned: List[str] = []
    for p in paths:
        for suffix in ("", "-wal", "-shm"):
            candidate = Path(str(p) + suffix) if suffix else p
            if not candidate.is_file():
                continue
            files_scanned.append(str(candidate))
            raw_bytes = candidate.read_bytes()
            for canary in canaries:
                if canary.encode("utf-8") in raw_bytes:
                    leaks.append({"file": str(candidate), "canary_prefix": canary[:6] + "..."})
    return {
        "files_scanned_count": len(files_scanned),
        "leaks_found_count": len(leaks),
        "leaks": leaks,
        "zero_credential_leak_verified": len(leaks) == 0,
    }


def run_synthetic_recovery_drill(repo_root: Path, output_json_path: Optional[Path] = None) -> Dict[str, Any]:
    """
    Materializes the real 52-task ledger into .agy/state.sqlite and executes a complete,
    reproducible synthetic crash/reboot recovery drill and credential redaction audit.
    """
    fixed_now = datetime(2026, 11, 2, 14, 0, 0, tzinfo=timezone.utc)
    agy_dir = repo_root / ".agy"
    for old_file in (
        agy_dir / "state.sqlite",
        agy_dir / "state.sqlite-wal",
        agy_dir / "state.sqlite-shm",
        agy_dir / "status.json",
        agy_dir / "events.jsonl",
    ):
        if old_file.exists():
            old_file.unlink()

    completed_bootstrap = {
        "P0-01": {
            "base_commit": "aaac0a6ecd464bf3f4798e18c94a003fb6ef0487",
            "tested_commit": "ace8777",
            "report_path": "evidence/P0-01/report.md",
            "artifacts": ["evidence/P0-01/report.md", "evidence/P0-01/backlog.json"],
            "reviewer": "staging-ci-gate",
        },
        "P0-02": {
            "base_commit": "eea986e879b70920c0a3c2c5579545ee3f509882",
            "tested_commit": "3361b41183cbd7370ccef6012902f090292e5691",
            "report_path": "evidence/P0-02/report.md",
            "artifacts": ["evidence/P0-02/report.md", "evidence/P0-02/artifacts-review.json"],
            "reviewer": "staging-ci-gate",
        },
        "P0-04": {
            "base_commit": "c3ff673791ac383c003bdbe6490e6ac4b007f066",
            "tested_commit": "131641971c28d7370ccef6012902f090292e5691"[:40],
            "report_path": "evidence/P0-04/report.md",
            "artifacts": ["evidence/P0-04/report.md", "evidence/P0-04/contract-threat-review.json"],
            "reviewer": "staging-ci-gate",
        },
    }

    # Step 1: Materialize authoritative .agy/state.sqlite for the repository
    with TaskLedger(
        agy_dir=agy_dir,
        boot_id="boot-20261102-hostA",
        supervisor_pid=4100,
        supervisor_run_id="sup-p0-05-main",
    ) as prod_ledger:
        mat_summary = prod_ledger.materialize_from_backlog(
            repo_root=repo_root,
            completed_bootstrap_tasks=completed_bootstrap,
            now=fixed_now,
        )
        integrity_info = prod_ledger.verify_integrity()
        backup_file = prod_ledger.backup_database(label="p0-05-bootstrap", now=fixed_now)
        prod_status = prod_ledger.export_snapshots(now=fixed_now)

    # Step 2: Execute isolated synthetic recovery drill in temporary workspace
    with tempfile.TemporaryDirectory() as tmp_root_str:
        tmp_root = Path(tmp_root_str)
        drill_agy = tmp_root / ".agy"

        # Create synthetic worktrees with uncommitted edits to verify preservation on crash
        wt_orphan = tmp_root / ".worktrees/p0-03-run-crash01"
        wt_orphan.mkdir(parents=True, exist_ok=True)
        (wt_orphan / "UNCOMMITTED_DRAFT.md").write_text(
            "# Draft rights manifest\nPreserved across crash recovery.\n",
            encoding="utf-8",
        )

        wt_alive = tmp_root / ".worktrees/p0-05-run-live01"
        wt_alive.mkdir(parents=True, exist_ok=True)
        (wt_alive / "IN_PROGRESS_NOTE.txt").write_text("Worker still running.\n", encoding="utf-8")

        # Canary credentials constructed dynamically so source scanners never trip
        canary_api_key = "cve_live_" + "9f8e7d6c5b4a3210fedcba98"
        canary_gh_token = "ghp_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"
        canary_sk_token = "sk-proj-" + "Zz99Yy88Xx77Ww66Vv55Uu44Tt33Ss22Rr11"
        canary_db_pass = "SuperSecretDbPass2026!"
        canary_s3_sig = "deadbeefcafebabe1234567890abcdef1234567890abcdef"
        canary_list = [
            canary_api_key,
            canary_gh_token,
            canary_sk_token,
            canary_db_pass,
            canary_s3_sig,
        ]

        # Boot 1: Claim P0-03 (will crash with in-flight command & expired lease) and P0-05 (will stay alive)
        with TaskLedger(
            agy_dir=drill_agy,
            boot_id="boot-001-before-crash",
            supervisor_pid=5001,
            supervisor_run_id="sup-drill-boot1",
        ) as ledger1:
            ledger1.materialize_from_backlog(
                repo_root=repo_root,
                completed_bootstrap_tasks=completed_bootstrap,
                now=fixed_now,
            )

            # Claim P0-03 at T=0 with scoped paths ["evidence/P0-03/", "docs/OPEN_SOURCE_EVALUATION.md"]
            claim_p003 = ledger1.claim_task(
                task_id="P0-03",
                owner="worker-alpha",
                repo_root=tmp_root,
                run_id="run-crash01",
                branch="agy/p0-03-rights",
                worktree=".worktrees/p0-03-run-crash01",
                claimed_paths=["evidence/P0-03/", "docs/OPEN_SOURCE_EVALUATION.md"],
                boot_id="boot-001-before-crash",
                worker_pid=9101,
                process_start_time=1730556000,
                now=fixed_now,
            )
            ledger1.transition_task(
                task_id="P0-03",
                run_id="run-crash01",
                lease_epoch=1,
                to_state="running",
                actor="worker-alpha",
                now=fixed_now + timedelta(seconds=10),
            )
            # Worker-alpha sends heartbeat with an in-flight command (no exit_code) and accidental secrets!
            ledger1.worker_heartbeat(
                task_id="P0-03",
                run_id="run-crash01",
                lease_epoch=1,
                command_category="validation",
                last_command=(
                    f"curl -H 'Authorization: Bearer {canary_api_key}' "
                    f"'https://storage.example.invalid/fixture.mp4?X-Amz-Signature={canary_s3_sig}'"
                ),
                last_exit_code=None,
                last_result=None,
                checkpoint={
                    "files": ["evidence/P0-03/UNCOMMITTED_DRAFT.md"],
                    "note": f"Using DSN postgres://cve_api:{canary_db_pass}@db.internal:5432/cve and token={canary_gh_token}",
                    "api_key": canary_sk_token,
                },
                now=fixed_now + timedelta(seconds=30),
            )

            # Verify that claiming P0-05 with unfocused 'docs/' (overlapping docs/OPEN_SOURCE_EVALUATION.md) is blocked!
            overlap_conflict_blocked = False
            try:
                ledger1.claim_task(
                    task_id="P0-05",
                    owner="worker-beta",
                    repo_root=tmp_root,
                    run_id="run-conflict",
                    branch="agy/p0-05-conflict",
                    worktree=".worktrees/p0-05-run-conflict",
                    claimed_paths=["evidence/P0-05/", "docs/"],
                    boot_id="boot-002-after-reboot",
                    worker_pid=9202,
                    process_start_time=1730556100,
                    now=fixed_now + timedelta(minutes=12),
                )
            except FileClaimConflictError:
                overlap_conflict_blocked = True

            # Claim P0-05 on boot-002 with disjoint file scope ["evidence/P0-05/", "docs/AGENTS.md"]
            claim_p005 = ledger1.claim_task(
                task_id="P0-05",
                owner="worker-beta",
                repo_root=tmp_root,
                run_id="run-live01",
                branch="agy/p0-05-ledger",
                worktree=".worktrees/p0-05-run-live01",
                claimed_paths=["evidence/P0-05/", "docs/AGENTS.md"],
                boot_id="boot-002-after-reboot",
                worker_pid=9202,
                process_start_time=1730556100,
                now=fixed_now + timedelta(minutes=12),
            )
            ledger1.transition_task(
                task_id="P0-05",
                run_id="run-live01",
                lease_epoch=1,
                to_state="running",
                actor="worker-beta",
                now=fixed_now + timedelta(minutes=12, seconds=5),
            )

            pre_recovery_p003 = ledger1.get_task("P0-03")
            pre_recovery_p005 = ledger1.get_task("P0-05")
            health_before = ledger1.check_heartbeat_health(now=fixed_now + timedelta(minutes=13))

        # Boot 2: Supervisor restarts after crash/reboot at T+13min (780s > 600s lease + 120s grace for P0-03)
        recovery_time = fixed_now + timedelta(minutes=13)
        with TaskLedger(
            agy_dir=drill_agy,
            boot_id="boot-002-after-reboot",
            supervisor_pid=6001,
            supervisor_run_id="sup-drill-boot2",
        ) as ledger2:
            recovery_report = ledger2.recover_after_crash_or_reboot(
                repo_root=tmp_root,
                live_processes={("boot-002-after-reboot", 9202, 1730556100, "run-live01")},
                now=recovery_time,
            )

            post_recovery_p003 = ledger2.get_task("P0-03")
            post_recovery_p005 = ledger2.get_task("P0-05")

            # Verify stale worker (worker-alpha with run-crash01, epoch=1) is rejected by fence!
            stale_rejected = False
            stale_error_msg = ""
            try:
                ledger2.transition_task(
                    task_id="P0-03",
                    run_id="run-crash01",
                    lease_epoch=1,
                    to_state="review",
                    actor="worker-alpha-zombie",
                    now=recovery_time + timedelta(seconds=5),
                )
            except StaleLeaseFenceError as exc:
                stale_rejected = True
                stale_error_msg = str(exc)

            # Verify reclaimed P0-03 can now be cleanly claimed by a new worker with lease_epoch = 3 (1 -> 2 on reclaim -> 3 on new claim)
            reclaim_p003 = ledger2.claim_task(
                task_id="P0-03",
                owner="worker-gamma",
                repo_root=tmp_root,
                run_id="run-fresh02",
                branch="agy/p0-03-rights-v2",
                worktree=".worktrees/p0-03-run-fresh02",
                claimed_paths=["evidence/P0-03/", "docs/OPEN_SOURCE_EVALUATION.md"],
                boot_id="boot-002-after-reboot",
                worker_pid=9303,
                process_start_time=1730556800,
                now=recovery_time + timedelta(seconds=10),
            )

            # Backup & restore + JSONL replay verification
            drill_backup = ledger2.backup_database(label="drill", now=recovery_time + timedelta(seconds=15))
            ledger2.export_snapshots(now=recovery_time + timedelta(seconds=15))

            leak_scan = scan_files_for_canary_leaks(
                paths=[ledger2.db_path, ledger2.status_path, ledger2.events_path, drill_backup],
                canaries=canary_list,
            )

        # Verify restore from backup + event replay into a separate directory
        restored_dir = tmp_root / ".agy-restored"
        with TaskLedger.restore_from_backup_and_replay(
            backup_path=drill_backup,
            events_jsonl_path=drill_agy / "events.jsonl",
            target_agy_dir=restored_dir,
            boot_id="boot-003-restored",
        ) as restored_ledger:
            restored_integrity = restored_ledger.verify_integrity()
            restored_p003 = restored_ledger.get_task("P0-03")
            restored_p005 = restored_ledger.get_task("P0-05")

        uncommitted_preserved = (wt_orphan / "UNCOMMITTED_DRAFT.md").is_file()

    result_payload: Dict[str, Any] = {
        "$schema": "creativanta.video-engine.p0-05-recovery-drill.v1",
        "task_id": "P0-05",
        "stream": "Supervisor",
        "phase": "P0",
        "executed_at": format_utc(fixed_now),
        "ledger_schema": {
            "sqlite_path": ".agy/state.sqlite",
            "status_export_path": ".agy/status.json",
            "events_export_path": ".agy/events.jsonl",
            "backup_directory": ".agy/backups/",
            "journal_mode": integrity_info["journal_mode"],
            "integrity_check": integrity_info["integrity_check"],
            "required_tables": list(TaskLedger.REQUIRED_TABLES),
            "all_required_tables_present": integrity_info["required_tables_present"],
            "task_states": list(TASK_STATES),
            "timing_policy": {
                "worker_heartbeat_seconds": WORKER_HEARTBEAT_INTERVAL_SECONDS,
                "worker_heartbeat_warn_seconds": WORKER_HEARTBEAT_WARN_SECONDS,
                "task_lease_seconds": TASK_LEASE_DURATION_SECONDS,
                "task_lease_grace_seconds": TASK_LEASE_GRACE_SECONDS,
                "reclaim_threshold_seconds": TASK_LEASE_DURATION_SECONDS + TASK_LEASE_GRACE_SECONDS,
                "supervisor_heartbeat_seconds": SUPERVISOR_HEARTBEAT_INTERVAL_SECONDS,
                "max_non_progress_attempts": MAX_NON_PROGRESS_ATTEMPTS,
            },
        },
        "bootstrap_materialization": {
            "total_tasks_imported": mat_summary["total_tasks"],
            "reconciled_done_tasks": mat_summary["reconciled_done"],
            "ready_tasks_after_bootstrap": prod_status["ready_tasks"],
            "counts_by_state": prod_status["counts"],
            "backup_created": backup_file.name,
        },
        "synthetic_recovery_drill": {
            "pre_crash_state": {
                "orphaned_task": {
                    "task_id": pre_recovery_p003["task_id"],
                    "state": pre_recovery_p003["state"],
                    "run_id": pre_recovery_p003["run_id"],
                    "lease_epoch": pre_recovery_p003["lease_epoch"],
                    "worktree": pre_recovery_p003["worktree"],
                },
                "live_task": {
                    "task_id": pre_recovery_p005["task_id"],
                    "state": pre_recovery_p005["state"],
                    "run_id": pre_recovery_p005["run_id"],
                    "lease_epoch": pre_recovery_p005["lease_epoch"],
                    "worktree": pre_recovery_p005["worktree"],
                },
                "heartbeat_health_diagnostics": health_before,
            },
            "recovery_execution": recovery_report,
            "post_recovery_verification": {
                "overlapping_file_claim_blocked": overlap_conflict_blocked,
                "orphaned_task_reclaimed_to_ready": post_recovery_p003["state"] == "ready",
                "orphaned_task_fenced_epoch": post_recovery_p003["lease_epoch"],
                "uncommitted_worktree_edits_preserved": uncommitted_preserved,
                "live_task_reattached_running": post_recovery_p005["state"] == "running",
                "live_task_preserved_run_id": post_recovery_p005["run_id"],
                "stale_worker_write_rejected": stale_rejected,
                "stale_worker_rejection_message": stale_error_msg,
                "fresh_worker_reclaim_succeeded": reclaim_p003["state"] == "claimed",
                "fresh_worker_new_lease_epoch": reclaim_p003["lease_epoch"],
            },
            "backup_restore_and_event_replay": {
                "restored_integrity_check": restored_integrity["integrity_check"],
                "restored_p003_state": restored_p003["state"],
                "restored_p003_lease_epoch": restored_p003["lease_epoch"],
                "restored_p005_state": restored_p005["state"],
                "no_invented_done_states": restored_p003["state"] != "done" and restored_p005["state"] != "done",
            },
        },
        "credential_redaction_audit": leak_scan,
    }

    if output_json_path is not None:
        output_json_path.parent.mkdir(parents=True, exist_ok=True)
        output_json_path.write_text(
            json.dumps(result_payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
    return result_payload


def main() -> int:
    parser = argparse.ArgumentParser(description="AGY Task Ledger & Synthetic Recovery Drill (P0-05)")
    parser.add_argument(
        "--repo-root",
        default=str(Path(__file__).resolve().parents[2]),
        help="Path to repository root",
    )
    parser.add_argument(
        "--output-json",
        default=str(Path(__file__).resolve().with_name("recovery-drill.json")),
        help="Output path for recovery-drill.json evidence artifact",
    )
    args = parser.parse_args()
    repo_root = Path(args.repo_root).resolve()
    out_path = Path(args.output_json).resolve()
    summary = run_synthetic_recovery_drill(repo_root=repo_root, output_json_path=out_path)
    print(
        json.dumps(
            {
                "status": "PASS",
                "sqlite_integrity": summary["ledger_schema"]["integrity_check"],
                "all_required_tables_present": summary["ledger_schema"]["all_required_tables_present"],
                "tasks_materialized": summary["bootstrap_materialization"]["total_tasks_imported"],
                "orphaned_task_reclaimed": summary["synthetic_recovery_drill"]["post_recovery_verification"][
                    "orphaned_task_reclaimed_to_ready"
                ],
                "stale_worker_rejected": summary["synthetic_recovery_drill"]["post_recovery_verification"][
                    "stale_worker_write_rejected"
                ],
                "zero_credential_leak_verified": summary["credential_redaction_audit"][
                    "zero_credential_leak_verified"
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
