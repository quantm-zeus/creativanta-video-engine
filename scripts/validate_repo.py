#!/usr/bin/python3
"""
Repository Validation Script for Creativanta Video Engine.
Scoped strictly to repository at /home/whaleorcale/evergreen/projects/creativanta-video-engine.
Uses standard library only (no external dependencies).
"""

from pathlib import Path
import json
import re
import sys

def main():
    root = Path(__file__).resolve().parent.parent
    errors = []
    warnings = []

    # 1. Required Design Documents (from DOC-001)
    required_docs = [
        "README.md",
        "AGENTS.md",
        "docs/PRD.md",
        "docs/ARCHITECTURE.md",
        "docs/API.md",
        "docs/SCENE-SPEC.md",
        "docs/OPEN_SOURCE_EVALUATION.md",
        "docs/SECURITY.md",
        "docs/TESTING.md",
        "docs/DEPLOYMENT.md",
        "docs/IMPLEMENTATION_PLAN.md",
        "docs/AGENTS.md",
        "docs/OPERATIONS.md",
        "docs/ADR/0001-engine-selection.md",
        "docs/EXECUTION_LOG.md",
        "docs/PROGRESS.md",
    ]

    for rel_path in required_docs:
        p = root / rel_path
        if not p.is_file():
            errors.append(f"Missing required document: {rel_path}")
        elif p.stat().st_size < 500:
            errors.append(f"Required document suspiciously small (<500 bytes): {rel_path}")

    # 2. Required Task Evidence Artifacts
    # Task P0-01 required evidence
    p01_evidence = [
        "evidence/P0-01/report.md",
        "evidence/P0-01/backlog.json",
    ]
    for rel_path in p01_evidence:
        p = root / rel_path
        if not p.is_file():
            errors.append(f"Missing P0-01 evidence artifact: {rel_path}")
        elif p.stat().st_size == 0:
            errors.append(f"Empty evidence artifact: {rel_path}")

    # 3. Markdown Structure and Internal Link Integrity
    md_paths = sorted([
        root / "README.md",
        root / "AGENTS.md",
        *root.glob("docs/**/*.md"),
        *root.glob("evidence/**/*.md"),
    ])

    links_checked = 0
    json_blocks_parsed = 0
    mermaid_blocks_counted = 0
    all_text = ""

    for p in md_paths:
        if not p.is_file():
            continue
        rel = str(p.relative_to(root))
        text = p.read_text(encoding="utf-8")
        all_text += text + "\n"

        # Check single H1
        h1_matches = re.findall(r"^# ", text, re.M)
        if len(h1_matches) != 1:
            errors.append(f"Expected exactly one H1 in {rel}, found {len(h1_matches)}")

        # Check balanced code fences
        fences = re.findall(r"^\x60\x60\x60", text, re.M)
        if len(fences) % 2 != 0:
            errors.append(f"Unbalanced code fences in {rel}: {len(fences)} fences")

        # Check JSON blocks inside markdown
        for block in re.findall(r"^\x60\x60\x60json\s*\n(.*?)^\x60\x60\x60", text, re.M | re.S):
            try:
                json.loads(block)
                json_blocks_parsed += 1
            except ValueError as ve:
                errors.append(f"Invalid JSON block in {rel}: {ve}")

        # Count mermaid blocks
        mermaid_blocks_counted += len(re.findall(r"^\x60\x60\x60mermaid\s*$", text, re.M))

        # Check relative markdown links
        clean_text = re.sub(r"^\x60\x60\x60[^\n]*\n.*?^\x60\x60\x60\s*$", "", text, flags=re.M | re.S)
        for url in re.findall(r"\[[^\]]*\]\(([^)]+)\)", clean_text):
            if re.match(r"^(?:https?://|mailto:|#)", url):
                continue
            target = url.split("#")[0]
            if not target:
                continue
            links_checked += 1
            resolved = (p.parent / target).resolve()
            if not resolved.is_relative_to(root) or not resolved.exists():
                errors.append(f"Broken internal link in {rel} -> {url} (resolved to {resolved})")

        # Heuristic secret detection
        if re.search(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}", text):
            errors.append(f"Possible secret pattern detected in {rel}")

    # 4. JSON Files Validity
    json_files = sorted([
        *root.glob("docs/**/*.json"),
        *root.glob("evidence/**/*.json"),
    ])
    for jf in json_files:
        rel = str(jf.relative_to(root))
        try:
            json.loads(jf.read_text(encoding="utf-8"))
        except ValueError as ve:
            errors.append(f"Invalid JSON file {rel}: {ve}")

    # 5. Implementation Plan and Task DAG Validation
    plan_path = root / "docs/IMPLEMENTATION_PLAN.md"
    tasks = {}
    if plan_path.is_file():
        plan_text = plan_path.read_text(encoding="utf-8")
        for line in plan_text.splitlines():
            m = re.match(r"^\|\s*(P\d+-\d+)\s*/\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|", line)
            if m:
                t_id = m.group(1).strip()
                stream = m.group(2).strip()
                deps_raw = m.group(3).strip()
                desc = m.group(4).strip()
                if t_id in tasks:
                    errors.append(f"Duplicate task ID in plan: {t_id}")
                deps = re.findall(r"P\d+-\d+|DOC-001", deps_raw)
                tasks[t_id] = {
                    "stream": stream,
                    "dependencies": deps,
                    "description": desc,
                }

        # Check dependencies reference known tasks or DOC-001
        for t_id, t_info in tasks.items():
            for dep in t_info["dependencies"]:
                if dep != "DOC-001" and dep not in tasks:
                    errors.append(f"Unknown dependency: task {t_id} depends on nonexistent {dep}")

        # Check task DAG for cycles
        visited = set()
        active = set()
        def visit(task_id):
            if task_id == "DOC-001" or task_id in visited:
                return
            if task_id in active:
                errors.append(f"Dependency cycle detected involving task {task_id}")
                return
            active.add(task_id)
            for dep in tasks.get(task_id, {}).get("dependencies", []):
                visit(dep)
            active.remove(task_id)
            visited.add(task_id)

        for t_id in tasks:
            visit(t_id)

        # Check that task references in markdown match known tasks
        for ref in set(re.findall(r"\bP\d+-\d{2}\b", all_text)):
            if ref not in tasks:
                errors.append(f"Unknown task reference in markdown: {ref}")

    # 6. Cross-check with Backlog Snapshot (if exists)
    backlog_path = root / "evidence/P0-01/backlog.json"
    if backlog_path.is_file():
        try:
            backlog_data = json.loads(backlog_path.read_text(encoding="utf-8"))
            backlog_tasks = backlog_data.get("tasks", [])
            backlog_ids = {t["task_id"] for t in backlog_tasks if "task_id" in t}
            if len(backlog_ids) != len(tasks):
                errors.append(f"Backlog task count mismatch: plan has {len(tasks)}, backlog has {len(backlog_ids)}")
            missing_in_backlog = set(tasks.keys()) - backlog_ids
            if missing_in_backlog:
                errors.append(f"Tasks in plan but missing in backlog: {sorted(missing_in_backlog)}")
        except Exception as e:
            errors.append(f"Failed to inspect backlog.json: {e}")

    # Summary
    summary = {
        "status": "PASS" if not errors else "FAIL",
        "required_docs_checked": len(required_docs),
        "markdown_files_checked": len(md_paths),
        "internal_links_checked": links_checked,
        "json_blocks_parsed": json_blocks_parsed,
        "json_files_parsed": len(json_files),
        "mermaid_blocks_counted": mermaid_blocks_counted,
        "tasks_in_plan": len(tasks),
        "dependency_graph_status": "acyclic" if not any("cycle" in e for e in errors) else "CYCLE_DETECTED",
        "errors_count": len(errors),
        "errors": errors,
        "warnings": warnings,
    }

    print(json.dumps(summary, indent=2, ensure_ascii=False))
    sys.exit(0 if not errors else 1)

if __name__ == "__main__":
    main()
