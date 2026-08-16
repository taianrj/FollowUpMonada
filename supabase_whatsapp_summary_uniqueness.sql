-- Garante no banco que cada usuário tenha no máximo um resumo por dia.
-- Antes de aplicar em uma base existente, confirme que não há duplicidades:
-- select created_by, summary_date, count(*)
-- from public.whatsapp_summaries
-- where created_by is not null
-- group by created_by, summary_date
-- having count(*) > 1;

create unique index if not exists whatsapp_summaries_created_by_summary_date_key
  on public.whatsapp_summaries (created_by, summary_date)
  where created_by is not null;

comment on index public.whatsapp_summaries_created_by_summary_date_key is
  'Impede mais de um resumo de WhatsApp por usuário na mesma data.';
