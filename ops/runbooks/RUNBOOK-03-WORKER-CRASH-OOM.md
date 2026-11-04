# Runbook: Worker crash, disk/OOM và duplicate risk (Worker Crash & Fencing)

Tài liệu vận hành và quy trình chẩn đoán sự cố tiến trình render worker bị đổ vỡ đột ngột (killed do OOM, kernel panic, lỗi bộ nhớ hoặc cgroup resource cap), cảnh báo tràn đĩa tạm (scratch disk exhaustion), và ngăn chặn nguy cơ xuất bản trùng lặp (duplicate artifact publication risk) từ zombie workers.

## 1. Thông tin cảnh báo và đối tượng giả lập (Synthetic IDs)

- **Alert triggers:**
  - `CveWorkerHeartbeatMissing` (mất heartbeat > 60s).
  - `CveDiskFreeWarning` / `CveDiskFreeCritical` (ổ đĩa tạm còn < 20% hoặc < 10%).
  - `CveHighMemoryUsage` (bộ nhớ vượt 90% trần 4GiB).
  - `CveStalePublishRejected` (zombie worker cố xuất bản artifact bị chặn bởi fencing token).
- **Mức độ nghiêm trọng:** `P1 - Critical Infrastructure & Invariant`.
- **Synthetic Tenant ID:** `tenant-synth-gamma-33333333`
- **Synthetic Worker ID:** `wrk-synth-worker-003`
- **Synthetic Job ID:** `job-synth-oom-003`
- **Synthetic Attempt ID cũ:** `att-synth-003-epoch1`
- **Synthetic Attempt ID mới:** `att-synth-003-epoch2`

## 2. Rủi ro cốt lõi và Cơ chế Fencing bảo vệ

Khi worker bị đóng băng (unresponsive) nhưng chưa chết hoàn toàn, hệ thống có thể phán đoán nhầm là worker đã chết và cấp phát lại job cho worker khác (`epoch = 2`). Nếu worker cũ tỉnh lại và cùng ghi đè tệp đầu ra hoặc xuất bản lên object store:
- Sẽ dẫn đến nguy cơ **Duplicate Artifact Publication** (vi phạm SLO Data Consistency).
- Để bảo vệ bất biến này, hệ thống áp dụng cơ chế **Monotonic Fencing Token (lease_epoch)**:
  - Mọi thao tác xuất bản lên DB và Object Store bắt buộc phải kèm theo số hiệu `lease_epoch`.
  - Nếu `lease_epoch` gửi lên nhỏ hơn `lease_epoch` hiện hành trong DB, giao dịch xuất bản lập tức bị từ chối với lỗi `STALE_LEASE_OR_EPOCH`.

## 3. Quy trình chẩn đoán tuần tự (Diagnostic Workflow)

### Bước 1: Kiểm tra log sự cố của Worker và Cgroup OOM
Kiểm tra xem tiến trình Chromium hoặc FFmpeg có bị kernel OOM killer tiêu diệt:

```bash
# Kiểm tra log kernel trên node render
dmesg -T | grep -E -i "oom[-_]killer|killed process" | tail -n 20
```

Kiểm tra log của worker bị sự cố (đã được lược bỏ dữ liệu nhạy cảm):
```bash
grep "job-synth-oom-003" /var/log/cve/worker.log | tail -n 30
```

Mẫu log ghi nhận lỗi OOM:
```json
{
  "timestamp": "2026-11-04T04:10:00.123Z",
  "level": "error",
  "service": "cve-renderer",
  "stage": "render",
  "job_id": "job-synth-oom-003",
  "attempt_id": "att-synth-003-epoch1",
  "lease_epoch": 1,
  "message": "Renderer child process terminated by signal SIGKILL (cgroup memory limit 4096MB reached)",
  "error_code": "RENDER_PROCESS_OOM"
}
```

### Bước 2: Kiểm tra dung lượng đĩa tạm (Scratch Temp Cleanup)
1. Kiểm tra tỷ lệ không gian trống trên thư mục tạm:
   ```bash
   df -h /tmp/cve-scratch
   ```
2. Nếu tỷ lệ còn trống dưới 20%, chạy tiến trình dọn dẹp các thư mục mồ côi (chỉ dọn các attempt mồ côi không còn heartbeat trên 24 giờ, tuyệt đối không dùng `rm -rf` bừa bãi làm hỏng các job đang chạy):
   ```bash
   find /tmp/cve-scratch -maxdepth 1 -name "att-*" -mtime +1 -exec rm -rf {} +
   ```

### Bước 3: Xác minh cơ chế Reaper và Fencing Token
1. Quan sát Reaper tự động thu hồi lease hết hạn của `wrk-synth-worker-003`:
   - Trạng thái lease chuyển thành `expired`.
   - Thuộc tính `lease_epoch` của job được tăng tự động: `1 -> 2`.
   - Trạng thái job chuyển sang `retry_wait` hoặc `queued`.
2. Kiểm tra metric chặn xuất bản trễ (stale publish rejection):
   ```bash
   curl -s http://127.0.0.1:9090/metrics | grep "cve_stale_publish_rejected_total"
   ```
   Nếu worker cũ cố gắng gọi API xuất bản với `lease_epoch: 1`, yêu cầu bị từ chối `409 CONFLICT` với mã lỗi `STALE_LEASE_OR_EPOCH`.

## 4. Hành động khắc phục và Phục hồi (Remediation & Recovery)

1. Tái khởi động container worker bị lỗi một cách an toàn:
   ```bash
   docker restart cve-worker-003
   ```
2. Cho phép công nhân mới nhận lại job `job-synth-oom-003` tại `lease_epoch = 2`.
3. Nếu job tiếp tục bị OOM tại epoch 2: Hệ thống tự động đánh dấu job là `failed` với mã lỗi `RESOURCE_EXHAUSTED` (không retry vô hạn quá ngưỡng cấu hình `max_attempts = 2`).
4. Bảng kê sử dụng (usage ledger) đảm bảo chỉ ghi nhận duy nhất 1 lần chi phí vận hành cho các attempt đã tiêu thụ, không tính phí trùng lặp cho khách hàng.
