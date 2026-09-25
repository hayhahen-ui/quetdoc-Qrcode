# QuetDoc Design System — "Industrial Minimal" (v6.0+)

Một ngôn ngữ duy nhất cho cả app: khung **minimalist** (flat, tương phản cao) +
kỷ luật **brutalist** (mono cho mã/số, số KPI lớn, viền 1px) + một nhúm **soft**
(bo góc, transition nhẹ) ở dashboard. Dark-first cho ca đêm.

## Design tokens

```css
:root{
  /* Surface — off-black, không #000 thuần */
  --bg:#0B0E13; --card:#11151d; --elev:#171d29; --border:#223047;
  /* Text */
  --text:#F1F5F9; --muted:#94A3B8; --faint:#64748b;
  /* Accent duy nhất: emerald (sản lượng/xưởng) */
  --emerald:#10B981;
  /* Semantic — đặt theo vai trò, giữ nguyên nghĩa mọi nơi */
  --ok:#10B981; --warn:#F59E0B; --danger:#F87171; --info:#38BDF8;
  /* Type */
  --font-sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;
  --font-mono:ui-monospace,SFMono-Regular,"JetBrains Mono",Consolas,monospace;
  --fs-kpi:clamp(1.6rem,5vw,2rem);
  /* Radius — 1 thang duy nhất */
  --r-sm:8px; --r-md:12px; --r-lg:16px;
  /* Touch — công nhân 1 tay */
  --touch:48px; --touch-lg:64px;
  /* Z */
  --z-toast:50; --z-modal:60;
}
```

## Quy tắc component

1. **Số liệu**: `font-variant-numeric: tabular-nums` mọi nơi; mã QR / số thùng dùng
   `font-family: var(--font-mono)`; mọi con số dashboard ghi đơn vị (thùng/đôi/pallet).
2. **Nút**: `min-height: var(--touch)`; nút quét chính `var(--touch-lg)` + `flex:1`
   (vùng ngón cái); `:active { transform: scale(.98) }`; disabled mờ 45%.
3. **Input/select**: label phía trên (không placeholder-as-label); `min-height: 44px`
   (khối phiên quét 48px); focus viền `--info`.
4. **Màu**: accent emerald chỉ cho hành động chính/sản lượng; trạng thái chỉ
   xanh/vàng/đỏ đúng nghĩa; không gradient tím, không neon glow, không chữ gradient.
5. **Motion**: chỉ `transform`/`opacity`, 150–200ms; tôn trọng `prefers-reduced-motion`.
6. **Bảng (cockpit)**: header uppercase 11px `--muted`; divider 1px; số tabular;
   hover row nhẹ; không card lồng card.
7. **Badge**: 📦 packing / 🤖 OCR là tín hiệu chức năng — giữ; không thêm icon trang trí.

## Pre-flight checklist (chạy trước mỗi release UI)

- [ ] Không placeholder: mọi màn hình chạy với dữ liệu thật, không `// TODO`/skeleton dở dang
- [ ] Mobile 1 tay: nút chính ≥64px, test ở 360px, vùng chạm không dính nhau
- [ ] Tương phản: text ≥4.5:1, số liệu ≥7:1 — đọc được dưới đèn xưởng
- [ ] Mọi số liệu có đơn vị + ghi nguồn (packing/master/thủ công)
- [ ] Không animate `top/left/width`; không blur trên vùng cuộn
- [ ] Bàn phím: `:focus-visible` thấy được; `prefers-reduced-motion` được tôn trọng
- [ ] Copy tiếng Việt: ngắn, động từ đầu câu, không từ hoa mỹ
