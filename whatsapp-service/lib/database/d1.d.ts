import { DataQuery, DataRequest, DataResult } from './query';
import { Execute } from './transport';
export type Actor = { id: string; role: string; is_active: boolean };
export function createD1Database(options?: { execute?: Execute; actor?: Actor | null; service?: boolean }): {
  query(request: DataRequest): Promise<DataResult>;
  from(table: string): DataQuery;
  execute: Execute;
};
