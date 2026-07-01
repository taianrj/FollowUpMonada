-- ==========================================
-- SCRIPT DE MIGRAÇÃO - DE NEXUS PARA FOLLOWUP MÔNADA
-- Execute este script no editor SQL do Supabase
-- ==========================================

-- 1. CRIAR TABELA DE COLABORADORES
create table if not exists public.collaborators (
    id uuid default gen_random_uuid() primary key,
    name text not null unique,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Habilitar RLS para colaboradores
alter table public.collaborators enable row level security;

-- Políticas para COLABORADORES
create policy "Qualquer usuário autenticado pode ver colaboradores"
    on public.collaborators for select
    to authenticated
    using (true);

create policy "Qualquer usuário autenticado pode cadastrar colaboradores"
    on public.collaborators for insert
    to authenticated
    with check (true);

create policy "Qualquer usuário autenticado pode atualizar colaboradores"
    on public.collaborators for update
    to authenticated
    using (true);

create policy "Apenas administradores podem deletar colaboradores"
    on public.collaborators for delete
    to authenticated
    using (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        )
    );


-- 2. CRIAR TABELA DE STATUS
create table if not exists public.statuses (
    id text primary key,
    name text not null unique,
    color text default '#8b5cf6' not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Habilitar RLS para status
alter table public.statuses enable row level security;

-- Políticas para STATUS
create policy "Qualquer usuário autenticado pode ver status"
    on public.statuses for select
    to authenticated
    using (true);

create policy "Qualquer usuário autenticado pode cadastrar status"
    on public.statuses for insert
    to authenticated
    with check (true);

create policy "Qualquer usuário autenticado pode atualizar status"
    on public.statuses for update
    to authenticated
    using (true);

create policy "Apenas administradores podem deletar status"
    on public.statuses for delete
    to authenticated
    using (
        exists (
            select 1 from public.profiles
            where id = auth.uid() and role = 'admin'
        )
    );

-- Popular status padrões iniciais
insert into public.statuses (id, name, color) values
('aguardando cliente', 'Aguardando Cliente', '#f59e0b'),
('aguardando texto', 'Aguardando Texto', '#f97316'),
('ajuste', 'Ajuste', '#06b6d4'),
('aguardando aprovação', 'Aguardando Aprovação', '#8b5cf6'),
('resolvido', 'Resolvido', '#10b981')
on conflict (id) do nothing;


-- 3. AJUSTAR TABELA DE TAREFAS (TASKS)
-- Adicionar coluna de arquivamento se não existir
alter table public.tasks add column if not exists is_archived boolean default false not null;

-- Remover check constraint de status antigo (costuma ter o nome 'tasks_status_check' gerado automaticamente)
alter table public.tasks drop constraint if exists tasks_status_check;

-- Adicionar chave estrangeira referenciando a tabela de status
-- Se houver status órfãos na tabela que não batem com os IDs do statuses, eles devem ser mapeados primeiro
-- Como os status existentes já batem exatamente com as chaves inseridas acima, a chave estrangeira criará sem erros
alter table public.tasks add constraint fk_tasks_status foreign key (status) references public.statuses(id) on update cascade;

-- ==========================================
-- 4. CRIAR TABELA DE RESUMOS DE WHATSAPP
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

