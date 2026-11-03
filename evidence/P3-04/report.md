# Báo cáo bằng chứng nghiệm thu nhiệm vụ P3-04

Báo cáo nghiệm thu kỹ thuật cho nhiệm vụ `P3-04` (`C / P3` — Remote Import Connector & Multi-Tier SSRF Defenses): Triển khai đầu nối nhập tài nguyên từ xa (remote import connector) đặt sau cờ tính năng mặc định tắt (`CVE_REMOTE_IMPORT_ENABLED=false`), tích hợp hệ thống phòng thủ SSRF đa tầng nghiêm ngặt (phòng vệ cú pháp WHATWG URL và chống parser differential, phát hiện mọi biểu diễn IP literal và số học thay thế, danh sách cho phép máy chủ quản lý theo từng tenant với ranh giới tiền tố nghiêm ngặt chống hijacking, kiểm toán phân giải DNS đối với toàn bộ dải IP cấm/nội bộ/metadata/multicast/IPv4-mapped, ghim IP tại thời điểm kết nối connect-time IP pinning ngăn chặn triệt để tấn công đổi bản ghi DNS rebinding, kiểm soát chuyển hướng redirect tối đa 3 bước với tái kiểm tra danh sách và IP tại mỗi chặng, giới hạn streaming 100 MiB, đối soát mã băm SHA-256 thực tế, thu nạp vào vùng kiểm dịch quarantine, thăm dò probe trong sandbox cô lập và bóc tách token nhạy cảm trong query string để lưu vết nguồn gốc bản quyền an toàn) cùng bộ kiểm thử đối kháng (adversarial suite) vượt qua toàn bộ 68 ca kiểm thử trước khi cờ được bật, tuân thủ chặt chẽ quy định tại [AGENTS.md](../../AGENTS.md), [docs/AGENTS.md](../../docs/AGENTS.md), [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md), [docs/SECURITY.md](../../docs/SECURITY.md), [docs/TESTING.md](../../docs/TESTING.md), [docs/SCENE-SPEC.md](../../docs/SCENE-SPEC.md) và [docs/API.md](../../docs/API.md).

