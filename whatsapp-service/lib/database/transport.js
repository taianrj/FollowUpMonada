'use strict';

const { d1Configuration } = require('./config');

/** Trusted server transport. SQL is built only by adapters, never supplied by HTTP clients. */
function createD1Transport({ env = process.env, fetchImpl = fetch } = {}) {
  const { accountId, databaseId, token } = d1Configuration(env);
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  return async function execute(statements) {
    if (!Array.isArray(statements) || !statements.length || statements.length > 500) {
      throw new Error('Lote D1 invalido.');
    }
    for (const statement of statements) {
      if (typeof statement.sql !== 'string' || Buffer.byteLength(statement.sql) > 100000 ||
          !Array.isArray(statement.params) || statement.params.length > 100) {
        throw new Error('Consulta D1 fora dos limites permitidos.');
      }
    }
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ batch: statements }),
      signal: AbortSignal.timeout(15000),
      cache: 'no-store'
    });
    if (!response.ok) throw new Error(`D1 indisponivel (${response.status}).`);
    const body = await response.json();
    if (!body.success || !Array.isArray(body.result) || body.result.length !== statements.length ||
        body.result.some(result => result.success === false || result.error)) {
      // Do not surface provider errors containing SQL parameters, user content or secrets.
      const error = new Error('Falha ao executar consulta no D1.');
      if (JSON.stringify([body.errors,body.result]).includes('UNIQUE constraint failed')) error.code = '23505';
      throw error;
    }
    return body.result;
  };
}

module.exports = { createD1Transport };
