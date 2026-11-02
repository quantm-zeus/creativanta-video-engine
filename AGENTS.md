# Quy tắc cho agent trong repository

Áp dụng toàn repo, bổ sung bởi [quy trình AGY](docs/AGENTS.md). Không suy diễn lộ trình thành quyền deploy hoặc sửa dự án khác.

## Ranh giới

- Chỉ làm việc trong `/home/whaleorcale/evergreen/projects/creativanta-video-engine`. Phiên thiết kế được đọc thêm `/tmp/video-engine-research.json`, không sửa file đó. Không sửa Creativanta hiện hữu, VPS, host services, credentials, DNS hoặc deployment.
- Phiên thiết kế chỉ tạo/chỉnh docs và commit local: không viết app, cài/chạy code upstream, khởi động AGY hay push. Task thiết kế `DOC-001` ghi evidence trong [Execution log](docs/EXECUTION_LOG.md).
- Phiên triển khai sau handoff chỉ làm task được giao trong [plan](docs/IMPLEMENTATION_PLAN.md). Contract harness Creativanta ở đây có thể triển khai theo task; sửa repo Creativanta thật cần scope riêng được cấp.
- Không generative video GPU, không paid AI-video generation, không bắt buộc premium model. Không chạy code do agent/user sinh trong API hoặc supervisor tin cậy.
- Không đọc/in secrets; không commit `.env`, tokens, signed URLs, private media hoặc dumps. Không gửi dữ liệu tenant cho AI provider khi chưa có policy/quyền phù hợp.
- Không `curl | sh`, unpinned `npx` hoặc install script chưa review. Pin dependencies, kiểm license/transitive dependencies và SBOM trước adoption. Không vendor source ngoại bộ trong phiên docs.

## Quy trình mỗi task

1. Đọc docs chuẩn tắc và `git status`; giữ nguyên thay đổi có sẵn. Ghi task ID, base commit, file scope, dependencies, acceptance trước khi sửa.
2. Claim durable task lease trước implementation; tránh hai agent sở hữu cùng file. `DOC-001` dùng execution log vì supervisor chưa có.
3. Thay đổi nhỏ có thể review; cập nhật schema/API/docs cùng behavior. Không thêm code ngoài scope để làm đẹp số test.
4. Ghi kiểm tra là `PASS`, `FAIL`, `NOT_RUN`, `BLOCKED` cùng lệnh, exit status, commit và artifact. Không gọi design là shipped; không bịa test, CI hay video.
5. Review diff/secrets trước commit. Implementation commit có task ID, ví dụ `feat(P2-02): render captioned fixture`; ngoại lệ `DOC-001` dùng đúng `docs: design independent code-first video engine`.
6. Chỉ `done` khi acceptance và review/CI cần thiết có evidence. Thiếu chứng cứ giữ `review`/`blocked`, lý do cụ thể. Không force-push, reset thay đổi người khác, merge/deploy ngoài quyền.

Thiếu runtime/credentials thì ghi test chưa chạy và giữ gate. Default đã nêu trong docs được dùng không cần hỏi lại; hỏi khi đổi scope/quyền hoặc public contract không thể giải quyết. Không che flaky tests bằng retry vô hạn. Security là release gate, không TODO để custom code chạy sớm.

Kết thúc phải có task IDs, files, behavior/design, test thực, giới hạn, commit và task tiếp theo. Không push trong phiên thiết kế. Worktree, recovery và PR theo [docs/AGENTS.md](docs/AGENTS.md).
