'use strict';

function databaseProvider(env = process.env) {
  const provider = env.DATABASE_PROVIDER || 'supabase';
  if (provider !== 'supabase' && provider !== 'd1') {
    throw new Error('DATABASE_PROVIDER invalido. Use supabase ou d1.');
  }
  return provider;
}

function d1Configuration(env = process.env) {
  const accountId = env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = env.CLOUDFLARE_D1_DATABASE_ID;
  const token = env.CLOUDFLARE_D1_API_TOKEN;
  if (!/^[a-f0-9]{32}$/i.test(accountId || '') ||
      !/^[a-f0-9-]{36}$/i.test(databaseId || '') || !token) {
    throw new Error('Configuracao D1 incompleta ou invalida.');
  }
  return { accountId, databaseId, token };
}

module.exports = { databaseProvider, d1Configuration };
