# Runbook: Video đen, thiếu font hoặc audio lệch (Video Quality Defects)

Tài liệu vận hành và quy trình chẩn đoán sự cố chất lượng video đầu ra: hiện tượng màn hình đen (black frames), văn bản bị lỗi font (missing glyphs/fallback font), hoặc âm thanh bị trôi/lệch khung hình (audio drift/A-V desync).

## 1. Thông tin cảnh báo và đối tượng giả lập (Synthetic IDs)

- **Alert trigger:** `CveTerminalFailureRateHigh` hoặc báo cáo lỗi kiểm định chất lượng từ khách hàng.
- **Mức độ nghiêm trọng:** `P2 - Major Quality Defect`.
- **Synthetic Tenant ID:** `tenant-synth-beta-22222222`
- **Synthetic Job ID:** `job-synth-defect-002`
- **Synthetic Video Artifact ID:** `art-synth-vid-002`
- **Synthetic Font ID:** `font-synth-main-002`

## 2. Các kịch bản lỗi và nguyên nhân cốt lõi

1. **Khung hình đen (Black Frames / Incomplete Assets):**
   - Tài nguyên ảnh/video đầu vào chưa được tải về bộ đệm cách ly trước khi render (quarantine/asset cache miss).
   - Chromium sandbox kích hoạt chặn truy cập mạng (`connect-src 'none'`), khiến thẻ `<img>` hoặc `<video>` không thể tải qua URL từ xa.
2. **Thiếu font chữ / Lỗi font tiếng Việt (Font Missing / Glyph Fallback):**
   - Font chữ chưa được đăng ký trong danh mục approved font hoặc tệp font `.ttf`/`.woff2` bị hỏng checksum SHA-256.
   - Chromium rơi vào cơ chế font dự phòng của hệ thống (fallback sans-serif) làm vỡ layout hoặc hiển thị ký tự ô vuông (tofu).
3. **Âm thanh bị lệch so với hình ảnh (Audio Drift / Desync):**
   - Tệp âm thanh đầu vào có tỷ lệ lấy mẫu biến thiên hoặc số mẫu âm thanh không khớp với tốc độ khung hình chuẩn 30fps (PTS discontinuity).

## 3. Các bước kiểm tra và xử lý (Investigation Procedure)

### Bước 1: Tải đặc tả Artifact Manifest và Báo cáo Kiểm định Chất lượng
Truy vấn thông tin manifest để kiểm tra các mã băm (`sha256`), tỷ lệ khung hình và codec:

```bash
# Kiểm tra chi tiết artifact video
curl -s -X GET "http://127.0.0.1:8080/v1/artifacts/art-synth-vid-002" \
  -H "Authorization: Bearer <authorized_tenant_key>"
```

Dữ liệu mẫu:
```json
{
  "artifact_id": "art-synth-vid-002",
  "job_id": "job-synth-defect-002",
  "kind": "video",
  "format": "mp4",
  "sha256": "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
  "metrics": {
    "duration_seconds": 15.0,
    "video_codec": "h264",
    "audio_codec": "aac",
    "width": 1280,
    "height": 720
  }
}
```

### Bước 2: Dò quét thông số kỹ thuật đa phương tiện bằng ffprobe
Thực hiện chạy `ffprobe` trên container phân tích cách ly:

```bash
ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate,duration \
  -show_entries format=duration,bit_rate -of json "/tmp/cve-quarantine/art-synth-vid-002.mp4"
```

1. **Kiểm tra đồng bộ khung hình (CFR):** Tốc độ khung hình phải cố định đúng `30/1` fps.
2. **Kiểm tra lệch thời lượng Audio vs Video:**
   - Chênh lệch `|duration_video - duration_audio|` không được vượt quá thời lượng 1 frame (<= 0.0333s).
   - Nếu chênh lệch lớn hơn: Kiểm tra cấu hình bộ lọc FFmpeg `aresample=async=1` hoặc bộ cắt âm thanh `atrim`.

### Bước 3: Chẩn đoán hiện tượng thiếu font
1. Kiểm tra danh mục font đã nạp trong container:
   ```bash
   fc-list : family | sort -u | grep -i "Noto"
   ```
2. So khớp mã băm font trong Scene Spec: Font phải khớp tuyệt đối với bản ghi kiểm định trong danh mục cục bộ. Không bao giờ cấu hình CSS `@import` hay nạp font động từ CDN bên ngoài (vi phạm security boundary).

## 4. Biện pháp khắc phục (Remediation)

1. **Khắc phục lỗi font:** Cập nhật bản sửa đổi font đã được kiểm định vào catalog; không ghi đè artifact cũ đã xuất bản.
2. **Tạo Job sửa đổi mới:** Người dùng hoặc tenant gửi yêu cầu render mới (`revision` tiếp theo) với tham số đã hiệu chỉnh:
   ```bash
   curl -s -X POST "http://127.0.0.1:8080/v1/render-jobs" \
     -H "Authorization: Bearer <authorized_tenant_key>" \
     -H "Content-Type: application/json" \
     -d '{
       "template_id": "tpl-synth-explainer",
       "composition_id": "cmp-synth-corrected",
       "profile": "mp4-720p-v1"
     }'
   ```
3. Giữ nguyên artifact cũ trong kho lưu trữ với trạng thái bất biến (immutable) để bảo toàn tính toàn vẹn của lịch sử kiểm toán.
