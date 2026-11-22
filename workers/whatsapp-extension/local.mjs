import { mkdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { ExtensionEngine } from './engine.mjs';
import { digest } from './domain.mjs';

// Somente desenvolvimento. Cada usuário tem um SQLite privado e persistente.
// Produção usa o armazenamento SQLite e os alarms dos Durable Objects.
const registry = globalThis[Symbol.for('monada.extension.local')] ||= new Map();
export async function localEngine(userId, providers, directory = path.join(process.cwd(), '.extension-data')) {
  const key = await digest(userId);
  if (registry.has(key)) return registry.get(key);
  const creation = (async () => {
    const dir = path.join(directory, key); await mkdir(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, 'state.sqlite'));
    db.exec('CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const get = db.prepare('SELECT value FROM state WHERE key = ?');
    const put = db.prepare('INSERT INTO state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const remove = db.prepare('DELETE FROM state WHERE key = ?');
    const list = db.prepare('SELECT key,value FROM state WHERE substr(key,1,?) = ? ORDER BY key');
    let timer, engine;
    const schedule = timestamp => { clearTimeout(timer); timer = setTimeout(async () => { remove.run('__alarm'); try { await engine.tick(); } catch { await storage.setAlarm(Date.now() + 30000); } }, Math.max(0, timestamp - Date.now())); timer.unref(); };
    const storage = {
      async get(k) { const row = get.get(k); return row ? JSON.parse(row.value) : undefined; },
      async put(k, value) { put.run(k, JSON.stringify(value)); }, async delete(k) { remove.run(k); },
      async list({ prefix }) { return new Map(list.all(prefix.length, prefix).map(row => [row.key, JSON.parse(row.value)])); },
      async getAlarm() { const row = get.get('__alarm'); return row ? JSON.parse(row.value) : null; },
      async setAlarm(t) { put.run('__alarm', JSON.stringify(t)); schedule(t); }
    };
    engine = new ExtensionEngine(storage, providers); const alarm = await storage.getAlarm(); if (alarm) schedule(alarm);
    let requests = Promise.resolve();
    return { call(action, body) { const result = requests.then(() => engine.call(action, body)); requests = result.catch(() => {}); return result; } };
  })();
  registry.set(key, creation); try { return await creation; } catch (error) { registry.delete(key); throw error; }
}
