export type DataRequest = {
  table: string; operation: 'select' | 'insert' | 'update' | 'upsert' | 'delete';
  select?: string; returning?: boolean;
  values?: Record<string, unknown> | Record<string, unknown>[];
  filters?: { field: string; operator: string; value: unknown }[];
  order?: { field: string; ascending: boolean }[];
  onConflict?: string; limit?: number; offset?: number;
  count?: 'exact'; head?: boolean; cardinality?: 'one' | 'maybe';
};
export type DataResult = { data: unknown; error: { message: string; code?: string } | null; count?: number | null };
export class DataQuery implements PromiseLike<DataResult> {
  constructor(table: string, execute: (request: DataRequest) => Promise<DataResult>);
  request: DataRequest;
  select(fields?: string, options?: { count?: 'exact'; head?: boolean }): this;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): this;
  update(values: Record<string, unknown>): this;
  upsert(values: Record<string, unknown> | Record<string, unknown>[], options?: { onConflict?: string }): this;
  delete(): this;
  filter(field: string, operator: string, value: unknown): this;
  eq(field: string, value: unknown): this;
  neq(field: string, value: unknown): this;
  is(field: string, value: unknown): this;
  in(field: string, value: unknown[]): this;
  gte(field: string, value: unknown): this;
  lte(field: string, value: unknown): this;
  gt(field: string, value: unknown): this;
  lt(field: string, value: unknown): this;
  order(field: string, options?: { ascending?: boolean }): this;
  limit(limit: number): this;
  range(from: number, to: number): this;
  single(): this;
  maybeSingle(): this;
  then<TResult1 = DataResult, TResult2 = never>(onfulfilled?: ((value: DataResult) => TResult1 | PromiseLike<TResult1>) | null, onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null): PromiseLike<TResult1 | TResult2>;
}
