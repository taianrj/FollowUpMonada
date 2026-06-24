import React from 'react';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import AdminClient from '@/components/AdminClient';
import { Profile } from '@/types';

// Desabilita cache estático para essa rota
export const revalidate = 0;

export default async function AdminPage() {
  const supabase = await createClient();

  // 1. Verifica se usuário está autenticado
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    redirect('/login');
  }

  // 2. Busca o perfil do usuário logado e valida se é Admin
  const { data: profileData } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  const profile = profileData as Profile | null;

  if (!profile || profile.role !== 'admin') {
    redirect('/');
  }

  // 3. Busca todos os perfis cadastrados no sistema
  const { data: allProfiles } = await supabase
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false });

  return (
    <AdminClient 
      profiles={(allProfiles || []) as Profile[]} 
      currentProfile={profile} 
    />
  );
}
