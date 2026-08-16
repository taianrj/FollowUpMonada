-- Migração aditiva: embeddings de demandas e auditoria dos resumos de IA.
-- Execute no SQL Editor do Supabase antes de ativar a deduplicação vetorial.

create schema if not exists extensions;
create extension if not exists vector with schema extensions;

alter table public.tasks
    add column if not exists description_embedding extensions.vector(768),
    add column if not exists description_embedding_model text,
    add column if not exists description_embedding_updated_at timestamp with time zone;

comment on column public.tasks.description_embedding is
    'Embedding de 768 dimensões da descrição, usado somente para deduplicação semântica.';
comment on column public.tasks.description_embedding_model is
    'Modelo usado para gerar description_embedding; embeddings de modelos diferentes não devem ser comparados.';

create index if not exists idx_tasks_active_description_embedding
    on public.tasks using hnsw (description_embedding extensions.vector_cosine_ops)
    where is_archived = false and description_embedding is not null;

create or replace function public.clear_task_embedding_on_description_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if new.description is distinct from old.description then
        new.description_embedding = null;
        new.description_embedding_model = null;
        new.description_embedding_updated_at = null;
    end if;
    return new;
end;
$$;

drop trigger if exists clear_task_embedding_on_description_change on public.tasks;
create trigger clear_task_embedding_on_description_change
    before update of description on public.tasks
    for each row execute function public.clear_task_embedding_on_description_change();

create or replace function public.match_active_task_embeddings(
    query_embedding extensions.vector(768),
    match_client_id uuid,
    match_threshold double precision,
    match_count integer,
    match_embedding_model text
)
returns table (
    id uuid,
    description text,
    similarity double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
    select
        tasks.id,
        tasks.description,
        (1 - (tasks.description_embedding <=> query_embedding))::double precision as similarity
    from public.tasks
    where tasks.client_id = match_client_id
      and tasks.is_archived = false
      and tasks.description_embedding is not null
      and tasks.description_embedding_model = match_embedding_model
      and 1 - (tasks.description_embedding <=> query_embedding) >= match_threshold
    order by tasks.description_embedding <=> query_embedding
    limit greatest(1, least(match_count, 50));
$$;

revoke all on function public.match_active_task_embeddings(
    extensions.vector(768), uuid, double precision, integer, text
) from public;
grant execute on function public.match_active_task_embeddings(
    extensions.vector(768), uuid, double precision, integer, text
) to authenticated;

alter table public.whatsapp_summaries
    add column if not exists ai_provider text,
    add column if not exists ai_model text;

comment on column public.whatsapp_summaries.ai_provider is
    'Provedor que gerou o resumo (gemini ou groq).';
comment on column public.whatsapp_summaries.ai_model is
    'ID exato do modelo que gerou o resumo.';
