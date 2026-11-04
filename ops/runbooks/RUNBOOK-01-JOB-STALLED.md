# Runbook: Accepted job không tiến triển (Job Stalled / Queue Wait High)

Tài liệu vận hành và quy trình chẩn đoán sự cố cho trường hợp yêu cầu kết xuất video đã được tiếp nhận (`status = queued` hoặc `running`) nhưng không tiến triển hoặc vượt ngưỡng chờ quy định (SLO `cve_queue_oldest_seconds > 120s`).

## 1. Thông tin cảnh báo và đối tượng giả lập (Synthetic IDs)

- **Alert trigger:** `CveOldestQueueStalled` (`cve_queue_oldest_seconds > 120s` kéo dài trên 5 phút).
- **Mức độ nghiêm trọng:** `P2 - Warning` (nếu có 1 job lẻ) hoặc `P1 - Critical` (nếu toàn bộ queue bị nghẽn).
- **Synthetic Tenant ID:** `tenant-synth-alpha-11111111`
- **Synthetic Job ID:** `job-synth-stalled-001`
- **Synthetic Request ID:** `req-synth-101-abcdef`
- **Synthetic Attempt ID:** `att-synth-001-epoch1`

## 2. Lưu đồ chẩn đoán (Diagnostic Decision Tree)

```text
Job Stalled (job-synth-stalled-001)
  │
  ├─> Kiểm tra trạng thái hiện tại (GET /v1/render-jobs/:id)
  │     │
  │     ├─ [state = queued]
  │     │     ├─ Hết hạn hạn chót (now > deadline_at)?
  │     │     │     └─ Chuyển failed (DEADLINE_EXCEEDED), giải phóng hạn mức.
  │     │     │
  │     │     └─ Còn hạn chót:
  │     │           ├─ Kiểm tra slots khả dụng (cve_worker_slots).
  │     │           ├─ Kiểm tra dispatcher node locks & DB transactions.
  │     │           └─ Kiểm tra hạn ngạch tenant (concurrency limit).
  │     │
  │     └─ [state = running]
  │           ├─ Heartbeat bị ngắt (>60s)?
  │           │     └─ Kích hoạt Reaper: tăng lease_epoch, fence output, requeue bounded.
  │           │
  │           └─ Heartbeat còn nhưng stage thời gian vượt trần?
  │                 └─ Đọc stage timer (compile/render/mux); hủy theo API POST /v1/render-jobs/:id/cancel.
```

## 3. Các bước xử lý tuần tự (Step-by-Step Procedure)

### Bước 1: Lấy thông tin trạng thái bằng quyền tenant (Tenant-Scoped Status)
Sử dụng ID giả lập để truy vấn thông tin chi tiết qua API:

```bash
# Kiểm tra trạng thái job
curl -s -X GET "http://127.0.0.1:8080/v1/render-jobs/job-synth-stalled-001" \
  -H "Authorization: Bearer <authorized_tenant_key>"
```

Dữ liệu trả về mẫu:
```json
{
  "job_id": "job-synth-stalled-001",
  "status": "queued",
  "state_version": 1,
  "queue_age_seconds": 145,
  "deadline_at": "2026-11-04T04:00:00.000Z",
  "cancel_requested": false,
  "attempt_count": 0
}
```

### Bước 2: Phân tích nguyên nhân nếu Job đang ở trạng thái `queued`
1. Kiểm tra số lượng worker slots hiện có qua Prometheus metrics:
   ```bash
   curl -s http://127.0.0.1:9090/metrics | grep "cve_worker_slots"
   ```
2. Nếu số worker khả dụng bằng 0, kiểm tra dịch vụ controller/dispatcher và tiến trình worker container.
3. Nếu worker slots còn rảnh nhưng dispatcher không giao việc:
   - Kiểm tra log của dispatcher:
     ```bash
     grep "job-synth-stalled-001" /var/log/cve/dispatcher.log | tail -n 20
     ```
   - Kiểm tra xem tenant có đang vượt hạn mức đồng thời (concurrent reservation limit) hay không.

### Bước 3: Phân tích nguyên nhân nếu Job đang ở trạng thái `running`
1. Kiểm tra mốc heartbeat gần nhất:
   - Nếu `now() - heartbeat_at > 60s`: Tiến trình worker có thể đã bị kill/OOM.
   - Không được sửa trực tiếp cơ sở dữ liệu bằng lệnh SQL ad-hoc.
   - Cho phép reaper tự động thực hiện chu trình thu hồi lease (reclaim lease), tăng `lease_epoch` lên `2`, và chuyển job sang trạng thái `retry_wait` hoặc tái xếp hàng.
2. Nếu heartbeat vẫn được gửi đều đặn nhưng một giai đoạn (stage) bị treo (ví dụ `render` quá thời gian tối đa 300s):
   - Gọi API hủy tiến trình chính thức:
     ```bash
     curl -s -X POST "http://127.0.0.1:8080/v1/render-jobs/job-synth-stalled-001/cancel" \
       -H "Authorization: Bearer <authorized_tenant_key>"
     ```
   - Hệ thống sẽ đánh dấu `cancel_requested = true`. Tại chu kỳ kiểm tra tiếp theo, worker sẽ ngắt render, dọn dẹp thư mục tạm và hoàn trả tài nguyên.

## 4. Xác minh hoàn tất phục hồi (Recovery Verification)

1. Kiểm tra lại trạng thái qua API: Trạng thái phải chuyển sang terminal (`failed` hoặc `canceled`).
2. Xác nhận thư mục tạm trên ổ đĩa được xóa bỏ: Không còn thư mục `/tmp/cve-scratch/job-synth-stalled-001*`.
3. Kiểm tra usage ledger: Hạn ngạch tạm giữ được giải phóng qua bản ghi bù trừ (`usage_released`).
4. Khách hàng/hệ thống có thể tạo job mới với `idempotency_key` mới nếu cần render lại.
