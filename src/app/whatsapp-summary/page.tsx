import React from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import WhatsappSummaryClient from '@/components/WhatsappSummaryClient';
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
  try {
    const { data: summariesData, error: summariesErr } = await supabase
      .from('whatsapp_summaries')
      .select('*')
      .eq('created_by', user.id)
      .order('summary_date', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(30);

    if (!summariesErr && summariesData) {
      initialSummaries = summariesData as WhatsappSummary[];
    }
  } catch (err) {
    console.warn('Tabela whatsapp_summaries ainda não foi criada no banco de dados.', err);
  }

  return (
    <WhatsappSummaryClient
      profile={profile}
      initialClients={(clients || []) as Client[]}
      initialStatuses={(statuses || []) as Status[]}
      initialSummaries={initialSummaries}
    />
  );
}
