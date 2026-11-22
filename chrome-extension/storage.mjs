const dbName = 'monada-extension-integration';
async function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('operations')) request.result.createObjectStore('operations', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('local')) request.result.createObjectStore('local');
    };
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('Não foi possível acessar a coleta local.'));
  });
}
export async function operation(id) {
  const db = await database();
  try { return await new Promise((resolve, reject) => { const request = db.transaction('operations', 'readonly').objectStore('operations').get(id); request.onsuccess = () => resolve(request.result); request.onerror = reject; }); }
  finally { db.close(); }
}
export async function saveOperation(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > 200 * 1024 * 1024) throw new Error('A coleta excede 200 MiB. Nenhum resumo foi substituído.');
  const db = await database();
  try { await new Promise((resolve, reject) => { const tx = db.transaction('operations', 'readwrite'); tx.objectStore('operations').put(value); tx.oncomplete = resolve; tx.onerror = reject; }); }
  finally { db.close(); }
}
export async function cleanOperations(userId, origin, expiredOnly = false) {
  const db = await database();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction('operations', 'readwrite'), request = tx.objectStore('operations').openCursor();
      request.onsuccess = () => {
        const cursor = request.result; if (!cursor) return;
        const value = cursor.value;
        if (expiredOnly ? value.createdAt + 7 * 86400000 <= Date.now() : value.userId === userId && value.origin === origin) cursor.delete();
        cursor.continue();
      };
      tx.oncomplete = resolve; tx.onerror = reject;
    });
  } finally { db.close(); }
}
export async function deleteOperation(id) {
  const db = await database();
  try { await new Promise((resolve, reject) => { const tx = db.transaction('operations', 'readwrite'); tx.objectStore('operations').delete(id); tx.oncomplete = resolve; tx.onerror = reject; }); }
  finally { db.close(); }
}

// A transação confirma antes de devolver sucesso: nenhum estado vive só em RAM.
export async function localTransaction(mode, action) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('local', mode), store = tx.objectStore('local');
      let result;
      const request = action(store, value => { result = value; });
      if (request) { request.onsuccess = () => { result = request.result; }; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = tx.onabort = () => reject(new Error('Não foi possível salvar os dados locais. Verifique o espaço disponível no Chrome.'));
    });
  } finally { db.close(); }
}
export function localStorage(namespace) {
  const prefix = namespace + ':';
  const size = value => value === undefined ? 0 : new TextEncoder().encode(JSON.stringify(value)).length;
  function change(key, value, remove) {
    return localTransaction('readwrite', store => {
      const usage = store.get(prefix + '__bytes');
      usage.onsuccess = () => {
        const previous = store.get(prefix + key);
        previous.onsuccess = () => {
          const next = Math.max(0, (usage.result || 0) - size(previous.result) + (remove ? 0 : size(value)));
          if (next > 256 * 1024 * 1024) { store.transaction.abort(); return; }
          if (remove) store.delete(prefix + key); else store.put(value, prefix + key);
          store.put(next, prefix + '__bytes');
        };
      };
    });
  }
  return {
    get: key => localTransaction('readonly', s => s.get(prefix + key)),
    put: (key, value) => change(key, value, false),
    delete: key => change(key, undefined, true),
    async list({ prefix: filter }) {
      const start = prefix + filter;
      return localTransaction('readonly', (store, setResult) => {
        const rows = new Map(), request = store.openCursor(IDBKeyRange.bound(start, start + '\uffff'));
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) { setResult(rows); return; }
          if (cursor.key !== prefix + '__bytes') rows.set(cursor.key.slice(prefix.length), cursor.value);
          cursor.continue();
        };
      });
    },
    async getAlarm() { return (await chrome.alarms.get('local:' + namespace))?.scheduledTime || null; },
    async setAlarm(timestamp) { await chrome.alarms.create('local:' + namespace, { when: Math.max(timestamp, Date.now() + 30000) }); }
  };
}
