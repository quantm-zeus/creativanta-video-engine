# Documentation validation — DOC-001

Ngày kiểm tra: 2026-11-02 UTC. Đây là validation tài liệu, không phải test ứng dụng, schema semantic validation, video benchmark hoặc security audit.

## Phương pháp có thể chạy lại

Từ repo root, chạy Python chuẩn bên dưới (không cài dependency) qua `python3 - <<'PY'`, kết thúc bằng `PY`. Validator chỉ đọc file và in thống kê; không gọi mạng hoặc thay đổi app.

```python
from pathlib import Path
import json, re
root = Path.cwd().resolve()
required = [
    "README.md", "AGENTS.md", "docs/PRD.md", "docs/ARCHITECTURE.md",
    "docs/API.md", "docs/SCENE-SPEC.md", "docs/OPEN_SOURCE_EVALUATION.md",
    "docs/SECURITY.md", "docs/TESTING.md", "docs/DEPLOYMENT.md",
    "docs/IMPLEMENTATION_PLAN.md", "docs/AGENTS.md", "docs/OPERATIONS.md",
    "docs/ADR/0001-engine-selection.md", "docs/EXECUTION_LOG.md"
]
errors = []
for name in required:
    p = root / name
    if not p.is_file() or p.stat().st_size < 1000:
        errors.append("missing or too short: " + name)
paths = sorted([root / "README.md", root / "AGENTS.md", *root.glob("docs/**/*.md")])
links = json_blocks = mermaid_blocks = 0
all_text = ""
for p in paths:
    s = p.read_text(encoding="utf-8")
    all_text += s + "\n"
    if len(re.findall(r"^# ", s, re.M)) != 1:
        errors.append("expected one H1: " + str(p.relative_to(root)))
    if len(re.findall(r"^\x60\x60\x60", s, re.M)) % 2:
        errors.append("unbalanced fences: " + str(p.relative_to(root)))
    for block in re.findall(r"^\x60\x60\x60json\s*\n(.*?)^\x60\x60\x60", s, re.M | re.S):
        try:
            json.loads(block)
            json_blocks += 1
        except ValueError:
            errors.append("invalid JSON block: " + str(p.relative_to(root)))
    mermaid_blocks += len(re.findall(r"^\x60\x60\x60mermaid\s*$", s, re.M))
    clean = re.sub(r"^\x60\x60\x60[^\n]*\n.*?^\x60\x60\x60\s*$", "", s, flags=re.M | re.S)
    for url in re.findall(r"\[[^\]]*\]\(([^)]+)\)", clean):
        if re.match(r"(?:https?://|mailto:)", url):
            continue
        target = url.split("#")[0]
        if not target:
            continue
        links += 1
        resolved = (p.parent / target).resolve()
        if not resolved.is_relative_to(root) or not resolved.exists():
            errors.append(str(p.relative_to(root)) + " -> " + url)
    if re.search(r"-----BEGIN [A-Z ]*PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:proj-)?[A-Za-z0-9]{30,}|AKIA[A-Z0-9]{16}", s):
        errors.append("possible secret pattern: " + str(p.relative_to(root)))
json_files = list(root.glob("docs/*.json"))
for p in json_files:
    try:
        json.loads(p.read_text(encoding="utf-8"))
    except ValueError:
        errors.append("invalid JSON file: " + str(p.relative_to(root)))
tasks = {}
for line in (root / "docs/IMPLEMENTATION_PLAN.md").read_text().splitlines():
    m = re.match(r"\| (P\d+-\d+) /.*?\| (.*?) \|", line)
    if m:
        if m[1] in tasks:
            errors.append("duplicate task: " + m[1])
        tasks[m[1]] = re.findall(r"P\d+-\d+|DOC-001", m[2])
for task, deps in tasks.items():
    for dep in deps:
        if dep != "DOC-001" and dep not in tasks:
            errors.append("unknown dependency: " + task + " -> " + dep)
for ref in set(re.findall(r"\bP\d+-\d{2}\b", all_text)):
    if ref not in tasks:
        errors.append("unknown task reference: " + ref)
visited, active = set(), set()
def visit(task):
    if task == "DOC-001" or task in visited:
        return
    if task in active:
        errors.append("dependency cycle: " + task)
        return
    active.add(task)
    for dep in tasks.get(task, []):
        visit(dep)
    active.remove(task)
    visited.add(task)
for task in tasks:
    visit(task)
result = {
    "required_files": len(required), "markdown_files": len(paths),
    "internal_links_checked": links, "json_blocks_parsed": json_blocks,
    "json_evidence_files_parsed": len(json_files),
    "mermaid_blocks_counted_not_rendered": mermaid_blocks,
    "planned_tasks": len(tasks),
    "dependency_graph": "acyclic" if not any("cycle" in e for e in errors) else "FAIL",
    "errors": errors
}
print(json.dumps(result, ensure_ascii=False, indent=2))
raise SystemExit(bool(errors))
```

Sau khi stage đúng các file tài liệu: `git diff --cached --check`, kiểm `git diff --cached --name-only` và diff summary. Kiểm tra sau commit bằng `git status --short` và `git log -1 --format='%h %s'`.

## Kết quả thực

Validator thực sự đã chạy bằng Python, exit code **0**, không có errors: **15/15 required files**, **16 Markdown files**, **84 internal links**, **11 JSON code blocks**, **1 JSON evidence file**, **52 unique planned task IDs**, dependency graph acyclic. Có **3 Mermaid blocks** được đếm, chưa render. Mỗi Markdown có một H1, code fences balanced, không gặp các secret patterns đã liệt kê trong validator. Lần kiểm sơ bộ trước đó tìm thấy một internal link chưa tồn tại tới chính VALIDATION.md; đã tạo file và chạy lại thành công.

Manual consistency review đã sửa hai dependency ngầm có thể gây vòng: engine security gate P2 tách khỏi DB/lease tenant-service tests P4/P6; asset revoke metadata P3 tách khỏi live-job publication race test P4. Bổ sung bootstrap durable-queue exception cho supervisor trước P0-05, preview timing, profile/binding constraints và secret-safe idempotency replay. Đây là review thiết kế, không phải execution test những hành vi đó.

`git diff --cached --check` đã chạy, exit **0**. `git diff --cached --name-only`/`--stat` xác nhận đúng **17 documentation files**: 15 yêu cầu + JSON upstream evidence + báo cáo này; không có app/deployment/runtime files. Final validator được chạy lại sau cập nhật nội dung trước commit. Local commit theo [Execution log](EXECUTION_LOG.md), không push.

## Giới hạn

JSON snippets chỉ được parse cú pháp, không validate theo full Scene Schema/OpenAPI vì chưa triển khai; fragment có `$ref` trong Scene spec được ghi rõ là fragment. Mermaid được đếm và kiểm fence, chưa render/parser-check bằng Mermaid runtime. YAML Compose là pseudoconfiguration có placeholders, không được gọi là runnable hoặc docker-validated. External links không được crawl toàn bộ; upstream evidence là các reads được ghi riêng trong [Execution log](EXECUTION_LOG.md) và [Upstream verification](UPSTREAM_VERIFICATION.json). Secret scan chỉ là heuristic trên docs, không phải chứng nhận không có secret ở mọi lịch sử Git. Không chạy test app, FFmpeg, benchmark, sandbox, deployment hoặc AGY.
