'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const {databaseFixture}=require('./database-fixture');
const {createD1Database}=require('../lib/database/d1');
const {createPersistenceFetch,persistenceConfiguration}=require('../lib/database/persistence');

const env={DATABASE_PROVIDER:'d1',CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_D1_DATABASE_ID:'b'.repeat(36),CLOUDFLARE_D1_API_TOKEN:'test-token'};

test('WhatsApp persistence selects D1 without calling Supabase and preserves fromMe and identity aliases',async()=>{
  const f=databaseFixture();
  const fetchDb=createPersistenceFetch({env,execute:f.execute,fetchImpl:()=>{throw new Error('Unexpected Supabase request');}});
  const base=persistenceConfiguration(env).cleanUrl+'/rest/v1/';
  const row={user_id:'u',dedupe_key:'id:message',message_id:'message',chat_jid:'chat@lid',chat_number:'test',chat_aliases:['chat@lid','pn@s.whatsapp.net'],text:'fixture',from_me:false,message_timestamp:'2026-10-31T12:00:00Z',message_date:'2026-10-31',updated_at:'2026-10-31T12:00:00Z'};
  assert.equal((await fetchDb(base+'whatsapp_messages?on_conflict=user_id,dedupe_key',{method:'POST',body:JSON.stringify([row])})).status,200);
  const result=await (await fetchDb(base+'whatsapp_messages?user_id=eq.u&message_date=eq.2026-10-31&select=*&order=message_timestamp.asc')).json();
  assert.equal(result.length,1);assert.equal(result[0].from_me,false);assert.deepEqual(result[0].chat_aliases,row.chat_aliases);
  assert.equal((await (await fetchDb(base+'whatsapp_messages?user_id=eq.other')).json()).length,0);
});

test('snapshots larger than the D1 row limit roundtrip as atomic checksummed chunks',async()=>{
  const f=databaseFixture();
  const db=createD1Database({execute:f.execute,service:true});
  const payload=JSON.stringify({fixture:'á😃'.repeat(500000),raw:{type:'Buffer',data:'AQID'}});
  const row={id:'user:media-processing:default',creds:payload,updated_at:'2026-10-31T12:00:00Z'};
  const stored=await db.from('whatsapp_sessions').upsert(row);
  assert.equal(stored.error,null);
  assert.ok(f.sqlite.prepare('SELECT max(length(content)) AS n FROM monada_blob_chunks').get().n<2000000);
  assert.equal((await db.from('whatsapp_sessions').select('creds').eq('id',row.id).single()).data.creds,payload);
  await db.from('whatsapp_sessions').upsert({...row,creds:'small'});
  assert.equal(f.sqlite.prepare('SELECT count(*) AS n FROM monada_blob_chunks').get().n,0);
  await db.from('whatsapp_sessions').upsert(row);
  f.sqlite.exec('DELETE FROM monada_blob_chunks WHERE chunk_index=0');
  assert.ok((await db.from('whatsapp_sessions').select().eq('id',row.id)).error);
});

test('prefix cleanup escapes SQL wildcards and removes only the intended user snapshots',async()=>{
  const f=databaseFixture();
  const fetchDb=createPersistenceFetch({env,execute:f.execute});
  const base=persistenceConfiguration(env).cleanUrl+'/rest/v1/whatsapp_sessions';
  for(const id of ['user_a:messages:2026-10-31','userXa:messages:2026-10-31','user_a:auth-state:default']) await fetchDb(base,{method:'POST',body:JSON.stringify({id,creds:'{}',updated_at:'2026-10-31T12:00:00Z'})});
  await fetchDb(base+'?id=like.'+encodeURIComponent('user_a:messages:*'),{method:'DELETE'});
  assert.deepEqual(f.sqlite.prepare('SELECT id FROM whatsapp_sessions ORDER BY id').all().map(row=>row.id),['userXa:messages:2026-10-31','user_a:auth-state:default']);
  await assert.rejects(()=>fetchDb('https://attacker.example/rest/v1/whatsapp_sessions'),/Origem/);
});
