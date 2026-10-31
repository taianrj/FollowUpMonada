'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {TABLE_ORDER,validateSnapshot,snapshotSummary,migrationPlan,verifySnapshots,sealSnapshot,openSnapshot}=require('../lib/database/migration');

function fixture(provider='supabase') {
  const tables=Object.fromEntries(TABLE_ORDER.map(table=>[table,[]]));
  tables.monada_auth_users=[{id:'u',email:'user@example.test',password_hash:null,email_confirmed_at:null,last_sign_in_at:null,created_at:'2026-10-31T12:00:00.000Z'}];
  tables.profiles=[{id:'u',email:'user@example.test',role:'admin',is_active:true}];
  tables.clients=[{id:'c',name:'Fixture'}];
  return {version:1,provider,createdAt:'2026-10-31T12:00:00.000Z',tables};
}

test('migration snapshots preserve all identities and reject missing tables, unknown columns and unsupported password hashes',()=>{
  assert.ok(validateSnapshot(fixture()));
  const missing=fixture();delete missing.tables.whatsapp_sessions;
  assert.throws(()=>validateSnapshot(missing),/incompleto/);
  const extra=fixture();extra.tables.clients[0].unmapped_secret='test';
  assert.throws(()=>validateSnapshot(extra),/nao mapeadas/);
  const unsupported=fixture();unsupported.tables.monada_auth_users[0].password_hash='not-bcrypt';
  assert.throws(()=>validateSnapshot(unsupported),/Hash/);
  const orphan=fixture();orphan.tables.profiles[0].id='other';
  assert.throws(()=>validateSnapshot(orphan),/sem identidade/);
});

test('encrypted backups are authenticated, require the correct key and contain no readable user data',()=>{
  const snapshot=fixture(),key=crypto.randomBytes(32);
  const encrypted=sealSnapshot(snapshot,key);
  assert.equal(encrypted.includes(Buffer.from('user@example.test')),false);
  assert.deepEqual(openSnapshot(encrypted,key),snapshot);
  assert.throws(()=>openSnapshot(encrypted,crypto.randomBytes(32)),/validar/);
  encrypted[encrypted.length-1]^=1;
  assert.throws(()=>openSnapshot(encrypted,key),/validar/);
});

test('migration dry runs detect inserts, changed content and deleted rows without exposing row contents',()=>{
  const source=fixture(),target=fixture('d1');
  source.tables.clients[0].name='Changed';
  source.tables.collaborators=[{id:'new',name:'Test'}];
  target.tables.tasks=[{id:'old',description:'old'}];
  const plan=migrationPlan(source,target);
  assert.deepEqual(plan.clients,{insert:0,update:1,remove:0});
  assert.deepEqual(plan.collaborators,{insert:1,update:0,remove:0});
  assert.deepEqual(plan.tasks,{insert:0,update:0,remove:1});
  assert.equal(JSON.stringify(plan).includes('Changed'),false);
  const summary=snapshotSummary(source);
  assert.equal(summary.profiles.rows,1);
  assert.equal(summary.profiles.sha256.length,64);
});

test('snapshot fingerprints ignore object key ordering but detect any changed value',()=>{
  const a=fixture(),b=fixture('d1');
  b.tables.clients=[{name:'Fixture',id:'c'}];
  assert.deepEqual(migrationPlan(a,b).clients,{insert:0,update:0,remove:0});
  b.tables.clients[0].name='Different';
  assert.equal(migrationPlan(a,b).clients.update,1);
});

test('verification allows Auth audit timestamps to change but requires identical credentials and business data',()=>{
  const source=fixture(),target=fixture('d1');
  target.tables.monada_auth_users[0].last_sign_in_at='2026-11-01T12:00:00.000Z';
  assert.equal(verifySnapshots(source,target).equal,true);
  target.tables.monada_auth_users[0].email='other@example.test';
  assert.deepEqual(verifySnapshots(source,target).differences,['monada_auth_users']);
});

test('real SQLite transfer preserves IDs, vectors, audit dates, JSON and large credential snapshots across repeated copies',async()=>{
  const {databaseFixture}=require('./database-fixture');
  const {createD1Database}=require('../lib/database/d1');
  const {readD1,importD1,reconcileDeletions}=require('../../scripts/database.cjs');
  const from=databaseFixture(),to=databaseFixture();
  from.sqlite.exec("INSERT INTO monada_auth_users(id,email) VALUES ('u','user@example.test');INSERT INTO profiles(id,email,role) VALUES ('u','user@example.test','admin');INSERT INTO clients(id,name) VALUES ('c','Fixture');INSERT INTO statuses(id,name) VALUES ('open','Open');");
  const db=createD1Database({execute:from.execute,service:true});
  await db.from('tasks').insert({id:'t',client_id:'c',description:'before',status:'open',responsibles:['Fixture'],description_embedding:'[1,0]',description_embedding_model:'test',created_at:'2026-10-31T12:00:00.000Z',updated_at:'2026-10-31T12:00:00.000Z'});
  await db.from('whatsapp_sessions').upsert({id:'u:messages:2026-10-31',creds:JSON.stringify({content:'a'.repeat(2100000)}),updated_at:'2026-10-31T12:00:00.000Z'});
  let snapshot=await readD1({execute:from.execute});
  snapshot.provider='supabase';
  await importD1(snapshot,{execute:to.execute});
  assert.equal(verifySnapshots(snapshot,await readD1({execute:to.execute})).equal,true);
  await db.from('tasks').update({description:'after'}).eq('id','t');
  await db.from('tasks').update({description_embedding:'[0,1]',description_embedding_model:'test'}).eq('id','t');
  snapshot=await readD1({execute:from.execute});snapshot.provider='supabase';
  await importD1(snapshot,{execute:to.execute});
  assert.equal(verifySnapshots(snapshot,await readD1({execute:to.execute})).equal,true);
  await db.from('whatsapp_sessions').delete().eq('id','u:messages:2026-10-31');
  snapshot=await readD1({execute:from.execute});snapshot.provider='supabase';
  const previous=await readD1({execute:to.execute});
  assert.equal(migrationPlan(snapshot,previous).whatsapp_sessions.remove,1);
  await reconcileDeletions(snapshot,previous,{execute:to.execute});
  assert.equal(verifySnapshots(snapshot,await readD1({execute:to.execute})).equal,true);
  assert.equal(to.sqlite.prepare('SELECT count(*) AS n FROM monada_blob_chunks').get().n,0);
});
