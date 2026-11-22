// Armazena SOMENTE o resultado final em testes locais, sem iniciar o engine
// antigo, seus timers ou qualquer importação persistida anteriormente.
import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { digest, requireValue, validId, validDate } from './domain.mjs';
export async function summaryStore(userId, directory = path.join(process.cwd(), '.extension-data', 'summaries')) {
  requireValue(validId(userId), 'Usuário inválido.', 403);
  const dir = path.join(directory, await digest(userId)); await mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, 'summaries.sqlite'));
  db.exec('CREATE TABLE IF NOT EXISTS summaries (date TEXT PRIMARY KEY, value TEXT NOT NULL)');
  return {
    all() { return db.prepare('SELECT value FROM summaries ORDER BY date DESC').all().map(row => JSON.parse(row.value)); },
    save(summary) {
      requireValue(validDate(summary.summary_date) && summary.created_by === userId && summary.raw_text === '', 'Resumo local inválido.');
      db.prepare('INSERT INTO summaries(date,value) VALUES (?,?) ON CONFLICT(date) DO UPDATE SET value=excluded.value').run(summary.summary_date, JSON.stringify(summary));
    },
    close() { db.close(); }
  };
}
