# Khuôn mẫu báo cáo bằng chứng nghiệm thu (Canonical Evidence Template)

Tài liệu chuẩn hóa khuôn mẫu báo cáo bằng chứng (`evidence/<task-id>/report.md`) cho tất cả các nhiệm vụ triển khai từ `P0-01` đến `P9-05` theo quy định tại [AGY execution](../../docs/AGENTS.md), [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md) và [Testing](../../docs/TESTING.md). Được xác thực tự động bởi công cụ [task_ledger.py](task_ledger.py) (`EvidenceValidator.validate_report_markdown`).

## 1. Khối bằng chứng bắt buộc (Mandatory Machine-Verifiable Block)

Mỗi tệp `evidence/<task-id>/report.md` bắt buộc phải có duy nhất một tiêu đề cấp 1 (`H1`) ở dòng đầu tiên và chứa một khối mã `text` theo đúng định dạng chuẩn dưới đây (minh họa cho nhiệm vụ `P2-03`):

```text
Task: P2-03
Base / tested commit: 704e03ef5410f94116d3652f5671d7afb7ef2b95 / 704e03ef5410f94116d3652f5671d7afb7ef2b95
Environment: Linux x86_64, Ubuntu 24.04 LTS, 4 vCPU, 8GiB RAM, Python 3.12, Node v24, Chromium pinned, FFmpeg pinned
Command: PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-02T14:00:00Z / 1.2s
Artifacts:
  - evidence/P0-05/recovery-drill.json, sha256=0000000000000000000000000000000000000000000000000000000000000000, expires=N/A (repo-versioned)
Acceptance mapping:
  - Criterion 1: PASS — Mô tả bằng chứng cụ thể và tệp đối chiếu
  - Criterion 2: PASS — Kết quả thực thi kiểm thử thực tế
Reviewer / reviewed commit / decision: pending independent reviewer / 704e03ef5410f94116d3652f5671d7afb7ef2b95 / local completion awaiting review
```

## 2. Quy tắc kiểm tra tự động (Validation Rules)

Bộ kiểm tra `EvidenceValidator` trong [task_ledger.py](task_ledger.py) và script [validate_repo.py](../../scripts/validate_repo.py) thực thi các quy tắc bất biến sau:

1. **Đầy đủ 9 trường bắt buộc:** `Task`, `Base / tested commit`, `Environment`, `Command`, `Result`, `Exit code / UTC started / duration`, `Artifacts`, `Acceptance mapping`, `Reviewer / reviewed commit / decision`.
2. **Giá trị `Result` đóng:** Chỉ chấp nhận một trong bốn giá trị `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED`.
3. **Tính nhất quán giữa `Result` và `Exit code`:** Nếu `Result: PASS`, trường `Exit code` bắt buộc phải bằng `0`. Lệnh đang chạy dở khi crash không có exit code phải ghi nhận là `NOT_RUN` và chạy lại.
4. **Mã băm toàn vẹn (`sha256`):** Mọi artifact liệt kê trong khối bằng chứng phải kèm mã băm `sha256=<64 lowercase hex>` thực tế của tệp.
5. **Không chứa thông tin bí mật (Zero Credentials):** Tuyệt đối không đưa API key, Bearer token, private key, chuỗi kết nối DB có mật khẩu hoặc presigned URL chứa chữ ký vào trường `Command`, `Artifacts` hay nội dung báo cáo.
6. **Không giả mạo trạng thái (No Fake Completion):** Worker hoàn tất tại worktree cục bộ chỉ được ghi nhận decision là `local completion awaiting review` (trạng thái `review`), không tự gán nhãn `done` hoặc giả mạo kết quả render MP4, CI từ xa hay phê duyệt bảo mật/pháp lý.
