# FollowUp Mônada — Gerenciador Inteligente de Demandas

O **FollowUp Mônada** é um sistema web corporativo de alta performance e produtividade desenvolvido para a gestão inteligente de demandas, controle de prazos e acompanhamento de colaborações de equipes. O sistema possui integração nativa com modelos de inteligência artificial (Gemini e Groq) para extração automatizada de demandas, controle de acessos (RLS) via Supabase e histórico de auditoria completo.

---

## 🛠️ Tecnologias Utilizadas

- **Frontend & Routing**: [Next.js (App Router)](https://nextjs.org/) + React 19 + TypeScript
- **Estilização**: Vanilla CSS (Premium Slate Theme com foco em design responsivo)
- **Banco de Dados & Autenticação**: [Supabase](https://supabase.com/) (PostgreSQL, Auth com e-mails transacionais e Row Level Security)
- **Inteligência Artificial**: API do Gemini (`gemini-2.5-flash`) e Groq API (`llama-3.3-70b-versatile`) para extração inteligente

---

## 🌟 Funcionalidades Principais

1. **Gestão Inteligente de Demandas (Kanban & Lista)**:
   - Visualização unificada de demandas em layouts de tabela ou cartões responsivos.
   - Filtros rápidos por clientes, responsáveis (colaboradores) e status.
2. **Processamento Inteligente por IA**:
   - Extração automática de tarefas a partir de mensagens brutas de texto ou briefings copiados.
   - Prevenção ativa de duplicidade semântica utilizando coeficientes de Jaccard e sobreposição de termos.
3. **Histórico de Auditoria Completo**:
   - Rastreamento em tempo real de cada modificação (criação, edição de campos, arquivamento e restauração).
   - Cálculo automático de *diff* no frontend exibindo as mudanças no formato *De ➔ Para*.
   - Timeline visual e intuitiva no modal de cada demanda.
4. **Controle de Acessos e Usuários (Usuários e Acessos)**:
   - Cadastro controlado por convite enviado por e-mail a partir de administradores.
   - Redefinição de senha segura para primeiro acesso e redefinições futuras.
   - Controle de ativação/status da conta (`Ativo` / `Inativo`).
   - Bloqueio de auto-desativação e auto-despromovimento do próprio administrador logado.

---

## 🚀 Como Executar o Projeto Localmente

### Pré-requisitos
- Node.js instalado (versão 18 ou superior)
- Conta criada no [Supabase](https://supabase.com)
- Chave de API do [Google AI Studio (Gemini)](https://aistudio.google.com/) ou [Groq Console](https://console.groq.com/) (opcionais)

### Passo 1: Clonar e instalar dependências
```bash
# Instale as dependências do projeto
npm install
```

### Passo 2: Configurar variáveis de ambiente
Crie um arquivo `.env.local` na raiz do projeto e adicione as seguintes variáveis:
```env
NEXT_PUBLIC_SUPABASE_URL=seu_url_do_supabase
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua_chave_anon_do_supabase
SUPABASE_SERVICE_ROLE_KEY=sua_chave_service_role_do_supabase
GEMINI_API_KEY=sua_chave_api_do_gemini
GROQ_API_KEY=sua_chave_api_do_groq
WHATSAPP_SERVICE_URL=http://localhost:8080
WHATSAPP_SERVICE_SECRET=gere_um_segredo_forte_e_use_o_mesmo_no_microsservico
```

Em producao, configure o mesmo `WHATSAPP_SERVICE_SECRET` no app Next.js e no `whatsapp-service`. O microsservico falha fechado sem esse segredo, para evitar acesso direto por UUID de usuario.

O `whatsapp-service` mantem por padrao uma janela de 48 horas de mensagens (`MESSAGE_RETENTION_DAYS=2`) e expoe `GET /healthz` para monitoramento simples sem dados de usuarios.

### Passo 3: Executar o servidor de desenvolvimento
```bash
npm run dev
```
Acesse o sistema em [http://localhost:3000](http://localhost:3000).

---

## 🗄️ Estrutura do Banco de Dados (Supabase)

Para o correto funcionamento do sistema, execute os seguintes scripts SQL no console do seu projeto Supabase (**SQL Editor**):

### 1. Estrutura Inicial do Banco
```sql
-- TABELA DE PERFIS DE USUÁRIOS
create table public.profiles (
    id uuid references auth.users on delete cascade primary key,
    email text not null,
    role text not null check (role in ('admin', 'collaborator')),
    name text,
    is_active boolean default true not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- TABELA DE CLIENTES
create table public.clients (
    id uuid default gen_random_uuid() primary key,
    name text not null unique,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- TABELA DE COLABORADORES
create table public.collaborators (
    id uuid default gen_random_uuid() primary key,
    name text not null unique,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- TABELA DE STATUS
create table public.statuses (
    id text primary key,
    name text not null unique,
    color text default '#8b5cf6' not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Popular status padrões iniciais
insert into public.statuses (id, name, color) values
('aguardando cliente', 'Aguardando Cliente', '#f59e0b'),
('aguardando texto', 'Aguardando Texto', '#f97316'),
('ajuste', 'Ajuste', '#06b6d4'),
('aguardando aprovação', 'Aguardando Aprovação', '#8b5cf6'),
('resolvido', 'Resolvido', '#10b981')
on conflict (id) do nothing;

-- TABELA DE TAREFAS / DEMANDAS
create table public.tasks (
    id uuid default gen_random_uuid() primary key,
    client_id uuid references public.clients(id) on delete cascade not null,
    description text not null,
    responsibles text[] default '{}'::text[] not null,
    status text not null references public.statuses(id) on update cascade,
    observations text default '' not null,
    created_by uuid references public.profiles(id) on delete set null,
    is_archived boolean default false not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);
```

### 2. Histórico de Auditoria e Logs
```sql
create table if not exists public.task_history (
    id uuid default gen_random_uuid() primary key,
    task_id uuid references public.tasks(id) on delete cascade not null,
    changed_by uuid references public.profiles(id) on delete set null,
    changed_at timestamp with time zone default timezone('utc'::text, now()) not null,
    action text not null check (action in ('create', 'update', 'archive', 'restore')),
    changes jsonb default '{}'::jsonb not null,
    created_by_ai boolean default false not null,
    ai_provider text
);

alter table public.task_history enable row level security;
create policy "Qualquer usuário autenticado pode ler o histórico" on public.task_history for select to authenticated using (true);
create policy "Qualquer usuário autenticado pode registrar no histórico" on public.task_history for insert to authenticated with check (true);
create index if not exists idx_task_history_task_id on public.task_history(task_id);
```

### 3. Triggers de Criação e Atualização
```sql
-- Trigger para atualizar timestamp de modificação
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

-- Trigger para sincronizar criação do usuário Auth com a tabela de profiles
create or replace function public.handle_new_user()
returns trigger as $$
declare
    user_count integer;
    assigned_role text;
    user_name text;
begin
    select count(*) into user_count from public.profiles;
    
    if user_count = 0 then
        assigned_role := 'admin';
    else
        assigned_role := coalesce(new.raw_user_meta_data->>'role', 'collaborator');
    end if;

    user_name := coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1));

    insert into public.profiles (id, email, role, name, is_active)
    values (new.id, new.email, assigned_role, user_name, true);
    
    return new;
end;
$$ language plpgsql security definer;

create or replace trigger on_auth_user_created
    after insert on auth.users
    for each row execute procedure public.handle_new_user();
```
