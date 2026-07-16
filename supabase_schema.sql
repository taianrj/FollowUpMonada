-- ==========================================
-- SCRIPT DE BANCO DE DADOS - FOLLOWUP MÔNADA SYSTEM
-- Execute este script no editor SQL do Supabase
-- ==========================================

-- 1. LIMPAR ESTRUTURA SE EXISTIR (Para reinstalação limpa)
-- drop trigger if exists on_auth_user_created on auth.users;
-- drop function if exists public.handle_new_user();
-- drop table if exists public.tasks;
-- drop table if exists public.clients;
-- drop table if exists public.profiles;

-- 2. TABELA DE PERFIS DE USUÁRIOS
create table public.profiles (
    id uuid references auth.users on delete cascade primary key,
    email text not null,
    role text not null check (role in ('admin', 'collaborator')),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Habilitar Row Level Security (RLS) para perfis
alter table public.profiles enable row level security;

-- 3. TABELA DE CLIENTES
create table public.clients (
    id uuid default gen_random_uuid() primary key,
    name text not null unique,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Habilitar RLS para clientes
alter table public.clients enable row level security;

-- 4. TABELA DE TAREFAS / DEMANDAS
create table public.tasks (
    id uuid default gen_random_uuid() primary key,
    client_id uuid references public.clients(id) on delete cascade not null,
    description text not null,
    responsibles text[] default '{}'::text[] not null,
    status text not null check (status in ('aguardando cliente', 'aguardando texto', 'ajuste', 'aguardando aprovação', 'resolvido')),
    observations text default '' not null,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Habilitar RLS para tarefas
alter table public.tasks enable row level security;

-- 5. ÍNDICES DE PERFORMANCE
create index idx_tasks_client_id on public.tasks(client_id);
create index idx_tasks_status on public.tasks(status);

-- 6. FUNÇÃO E TRIGGER PARA CRIAÇÃO AUTOMÁTICA DE PERFIL
-- Esta funcao e disparada quando um novo usuario se registra no Supabase Auth.
-- Metadados enviados pelo proprio cadastro nunca podem conceder privilegios.
create or replace function public.handle_new_user()
returns trigger as $$
begin
    insert into public.profiles (id, email, role)
    values (new.id, new.email, 'collaborator')
    on conflict (id) do nothing;
    
    return new;
end;
$$ language plpgsql security definer set search_path = public;

revoke all on function public.handle_new_user() from public;
revoke all on function public.handle_new_user() from anon;
revoke all on function public.handle_new_user() from authenticated;

-- Trigger que roda após o insert em auth.users
create or replace trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- 7. CONFIGURAÇÃO DE POLÍTICAS RLS (Row Level Security)

create or replace function public.is_current_user_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select exists (
        select 1 from public.profiles
        where id = auth.uid() and role = 'admin'
    );
$$;

grant execute on function public.is_current_user_admin() to authenticated;

-- Políticas para PROFILES
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

-- Políticas para CLIENTES
create policy "Qualquer usuário autenticado pode ver clientes"
    on public.clients for select
    to authenticated
    using (true);

create policy "Qualquer usuário autenticado pode inserir clientes"
    on public.clients for insert
    to authenticated
    with check (true);

create policy "Qualquer usuário autenticado pode atualizar clientes"
    on public.clients for update
    to authenticated
    using (true);

create policy "Apenas administradores podem deletar clientes"
    on public.clients for delete
    to authenticated
    using (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        )
    );

-- Políticas para TAREFAS
create policy "Qualquer usuário autenticado pode ver tarefas"
    on public.tasks for select
    to authenticated
    using (true);

create policy "Qualquer usuário autenticado pode inserir tarefas"
    on public.tasks for insert
    to authenticated
    with check (true);

create policy "Qualquer usuário autenticado pode atualizar tarefas"
    on public.tasks for update
    to authenticated
    using (true);

create policy "Apenas administradores podem deletar tarefas permanentemente"
    on public.tasks for delete
    to authenticated
    using (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        )
    );

-- 8. FUNÇÃO PARA ATUALIZAR O TIMESTAMP DE UPDATED_AT AUTOMATICAMENTE
create or replace function public.update_updated_at_column()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create or replace trigger update_tasks_updated_at
    before update on public.tasks
    for each row execute procedure public.update_updated_at_column();

-- ==========================================
-- 9. TABELA DE RESUMOS DE WHATSAPP
-- ==========================================
create table if not exists public.whatsapp_summaries (
    id uuid default gen_random_uuid() primary key,
    summary_date date not null default current_date,
    raw_text text not null,
    summary_data jsonb not null,
    created_by uuid references public.profiles(id) on delete set null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Habilitar RLS para resumos de whatsapp
alter table public.whatsapp_summaries enable row level security;

-- Políticas para WHATSAPP_SUMMARIES
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

-- 5. ADICIONAR COLUNAS DE CONFIGURAÇÃO DO WHATSAPP NA TABELA DE PERFIS
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS transcribe_audio BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS interpret_images BOOLEAN DEFAULT FALSE;
