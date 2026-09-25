-- QuetDoc v6.2: quản lý tài khoản (25/09/2026)
-- Chạy 1 lần trong Supabase Dashboard -> SQL Editor. An toàn khi chạy lại.
--
-- 1. Admin đổi "tên user" thành tên nhân viên / mã số NV (cột display_name).
--    Tên đăng nhập KHÔNG đổi (vẫn user1..user5) để không gãy đăng nhập.
-- 2. Admin đổi mật khẩu tài khoản khác ngay trong app.
--    Frontend tĩnh không giữ service_role key nên dùng hàm SECURITY DEFINER
--    + pgcrypto (bcrypt, tương thích GoTrue). Chỉ admin gọi được (is_admin()).
-- 3. Vá nợ kỹ thuật: chặn user tự nâng role admin (trước đây policy profiles_self
--    cho phép). User vẫn được sửa display_name của chính mình.

-- 1. Cột tên hiển thị
alter table public.profiles add column if not exists display_name text;

-- 2. Admin được UPDATE profiles (đổi display_name)
drop policy if exists "profiles_admin_update" on public.profiles;
create policy "profiles_admin_update" on public.profiles
  for update using (public.is_admin()) with check (public.is_admin());

-- 3. Chỉ admin được đổi role
create or replace function public.protect_profile_role()
returns trigger language plpgsql as $$
begin
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'Bạn không có quyền đổi vai trò tài khoản.';
  end if;
  return new;
end $$;
drop trigger if exists trg_protect_profile_role on public.profiles;
create trigger trg_protect_profile_role
  before update on public.profiles
  for each row execute function public.protect_profile_role();

-- 4. Admin đổi mật khẩu tài khoản khác
create extension if not exists pgcrypto;

create or replace function public.admin_set_password(p_username text, p_new_password text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_email text;
  v_uid uuid;
begin
  if not public.is_admin() then
    raise exception 'Chỉ quản trị viên được đổi mật khẩu tài khoản khác.';
  end if;
  if p_new_password is null or char_length(p_new_password) < 6 then
    raise exception 'Mật khẩu mới phải từ 6 ký tự trở lên.';
  end if;
  v_email := lower(trim(p_username)) || '@quetdoc.local';
  select id into v_uid from auth.users where email = v_email;
  if v_uid is null then
    raise exception 'Không tìm thấy tài khoản: %', p_username;
  end if;
  update auth.users
     set encrypted_password = crypt(p_new_password, gen_salt('bf')),
         updated_at = now()
   where id = v_uid;
end $$;

revoke all on function public.admin_set_password(text, text) from public, anon;
grant execute on function public.admin_set_password(text, text) to authenticated;
