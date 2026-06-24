export type UserRole = 'admin' | 'collaborator';

export interface Profile {
  id: string;
  email: string;
  role: UserRole;
  created_at: string;
  name?: string;
  is_active: boolean;
}

export interface Client {
  id: string;
  name: string;
  created_at: string;
}

export interface Collaborator {
  id: string;
  name: string;
  created_at: string;
}

export interface Status {
  id: string; // ex: 'ajuste'
  name: string; // ex: 'Ajuste'
  color: string; // ex: '#06b6d4'
  created_at: string;
}

export interface Task {
  id: string;
  client_id: string;
  description: string;
  responsibles: string[];
  status: string; // dinâmico referenciando public.statuses.id
  observations: string;
  created_by: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  // Campos populados por joins do Supabase
  clients?: {
    name: string;
  };
  statuses?: {
    name: string;
    color: string;
  };
}
