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
    chat_aliases jsonb default '[]'::jsonb not null,
    chat_name text,
    participant_jid text,
    participant_number text,
    participant_aliases jsonb default '[]'::jsonb not null,
    display_name text,
    text text not null,
    from_me boolean default false not null,
    routing_status text default 'legacy' not null,
    routing_issue text,
    is_forwarded boolean default false not null,
    quoted_message_id text,
    quoted_message_sender text,
    quoted_message_text text,
    message_timestamp timestamp with time zone not null,
    message_date date not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
    primary key (user_id, dedupe_key)
);

alter table public.whatsapp_messages
    add column if not exists participant_aliases jsonb default '[]'::jsonb not null;

alter table public.whatsapp_messages
    add column if not exists chat_aliases jsonb default '[]'::jsonb not null,
    add column if not exists routing_status text default 'legacy' not null,
    add column if not exists routing_issue text;

alter table public.whatsapp_messages
    add column if not exists is_forwarded boolean default false not null,
    add column if not exists quoted_message_id text,
    add column if not exists quoted_message_sender text,
    add column if not exists quoted_message_text text;

create index if not exists idx_whatsapp_contacts_user_type
    on public.whatsapp_contacts (user_id, type);

create index if not exists idx_whatsapp_messages_user_date_time
    on public.whatsapp_messages (user_id, message_date, message_timestamp);

create index if not exists idx_whatsapp_messages_user_chat_date
    on public.whatsapp_messages (user_id, chat_jid, message_date);

-- O ID da mensagem e estavel entre ressincronizacoes, mesmo quando o WhatsApp
-- corrige o JID/LID da conversa. A chave canonica evita duplicatas com rotas antigas.
with ranked_messages as (
    select ctid,
           row_number() over (
               partition by user_id, message_id
               order by
                   case routing_status
                       when 'resolved-alt' then 4
                       when 'mapped' then 3
                       when 'resolved' then 2
                       when 'legacy' then 1
                       else 0
                   end desc,
                   updated_at desc
           ) as duplicate_rank
    from public.whatsapp_messages
    where nullif(message_id, '') is not null
)
delete from public.whatsapp_messages
where ctid in (
    select ctid from ranked_messages where duplicate_rank > 1
);

update public.whatsapp_messages
set dedupe_key = 'id:' || message_id
where nullif(message_id, '') is not null
  and dedupe_key is distinct from 'id:' || message_id;

create unique index if not exists idx_whatsapp_messages_user_message_id
    on public.whatsapp_messages (user_id, message_id)
    where nullif(message_id, '') is not null;

alter table public.whatsapp_sessions enable row level security;
alter table public.whatsapp_contacts enable row level security;
alter table public.whatsapp_messages enable row level security;

-- O microsservico usa SUPABASE_SERVICE_ROLE_KEY e ignora RLS.
-- As politicas abaixo permitem leitura pelo app autenticado quando necessario,
-- mantendo a separacao por user_id/id.
drop policy if exists "Usuarios autenticados podem ler sua sessao whatsapp"
    on public.whatsapp_sessions;
create policy "Usuarios autenticados podem ler sua sessao whatsapp"
    on public.whatsapp_sessions for select
    to authenticated
    using (id = auth.uid()::text);

drop policy if exists "Usuarios autenticados podem ler seus contatos whatsapp"
    on public.whatsapp_contacts;
create policy "Usuarios autenticados podem ler seus contatos whatsapp"
    on public.whatsapp_contacts for select
    to authenticated
    using (user_id = auth.uid()::text);

drop policy if exists "Usuarios autenticados podem ler suas mensagens whatsapp"
    on public.whatsapp_messages;
create policy "Usuarios autenticados podem ler suas mensagens whatsapp"
    on public.whatsapp_messages for select
    to authenticated
    using (user_id = auth.uid()::text);
