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
-- Esta função é disparada quando um novo usuário se registra no Supabase Auth.
-- Se for o primeiro usuário do banco, ele é automaticamente 'admin'.
-- Caso contrário, ele assume a role enviada nos metadados ou 'collaborator' por padrão.
create or replace function public.handle_new_user()
returns trigger as $$
declare
    user_count integer;
    assigned_role text;
begin
    select count(*) into user_count from public.profiles;
    
    if user_count = 0 then
        assigned_role := 'admin';
    else
        assigned_role := coalesce(new.raw_user_meta_data->>'role', 'collaborator');
    end if;

    insert into public.profiles (id, email, role)
    values (new.id, new.email, assigned_role);
    
    return new;
end;
$$ language plpgsql security definer;

-- Trigger que roda após o insert em auth.users
create or replace trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();

-- 7. CONFIGURAÇÃO DE POLÍTICAS RLS (Row Level Security)

-- Políticas para PROFILES
create policy "Qualquer usuário autenticado pode ler perfis"
    on public.profiles for select
    to authenticated
    using (true);

create policy "Apenas administradores podem atualizar perfis"
    on public.profiles for update
    to authenticated
    using (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        )
    );

create policy "Apenas administradores podem inserir perfis"
    on public.profiles for insert
    to authenticated
    with check (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        )
    );

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
create policy "Qualquer usuário autenticado pode ver resumos"
    on public.whatsapp_summaries for select
    to authenticated
    using (true);

create policy "Qualquer usuário autenticado pode cadastrar resumos"
    on public.whatsapp_summaries for insert
    to authenticated
    with check (true);

create policy "Qualquer usuário autenticado pode atualizar resumos"
    on public.whatsapp_summaries for update
    to authenticated
    using (true);

create policy "Apenas administradores podem deletar resumos"
    on public.whatsapp_summaries for delete
    to authenticated
    using (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        )
    );

-- 5. ADICIONAR COLUNAS DE CONFIGURAÇÃO DO WHATSAPP NA TABELA DE PERFIS
ALTER TABLE public.profiles 
ADD COLUMN IF NOT EXISTS transcribe_audio BOOLEAN DEFAULT TRUE,
ADD COLUMN IF NOT EXISTS interpret_images BOOLEAN DEFAULT FALSE;

