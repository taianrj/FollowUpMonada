'use strict';

(function initMonadaPocStorage(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MonadaPocStorage = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function createMonadaPocStorage() {
  const DB_NAME = 'monada-wa-poc-viewer-db';
  const STORE_NAME = 'rounds';
  const DB_VERSION = 1;

  function openDb() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB indisponível neste contexto.'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'roundKey' });
        }
      };
      req.onerror = () => reject(req.error || new Error('Erro ao abrir armazenamento local da PoC.'));
      req.onsuccess = () => resolve(req.result);
    });
  }

  async function saveRound(roundKey, report) {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put({
          roundKey,
          savedAt: new Date().toISOString(),
          report
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Erro ao salvar rodada localmente.'));
      });
    } finally {
      db.close();
    }
  }

  async function loadAllRounds() {
    const db = await openDb();
    try {
      const records = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const req = tx.objectStore(STORE_NAME).getAll();
        req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
        req.onerror = () => reject(req.error || new Error('Erro ao carregar rodadas salvas.'));
      });
      const out = { round1: null, round2: null, round3: null };
      for (const rec of records) {
        if (rec?.roundKey && Object.prototype.hasOwnProperty.call(out, rec.roundKey)) {
          out[rec.roundKey] = rec.report || null;
        }
      }
      return out;
    } finally {
      db.close();
    }
  }

  async function clearAllRounds() {
    const db = await openDb();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error || new Error('Erro ao limpar rodadas salvas.'));
      });
    } finally {
      db.close();
    }
  }

  return {
    saveRound,
    loadAllRounds,
    clearAllRounds
  };
});
