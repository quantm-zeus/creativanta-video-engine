# @creativanta/sdk

Thư viện khách hàng TypeScript chính thức và bộ công cụ tích hợp cho **Creativanta Video Engine (CVE) REST API v1**.

Cung cấp kết nối hoàn toàn độc lập, **không giả định chia sẻ cơ sở dữ liệu (`no shared DB assumptions`)**, bảo đảm an toàn với định dạng khóa `Idempotency-Key` nghiêm ngặt, chuẩn hóa canonical request hash theo RFC 8785 (JCS), xác thực Webhook ký số HMAC-SHA256, đối soát trạng thái polling reconciliation (2s -> 10s), và tự động làm mới grant tải hết hạn (TTL <= 5 phút).

---

## 1. Cài đặt và Yêu cầu Môi trường

- **Node.js:** `>= 24.0.0`
- **TypeScript:** `>= 5.7.0`
- **Giao thức:** REST API v1 over HTTPS (hoặc HTTP loopback development)

---

## 2. Tài liệu Chi tiết

- [Hướng dẫn Tích hợp API Toàn diện (API Integration Guide)](docs/API_INTEGRATION_GUIDE.md)
- [Báo cáo Bằng chứng Nghiệm thu Nhiệm vụ P5-04](../../evidence/P5-04/report.md)
- [Đặc tả REST API v1 Chuẩn tắc](../../docs/API.md)
- [Đặc tả Scene Spec 1.0](../../docs/SCENE-SPEC.md)

---

## 3. Khởi tạo Khách hàng (Quick Start)

> [!NOTE]
> Mọi thông tin khóa API và bí mật ký số dưới đây là **giá trị giữ chỗ (placeholders)**. Tuyệt đối không hardcode khóa sản xuất trong mã nguồn.

```typescript
import {
  CreativantaClient,
  CreativantaWebhookReceiver,
  JobReconciliationManager,
} from '@creativanta/sdk';

// 1. Khởi tạo client
const client = new CreativantaClient({
  baseUrl: 'https://video.example.invalid/v1',
  apiKey: 'cve_live_placeholder_key_000000000000000000000000',
  timeoutMs: 15000,
  maxRetries: 3,
});

// 2. Tra cứu capabilities
const caps = await client.getCapabilities();

// 3. Khởi tạo template
const comp = await client.instantiateTemplate('tpl_retail_promo', {
  templateRevision: 1,
  name: 'Chiến dịch Khuyến mãi 2026',
  variables: {
    headline: 'Ưu Đãi Hôm Nay',
    price: '199.000 ₫',
  },
  locale: 'vi-VN',
  idempotencyKey: `idem_tpl_${Date.now()}`,
});

// 4. Gửi render job với externalReference
const job = await client.createRenderJob({
  compositionId: comp.id,
  revision: comp.revision,
  profile: 'mp4-720p-v1',
  externalReference: 'creativanta-order-2026-nov-001',
  idempotencyKey: `idem_render_${Date.now()}`,
});

// 5. Đối soát trạng thái và tải video
const recon = new JobReconciliationManager(client);
const finished = await recon.waitForJobTerminal(job.id);

const videoBuffer = await client.downloadArtifact(finished.artifacts[0].id, {
  verifyIntegrity: true,
});
```

---

## 4. Cấu trúc Mô-đun Xuất bản (Package Exports)

- `@creativanta/sdk`: Khách hàng HTTP, Webhook Receiver, Quản lý Reconciliation, và Mô phỏng Hợp đồng Mock Server.
- `@creativanta/sdk/client`: Chi tiết các lớp giao tiếp mạng, định nghĩa kiểu và lỗi định kiểu.
- `@creativanta/sdk/tts`: Giao thức và bộ điều phối tổng hợp giọng nói offline và cache dự phòng.
- `@creativanta/sdk/examples`: Các công thức mẫu tích hợp định kiểu và kịch bản xử lý lỗi/thử lại.

---

## 5. Lệnh Kiểm thử và Biên dịch

```bash
# Biên dịch TypeScript
pnpm --filter @creativanta/sdk build

# Kiểm tra kiểu (Typecheck)
pnpm --filter @creativanta/sdk typecheck

# Chạy toàn bộ bài kiểm thử SDK
node --test packages/sdk/test/**/*.test.mjs

# Chạy kịch bản ví dụ tích hợp
node packages/sdk/scripts/run-client-examples.mjs
```
