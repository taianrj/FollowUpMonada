import React from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import CadastrosClient from '@/components/CadastrosClient';
import { Client, Collaborator, Status, Profile } from '@/types';

// Desabilita cache estático para essa rota
export const revalidate = 0;

export default async function CadastrosPage() {
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

  // 3. Busca todos os clientes
  const { data: clients } = await supabase
    .from('clients')
    .select('*')
    .order('name', { ascending: true });

  // 4. Busca todos os colaboradores
  const { data: collaborators } = await supabase
    .from('collaborators')
    .select('*')
    .order('name', { ascending: true });

  // 5. Busca todos os status
  const { data: statuses } = await supabase
    .from('statuses')
    .select('*')
    .order('created_at', { ascending: true });

  return (
    <CadastrosClient 
      initialClients={(clients || []) as Client[]} 
      initialCollaborators={(collaborators || []) as Collaborator[]} 
      initialStatuses={(statuses || []) as Status[]} 
      profile={profile} 
    />
  );
}
