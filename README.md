# QuetDoc QRcode 📷☁️

Quét mã **QR / barcode** bằng camera và **ghi nhận dữ liệu** (nội dung mã, thời gian, phiên, ghi chú, người quét) —
**đồng bộ trực tiếp đa thiết bị** qua Supabase. Có **đăng nhập phân quyền** quản trị / nhân viên.

## Tài khoản mặc định (tạo trong Supabase Dashboard → Authentication → Users)

| Tài khoản | Mật khẩu | Quyền |
|---|---|---|
| `admin` | `admin123` | Xem mọi bản ghi (trực tiếp), xóa bản ghi, xóa toàn bộ dữ liệu, xem danh sách tài khoản |
| `user1` … `user5` | `123456` | Chỉ quét, chỉ xem bản ghi của mình, đổi mật khẩu |

> Email nội bộ: `user1` → `user1@quetdoc.local` (tự ánh xạ trong app, người dùng vẫn gõ tên ngắn).
> Thêm/xóa/đặt lại mật khẩu tài khoản: thực hiện trong Supabase Dashboard → Authentication → Users.

## Kiến trúc v3 (đồng bộ cloud)

- **Supabase Postgres**: bảng `records` (bản ghi chung) + `profiles` (username, role).
- **Chống trùng toàn cục**: unique index `upper(trim(content))` — 2 máy quét cùng 1 mã cùng lúc thì chỉ 1 được ghi nhận, máy còn lại báo "Đã được quét".
- **Row Level Security**: user chỉ đọc/ghi bản ghi của mình; admin đọc/xóa toàn bộ.
- **Realtime**: admin (và user) tự thấy bản ghi mới mà không cần tải lại trang.

## Tính năng

- 🔐 Đăng nhập phân quyền **admin / nhân viên** (Supabase Auth)
- 📷 Quét live bằng camera (chọn camera trước/sau, bật đèn flash nếu máy hỗ trợ)
  - **Engine v3.1**: ưu tiên bộ giải mã native của trình duyệt (`BarcodeDetector`, nhanh hơn nhiều trên Chrome/Android), tự fallback về zxing
  - Lấy nét liên tục (`focusMode: continuous`) + độ phân giải 720p — đọc mã nhanh và chính xác hơn
  - 🔍 Thanh trượt **thu phóng camera** (khi máy hỗ trợ) — đọc mã nhỏ / mã ở xa tốt hơn
- 🖼 Quét mã từ ảnh tải lên · ⌨️ nhập tay khi không quét được
- 🛡 Mỗi mã chỉ ghi nhận **1 lần duy nhất trên toàn hệ thống** — quét trùng thì bỏ qua, chỉ cảnh báo "Đã được quét"
- ☁️ Đồng bộ trực tiếp đa thiết bị (Supabase + realtime)
- 🔍 Tìm kiếm, lọc theo ngày, phân trang
- 🏷 **Chế độ tem thùng giày (v4.0)**: tự tách **Chỉ thị** từ số thùng (9 ký tự đầu, VD `AE260821060012` → `AE2608210`),
  tự tra **PO / Size mặc định** từ **Danh mục Chỉ thị** (admin quản lý), bấm vào ô PO/Size để sửa từng thùng
- ⬇ Xuất **Excel (.xlsx)** đúng mẫu: 1 sheet/ngày, cột `STT | Chỉ thị | PO | Size/số đôi | Số thùng | Số pallet | Giờ quét | Người quét`,
  header vàng, tên file `Ket_Qua_Quet_Ma_YYYYMMDD_HHMMSS.xlsx`; vẫn có **CSV** và **JSON**
- 📊 Thống kê: tổng lượt quét / hôm nay / mã duy nhất / lượt bỏ qua trùng

## Cấu hình Supabase (làm 1 lần)

1. Tạo project miễn phí tại [supabase.com](https://supabase.com).
2. **SQL Editor** → New query → chạy **toàn bộ** `docs/supabase-setup.sql`
   (tạo bảng `profiles`, `records`, `directives`, unique index chống trùng, realtime và các RLS policy).
   > Đã chạy SQL bản cũ? Chạy lại toàn bộ file vẫn an toàn (mọi lệnh đều `IF NOT EXISTS`);
   > đoạn **v4.0** ở cuối file sẽ thêm cột `chi_thi/po/size`, bảng `directives` và seed 4 chỉ thị mẫu.
3. **Authentication** → **Users** → Add user (bật **Auto Confirm user**):
   `admin@quetdoc.local` / `admin123`, `user1@quetdoc.local` / `123456` … `user5@quetdoc.local` / `123456`.
   (Supabase yêu cầu mật khẩu tối thiểu 6 ký tự.)
4. **Project Settings** → **API**: copy **Project URL** và **anon public key**
   → dán vào `SUPABASE_URL` / `SUPABASE_ANON_KEY` ở đầu `assets/js/app.js`.

> Gói Free: project tự "ngủ" sau 1 thời gian không dùng — lần truy cập đầu có thể
> chậm vài giây để "đánh thức", sau đó chạy bình thường.

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
