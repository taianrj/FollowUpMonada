export type Statement = { sql: string; params: (string | number | null)[] };
export type SqlResult = { success: boolean; results: Record<string, unknown>[]; meta?: { changes?: number } };
export type Execute = (statements: Statement[]) => Promise<SqlResult[]>;
export function createD1Transport(options?: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch }): Execute;
