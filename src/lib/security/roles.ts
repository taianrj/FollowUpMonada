export type ManagedUserRole = 'admin' | 'collaborator';

export function normalizeManagedUserRole(value: unknown): ManagedUserRole | null {
  return value === 'admin' || value === 'collaborator' ? value : null;
}
