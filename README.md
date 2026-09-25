# QuetDoc QRcode 📷

Quét mã **QR / barcode** bằng camera và **ghi nhận dữ liệu** (nội dung mã, thời gian, phiên, ghi chú, người quét) —
chạy 100% trên trình duyệt, không cần server. Có **đăng nhập phân quyền** quản trị / nhân viên.

## Tài khoản mặc định

| Tài khoản | Mật khẩu | Quyền |
|---|---|---|
| `admin` | `admin` | Full: xem mọi bản ghi, quản lý tài khoản (thêm/xóa/đặt lại MK), xóa toàn bộ dữ liệu |
| `user1` … `user5` | `123456` | Chỉ quét, chỉ xem bản ghi của mình, đổi tên đăng nhập, đổi mật khẩu |

> Mật khẩu lưu dưới dạng băm SHA-256 + salt. Lưu ý: xác thực chạy hoàn toàn phía
> trình duyệt (localStorage) nên phù hợp "phân quyền vận hành", chưa phải bảo mật
> cấp server. Cần bảo mật thật → bổ sung backend (Supabase Auth).

## Tính năng

- 🔐 Đăng nhập phân quyền **admin / nhân viên**
- 📷 Quét live bằng camera (chọn camera trước/sau, bật đèn flash nếu máy hỗ trợ)
- 🖼 Quét mã từ ảnh tải lên · ⌨️ nhập tay khi không quét được
- 🛡 Mỗi mã chỉ ghi nhận **1 lần duy nhất** — quét trùng thì bỏ qua, chỉ cảnh báo "Đã được quét"
- 💾 Tự động lưu vào trình duyệt (localStorage) — tắt trang vẫn còn
- 🔍 Tìm kiếm, lọc theo ngày, phân trang
- ⬇ Xuất **CSV** (mở ngon bằng Excel, có dấu tiếng Việt) và **JSON**
- 📊 Thống kê: tổng lượt quét / hôm nay / mã duy nhất / lượt bỏ qua trùng

## Chạy local

Mở `index.html` bằng trình duyệt là dùng được ngay.
Muốn dùng camera thì mở qua local server (camera cần HTTPS hoặc localhost):

```bash
npx serve .
# hoặc: python -m http.server 8000
```

## Deploy lên Vercel

1. Push code lên GitHub (repo `hayhahen-ui/quetdoc-Qrcode`).
2. Vào https://vercel.com/new → **Import** repo → **Deploy**. Không cần chỉnh gì thêm.
3. Mở URL `https://...vercel.app` bằng điện thoại → cấp quyền camera → quét.

> Camera trên trình duyệt **bắt buộc HTTPS** (Vercel cấp sẵn) hoặc localhost.

## Cấu trúc

```
.
├── index.html            # Giao diện + khung app
├── assets/
│   ├── css/styles.css    # Theme tối
│   └── js/app.js         # Toàn bộ logic: quét, lưu, lọc, xuất
├── vercel.json           # Cấu hình deploy Vercel + security headers
└── docs/AUDIT_KAIZEN.md  # Báo cáo audit dự án cũ + cải tiến đã áp dụng
```

## Công nghệ

- [html5-qrcode](https://github.com/mebjas/html5-qrcode) (CDN) — quét QR + Code128/39, EAN-13/8, UPC-A, DataMatrix
- Vanilla JS + CSS thuần — không build step, deploy static là chạy
- localStorage (key `quetdoc_qrcode_v1`, có version để nâng cấp an toàn)
