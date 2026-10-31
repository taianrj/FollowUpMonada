'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { databaseProvider, d1Configuration } = require('../lib/database/config');
const { createD1Transport } = require('../lib/database/transport');
const { createD1Database } = require('../lib/database/d1');
const { DataQuery } = require('../lib/database/query');

// Production stays compatible with Node 20. The verification environment (CI
// Node 24) uses the real built-in SQLite engine rather than canned row mocks.
function fixture() {
  const { DatabaseSync } = require('node:sqlite');
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(path.join(__dirname,'../lib/database/schema.sql'),'utf8'));
  sqlite.exec("INSERT INTO monada_auth_users(id,email) VALUES ('alice','alice@example.test'),('bob','bob@example.test'),('root','root@example.test'); INSERT INTO profiles(id,email,role) SELECT id,email,CASE WHEN id='root' THEN 'admin' ELSE 'collaborator' END FROM monada_auth_users; INSERT INTO clients(id,name) VALUES ('c','Cliente'); INSERT INTO statuses(id,name) VALUES ('open','Aberto');");
  const execute = async statements => {
    sqlite.exec('BEGIN');
    try {
      const result = statements.map(({sql,params})=>({success:true,results:sqlite.prepare(sql).all(...params)}));
      sqlite.exec('COMMIT'); return result;
    } catch(error) { sqlite.exec('ROLLBACK'); throw error; }
  };
  const user = id => createD1Database({execute, actor:{id,role:id==='root'?'admin':'collaborator',is_active:true}});
  return { sqlite, execute, user, service:createD1Database({execute,service:true}) };
}

test('provider configuration defaults only when absent and rejects unknown providers',()=>{
  assert.equal(databaseProvider({}),'supabase');
  assert.equal(databaseProvider({DATABASE_PROVIDER:'d1'}),'d1');
  assert.throws(()=>databaseProvider({DATABASE_PROVIDER:'postgres'}));
  assert.throws(()=>d1Configuration({}));
});

test('D1 transport uses the documented batch envelope and never leaks provider error text',async()=>{
  let request;
  const execute=createD1Transport({env:{CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_D1_DATABASE_ID:'b'.repeat(36),CLOUDFLARE_D1_API_TOKEN:'test-secret'},fetchImpl:async(url,options)=>{
    request={url,options};
    return new Response(JSON.stringify({success:true,result:[{success:true,results:[{ok:1}]}]}));
  }});
  assert.deepEqual((await execute([{sql:'SELECT ? AS ok',params:[1]}]))[0].results,[{ok:1}]);
  assert.deepEqual(JSON.parse(request.options.body),{batch:[{sql:'SELECT ? AS ok',params:[1]}]});
  assert.equal(request.options.cache,'no-store');
  const failed=createD1Transport({env:{CLOUDFLARE_ACCOUNT_ID:'a'.repeat(32),CLOUDFLARE_D1_DATABASE_ID:'b'.repeat(36),CLOUDFLARE_D1_API_TOKEN:'test-secret'},fetchImpl:async()=>new Response(JSON.stringify({success:false,errors:[{message:'sensitive SQL value'}]}))});
  await assert.rejects(()=>failed([{sql:'SELECT 1',params:[]}]),error=>!error.message.includes('sensitive'));
});

test('query descriptors preserve chained operations and execute only once',async()=>{
  let calls=0;
  const query=new DataQuery('tasks',async request=>{calls++;return request;}).update({is_archived:true}).eq('id','t').select('id').single();
  const result=await query; await query;
  assert.equal(calls,1);
  assert.equal(result.operation,'update');
  assert.deepEqual(result.filters,[{field:'id',operator:'eq',value:'t'}]);
  assert.equal(result.cardinality,'one');
});

test('schema is idempotent and data adapter preserves JSON, booleans, joins and count',async()=>{
  const f=fixture();
  f.sqlite.exec(fs.readFileSync(path.join(__dirname,'../lib/database/schema.sql'),'utf8'));
  const inserted=await f.user('alice').from('tasks').insert({client_id:'c',description:'Revisar contrato',responsibles:['Ana'],status:'open'}).select().single();
  assert.equal(inserted.error,null);
  assert.equal(inserted.data.created_by,'alice');
  assert.equal(inserted.data.is_archived,false);
  const selected=await f.user('bob').from('tasks').select('*, clients(name)').eq('id',inserted.data.id).single();
  assert.deepEqual(selected.data.responsibles,['Ana']);
  assert.deepEqual(selected.data.clients,{name:'Cliente'});
  const counted=await f.user('alice').from('tasks').select('*',{head:true,count:'exact'});
  assert.equal(counted.count,1); assert.equal(counted.data,null);
});

