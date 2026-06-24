import React from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import DashboardClient from '@/components/DashboardClient';
import { Task, Client, Profile, Collaborator, Status } from '@/types';

// Desabilita cache estático para essa rota
export const revalidate = 0;

export default async function HomePage() {
  const supabase = await createClient();

  // Verifica se o usuário está autenticado no servidor
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Busca o perfil do usuário atual
  const { data: profileData, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  let profile = profileData as Profile | null;

  // Fallback de segurança: se o trigger falhar em criar o perfil, criamos aqui
  if (!profile && user) {
    // Verifica a quantidade de perfis para ver se é o primeiro usuário
    const { count } = await supabase
      .from('profiles')
      .select('*', { count: 'exact', head: true });

    const role = (count === 0) ? 'admin' : 'collaborator';

    const { data: newProfile } = await supabase
      .from('profiles')
      .insert({
        id: user.id,
        email: user.email!,
        role: role
      })
      .select()
      .single();

    if (newProfile) {
      profile = newProfile as Profile;
    }
  }

  // Busca todas as tarefas
  const { data: tasksData } = await supabase
    .from('tasks')
    .select('*, clients(name)')
    .order('created_at', { ascending: false });

  const tasks = (tasksData || []) as Task[];

  // Busca todos os clientes
  const { data: clientsData } = await supabase
    .from('clients')
    .select('*')
    .order('name', { ascending: true });

  const clients = (clientsData || []) as Client[];

  // Busca todos os colaboradores
  const { data: collaboratorsData } = await supabase
    .from('collaborators')
    .select('*')
    .order('name', { ascending: true });

  const collaborators = (collaboratorsData || []) as Collaborator[];

  // Busca todos os status
  const { data: statusesData } = await supabase
    .from('statuses')
    .select('*')
    .order('created_at', { ascending: true });

  const statuses = (statusesData || []) as Status[];

  return (
    <DashboardClient 
      initialTasks={tasks} 
      initialClients={clients} 
      initialCollaborators={collaborators}
      initialStatuses={statuses}
      profile={profile} 
    />
  );
}
