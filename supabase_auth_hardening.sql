-- ============================================================
-- AUTH HARDENING - FOLLOWUP MONADA
-- Aplicar uma vez no SQL Editor do Supabase em ambiente controlado.
-- Preserva perfis existentes; afeta apenas novos cadastros e permissoes.
-- ============================================================

begin;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, role)
  values (new.id, new.email, 'collaborator')
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;

-- A tabela contem credenciais reutilizaveis do WhatsApp e nao deve ser lida
-- diretamente pelo navegador. O service_role continua com acesso server-side.
drop policy if exists "Usuarios autenticados podem ler sua sessao whatsapp"
  on public.whatsapp_sessions;
revoke select on public.whatsapp_sessions from authenticated;

commit;
