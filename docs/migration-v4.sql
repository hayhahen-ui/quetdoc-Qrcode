/* ============================================================================
 * QuetDoc QRcode — MIGRATION v4.0 (nghiệp vụ tem thùng giày, 25/09/2026)
 * ----------------------------------------------------------------------------
 * Cách chạy:
 *   1. Mở Supabase Dashboard (dự án cdxoaoemnidwuzentxrc) -> SQL Editor
 *   2. Bấm "New query", dán TOÀN BỘ nội dung file này vào
 *   3. Bấm Run (Ctrl+Enter). Chạy lại nhiều lần vẫn an toàn
 *      (mọi lệnh đều có IF NOT EXISTS / DROP IF EXISTS / ON CONFLICT DO NOTHING).
 * ========================================================================== */

-- 1) records thêm 3 cột nghiệp vụ tem thùng
alter table public.records
  add column if not exists chi_thi text,
  add column if not exists po text,
  add column if not exists size text;

-- 2) Cho phép chủ bản ghi (hoặc admin) SỬA po/size inline trên bảng
drop policy if exists "records_update" on public.records;
create policy "records_update" on public.records
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

-- 3) Bảng danh mục Chỉ thị -> PO + Size mặc định (admin quản lý trong app)
create table if not exists public.directives (
  chi_thi text primary key,
  po text not null default '',
  size text not null default '',
  updated_at timestamptz not null default now(),
  updated_by text not null default ''
);
alter table public.directives enable row level security;

drop policy if exists "directives_read" on public.directives;
create policy "directives_read" on public.directives
  for select to authenticated using (true);
drop policy if exists "directives_admin_write" on public.directives;
create policy "directives_admin_write" on public.directives
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- 4) Seed 3 chỉ thị từ tem mẫu (25/09/2026)
insert into public.directives (chi_thi, po, size, updated_by) values
  ('AE2608210', '0903174893-1', '5.0-6', 'seed'),
  ('AE2608443', '0903172240-1', '6.0-6', 'seed'),
  ('AE2607353', '0903082783-1', '8.0-3', 'seed')
on conflict (chi_thi) do nothing;