test('ownership is forced on summaries and cannot be bypassed by a guessed UUID or user fields',async()=>{
  const f=fixture();
  const first=await f.user('alice').from('whatsapp_summaries').insert({id:'s',summary_date:'2026-10-31',raw_text:'test',summary_data:{summaries:[]},created_by:'bob'}).select().single();
  assert.equal(first.data.created_by,'alice');
  assert.deepEqual((await f.user('bob').from('whatsapp_summaries').select()).data,[]);
  assert.equal((await f.user('bob').from('whatsapp_summaries').update({raw_text:'changed'}).eq('id','s')).error,null);
  assert.equal((await f.user('alice').from('whatsapp_summaries').select().single()).data.raw_text,'test');
  const overwrite=await f.user('bob').from('whatsapp_summaries').upsert({id:'s',summary_date:'2026-10-31',raw_text:'changed',summary_data:{}});
  assert.equal(overwrite.error.code,'FORBIDDEN');
});

test('credentials, archives, profile escalation and inactive or anonymous access are denied',async()=>{
  const f=fixture();
  for(const table of ['whatsapp_sessions','whatsapp_summaries_duplicate_archive']) {
    assert.equal((await f.user('root').from(table).select()).error.code,'FORBIDDEN');
  }
  assert.equal((await f.user('alice').from('profiles').update({role:'admin'}).eq('id','alice')).error.code,'FORBIDDEN');
  assert.equal((await f.user('alice').from('profiles').insert({id:'new',email:'new@example.test',role:'admin'})).error.code,'FORBIDDEN');
  const prefs=await f.user('alice').from('profiles').update({interpret_images:true}).eq('id','bob');
  assert.equal(prefs.error,null);
  assert.equal(f.sqlite.prepare("SELECT interpret_images FROM profiles WHERE id='bob'").get().interpret_images,0);
  assert.equal((await createD1Database({execute:f.execute}).from('tasks').select()).error.code,'FORBIDDEN');
  assert.equal((await createD1Database({execute:f.execute,actor:{id:'alice',role:'admin',is_active:false}}).from('tasks').select()).error.code,'FORBIDDEN');
});

test('SQL injection, unknown fields, unbounded mutations and batches violating constraints fail closed',async()=>{
  const f=fixture();
  assert.ok((await f.user('alice').from('tasks; DROP TABLE profiles').select()).error);
  assert.ok((await f.user('alice').from('tasks').select().eq('id OR 1=1','x')).error);
  assert.ok((await f.user('root').from('clients').delete()).error);
  assert.ok((await f.user('alice').from('tasks').update({description:'all'})).error);
  assert.ok((await f.user('alice').from('clients').insert([{name:'same'},{name:'same'}])).error);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM clients WHERE name='same'").get().n,0);
  assert.equal((await f.user('alice').from('clients').select().eq('name',"' OR 1=1 --")).data.length,0);
});

test('description edits invalidate semantic vectors and audit identity cannot be impersonated',async()=>{
  const f=fixture();
  await f.service.from('tasks').insert({id:'t',client_id:'c',description:'before',status:'open',description_embedding:'[1,0]',description_embedding_model:'model'});
  await f.user('alice').from('tasks').update({description:'after'}).eq('id','t');
  assert.equal(f.sqlite.prepare("SELECT description_embedding FROM tasks WHERE id='t'").get().description_embedding,null);
  const history=await f.user('alice').from('task_history').insert({task_id:'t',action:'update',changed_by:'root',changes:{description:{old:'before',new:'after'}}}).select().single();
  assert.equal(history.data.changed_by,'alice');
  const view=await f.user('bob').from('task_history').select('id,task_id,changed_by,profiles:changed_by(name,email)');
  assert.equal(view.data[0].profiles,null);
});
