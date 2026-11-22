import React from 'react';
import { isLocalExtension, localExtensionSummaries } from '@/lib/whatsapp-extension/server';
import { getWhatsappIntegrationMode } from '@/lib/whatsapp/integration-mode';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import WhatsappSummaryClient from '@/components/WhatsappSummaryClient';
import { getSaoPauloDateString } from '@/lib/whatsapp/summary-date';
import { Client, Status, Profile, WhatsappSummary } from '@/types';

// Desabilita cache estático para essa rota
export const revalidate = 0;

export default async function WhatsappSummaryPage() {
  const supabase = await createClient();

  // 1. Verifica se usuário está autenticado
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  // 2. Busca o perfil do usuário logado
  const { data: profileData } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  const profile = profileData as Profile | null;
  if (!profile) {
    redirect('/login');
  }

  // Permite acesso à funcionalidade apenas para administradores
  if (profile.role !== 'admin') {
    redirect('/');
  }

  // 3. Busca todos os clientes
  const { data: clients } = await supabase
    .from('clients')
    .select('*')
    .order('name', { ascending: true });

  // 4. Busca todos os status
  const { data: statuses } = await supabase
    .from('statuses')
    .select('*')
    .order('created_at', { ascending: true });

  // 5. Busca os resumos de WhatsApp anteriores (tratamos caso a tabela ainda não exista)
  let initialSummaries: WhatsappSummary[] = [];
  let initialSummaryDates: string[] = [];
  try {
    const [summariesResult, datesResult] = await Promise.all([
      supabase
        .from('whatsapp_summaries')
        .select('*')
        .eq('created_by', user.id)
        .order('summary_date', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(30),
      supabase
        .from('whatsapp_summaries')
        .select('summary_date')
        .eq('created_by', user.id)
        .order('summary_date', { ascending: false }),
    ]);

    if (!summariesResult.error && summariesResult.data) {
      initialSummaries = summariesResult.data as WhatsappSummary[];
    }
    if (!datesResult.error && datesResult.data) {
      initialSummaryDates = datesResult.data.map((summary) => summary.summary_date);
    }
  } catch (err) {
    console.warn('Tabela whatsapp_summaries ainda não foi criada no banco de dados.', err);
  }

  const integrationMode = getWhatsappIntegrationMode();
  const localExtension = integrationMode === 'chrome_extension' && isLocalExtension();
  if (localExtension) {
    const localSummaries = await localExtensionSummaries(user.id);
    initialSummaries = [...localSummaries, ...initialSummaries.filter(s => !localSummaries.some(local => local.summary_date === s.summary_date))];
    initialSummaryDates = [...new Set([...initialSummaryDates, ...localSummaries.map(s => s.summary_date)])];

  }

  return (
    <WhatsappSummaryClient
      initialDate={getSaoPauloDateString()}
      integrationMode={integrationMode}
      localExtension={localExtension}
      profile={profile}
      initialClients={(clients || []) as Client[]}
      initialStatuses={(statuses || []) as Status[]}
      initialSummaries={initialSummaries}
      initialSummaryDates={initialSummaryDates}
    />
  );
}