```text
Task: P3-04
Base / tested commit: 5d2fc9eb1ac00277b5c6b6c9a9b2ddbfa97b034a / 0444dbdce66a0fd3401c9c691b7d9cc713f896aa
Environment: Linux x86_64, Debian 12 container, Node v24.22.2 (built-in node:sqlite, node:crypto & node:https), pnpm 12.16.1, TypeScript 5.7.3, Python 3.11.2
Command: PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -F @creativanta/api build && pnpm -F @creativanta/api test && pnpm test && node scripts/health-check.mjs && PATH=/usr/bin:$PATH python3 scripts/validate_repo.py
Result: PASS
Exit code / UTC started / duration: 0 / 2026-11-03T05:58:45Z / 35.2s
Artifacts:
  - packages/api/src/assets/ssrf-guard.ts, sha256=a542e0c26c5e50754afcfd67dc2c42e7310ca12cfcb2a77707e0e45d8710151c, expires=N/A (repo-versioned)
  - packages/api/src/assets/import-connector.ts, sha256=8afb89d9edf9497a3068beb45177fa09fb61fc62607530d775a7cdfec04fe9b6, expires=N/A (repo-versioned)
  - packages/api/src/db/repository.ts, sha256=2cf80b95e292acc3f5d8f6e6ee2e3891dc71f1c464d87c29e8f77bcff2a0d001, expires=N/A (repo-versioned)
  - packages/api/src/server.ts, sha256=d6617638897f5f2199a8b9e514c00d0a2212bcd11d37fabfb3c0e49e9ef54b21, expires=N/A (repo-versioned)
  - packages/api/src/index.ts, sha256=f305e6379a1a0a30e3678d819eb2928e93043673ddfc212f8a364bfcb8fed2ba, expires=N/A (repo-versioned)
  - packages/api/test/p3-04-import-connector.test.mjs, sha256=6623d51b1a7f1c1f649162127a03b2b7eb181085db72e542cfc3f3c393db3bcd, expires=N/A (repo-versioned)
  - evidence/P3-04/summary.json, sha256=3ab1bccd3cc63782b72b766cfc289558319e37c7785374de01b1328db78ea0ca, expires=N/A (repo-versioned)
Acceptance mapping:
  - Feature flag admission gate (CVE_REMOTE_IMPORT_ENABLED): PASS — Mặc định tắt (false); khi tắt, POST /v1/assets/imports bị chặn ngay tại admission gate với mã 403 CAPABILITY_DISABLED, không rò rỉ trạng thái hay kích hoạt network request. Bắt buộc quyền assets:write và header Idempotency-Key hợp lệ.
  - Syntactic URL validation & parser differential defenses: PASS — Chuẩn hóa cú pháp WHATWG URL nghiêm ngặt; bắt buộc HTTPS trên cổng 443; từ chối userinfo/credentials (@), URL fragments (#), ký tự điều khiển/NULL bytes, dấu gạch chéo ngược (\) và tấn công duyệt thư mục (path traversal ..) trước khi bộ phân giải URL có thể chuẩn hóa giấu đi.
  - IP literal & numeric alternate encoding defenses: PASS — Phát hiện và chặn mọi biểu diễn IP literal hoặc mã hóa số học thay thế (dotted-decimal, bracketed IPv6, DWORD integer 2130706433, hexadecimal 0x7f000001, octal 0177.0.0.1, mixed-base 127.0x0.01, short dotted 127.1) nhằm ngăn chặn vượt tường lửa.
  - Server-managed tenant allowlist: PASS — Chỉ cho phép tải từ các tên miền/tiền tố đường dẫn được máy chủ cấu hình cho từng tenant; kiểm tra ranh giới chính xác (boundary-enforced match), chặn tấn công chiếm dụng hậu tố (suffix hijacking); cách ly allowlist tuyệt đối giữa các tenant và cấm tenant tự đưa IP nội bộ vào allowlist.
  - DNS resolution & prohibited IP auditing: PASS — Phân giải toàn bộ bản ghi A/AAAA, duyệt qua tất cả địa chỉ IP phản hồi; chặn đứng Loopback (127.0.0.0/8), Link-Local (169.254.0.0/16), RFC 1918 (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16), CGNAT (100.64.0.0/10), Cloud Metadata (169.254.169.254, 100.100.100.200), Multicast, Broadcast, IPv6 Loopback (::1), ULA (fc00::/7) và IPv4-mapped IPv6 (::ffff:192.168.1.1); chặn phản hồi DNS đa homed chứa IP công khai lẫn IP nội bộ.
  - Connect-time IP pinning & anti-DNS-rebinding: PASS — Ghim trực tiếp địa chỉ IP đã qua kiểm duyệt bảo mật vào socket kết nối qua Agent lookup chuyên biệt nhưng giữ nguyên servername TLS SNI và kiểm tra chứng chỉ x509 theo tên miền gốc; ngăn chặn triệt để tấn công đổi IP giữa thời điểm kiểm tra và kết nối (DNS rebinding).
  - Multi-hop redirect defenses: PASS — Giới hạn tối đa 3 lần chuyển hướng (301, 302, 303, 307, 308); tái kiểm tra cú pháp, danh sách cho phép của tenant và phân giải IP cấm tại từng chặng; cấm chuyển hướng về IP nội bộ hoặc tên miền ngoài allowlist; không chuyển tiếp thông tin xác thực/cookies giữa các máy chủ.
  - Payload streaming & sandbox probe containment: PASS — Giới hạn kích thước streaming tối đa 100 MiB (ngắt luồng và trả 413 nếu vượt quá); đối soát mã băm SHA-256 thực tế với expected_sha256; tiếp nhận vào kho kiểm dịch quarantine cô lập; thực thi thăm dò probe bằng sandbox biệt lập, bẫy gọn HTML giả mạo video mà không làm gián đoạn hệ thống.
  - Rights provenance & query string token stripping: PASS — Bắt buộc siêu dữ liệu bản quyền (basis, source, attribution); kiểm tra thời hạn giấy phép (expires_at); tự động bóc tách các tham số query string nhạy cảm (OAuth tokens, signed URLs, chữ ký bảo mật) trước khi lưu trữ nguồn gốc vào cơ sở dữ liệu.
  - End-to-end import lifecycle & AMB-007 IDOR guarantee: PASS — Tiếp nhận yêu cầu nhập với 202 ACCEPTED và trạng thái ban đầu processing; hỗ trợ phát lại idempotent an toàn; thăng cấp trạng thái sang ready khi tải và probe thành công; đảm bảo Tenant B thăm dò tài nguyên của Tenant A luôn nhận về 404 NOT_FOUND (không bao giờ trả 403).
Reviewer / reviewed commit / decision: pending independent reviewer / 0444dbdce66a0fd3401c9c691b7d9cc713f896aa / local completion awaiting review
```

