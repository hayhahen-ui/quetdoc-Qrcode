-- QuetDoc QRcode v3 — Supabase setup (chạy 1 lần trong SQL Editor)
-- Project: quetdoc (https://cdxoaoemnidwuzentxrc.supabase.co)

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique not null,
  role text not null default 'user' check (role in ('admin','user')),
  created_at timestamptz default now()
);

create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  format text not null default 'QR',
  session text default '',
  note text default '',
  user_id uuid not null references auth.users(id) on delete cascade,
  username text not null,
  scanned_at timestamptz not null default now(),
  created_at timestamptz default now()
);

-- Mỗi nội dung mã chỉ tồn tại 1 lần trên TOÀN BỘ máy (chống trùng toàn cục)
create unique index if not exists records_content_uniq
  on public.records ((upper(btrim(content))));

-- Realtime: admin xem trực tiếp bản ghi mới
alter publication supabase_realtime add table public.records;

create or replace function public.is_admin()
returns boolean language sql security definer stable as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

alter table public.profiles enable row level security;
alter table public.records enable row level security;

drop policy if exists "profiles_self" on public.profiles;
create policy "profiles_self" on public.profiles
  for all using (id = auth.uid()) with check (id = auth.uid());
drop policy if exists "profiles_admin_select" on public.profiles;
create policy "profiles_admin_select" on public.profiles
  for select using (public.is_admin());

drop policy if exists "records_select" on public.records;
create policy "records_select" on public.records
  for select using (user_id = auth.uid() or public.is_admin());
drop policy if exists "records_insert" on public.records;
create policy "records_insert" on public.records
  for insert with check (user_id = auth.uid());
drop policy if exists "records_delete" on public.records;
create policy "records_delete" on public.records
  for delete using (user_id = auth.uid() or public.is_admin());

/* ================= v4.0: TEM THÙNG GIÀY (25/09/2026) =================
 * Chạy đoạn này trong Supabase Dashboard -> SQL Editor (toàn bộ file cũng chạy được,
 * các lệnh cũ đều có IF NOT EXISTS / DROP IF EXISTS nên an toàn khi chạy lại).
 *
 * - records thêm 3 cột: chi_thi (9 ký tự đầu của số thùng, VD AE2608210),
 *   po (VD 0903174893-1), size (VD 5.0-6).
 * - Bảng directives: danh mục Chỉ thị -> PO + Size mặc định (admin quản lý).
 *   Khi quét, app tự tách chỉ thị từ số thùng và tra PO/Size từ danh mục này. */

alter table public.records
  add column if not exists chi_thi text,
  add column if not exists po text,
  add column if not exists size text;

-- Cho phép chủ bản ghi (hoặc admin) SỬA po/size sau khi quét (sửa inline trên bảng)
drop policy if exists "records_update" on public.records;
create policy "records_update" on public.records
  for update using (user_id = auth.uid() or public.is_admin())
  with check (user_id = auth.uid() or public.is_admin());

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

-- Seed 4 chỉ thị từ tem mẫu (25/09/2026)
insert into public.directives (chi_thi, po, size, updated_by) values
  ('AE2608210', '0903174893-1', '5.0-6', 'seed'),
  ('AE2608443', '0903172240-1', '6.0-6', 'seed'),
  ('AE2607353', '0903082783-1', '8.0-3', 'seed')
on conflict (chi_thi) do nothing;
