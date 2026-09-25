# Audit & Kaizen — bộ skill Leonxlnx/taste-skill cho dự án QuetDoc

Ngày: 25/09/2026 · Người audit: 3 agent đọc toàn bộ 12 SKILL.md (~6800 dòng) + README + research.

## Design Read (theo format của skill — 1 dòng trước khi code)

> *Reading this as: industrial scan tool for factory workers on phones (night shift),
> with a utilitarian high-legibility language — plus a trust-first management
> reporting surface for admin/leaders. One dark-first "Industrial Minimal" system,
> native CSS, no framework.*

## Dials đã chốt

| Persona | VARIANCE | MOTION | DENSITY | Nghĩa thực tế |
|---|---|---|---|---|
| Công nhân quét | 2 | 2 | 7 | Đối xứng tuyệt đối (thao tác không cần nhìn); motion chỉ còn tactile feedback; nút ≥48px, nút quét chính 64px trong tầm ngón cái |
| Admin / lãnh đạo | 3 | 2 | 9 | Cockpit: bảng đặc, số mono/tabular, phân cách bằng line 1px; không animation trang trí |

## 1. ÁP DỤNG (đã đưa vào v6.0)

- **Color consistency lock**: 1 accent (emerald) + màu trạng thái giữ nguyên nghĩa mọi nơi (xanh ok / vàng warn / đỏ danger). Đổi `--blue` sang sky `#38BDF8` cho tương phản tốt hơn trên nền tối ca đêm.
- **Shape consistency lock**: 1 thang radius `--r-sm/--r-md/--r-lg` cho cả app.
- **Semantic tokens**: màu đặt theo vai trò (`--ok/--warn/--danger/--info`), không theo tên màu.
- **Tactile feedback**: `:active { transform: scale(.98) }` mọi nút — thay cho mọi motion điện ảnh.
- **Tabular numbers** cho mọi con số (dashboard, bảng, mã thùng); font mono cho mã QR/số thùng (spirit brutalist, bỏ phần trang trí).
- **Off-black** (`#0B0E13`), không `#000` thuần; **không gradient tím AI**.
- **Label trên input** (đã đúng từ v5.3 — giữ, không dùng placeholder-as-label).
- **Touch target ≥48px** (nút quét chính 64px); `100dvh` thay `100vh`; chỉ animate `transform`/`opacity`.
- **Full state cycle**: skeleton khi tải packing/master, empty state, lỗi inline (giữ + rà soát).
- **A11y thực dụng**: `:focus-visible` ring; `prefers-reduced-motion`; `text-wrap: balance` cho tiêu đề tiếng Việt.
- **Pre-flight checklist** (7 mục) → `docs/design-system.md`.

## 2. LOẠI BỎ CÓ LÝ DO (không áp máy móc)

| Rule của skill | Vì sao không áp |
|---|---|
| Anti-center bias, bento grid, zigzag, "cấm 3 card đều nhau", hero-fit-viewport | Luật composition cho **landing/marketing**; app công cụ không có hero; 3 KPI đều nhau là đúng UX nhận diện nhanh |
| Emoji ban tuyệt đối | 📦/🤖/🎯 là **tín hiệu trạng thái chức năng**, đọc nhanh trên máy cũ không cần icon font — giữ, cấm thêm icon trang trí vô nghĩa |
| Spring physics, shimmer/micro-loop vô hạn | Giật lag + tốn pin trên điện thoại công nhân giá rẻ; chỉ dùng transition 150–200ms |
| Brandkit kiểu agency (board 3×3, construction geometry, image direction, mockup) | Đồ nghề làm deck thuyết trình, không phải để code; team nhỏ đầu tư vào tokens + checklist cho lợi tức cao hơn |
| "Cài official DS (shadcn/Fluent…)", ví dụ React/Next/Tailwind/Motion | App là vanilla JS + CSS thuần; cài DS React là không khả thi và phình bundle |
| Dual-mode dark protocol | Brief đã chốt **dark-only cho ca đêm** (skill cho phép override khi có chỉ định rõ) |
| Image strategy (gen ảnh trang trí, logo wall) | Tool vận hành không cần ảnh trang trí |

## 3. ĐIỂM YẾU CỦA SKILL (audit trung thực)

1. **Tự loại trừ đúng phần lõi của ta**: *"Not dashboards, not data tables, not multi-step product UI"* — trong khi app là bảng dữ liệu + flow quét nhiều bước + báo cáo Excel.
2. **Không có ergonomics công nghiệp**: thao tác 1 tay, găng tay, đèn xưởng, máy Android cũ/pin yếu — skill chỉ bàn aesthetics.
3. **Thiếu craft cho data/reporting**: không có gì về bảng dữ liệu rộng, sticky header, style file Excel, print — tức nửa "quản trị" của dự án.
4. **A11y chung chung**: chỉ WCAG text-contrast; thiếu yêu cầu đặc thù (trạng thái không phụ thuộc mỗi màu sắc — mù màu đỏ/xanh trong xưởng; chữ đọc được ở khoảng cách tay với).
5. **Hype trong README**: copy "thiết kế $150k / Awwwards-tier", "Python-driven true randomization" (giả ngẫu nhiên bằng seed đếm ký tự — trò hề), README nhồi sponsor + tracking link, disclaimer crypto — mục tiêu growth/affiliate nặng.

## 4. Kaizen đã làm cho chính skill

Biến skill từ "bộ luật cho landing page" thành **hệ điều hành thiết kế cho tool công nghiệp**:
`docs/design-system.md` — tokens + dials + component rules + pre-flight checklist,
cắt bỏ mọi phần agency/marketing, bổ sung ergonomics xưởng và data-craft mà skill gốc thiếu.

**Kết luận**: giữ ~40% skill (design read, dials, consistency locks, anti-patterns checklist,
token methodology), loại ~60% (landing composition, motion điện ảnh, brand deck, framework advice).