---

## 1. Tóm tắt kết quả thực thi (Executive Summary)

Nhiệm vụ **P3-04** (`C / P3`) hiện thực hóa toàn diện đầu nối nhập tài nguyên từ xa và bộ phòng vệ SSRF đa tầng theo các yêu cầu nghiêm ngặt tại [docs/SECURITY.md](../../docs/SECURITY.md) (dòng 25–32), [docs/API.md](../../docs/API.md) (dòng 35) và [docs/IMPLEMENTATION_PLAN.md](../../docs/IMPLEMENTATION_PLAN.md):

1. **Bộ Cổng Cờ Tính Năng & Tiếp Nhận Ủy Quyền (Admission & Policy Gate - [server.ts](../../packages/api/src/server.ts)):**
   - Mặc định cờ tính năng `CVE_REMOTE_IMPORT_ENABLED=false` theo [docs/SECURITY.md](../../docs/SECURITY.md) dòng 27 ("Mặc định remote imports off; upload là baseline").
   - Khi cờ tắt, mọi yêu cầu tới `POST /v1/assets/imports` bị từ chối ngay lập tức với mã HTTP `403 CAPABILITY_DISABLED` mà không thực hiện bất kỳ truy vấn DNS hay kết nối mạng nào.
   - Khi cờ bật, yêu cầu bắt buộc phải có quyền `assets:write` từ API key và tiêu đề `Idempotency-Key` hợp lệ (tuân thủ RFC 7230/7231). Hỗ trợ phát lại idempotent an toàn với cờ phản hồi `Idempotency-Replayed: true`.

