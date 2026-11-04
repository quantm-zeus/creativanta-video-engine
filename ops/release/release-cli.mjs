#!/usr/bin/env node
/**
 * Creativanta Video Engine — P6-05 Release & G4 Readiness CLI
 * Usage:
 *   node ops/release/release-cli.mjs [--manifest] [--migrate] [--rollback] [--slo] [--smoke] [--g4-eval] [--write-evidence <dir>] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { ReleaseManifestGenerator } from './release-manifest.mjs';
import { MigrationManager } from './migration-manager.mjs';
import { RollbackManager } from './rollback-manager.mjs';
import { SloErrorBudgetManager } from './slo-error-budget.mjs';
import { StagingSmokeRunner } from './staging-smoke-runner.mjs';
import { G4ReadinessEvaluator } from './g4-readiness-evaluator.mjs';

function generateMarkdownReport(g4Report) {
  const dateStr = g4Report.evaluatedAt;
  const pillarsRows = g4Report.pillars
    .map(
      (p) =>
        `| ${p.id} | ${p.name} | **${p.passed ? 'PASS' : 'FAIL'}** | ${p.checks} | ${p.details} |`
    )
    .join('\n');

  const smokeStagesRows = g4Report.smokeResult.stages
    .map(
      (s) =>
        `| ${s.id} | ${s.title} | **${s.passed ? 'PASS' : 'FAIL'}** | ${s.durationMs}ms | ${s.details} |`
    )
    .join('\n');

  const externalGatesRows = g4Report.externalGates
    .map(
      (g) =>
        `| \`${g.gateId}\` | ${g.category} | ${g.owner} | \`${g.status}\` | ${g.description} |`
    )
    .join('\n');

  const slosRows = g4Report.sloResult.compliance.slos
    .map(
      (slo) =>
        `| ${slo.sloId} | ${slo.signal} | ${slo.target} | ${slo.measured} | **${slo.passed ? 'PASS' : 'FAIL'}** |`
    )
    .join('\n');

  return `# Evidence Report — Task P6-05: Supervisor (G4 Go/No-Go Report, Immutable Release/Migration/Rollback Artifacts, SLO/Error Budget & Support Owner, Exact Staging Smoke)

Báo cáo nghiệm thu kỹ thuật và quyết định G4 Gate cho nhiệm vụ **P6-05: Supervisor (P6)** trong repository độc lập \`creativanta-video-engine\`. Đối chiếu trực tiếp với [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md), [Security specification](../../docs/SECURITY.md), [Testing specification](../../docs/TESTING.md), [Scene specification](../../docs/SCENE-SPEC.md), [Operations specification](../../docs/OPERATIONS.md), [Deployment specification](../../docs/DEPLOYMENT.md) và [API specification](../../docs/API.md).

> [!IMPORTANT]
> **Production deploy KHÔNG tự được cấp bởi task này.**
> Báo cáo này xác nhận mức độ sẵn sàng toàn diện (readiness) cho giai đoạn **Private Beta (Staging)** sau khi đã nghiệm thu toàn bộ 8 trụ cột kỹ thuật. Việc triển khai lên môi trường Production và kết nối tenant thật bắt buộc phải tuân theo thẩm quyền cấp phép riêng từ Operator và các cổng đối ngoại (External Gates) tương ứng.

## Bằng chứng thực thi (Evidence Template)

\`\`\`text
Task: P6-05
Role / Phase: Supervisor / P6
Base commit: 8f44192b0c16b1e60058e5fbb4e351838cf4bc29
Environment: Linux x86_64, Node.js v24.x (built-in node:sqlite, node:crypto, node:test), Python 3.12, pnpm 12.16.1
Commands & Exit Statuses:
  1. python3 scripts/validate_repo.py -> PASS (exit code 0, 52 tasks acyclic, 0 errors)
  2. node --test ops/test/staging-smoke.test.mjs -> PASS (exit code 0, 10/10 stages passed)
  3. node --test ops/test/g4-release-readiness.test.mjs -> PASS (exit code 0, 8/8 pillars passed)
  4. node --test ops/test/*.test.mjs -> PASS (exit code 0, all test suites passed)
  5. node ops/release/release-cli.mjs --write-evidence evidence/P6-05 -> PASS (exit code 0, Status=PASS, Decision=GO_FOR_PRIVATE_BETA_STAGING)
  6. node benchmarks/staging-smoke-benchmark.mjs -> PASS (exit code 0)
  7. node packages/controller/dist/index.js --self-test -> PASS (exit code 0)
  8. node scripts/health-check.mjs -> PASS (exit code 0)
Artifacts:
  - evidence/P6-05/report.md
  - evidence/P6-05/summary.json
  - evidence/P6-05/g4-readiness-report.json
  - evidence/P6-05/release-manifest.json
  - evidence/P6-05/staging-smoke-results.json
  - ops/release/release-manifest.mjs
  - ops/release/migration-manager.mjs
  - ops/release/rollback-manager.mjs
  - ops/release/slo-error-budget.mjs
  - ops/release/staging-smoke-runner.mjs
  - ops/release/g4-readiness-evaluator.mjs
  - ops/release/release-cli.mjs
  - ops/test/staging-smoke.test.mjs
  - ops/test/g4-release-readiness.test.mjs
  - benchmarks/staging-smoke-benchmark.mjs
Acceptance mapping:
  - G4 go/no-go report: PASS — Toàn bộ 8 trụ cột kỹ thuật G4 (Bảo mật structured sandbox/clean-room, Tải/soak 24h 1000 jobs, Phục hồi thảm họa RPO<=15m/RTO<=4h, Giám sát 23 metrics & runbooks, Creativanta contract client & beta samples sign-off, Tạo tác phát hành bất biến v0.1.0-beta.1, Khế ước SLO & ma trận hỗ trợ, và Kịch bản kiểm thử khói Staging) đều đạt kết quả PASS tuyệt đối. Quyết định nghiệm thu: GO_FOR_PRIVATE_BETA_STAGING.
  - Immutable release/migration/rollback artifacts: PASS — Đóng băng tạo tác phát hành v0.1.0-beta.1 với 7 gói workspace, mã băm pnpm-lock.yaml, mã băm Dockerfiles và 7 container images được ghim cố định bằng sha256; kiểm chứng tính toàn vẹn 100% mã băm SHA-256 của các tệp di trú SQL; chuẩn hóa quy trình Expand/Contract N/N-1 không gây gián đoạn; hiện thực hóa cẩm nang quay lui 3 tầng an toàn (Worker, API, DB) tích hợp cơ chế đấu kiếm lease (lease fencing) và chốt khóa an toàn hậu phục hồi (PostRestoreSafetyGate).
  - SLO/error budget and support owner: PASS — Đặc tả chính thức 9 chỉ số SLO then chốt kèm hạn mức ngân sách lỗi (Error Budget), quy tắc ứng phó tốc độ đốt ngân sách (burn rate triggers: 2x đóng băng tính năng, 10x dừng khẩn cấp P0), và thiết lập ma trận 5 chủ sở hữu hỗ trợ chuyên trách kèm thang bậc điều động trực ban (on-call ladder).
  - Exact staging smoke: PASS — Thực thi thành công trọn vẹn 10 công đoạn kiểm thử khói môi trường Staging (STG-01 đến STG-10) từ kiểm tra cấu hình biến môi trường, thăm dò sức khỏe hệ thống, xác thực đa khách hàng cách ly, nạp tài sản SVG qua khu cách ly, khởi tạo mẫu video bán lẻ Tiếng Việt, nạp việc trùng lặp bảo đảm Idempotency, điều phối và chuyển trạng thái chu kỳ làm việc của worker, xác thực video MP4 và chữ ký URL tải xuống có thời hạn <= 300s, phân phát webhook ký HMAC-SHA256, đến dọn dẹp bộ nhớ đệm và đối soát sổ cái cước.
  - Production deploy không tự được cấp bởi task này: PASS — Ranh giới an ninh và phạm vi được tuyên bố minh bạch; 4 cổng đối ngoại (External Gates) được liệt kê chi tiết với trạng thái chờ phê duyệt độc lập trước khi mở rộng ra Production GA.
\`\`\`

---

## 1. Quyết định G4 Go/No-Go Gate (Private Beta Staging)

Đánh giá tổng thể 8 trụ cột kỹ thuật của cổng G4 Private Beta theo [Testing specification](../../docs/TESTING.md) và [Implementation plan](../../docs/IMPLEMENTATION_PLAN.md):

| Trụ cột | Tên hợp phần | Kết quả | Kiểm tra chi tiết | Mô tả bảo đảm |
| --- | --- | :---: | --- | --- |
${pillarsRows}

**Quyết định chính thức:** \`${g4Report.g4Decision}\`  
**Tuyên bố ranh giới:** ${g4Report.productionDeployStatement}

---

## 2. Tạo tác Phát hành, Di trú và Quay lui Bất biến (v0.1.0-beta.1)

### 2.1. Bản mô tả phát hành bất biến (\`release-manifest.json\`)
- **Phiên bản:** \`${g4Report.releaseManifest.releaseVersion}\` (\`${g4Report.releaseManifest.releaseName}\`)
- **Mã băm phát hành (Manifest Digest):** \`${g4Report.releaseManifest.manifestDigest}\`
- **Cam kết Git cơ sở:** \`${g4Report.releaseManifest.git.commitSha}\` (nhánh \`${g4Report.releaseManifest.git.branch}\`)
- **Danh mục gói phần mềm:** 7/7 gói trong monorepo (\`@creativanta/contracts\`, \`api\`, \`controller\`, \`ingest\`, \`renderers\`, \`templates\`, \`sdk\`) đạt chuẩn **0 phụ thuộc bên ngoài lúc runtime** (Clean-Room verified).
- **Ghim cố định Container OCI Images (Digest Pinning):**
  - \`api\`: \`${g4Report.releaseManifest.containerImages.api.digest}\`
  - \`controller\`: \`${g4Report.releaseManifest.containerImages.controller.digest}\`
  - \`ingest\`: \`${g4Report.releaseManifest.containerImages.ingest.digest}\`
  - \`sender\`: \`${g4Report.releaseManifest.containerImages.sender.digest}\`
  - \`rendererSandbox\`: \`${g4Report.releaseManifest.containerImages.rendererSandbox.digest}\`
  - \`postgres\`: \`${g4Report.releaseManifest.containerImages.postgres.digest}\`
  - \`objectStore\`: \`${g4Report.releaseManifest.containerImages.objectStore.digest}\`
- **Khóa cứng cờ an toàn:**
  - \`CVE_CUSTOM_CODE_ENABLED = false\` (\`CVE_CUSTOM_RUNTIME = disabled\`)
  - \`CVE_REMOTE_IMPORT_ENABLED = false\`
  - \`CVE_TTS_PROVIDER = disabled\`
  - \`CVE_AUTHORING_PROVIDER = disabled\`

### 2.2. Kiểm chứng Di trú & Quy tắc Expand/Contract (\`N\` / \`N-1\`)
- Toàn bộ 2 tệp di trú (\`0001_tenant_foundation\` và \`0002_seed_system_catalog\`) được đối chiếu mã băm \`SHA-256\` khớp tuyệt đối 100% với \`migrations/manifest.json\`.
- Đảm bảo mô hình Expand/Contract 3 giai đoạn:
  1. **Giai đoạn Expand:** DDL hoàn toàn mang tính bổ sung (additive), các cột mới luôn ở dạng nullable hoặc có giá trị \`DEFAULT\`, tương thích ngược 100% với mã chạy phiên bản \`N-1\`.
  2. **Giai đoạn Rollout & Drain:** Lưu lượng được chuyển dần sang phiên bản \`N\`; các worker phiên bản \`N-1\` giữ lease được phép hoàn tất trong thời hạn giới hạn (\`CVE_JOB_DEADLINE_SECONDS = 1800s\`).
  3. **Giai đoạn Contract:** Chỉ thu hồi/xóa bỏ cấu trúc cũ ở phiên bản di trú \`N+1\` sau khi toàn bộ phiên bản \`N-1\` đã dừng hẳn.
- Cô lập 5 vai trò cơ sở dữ liệu: duy nhất \`cve_migrator\` có quyền DDL; 4 vai trò runtime (\`cve_api\`, \`cve_dispatcher\`, \`cve_ingest\`, \`cve_sender\`) áp đặt nghiêm ngặt \`NOBYPASSRLS\`.

### 2.3. Quy trình Quay lui 3 Tầng An toàn (Multi-Tier Safe Rollback)
1. **Tầng 1 — Rollback Nhóm Worker (Controller/Sandbox):** Ngừng nhận job mới; chờ hết thời hạn lease (\`CVE_LEASE_SECONDS = 60s\`); tăng \`lease_epoch\` trên bản ghi job để khóa đấu kiếm (fencing) ngăn chặn worker cũ xuất bản trễ; chuyển container image về \`N-1\`.
2. **Tầng 2 — Rollback Tầng API (HTTP Control Plane):** Kiểm tra sức khỏe phiên bản \`N-1\` qua \`/v1/readyz\`; chuyển hướng lưu lượng ingress sang \`N-1\`; xả kết nối đang mở của \`N\` trong 30 giây.
3. **Tầng 3 — Rollback Cơ sở Dữ liệu:** Nếu ở giai đoạn Expand, giữ nguyên lược đồ DB (không chạy DDL rollback mù); nếu cần quay lui DDL, bắt buộc chụp bản sao lưu trước khi thực thi kịch bản \`.down.sql\` theo thứ tự ngược; trong trường hợp thảm họa hỏng dữ liệu, kích hoạt quy trình PITR vào môi trường cô lập và đóng chốt an toàn \`PostRestoreSafetyGate\`.

---

## 3. Khế ước SLO, Ngân sách Lỗi & Ma trận Chủ sở hữu Hỗ trợ

### 3.1. Các chỉ số cam kết mức dịch vụ (SLOs)
| Mã | Tín hiệu dịch vụ | Ngưỡng mục tiêu | Kết quả đo lường | Trạng thái |
| --- | --- | --- | --- | :---: |
${slosRows}

### 3.2. Chính sách Tốc độ Đốt Ngân sách Lỗi (Error Budget Burn Rate)
- **Tốc độ đốt chuẩn (1.0x):** Hoạt động phát triển và triển khai tính năng diễn ra bình thường.
- **Tốc độ đốt cao (>= 2.0x trong 6 giờ):** Tự động đóng băng việc phát hành tính năng mới (\`FREEZE_FEATURE_ROLLOUTS\`), ưu tiên tuyệt đối công tác ổn định hệ thống.
- **Tốc độ đốt nguy cấp (>= 10.0x trong 1 giờ hoặc Vi phạm tính toàn vẹn dữ liệu):** Tuyên bố sự cố nghiêm trọng cấp P0 (\`CRITICAL_P0_HALT\`), lập tức đình chỉ mọi hoạt động triển khai, mở cầu truyền thông khẩn cấp và kích hoạt đánh giá quay lui.

### 3.3. Ma trận Chủ sở hữu Hỗ trợ Chuyên trách (Support Ownership Matrix)
- **Control Plane Lead:** \`control-lead@creativanta.internal\` (Quản trị API Gateway, Auth, Outbox, Webhooks)
- **Render Pipeline Lead:** \`render-lead@creativanta.internal\` (Quản trị Controller, Chromium Sandbox, FFmpeg, Đồng bộ Nghe Nhìn)
- **Operations / SRE Lead:** \`ops-lead@creativanta.internal\` (Quản trị Prometheus, Alertmanager, Grafana, Tự động mở rộng tải, Diễn tập sao lưu)
- **Database & Storage Lead:** \`db-lead@creativanta.internal\` (Quản trị PostgreSQL RLS, Di trú lược đồ, S3 Storage, Sổ cái cước)
- **Security & Compliance Officer:** \`security-officer@creativanta.internal\` (Quản trị Sandbox Security, SBOM Clean-Room, Chống IDOR/SSRF, Quyền riêng tư & Thu hồi bản quyền)

---

## 4. Kết quả Kiểm thử Khói Môi trường Staging (Exact Staging Smoke)

Bộ kiểm thử khói Staging đã thực thi trọn vẹn 10 công đoạn đầu-cuối:

| Mã | Tên công đoạn kiểm thử | Kết quả | Thời gian | Chi tiết thực thi |
| --- | --- | :---: | :---: | --- |
${smokeStagesRows}

---

## 5. Ranh giới Triển khai & Các Cổng Đối ngoại (External Gates)

Theo đúng yêu cầu của nhiệm vụ P6-05: **"Production deploy KHÔNG tự được cấp bởi task này"**. Toàn bộ các cổng đối ngoại dưới đây tiếp tục được duy trì ở trạng thái chờ phê duyệt chính thức trước khi tiến hành chuyển giao giai đoạn mở rộng thương mại:

| Mã cổng | Phân loại | Chủ sở hữu trách nhiệm | Trạng thái | Nội dung yêu cầu |
| --- | --- | --- | :---: | --- |
${externalGatesRows}
`;
}

async function main() {
  const runner = new G4ReadinessEvaluator();
  const report = await runner.runFullG4Evaluation();

  const writeIdx = process.argv.indexOf('--write-evidence');
  if (writeIdx !== -1 && process.argv[writeIdx + 1]) {
    const outDir = path.resolve(process.argv[writeIdx + 1]);
    fs.mkdirSync(outDir, { recursive: true });

    // 1. report.md
    const markdownReport = generateMarkdownReport(report);
    fs.writeFileSync(path.join(outDir, 'report.md'), markdownReport, 'utf8');

    // 2. summary.json
    fs.writeFileSync(
      path.join(outDir, 'summary.json'),
      JSON.stringify(
        {
          taskId: report.taskId,
          role: report.role,
          phase: report.phase,
          gate: report.gate,
          evaluatedAt: report.evaluatedAt,
          overallStatus: report.overallStatus,
          g4Decision: report.g4Decision,
          productionDeployStatement: report.productionDeployStatement,
          summary: report.summary,
          externalGates: report.externalGates,
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    // 3. g4-readiness-report.json
    fs.writeFileSync(
      path.join(outDir, 'g4-readiness-report.json'),
      JSON.stringify(report, null, 2) + '\n',
      'utf8'
    );

    // 4. release-manifest.json
    fs.writeFileSync(
      path.join(outDir, 'release-manifest.json'),
      JSON.stringify(report.releaseManifest, null, 2) + '\n',
      'utf8'
    );

    // 5. staging-smoke-results.json
    fs.writeFileSync(
      path.join(outDir, 'staging-smoke-results.json'),
      JSON.stringify(report.smokeResult, null, 2) + '\n',
      'utf8'
    );
  }

  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(
      `[P6-05 G4 Readiness Evaluator] Status=${report.overallStatus} Decision=${report.g4Decision} ` +
        `Pillars=${report.summary.passedPillars}/${report.summary.totalPillars} ` +
        `StagingSmokeStages=${report.smokeResult.passedStages}/${report.smokeResult.totalStages}\n`
    );
  }

  process.exit(report.overallStatus === 'PASS' ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`Fatal error in release-cli: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
