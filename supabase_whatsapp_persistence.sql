-- ==========================================
-- WHATSAPP PERSISTENCE - FOLLOWUP MONADA
-- Execute este script no SQL Editor do Supabase.
-- ==========================================

create table if not exists public.whatsapp_sessions (
    id text primary key,
    creds text not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

create table if not exists public.whatsapp_contacts (
    user_id text not null,
    jid text not null,
    name text not null,
    type text not null default 'contact' check (type in ('contact', 'group')),
    source text,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
    primary key (user_id, jid)
);

create table if not exists public.whatsapp_messages (
    user_id text not null,
    dedupe_key text not null,
    message_id text,
    chat_jid text not null,
    chat_number text not null,
    chat_name text,
    participant_jid text,
    participant_number text,
    participant_aliases jsonb default '[]'::jsonb not null,
    display_name text,
    text text not null,
    from_me boolean default false not null,
    message_timestamp timestamp with time zone not null,
    message_date date not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
    primary key (user_id, dedupe_key)
);

alter table public.whatsapp_messages
    add column if not exists participant_aliases jsonb default '[]'::jsonb not null;

create index if not exists idx_whatsapp_contacts_user_type
    on public.whatsapp_contacts (user_id, type);

create index if not exists idx_whatsapp_messages_user_date_time
    on public.whatsapp_messages (user_id, message_date, message_timestamp);

create index if not exists idx_whatsapp_messages_user_chat_date
    on public.whatsapp_messages (user_id, chat_jid, message_date);

alter table public.whatsapp_sessions enable row level security;
alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_messages enable row level security;

-- O microsservico usa SUPABASE_SERVICE_ROLE_KEY e ignora RLS.
-- As politicas abaixo permitem leitura pelo app autenticado quando necessario,
-- mantendo a separacao por user_id/id.
create policy "Usuarios autenticados podem ler sua sessao whatsapp"
    on public.whatsapp_sessions for select
    to authenticated
    using (id = auth.uid()::text);

create policy "Usuarios autenticados podem ler seus contatos whatsapp"
    on public.whatsapp_contacts for select
    to authenticated
    using (user_id = auth.uid()::text);

create policy "Usuarios autenticados podem ler suas mensagens whatsapp"
    on public.whatsapp_messages for select
    to authenticated
    using (user_id = auth.uid()::text);