2. **Phòng Vệ Cú Pháp URL & Ngăn Chặn Parser Differential ([ssrf-guard.ts](../../packages/api/src/assets/ssrf-guard.ts)):**
   - Áp dụng bộ phân tích chuẩn WHATWG URL đồng nhất (`new URL()`) để triệt tiêu chênh lệch giữa các thư viện HTTP parser.
   - Bắt buộc giao thức an toàn `https:` (từ chối `http:`, `ftp:`, `file:`, `data:`, `gopher:`, `blob:` với mã lỗi `UNSUPPORTED_SCHEME`).
   - Giới hạn cổng mặc định `443` (từ chối mọi cổng khác với mã lỗi `UNSUPPORTED_PORT`).
   - Cấm tuyệt đối thông tin xác thực/userinfo (`user:pass@host`) chống lừa đảo phân giải và rò rỉ credential (`USERINFO_PROHIBITED`).
   - Cấm mảnh URL (`#`) chống kỹ thuật lách bộ lọc (`URL_FRAGMENT_PROHIBITED`).
   - Cấm ký tự dấu gạch chéo ngược (`\`) chống kỹ thuật parser differential giữa URL parsers (`INVALID_URL_SYNTAX`).
   - Cấm ký tự điều khiển, ký tự xuống dòng (`\r\n`), NULL bytes (`\0`) chống kỹ thuật HTTP request smuggling.
   - Phát hiện và từ chối các chuỗi duyệt thư mục (`..`, `/.`, `%2e%2e`) trước khi bộ phân giải URL tự động chuẩn hóa giấu đi (`PATH_TRAVERSAL_DETECTED`).

3. **Phát Hiện & Chặn Đứng Địa Chỉ IP Literal và Mã Hóa Số Học Thay Thế ([ssrf-guard.ts](../../packages/api/src/assets/ssrf-guard.ts)):**
   - Ngăn chặn triệt để việc nhắm mục tiêu trực tiếp tới địa chỉ IP thay vì tên miền FQDN đã được kiểm duyệt (`IP_LITERAL_PROHIBITED`).
   - Nhận diện toàn bộ các định dạng biểu diễn:
     - IP thập phân phân tách dấu chấm: `127.0.0.1`, `10.0.0.1`, `192.168.1.1`, `169.254.169.254`.
     - IPv6 ngoặc vuông: `[::1]`, `[fe80::1]`, `[::ffff:127.0.0.1]`.
     - Mã hóa số nguyên DWORD (integer encoding): `2130706433`.
     - Mã hóa hệ thập lục phân (hexadecimal): `0x7f000001`, `0x7f.0.0.1`.
     - Mã hóa hệ bát phân (octal): `0177.0.0.1`.
     - Biểu diễn kết hợp cơ số (mixed-base): `127.0x0.01`, `127.1`.

4. **Danh Sách Cho Phép Máy Chủ Quản Lý Theo Tenant (Server-Managed Tenant Allowlist - [ssrf-guard.ts](../../packages/api/src/assets/ssrf-guard.ts) & [repository.ts](../../packages/api/src/db/repository.ts)):**
   - Danh sách allowlist được quản lý ở tầng máy chủ (`tenant_import_allowlists`), cách ly độc lập giữa các tenant.
   - So khớp ranh giới tên miền và tiền tố đường dẫn chính xác (boundary-enforced matching): tên miền phải khớp hoàn toàn hoặc là tiền tố đường dẫn hợp lệ. Cấm tuyệt đối so khớp hậu tố không có ranh giới (`endsWith('example.com')`) để chống tấn công chiếm dụng hậu tố tên miền (suffix hijacking, ví dụ `approved-stock.example.invalid.attacker.com`).
   - Tenant không có quyền tự đưa các dải IP nội bộ hoặc endpoint nhạy cảm vào danh sách (`self_whitelisting_prohibited`).

5. **Kiểm Toán Phân Giải DNS & Dải IP Bị Cấm ([ssrf-guard.ts](../../packages/api/src/assets/ssrf-guard.ts)):**
   - Sử dụng bộ phân giải DNS độc lập (`node:dns/promises` hoặc mock resolver trong kiểm thử), truy vấn toàn bộ bản ghi A (IPv4) và AAAA (IPv6).
   - Kiểm toán toàn diện tất cả địa chỉ IP được trả về chống lại danh sách khối dải mạng bị cấm theo chuẩn CIDR:
     - Dải Loopback: `127.0.0.0/8`, `::1/128`.
     - Dải Mạng riêng RFC 1918: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
     - Dải Link-Local & Cloud Metadata: `169.254.0.0/16`, `fe80::/10`, `169.254.169.254`, `100.100.100.200`.
     - Dải Carrier-Grade NAT (CGNAT): `100.64.0.0/10`.
     - Dải Unique Local Address (ULA): `fc00::/7`.
     - Dải Multicast & Reserved: `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255/32`, `ff00::/8`.
     - Dải IPv4-mapped IPv6: `::ffff:0:0/96` (giải nén phần IPv4 nhúng và kiểm tra đối chiếu qua toàn bộ danh sách IPv4).
   - Kiểm toán đa homed (multi-homed DNS): Nếu DNS trả về cả IP công khai hợp lệ lẫn IP nội bộ độc hại, hệ thống lập tức từ chối toàn bộ kết nối.

6. **Ghim Địa Chỉ IP Tại Thời Điểm Kết Nối & Chống Đổi DNS Rebinding ([import-connector.ts](../../packages/api/src/assets/import-connector.ts)):**
   - Ghim trực tiếp địa chỉ IP hợp lệ đã được kiểm duyệt an toàn (`pinnedIp`) vào hàm `lookup` tùy biến của `https.Agent` (hỗ trợ cả định dạng lookup đơn và mảng `{ all: true }`).
   - Duy trì thuộc tính `servername` TLS SNI và kiểm tra chứng chỉ x509 theo tên miền FQDN gốc, đảm bảo tính toàn vẹn kênh truyền mã hóa TLS mà không bị vô hiệu hóa xác thực tên miền.
   - Ngăn chặn triệt để kỹ thuật tấn công đổi bản ghi DNS (DNS rebinding / TOCTOU - Time-Of-Check to Time-Of-Use).

7. **Kiểm Soát Chuyển Hướng Đa Chặng (Redirect Defenses - [import-connector.ts](../../packages/api/src/assets/import-connector.ts)):**
   - Giới hạn tối đa 3 lần chuyển hướng (`maxRedirects = 3`), phát hiện và cắt đứt vòng lặp chuyển hướng vô hạn (`MAX_REDIRECTS_EXCEEDED`).
   - Tái kiểm tra tính hợp lệ cú pháp, danh sách cho phép của tenant và kiểm toán DNS phân giải IP tại từng chặng chuyển hướng.
   - Cấm chuyển hướng tới IP nội bộ/metadata hoặc tên miền chưa được duyệt.
   - Tuyệt đối không chuyển tiếp thông tin xác thực (`Authorization`) hoặc cookies giữa các máy chủ khác nhau.

8. **Bảo Vệ Luồng Tải & Thăm Dò Sandbox Cô Lập ([import-connector.ts](../../packages/api/src/assets/import-connector.ts)):**
   - Giới hạn thời gian kết nối `connectTimeoutMs = 3000ms` (3 giây) và tổng thời gian tải `totalTimeoutMs = 30000ms` (30 giây) theo [docs/SECURITY.md](../../docs/SECURITY.md) dòng 31.
   - Giới hạn kích thước streaming tối đa `100 MiB` (`104,857,600` bytes): kiểm tra cả tiêu đề `Content-Length` lẫn đếm số byte thực tế trong luồng dữ liệu; hủy kết nối (`req.destroy()`) ngay khi vượt ngưỡng.
   - Tính toán mã băm SHA-256 từ luồng byte thực tế và đối soát nghiêm ngặt với `expected_sha256` của người dùng; từ chối với `CHECKSUM_MISMATCH` nếu sai lệch.
   - Dữ liệu tải về được đưa vào vùng lưu trữ kiểm dịch (`QuarantineStore`) có kiểm soát chống path traversal.
   - Thăm dò siêu dữ liệu và cấu trúc container media bằng sandbox biệt lập (`executeSandboxMediaProbe` qua tiến trình con `ffprobe` với các cờ hạn chế quyền tối đa); bẫy gọn tệp HTML giả mạo video mà không gây lỗi máy chủ.
   - Chỉ khi toàn bộ kiểm tra thành công, tài nguyên mới được thăng cấp vào kho lưu trữ chính thức và cập nhật trạng thái `ready`.

9. **Bảo Đảm Bản Quyền & Bóc Tách Token Nhạy Cảm (Rights Provenance & Token Sanitization - [import-connector.ts](../../packages/api/src/assets/import-connector.ts)):**
   - Bắt buộc cấu trúc bản quyền: cơ sở pháp lý `rights.basis` (`owned`, `licensed`, `public_domain`), nguồn gốc `source`, và đơn vị cấp phép `attribution`.
   - Kiểm tra thời hạn bản quyền: từ chối các giấy phép đã hết hạn (`RIGHTS_EXPIRED`).
   - Tự động bóc tách và loại bỏ toàn bộ tham số truy vấn (`query string`) và mảnh (`fragment`) khỏi URL nguồn khi lưu vào cơ sở dữ liệu (`sanitizeSourceUrl`), đảm bảo các chữ ký tạm thời (signed URL tokens, OAuth credentials) không bị rò rỉ trong log hay bản ghi lưu trữ.

10. **Cách Ly Tuyệt Đối Chuẩn AMB-007 (Foreign Asset 404 Isolation):**
    - Đảm bảo khi Tenant B cố tình truy vấn định danh tài nguyên nhập của Tenant A qua `GET /v1/assets/{id}`, hệ thống luôn trả về `404 NOT_FOUND` (không bao giờ trả `403 FORBIDDEN`), loại bỏ hoàn toàn nguy cơ rò rỉ định danh tài nguyên (resource existence oracle).

---

## 2. Nhật ký kiểm tra thực tế (Execution Log & Verification Checks)

| # | Lệnh kiểm tra | Mã thoát | Kết quả | Ghi chú |
|---|---|---|---|---|
| 1 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -F @creativanta/api build` | `0` | `PASS` | Biên dịch TypeScript `@creativanta/api` sang ESM `dist/` thành công không có lỗi |
| 2 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm typecheck` | `0` | `PASS` | Kiểm tra hệ thống kiểu tĩnh TypeScript trên toàn bộ 5 packages trong monorepo |
| 3 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm lint` | `0` | `PASS` | Kiểm tra quy chuẩn mã nguồn tĩnh trên toàn bộ monorepo |
| 4 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm -F @creativanta/api test` | `0` | `PASS` | Chạy 127 bài kiểm tra (18 bài P3-01, 41 bài P3-02, 68 bài P3-04 và health-check) |
| 5 | `PATH=/usr/local/lib/node_modules/corepack/shims:/usr/bin:$PATH pnpm test` | `0` | `PASS` | Chạy toàn bộ test suites trên cả 5 packages trong workspace |
| 6 | `node scripts/health-check.mjs` | `0` | `PASS` | Xác nhận `/healthz`, `/readyz`, cấu hình adapter và khả năng engine |
| 7 | `PATH=/usr/bin:$PATH python3 scripts/validate_repo.py` | `0` | `PASS` | Kiểm tra toàn vẹn 16 tài liệu, 386 liên kết nội bộ, 16 khối JSON, và DAG 52 nhiệm vụ |

---

## 3. Các cổng phê duyệt bên ngoài đang chờ (Pending External Gates)

1. **Independent Reviewer & Staging CI Gate:** Chờ supervisor tích hợp nhánh `agy/p3-04` vào `staging`, chạy GitHub Actions CI và người đánh giá độc lập phê duyệt nghiệm thu nhiệm vụ `P3-04`.
2. **Feature Flag Production Gate (`CVE_REMOTE_IMPORT_ENABLED`):** Giữ nguyên giá trị mặc định `false` trong môi trường sản xuất; cờ tính năng chỉ được kích hoạt khi có chính sách phê duyệt từ bộ phận bảo mật và danh sách tên miền đối tác được kiểm toán chính thức.
3. **Nhiệm vụ tiếp theo mở khóa:** Nhiệm vụ `P3-04` hoàn tất giai đoạn `P3` (Multi-tenant Foundation, Ingestion & Security Guards), mở khóa giai đoạn `P4` (Dispatcher, Lease Scheduler & Scalable Execution: `P4-01` Dispatcher & lease scheduler, `P4-02` Worker pool & render daemon).
