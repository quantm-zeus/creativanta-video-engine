# ADR 0004 — Đánh giá kiến trúc hàng đợi: Duy trì PostgreSQL FOR UPDATE SKIP LOCKED vs Bổ sung Message Broker (Redis/BullMQ, RabbitMQ, Kafka)

- **Mã quyết định:** `ADR-0004`
- **Nhiệm vụ / Giai đoạn:** `P9-03` (`A+C / P9 — DB/queue profiling, broker evaluation, transactional outbox/fencing`)
- **Ngày:** `2026-11-05`
- **Trạng thái:** **Accepted** (Duy trì hàng đợi nội tại PostgreSQL `FOR UPDATE SKIP LOCKED`, không bổ sung standalone message broker ở giai đoạn này; transactional outbox và monotonic fencing tokens giữ nguyên bất biến).
- **Tài liệu chuẩn tắc liên quan:** [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/OPERATIONS.md](../../docs/OPERATIONS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [ops/CAPACITY_AND_AUTOSCALE.md](../../ops/CAPACITY_AND_AUTOSCALE.md), [ADR 0001 Engine Selection](../../docs/ADR/0001-engine-selection.md).

---

## 1. Bối cảnh và Thách thức (Context & Problem Statement)

Trong kiến trúc tổng thể của Creativanta Video Engine:
- Nền tảng điều phối công việc kết xuất video (`video render dispatching`) hiện sử dụng **PostgreSQL** làm nguồn chân lý duy nhất (`single source of truth`) kết hợp cơ chế hàng đợi giao dịch nội tại (`FOR UPDATE SKIP LOCKED`, transaction ngắn, lease 60s, heartbeat 15s, monotonic fencing token qua `lease_epoch`).
- Giao thức xuất bản kết quả và thông báo trạng thái dựa trên mẫu hình **Transactional Outbox**: sự kiện chuyển trạng thái cuối cùng (`job.succeeded`, `job.failed`, `job.canceled`), bản ghi tạo tác (`artifacts`), và bản ghi sổ cái sử dụng (`usage_entries`) được cam kết đồng thời trong **cùng một giao dịch cơ sở dữ liệu** (`atomic commit`).
- Nhiệm vụ **P9-03** (theo [Implementation Plan](../../docs/IMPLEMENTATION_PLAN.md)) đặt ra yêu cầu nghiệm thu cốt lõi:
  > *"DB/queue profiling; chỉ thêm broker khi evidence bottleneck, transactional outbox/fencing giữ nguyên; ADR và recovery tests"*
- Vấn đề kiến trúc cần định đoạt:
  1. Dựa trên dữ liệu đo kiểm hiệu năng thực tế (`empirical profiling`), cơ chế hàng đợi nội tại của PostgreSQL có gặp hiện tượng thắt nút cổ chai (`bottleneck`) hay không?
  2. Có cần thiết bổ sung một hệ thống môi giới thông điệp chuyên biệt (`message broker`) độc lập như Redis/BullMQ, RabbitMQ, hoặc Apache Kafka ở quy mô hiện tại hoặc mở rộng thương mại hay không?
  3. Nếu không thêm broker, các ngưỡng giới hạn nào sẽ kích hoạt việc tái đánh giá trong tương lai, và làm thế nào để bảo toàn tuyệt đối tính bất biến của Transactional Outbox và Monotonic Fencing Token?

---

## 2. Tiêu chí và Trọng số Đánh giá (Evaluation Framework)

Kế thừa khung đánh giá đa tiêu chí từ [ADR 0001](../../docs/ADR/0001-engine-selection.md), các phương án kiến trúc được chấm điểm dựa trên 5 tiêu chí cốt lõi:

| Tiêu chí | Trọng số | Mô tả yêu cầu kỹ thuật |
| :--- | :---: | :--- |
| **Tính nhất quán giao dịch & Toàn vẹn Outbox (Transactional Consistency & Outbox)** | 30% | Bảo đảm tính nguyên tử tuyệt đối (`ACID atomicity`) giữa cập nhật trạng thái job và sinh sự kiện outbox; loại trừ hoàn toàn nguy cơ ghi hai pha lỗi (`dual-write hazard`), mất mát sự kiện hoặc gửi webhook trùng lặp. |
| **Thông lượng điều phối & Dự phòng tải (Dispatch Throughput & Headroom)** | 25% | Khả năng tiếp nhận (`enqueue`) và cấp phát (`claim`) công việc với độ trễ thấp ($p95 < 10$ms); tỷ lệ dự phòng năng lực (`headroom factor`) so với năng lực kết xuất vật lý thực tế của cụm worker CPU. |
| **An toàn hàng rào Lease & Chống Double Lease (Lease Fencing & Mutual Exclusion)** | 20% | Đảm bảo tính bài xích tuyệt đối: không có 2 worker nào đồng thời sở hữu lease hợp lệ; kiểm soát thế hệ đơn điệu (`monotonic lease_epoch`); ngăn chặn tuyệt đối worker zombie xuất bản tạo tác đè lên kết quả mới. |
| **Độ đơn giản hạ tầng & Ranh giới sự cố (Operational Overhead & Failure Domain)** | 15% | Số lượng dịch vụ phụ thuộc cần triển khai, bảo trì, giám sát, và cấp chứng chỉ; rủi ro phân mảnh não (`split-brain`); chi phí vận hành máy chủ nằm trong hạn mức ngân sách ($350.40/tháng tối đa 3 nodes). |
| **Phục hồi thảm họa & Đối soát dữ liệu (Disaster Recovery & Data Replay)** | 10% | Khả năng sao lưu/phục hồi nhất quán tại một mốc thời gian (`point-in-time recovery`); độ phức tạp trong kịch bản phát lại outbox (`replay`); tuân thủ chỉ tiêu RPO $\le 15$ phút, RTO $\le 4$ giờ theo [docs/OPERATIONS.md](../../docs/OPERATIONS.md). |

---

## 3. Bảng điểm Đối chuẩn và Kết quả Đo đạc Thực nghiệm (Empirical Benchmark & Scoring)

Khảo sát được thực hiện thông qua công cụ đo kiểm chuyên dụng `ops/scaling/db-queue-profiler.mjs` trên môi trường chuẩn 4 vCPU / 8 GiB RAM (máy chủ tham chiếu độc lập).

### 3.1. Dữ liệu đo đạc thực tế của PostgreSQL / DB Queue

| Thao tác hàng đợi | Số lượng mẫu | Thông lượng (ops/giây) | Độ trễ p50 (ms) | Độ trễ p95 (ms) | Độ trễ p99 (ms) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| **Enqueue Job (Admission Transaction)** | 1,000 | **2,840.9** | 0.312 ms | 0.584 ms | 1.120 ms |
| **Claim Job (`FOR UPDATE SKIP LOCKED`)** | 1,000 | **2,363.7** | 0.415 ms | 0.604 ms | 1.450 ms |
| **Heartbeat Renewal (Fenced Lease)** | 1,000 | **7,812.5** | 0.118 ms | 0.245 ms | 0.520 ms |
| **Complete Job + Outbox Atomic Commit** | 1,000 | **6,919.3** | 0.135 ms | 0.182 ms | 0.485 ms |
| **Outbox Drain & Webhook Dispatch** | 1,000 | **4,150.0** | 0.210 ms | 0.450 ms | 0.980 ms |

### 3.2. Đối chiếu Tương quan: Năng lực Điều phối DB vs Năng lực Kết xuất Cụm

Theo quy định tại [docs/CAPACITY_AND_AUTOSCALE.md](../../ops/CAPACITY_AND_AUTOSCALE.md) và nhiệm vụ [P9-01](../../evidence/P9-01/report.md):
- Cụm máy chủ thương mại bị kẹp ngân sách cứng: tối đa **3 nodes (6 worker slots)**.
- Thời gian kết xuất trung bình một video (POC-01 15s đến POC-03 45s): **20.0 giây**.
- **Năng lực tiêu thụ vật lý tối đa của cụm render:**
  $$\text{Render Throughput} = \frac{6 \text{ slots}}{20 \text{ s/job}} = 0.30 \text{ jobs/giây} \quad (18 \text{ jobs/phút})$$
- **Thông lượng điều phối đo được của DB Queue:** **2,363.7 claims/giây**.
- **Hệ số dự phòng năng lực (Headroom Factor):**
  $$\text{Headroom} = \frac{2,363.7 \text{ claims/giây}}{0.30 \text{ jobs/giây}} \approx \mathbf{7,879\times}$$
- Ngay cả khi cụm mở rộng gấp 10 lần quy mô ($30$ nodes = $60$ slots, thông lượng tiêu thụ $3.0$ jobs/giây), hệ số dự phòng vẫn đạt **$787.9\times$**.

### 3.3. Bảng điểm Tổng hợp 4 Ứng viên Kiến trúc

| Tiêu chí (Trọng số) | 1. PostgreSQL Native | 2. Redis / BullMQ | 3. RabbitMQ | 4. Apache Kafka + CDC |
| :--- | :---: | :---: | :---: | :---: |
| **Toàn vẹn Outbox & Nhất quán (30%)** | **30.0** (ACID 1 transaction) | 18.0 (Dual-write hazard) | 18.5 (Dual-write hazard) | 22.0 (CDC lag & replay) |
| **Thông lượng & Dự phòng (25%)** | **23.5** (>7,800x headroom) | 24.5 (Rất cao in-memory) | 23.0 (Cao) | 24.0 (Rất cao phân tán) |
| **An toàn Fencing & Lease (20%)** | **20.0** (Monotonic epoch DB) | 12.0 (Split-brain Redlock) | 11.0 (Không atomic fence) | 10.0 (Log streaming) |
| **Độ đơn giản hạ tầng (15%)** | **15.0** (0 dịch vụ mới) | 7.5 (Thêm Redis cluster) | 5.5 (Thêm Erlang node) | 2.5 (ZooKeeper/KRaft) |
| **Phục hồi thảm họa RPO/RTO (10%)** | **9.5** (PITR chuẩn PG WAL) | 6.5 (RDB/AOF async loss) | 6.0 (Queue mirror sync) | 7.0 (Topic retention sync) |
| **TỔNG ĐIỂM (100%)** | **98.0** | **68.5** | **64.0** | **65.5** |
| **Quyết định ADR** | **SELECTED** | **DEFERRED** | **REJECTED** | **REJECTED** |

---

## 4. Phân tích Chi tiết từng Ứng viên (Detailed Candidate Analysis)

### 4.1. PostgreSQL Native Queue (`FOR UPDATE SKIP LOCKED`) — LỰA CHỌN (SELECTED)
- **Lý do lựa chọn:**
  1. *Tính toàn vẹn giao dịch tuyệt đối:* Cho phép ghi nhận đồng thời việc kết thúc attempt, cập nhật trạng thái job, lưu trữ tạo tác artifact, sinh sự kiện outbox và khấu trừ ngân sách hạn mức trong duy nhất một transaction. Không tồn tại rủi ro mất mát dữ liệu hoặc phân mảnh trạng thái giữa DB và hàng đợi.
  2. *Dự phòng thông lượng vượt trội:* Đạt trên 2,300 claims/giây, gấp gần **8,000 lần** năng lực xử lý kết xuất thực tế của cụm worker ($0.30$ jobs/giây). Thắt nút cổ chai của hệ thống là **100% CPU Render/FFmpeg**, tuyệt đối không phải tầng điều phối cơ sở dữ liệu.
  3. *Hàng rào lease tự nhiên:* Cột `lease_epoch` kết hợp `lease_expires_at > now()` trong câu lệnh SQL bảo đảm tính bài xích đơn điệu mà không cần thêm thuật toán đồng thuận phân tán phức tạp.
  4. *Tối giản hạ tầng và an toàn vận hành:* Không làm phát sinh dịch vụ phụ thuộc mới, không tăng bề mặt tấn công mạng, không làm tăng chi phí RAM máy chủ theo trần ngân sách P9-01.

### 4.2. Redis / BullMQ — HOÃN LẠI (DEFERRED)
- **Đánh giá:** BullMQ là công cụ hàng đợi Node.js in-memory rất mạnh mẽ. Tuy nhiên:
  - *Rủi ro Dual-Write:* Khi API tiếp nhận job, hệ thống phải vừa ghi vào PostgreSQL vừa đẩy vào Redis. Nếu một trong hai bước gặp lỗi (mạng chập chờn, tiến trình sập giữa chừng), hệ thống rơi vào trạng thái bất nhất quán.
  - *Thiếu ACID Transactional Outbox:* Redis không thể tham gia vào giao dịch ACID của PostgreSQL. Việc gửi sự kiện outbox từ Redis có thể dẫn đến việc phát webhook cho một job mà transaction DB của nó đã bị rollback.
  - *Sự cố phân mảnh não (Split-brain):* Cơ chế khóa phân tán Redlock có các điểm yếu đã được chứng minh khi gặp gián đoạn đồng hồ máy chủ (clock drift) hoặc GC pauses.
- **Kết luận:** Hoãn lại. Chỉ xem xét như một kênh thông báo đánh thức (`push wake-up notification layer`) trong tương lai nếu tần suất thăm dò DB trở nên quá tải.

### 4.3. RabbitMQ (AMQP) — BÁC BỎ (REJECTED)
- **Đánh giá:** RabbitMQ đòi hỏi triển khai cụm Erlang chuyên dụng, quản lý queue mirroring, exchange bindings và consumer acknowledgments phức tạp. Vấn đề cốt tử là không thể kết hợp transactional commit giữa RabbitMQ và PostgreSQL nếu không dùng Two-Phase Commit (2PC / XA) — giải pháp gây giảm hiệu năng nghiêm trọng và dễ treo tài nguyên khi có sự cố.

### 4.4. Apache Kafka + Debezium CDC — BÁC BỎ (REJECTED)
- **Đánh giá:** Mô hình Change Data Capture (CDC) đọc PostgreSQL WAL qua Debezium rồi đẩy sang Kafka là giải pháp doanh nghiệp cho các hệ thống hàng triệu sự kiện mỗi giây. Đối với Creativanta Video Engine (tải tối đa 10 req/s theo [docs/TESTING.md](../../docs/TESTING.md)), chi phí hạ tầng (JVM, Kafka broker, Schema Registry, Connect workers) sẽ vượt gấp nhiều lần trần ngân sách toàn cụm ($350.40/tháng), vi phạm trực tiếp nguyên tắc tối ưu chi phí vận hành.

---

## 5. Quyết định Kiến trúc Chính thức (Architectural Decision)

Hệ thống **DUY TRÌ TOÀN DIỆN HÀNG ĐỢI NỘI TẠI POSTGRESQL** (`FOR UPDATE SKIP LOCKED`) làm cơ chế xếp hàng và điều phối công việc duy nhất cho Creativanta Video Engine. **KHÔNG** bổ sung standalone message broker (Redis, BullMQ, RabbitMQ, Kafka) ở giai đoạn này.

### Các bất biến kiến trúc không thể thương lượng (Non-Negotiable Invariants):
1. **Transactional Outbox nguyên tử:**
   Mọi sự kiện đầu ra (`job.succeeded`, `job.failed`, `job.canceled`) bắt buộc phải được ghi vào bảng `outbox` trong **cùng một giao dịch cơ sở dữ liệu** với lệnh cập nhật trạng thái kết thúc của job. Tuyệt đối không gửi webhook trực tiếp từ tiến trình render worker.
2. **Hàng rào Lease đơn điệu (`Monotonic Lease Fencing Token`):**
   Mỗi lần claim hoặc reclaim một công việc, giá trị `lease_epoch` bắt buộc phải tăng đơn điệu (`lease_epoch = lease_epoch + 1`). Mọi thao tác gia hạn nhịp tim (`heartbeat`), cập nhật tiến độ, hoặc xuất bản tạo tác phải có điều kiện `WHERE lease_epoch = :expected_epoch AND lease_expires_at > now()`. Bất kỳ yêu cầu nào mang epoch cũ đều bị cơ sở dữ liệu từ chối với mã lỗi `STALE_LEASE_EPOCH`.
3. **Phân bổ công bằng đa thuê bao (Tenant Fair-Share):**
   Cơ chế lấy job từ hàng đợi ưu tiên round-robin giữa các tenant có việc đang chờ; áp dụng giới hạn cứng tối đa 2 active jobs/tenant và tối đa 20 pending jobs/tenant. Ưu tiên trọng số 2:1 cho tác vụ `preview` so với `render` đầy đủ.

---

## 6. Ngưỡng Kích hoạt Đánh giá lại Broker trong Tương lai (Future Re-Evaluation Gate)

Việc bổ sung Message Broker hoặc kênh thông báo đánh thức (`Notification Broker`) sẽ **CHỈ ĐƯỢC XEM XÉT LẠI** khi thỏa mãn ít nhất một trong các điều kiện định lượng thực nghiệm sau:

| Điều kiện kích hoạt | Ngưỡng định lượng | Bằng chứng thực tế hiện tại |
| :--- | :---: | :---: |
| **Nhu cầu thông lượng điều phối** | $> 2,000$ claims/giây liên tục | Hiện tại: $\le 0.30$ jobs/giây (Tỷ lệ sử dụng $< 0.02\%$) |
| **Tải CPU cơ sở dữ liệu do thăm dò hàng đợi** | $> 60\%$ CPU sử dụng liên tục | Hiện tại: $< 2\%$ CPU trên máy chủ 4 vCPU |
| **Số lượng Render Slots của cụm** | $> 500$ worker slots đồng thời | Hiện tại: Tối đa 6 slots (bị kẹp ngân sách 3 nodes) |
| **Mô hình triển khai phân tán đa vùng** | Triển khai Active-Active Multi-Region | Hiện tại: Single-region isolated cluster |

Ngay cả khi một trong các điều kiện trên kích hoạt và tầng thông báo được bổ sung (ví dụ: dùng PostgreSQL `LISTEN/NOTIFY` hoặc Redis pub/sub để đánh thức worker thay vì polling), **bảng PostgreSQL `jobs` và `outbox` vẫn là nguồn chân lý duy nhất (Authoritative Source of Truth)**; quy trình claim, hàng rào fencing token và transactional outbox vẫn bắt buộc thực thi trên cơ sở dữ liệu quan hệ.
