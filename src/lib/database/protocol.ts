export type DataRequest = {
  table: string;
  operation: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  select?: string;
  returning?: boolean;
  values?: Record<string, unknown> | Record<string, unknown>[];
  filters?: { field: string; operator: string; value: unknown }[];
  order?: { field: string; ascending: boolean }[];
  onConflict?: string;
  limit?: number;
  offset?: number;
  count?: 'exact';
  head?: boolean;
  cardinality?: 'one' | 'maybe';
};

// The compatibility boundary is deliberately restricted to the query methods
// used by this app. Providers do not have to implement the Supabase SDK.
export type DataResult = {
  data: unknown;
  error: { message: string; code?: string } | null;
  count?: number | null;
};
