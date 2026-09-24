# Audit & Kaizen — từ `DU_AN_QUET_MA_CODE_clean.zip` sang QuetDoc QRcode

Ngày: 24/09/2026 · Người audit: Muse (AI assistant)

## 1. Đã đọc toàn bộ file nén — cấu trúc hiểu được

```
DU_AN_QUET_MA_CODE_clean.zip
├── web/index.html        # 26.9 KB — app 1-file: đối chiếu Packing List ↔ kết quả quét mã thùng
├── web/vercel.json       # headers cơ bản (nosniff, no-referrer)
├── frontend/             # React 18 + craco + Tailwind, gọi API backend
│   └── src/: App.js, pages/Dashboard.jsx, components/ (FileUploader, ControlsPanel,
│       KpiCards, ResultsTable, Header), lib/api.js, lib/utils.js
├── backend/              # FastAPI + pandas + openpyxl
│   └── server.py (18.5 KB), requirements.txt, tests/test_packing_calculator.py, Dockerfile
├── docs/AUDIT.md         # Báo cáo audit bản .rar gốc (đã phục hồi từ bytecode)
├── docker-compose.yml    # backend + MongoDB
└── .gitignore / README.md
```

**Chức năng dự án cũ:** import 2 file Excel (Packing List + Kết quả quét mã thùng),
tính P (đếm số thùng) & Q (số lượng = P × số đôi/thùng), xuất Excel tô màu.

## 2. Kết quả audit (điểm mạnh / điểm cần kaizen)

| # | Nhận xét | Mức |
|---|----------|-----|
| 1 | `docs/AUDIT.md` đã chỉ ra và sửa các lỗi nghiêm trọng: khớp header ẩu (`MIN_FUZZY_LEN`), `.env` lọt secret, bắt buộc MongoDB → đã có `MemoryStore` | ✅ tốt |
| 2 | Thuật toán đếm thùng đã tối ưu O(rows × log boxes) bằng `bisect` | ✅ tốt |
| 3 | Dự án cũ **cần backend + MongoDB** cho nhu cầu thực chất chỉ là "quét → ghi nhận" → chi phí vận hành/deploy cao hơn giá trị | ⚠️ kaizen |
| 4 | `web/index.html` bản 1-file chứng minh toàn bộ logic chạy được **trong trình duyệt** → không có lý do giữ backend cho app quét-ghi nhận | ⚠️ kaizen |
| 5 | Thiếu kiểm tra trùng lặp ở khâu quét (AUDIT.md §4 ghi nhận thùng `0000` quét lỗi, lệch số liệu 92 vs 91) | ⚠️ kaizen |
| 6 | Không có cơ chế chống quét dính 2 lần (camera quét liên tục cùng 1 mã) | ⚠️ kaizen |
| 7 | `vercel.json` thiếu `X-Frame-Options`, `Permissions-Policy` cho trang xin quyền camera | ⚠️ kaizen |
| 8 | Không có version cho dữ liệu lưu local → nâng cấp app dễ vỡ dữ liệu cũ | ⚠️ kaizen |

## 3. Kaizen đã áp dụng trong QuetDoc QRcode

1. **Bỏ backend, static-only:** app quét-ghi nhận không cần server → deploy Vercel free,
   không DB, không secret, không CORS. Dữ liệu lưu `localStorage` (key có version `quetdoc_qrcode_v1`).
2. **Quét live bằng camera** (html5-qrcode): QR, Code128/39, EAN-13/8, UPC-A, DataMatrix —
   đúng nhu cầu "quét mã code để ghi nhận dữ liệu thông tin".
3. **Chống trùng 2 lớp:** cooldown 2.5s chống quét dính + gắn cờ `dup` và cảnh báo khi mã đã tồn tại
   (khắc phục bài học thùng `0000` trong AUDIT.md §4).
4. **Ghi nhận đầy đủ:** nội dung, định dạng mã, thời gian (giờ VN), phiên/ca/người quét, ghi chú.
5. **Xuất CSV có BOM** → mở bằng Excel không lỗi font tiếng Việt; thêm xuất JSON để tích hợp tiếp.
6. **Tìm kiếm + lọc ngày + phân trang** 50 dòng/trang (kế thừa ý tưởng `limit/offset` của API cũ).
7. **Security headers đầy đủ** trên Vercel: `X-Frame-Options: DENY`, `Permissions-Policy: camera=(self)`,
   `nosniff`, `no-referrer`; cache immutable cho assets.
8. **UX thực tế:** chọn camera, bật đèn flash, quét từ ảnh, nhập tay fallback, âm báo,
   toast thông báo, chip cảnh báo khi không phải HTTPS (camera cần HTTPS).
9. **Không build step:** HTML/CSS/JS thuần → ai cũng đọc/sửa được, không lo mất source như sự cố `.rar` cũ.
10. **`.gitignore` chặn secret** ngay từ đầu (`.env`, `*.pem`, `*.key`).

## 4. Việc nên làm tiếp (không bắt buộc)

- Đồng bộ nhiều máy: thay localStorage bằng Supabase/Firebase (giữ nguyên UI).
- PWA: thêm `manifest.json` + service worker để cài như app điện thoại, quét offline.
- In tem / xuất báo cáo theo ca: tổng hợp từ dữ liệu đã ghi nhận.
- CI: kiểm tra cú pháp JS + quét secret trước khi push (kế thừa gợi ý AUDIT.md §5).
