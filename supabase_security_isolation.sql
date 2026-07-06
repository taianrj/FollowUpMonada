-- ==========================================
-- SECURITY ISOLATION PATCH - FOLLOWUP MONADA
-- Apply in the Supabase SQL Editor after the base schema/migrations.
-- ==========================================

alter table public.profiles
  add column if not exists is_active boolean default true not null;

create or replace function public.is_current_user_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
      and role = 'admin'
      and coalesce(is_active, true) = true
  );
$$;

grant execute on function public.is_current_user_admin() to authenticated;

-- Profiles: users can read their own profile; admins can read all profiles.
drop policy if exists "Qualquer usuario autenticado pode ler perfis" on public.profiles;
drop policy if exists "Qualquer usuário autenticado pode ler perfis" on public.profiles;
drop policy if exists "Usuarios podem ler proprio perfil; admins leem todos" on public.profiles;
drop policy if exists "Apenas administradores podem atualizar perfis" on public.profiles;
drop policy if exists "Apenas administradores podem inserir perfis" on public.profiles;

create policy "Usuarios podem ler proprio perfil; admins leem todos"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_current_user_admin());

create policy "Apenas administradores podem atualizar perfis"
  on public.profiles for update
  to authenticated
  using (public.is_current_user_admin());

create policy "Apenas administradores podem inserir perfis"
  on public.profiles for insert
  to authenticated
  with check (public.is_current_user_admin());

-- WhatsApp summaries contain private WhatsApp raw text and generated summaries.
-- They must never be visible or mutable across users.
drop policy if exists "Qualquer usuario autenticado pode ver resumos" on public.whatsapp_summaries;
drop policy if exists "Qualquer usuário autenticado pode ver resumos" on public.whatsapp_summaries;
drop policy if exists "Qualquer usuario autenticado pode cadastrar resumos" on public.whatsapp_summaries;
drop policy if exists "Qualquer usuário autenticado pode cadastrar resumos" on public.whatsapp_summaries;
drop policy if exists "Qualquer usuario autenticado pode atualizar resumos" on public.whatsapp_summaries;
drop policy if exists "Qualquer usuário autenticado pode atualizar resumos" on public.whatsapp_summaries;
drop policy if exists "Apenas administradores podem deletar resumos" on public.whatsapp_summaries;
drop policy if exists "Usuarios podem ler apenas seus resumos whatsapp" on public.whatsapp_summaries;
drop policy if exists "Usuarios podem cadastrar apenas seus resumos whatsapp" on public.whatsapp_summaries;
drop policy if exists "Usuarios podem atualizar apenas seus resumos whatsapp" on public.whatsapp_summaries;
drop policy if exists "Usuarios podem deletar apenas seus resumos whatsapp" on public.whatsapp_summaries;

create index if not exists idx_whatsapp_summaries_created_by_date
  on public.whatsapp_summaries (created_by, summary_date desc, created_at desc);

create policy "Usuarios podem ler apenas seus resumos whatsapp"
  on public.whatsapp_summaries for select
  to authenticated
  using (created_by = auth.uid());

create policy "Usuarios podem cadastrar apenas seus resumos whatsapp"
  on public.whatsapp_summaries for insert
  to authenticated
  with check (created_by = auth.uid());

create policy "Usuarios podem atualizar apenas seus resumos whatsapp"
  on public.whatsapp_summaries for update
  to authenticated
  using (created_by = auth.uid())
  with check (created_by = auth.uid());

create policy "Usuarios podem deletar apenas seus resumos whatsapp"
  on public.whatsapp_summaries for delete
  to authenticated
  using (created_by = auth.uid());
