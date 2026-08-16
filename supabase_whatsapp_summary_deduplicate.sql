-- Execute este script antes de supabase_whatsapp_summary_uniqueness.sql.
--
-- Para cada combinação de usuário e data, mantém o resumo mais recente
-- (created_at maior; id maior como desempate) e remove os anteriores.
-- Os registros removidos são preservados integralmente, em JSONB, na tabela
-- protegida whatsapp_summaries_duplicate_archive para auditoria e recuperação.

begin;

-- Impede inserções/alterações concorrentes durante a seleção e a remoção.
lock table public.whatsapp_summaries in share row exclusive mode;

create table if not exists public.whatsapp_summaries_duplicate_archive (
  original_id uuid primary key,
  archived_at timestamp with time zone not null default timezone('utc'::text, now()),
  archival_reason text not null,
  summary_record jsonb not null
);

alter table public.whatsapp_summaries_duplicate_archive enable row level security;
revoke all on table public.whatsapp_summaries_duplicate_archive from anon, authenticated;

-- Primeiro arquiva todas as cópias antigas. A transação inteira será revertida
-- se qualquer etapa falhar, evitando remoções sem uma cópia recuperável.
with ranked_summaries as (
  select
    id,
    row_number() over (
      partition by created_by, summary_date
      order by created_at desc, id desc
    ) as position
  from public.whatsapp_summaries
  where created_by is not null
)
insert into public.whatsapp_summaries_duplicate_archive (
  original_id,
  archival_reason,
  summary_record
)
select
  summary.id,
  'Duplicado mais antigo removido antes da criação do índice único',
  to_jsonb(summary)
from public.whatsapp_summaries as summary
inner join ranked_summaries as ranked on ranked.id = summary.id
where ranked.position > 1
on conflict (original_id) do nothing;

-- Remove somente os registros antigos que já possuem cópia no arquivo.
with ranked_summaries as (
  select
    id,
    row_number() over (
      partition by created_by, summary_date
      order by created_at desc, id desc
    ) as position
  from public.whatsapp_summaries
  where created_by is not null
),
deleted_summaries as (
  delete from public.whatsapp_summaries as summary
  using ranked_summaries as ranked
  where summary.id = ranked.id
    and ranked.position > 1
    and exists (
      select 1
      from public.whatsapp_summaries_duplicate_archive as archive
      where archive.original_id = summary.id
    )
  returning summary.id
)
select count(*) as deleted_duplicate_count
from deleted_summaries;

commit;

-- Deve retornar zero linhas antes da execução do script de unicidade.
select created_by, summary_date, count(*) as summary_count
from public.whatsapp_summaries
where created_by is not null
group by created_by, summary_date
having count(*) > 1;
