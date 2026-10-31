#!/usr/bin/env node
'use strict';

// Explicit operator CLI. No command changes DATABASE_PROVIDER or deployment
// settings before a data copy has been independently verified.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {createD1Transport}=require('../whatsapp-service/lib/database/transport');
const {createD1Database}=require('../whatsapp-service/lib/database/d1');
const {tables}=require('../whatsapp-service/lib/database/catalog');
const {TABLE_ORDER,AUTH_FIELDS,canonical,normalizeRow,validateSnapshot,rowKey,snapshotSummary,migrationPlan,verifySnapshots,sealSnapshot,openSnapshot}=require('../whatsapp-service/lib/database/migration');

const root=path.resolve(__dirname,'..');
const backupDir=path.join(root,'.migration-data');
class MigrationError extends Error {}
function loadEnvironment() {
  const file=path.join(root,'.env.local');
  if(!fs.existsSync(file)) return;
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)) {
    const match=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if(match&&process.env[match[1]]===undefined) process.env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
  }
}
function backupKey() {
  fs.mkdirSync(backupDir,{recursive:true,mode:0o700});
  const filename=path.join(backupDir,'backup.key');
  if(!fs.existsSync(filename)) fs.writeFileSync(filename,crypto.randomBytes(32),{flag:'wx',mode:0o600});
  const key=fs.readFileSync(filename);
  if(key.length!==32) throw new MigrationError('Chave de backup invalida.');
  return key;
}
function backup(snapshot,key) {
  const filename=path.join(backupDir,`${snapshot.provider}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.monada`);
  fs.writeFileSync(filename,sealSnapshot(snapshot,key),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({backup:path.relative(root,filename),encrypted:true}));
  return filename;
}

async function postgres() {
  if(!process.env.SUPABASE_DB_URL) throw new MigrationError('Configure SUPABASE_DB_URL para exportar usuarios e senhas sem exibi-los.');
  const {Client,types}=require('pg');
  types.setTypeParser(1082,value=>value);
  const uri=new URL(process.env.SUPABASE_DB_URL);
  if(!['postgres:','postgresql:'].includes(uri.protocol)) throw new MigrationError('URL PostgreSQL invalida.');
  const local=['localhost','127.0.0.1','::1'].includes(uri.hostname);
  // pg URL SSL options must not override certificate verification.
  for(const option of ['sslmode','sslcert','sslkey','sslrootcert']) uri.searchParams.delete(option);
  const client=new Client({connectionString:uri.toString(),ssl:local?false:{rejectUnauthorized:true,...(process.env.SUPABASE_DB_CA_FILE?{ca:fs.readFileSync(process.env.SUPABASE_DB_CA_FILE,'utf8')}:{})},connectionTimeoutMillis:15000,statement_timeout:30000});
  await client.connect();return client;
}

async function readSupabase() {
  const pg=await postgres();
  try {
    await pg.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const inventory=await pg.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
    if(inventory.rows.some(row=>!TABLE_ORDER.includes(row.tablename))) throw new MigrationError('Existem tabelas publicas nao mapeadas. Revise o catalogo antes de migrar.');
    const storage=await pg.query('SELECT count(*) AS count FROM storage.objects');
    if(Number(storage.rows[0].count)) throw new MigrationError('Storage possui objetos; exporte e planeje o armazenamento de arquivos antes de migrar.');
    const identityTypes=await pg.query("SELECT count(*) AS count FROM auth.identities WHERE provider <> 'email'");
    if(Number(identityTypes.rows[0].count)) throw new MigrationError('Existem identidades OAuth; a migracao automatica atual aceita somente login por e-mail e senha.');
    const mfa=await pg.query("SELECT count(*) AS count FROM auth.mfa_factors WHERE status='verified'");
    if(Number(mfa.rows[0].count)) throw new MigrationError('Existem contas com MFA. A migracao foi interrompida para nao reduzir a protecao de acesso.');
    const restricted=await pg.query('SELECT count(*) AS count FROM auth.users WHERE banned_until > now() OR deleted_at IS NOT NULL');
    if(Number(restricted.rows[0].count)) throw new MigrationError('Existem identidades bloqueadas ou excluidas no Auth. Revise a preservacao dessas restricoes antes de migrar.');
    const auth=await pg.query('SELECT id,email,encrypted_password AS password_hash,email_confirmed_at,last_sign_in_at,created_at FROM auth.users ORDER BY id');
    const data={monada_auth_users:auth.rows.map(canonical)};
    for(const table of TABLE_ORDER) {
      const result=await pg.query(`SELECT * FROM public."${table}" ORDER BY ${tables[table].key.map(key=>`"${key}"`).join(',')}`);
      data[table]=result.rows.map(row=>normalizeRow(table,row));
    }
    await pg.query('COMMIT');
    return validateSnapshot({version:1,provider:'supabase',createdAt:new Date().toISOString(),tables:data});
  } finally {await pg.end();}
}

async function readD1({allowEmpty=false,execute=createD1Transport()}={}) {
  const db=createD1Database({execute,service:true});
  const auth=(await execute([{sql:`SELECT ${AUTH_FIELDS.join(',')} FROM monada_auth_users ORDER BY id`,params:[]}]))[0].results;
  const data={monada_auth_users:auth};
  for(const table of TABLE_ORDER) {
    data[table]=[];
    for(let offset=0;;offset+=200) {
      let query=db.from(table).select('*').range(offset,offset+199);
      for(const key of tables[table].key) query=query.order(key);
      const result=await query;
      if(result.error) throw new MigrationError(`Nao foi possivel exportar a tabela ${table}.`);
      data[table].push(...result.data.map(row=>normalizeRow(table,row)));
      if(result.data.length<200) break;
    }
  }
  const snapshot={version:1,provider:'d1',createdAt:new Date().toISOString(),tables:data};
  if(allowEmpty&&Object.values(data).every(rows=>rows.length===0)) return snapshot;
  return validateSnapshot(snapshot);
}

async function initializeD1() {
  // D1 accepts multiple SQL statements in a single query, including trigger bodies.
  const execute=createD1Transport();
  const schema=fs.readFileSync(path.join(root,'whatsapp-service/lib/database/schema.sql'),'utf8');
  // The transport expects one result per statement. Execute the schema directly
  // through this dedicated setup request and validate every returned result.
  const {d1Configuration}=require('../whatsapp-service/lib/database/config');
  const config=d1Configuration();
  const response=await fetch(`https://api.cloudflare.com/client/v4/accounts/${config.accountId}/d1/database/${config.databaseId}/query`,{method:'POST',headers:{Authorization:`Bearer ${config.token}`,'Content-Type':'application/json'},body:JSON.stringify({sql:schema}),signal:AbortSignal.timeout(30000)});
  if(!response.ok) throw new MigrationError('Nao foi possivel inicializar o D1.');
  const result=await response.json();
  if(!result.success||!Array.isArray(result.result)||result.result.some(row=>row.success===false)) throw new MigrationError('Schema D1 nao foi confirmado.');
  await execute([{sql:"INSERT INTO monada_migrations(id,applied_at) VALUES ('schema-v1',?) ON CONFLICT(id) DO NOTHING",params:[new Date().toISOString()]}]);
}

async function importD1(snapshot,{execute=createD1Transport()}={}) {
  const db=createD1Database({execute,service:true});
  for(const user of snapshot.tables.monada_auth_users) {
    await execute([{sql:`INSERT INTO monada_auth_users (${AUTH_FIELDS.join(',')}) VALUES (${AUTH_FIELDS.map(()=>'?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${AUTH_FIELDS.filter(key=>key!=='id').map(key=>`${key}=excluded.${key}`).join(',')}`,params:AUTH_FIELDS.map(key=>user[key]??null)}]);
  }
  for(const table of TABLE_ORDER) {
    // Each provider batch is atomic; a failed copy is never activated.
    // Small batches accommodate the largest bounded WhatsApp snapshots.
    for(let offset=0;offset<snapshot.tables[table].length;offset+=10) {
      const result=await db.from(table).upsert(snapshot.tables[table].slice(offset,offset+10));
      if(result.error) throw new MigrationError(`Importacao interrompida na tabela ${table}. O banco atual nao foi trocado.`);
    }
  }
  // Updating a description correctly invalidates vectors in ordinary requests.
  // A migration reattaches the vector from the same consistent source snapshot.
  for(const row of snapshot.tables.tasks) {
    await execute([{sql:'UPDATE tasks SET description_embedding=?,description_embedding_model=?,description_embedding_updated_at=? WHERE id=?',params:[row.description_embedding??null,row.description_embedding_model??null,row.description_embedding_updated_at??null,row.id]}]);
  }
}

async function importSupabase(snapshot) {
  const {createClient}=require('@supabase/supabase-js');
  if(!process.env.NEXT_PUBLIC_SUPABASE_URL||!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new MigrationError('Credenciais administrativas Supabase ausentes.');
  const admin=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
  for(const user of snapshot.tables.monada_auth_users) {
    const existing=await admin.auth.admin.getUserById(user.id);
    const attributes={email:user.email,email_confirm:!!user.email_confirmed_at,...(user.password_hash?{password_hash:user.password_hash}:{})};
    const result=existing.data?.user?await admin.auth.admin.updateUserById(user.id,attributes):await admin.auth.admin.createUser({...attributes,id:user.id});
    if(result.error||result.data.user?.id!==user.id) throw new MigrationError('Nao foi possivel preservar uma identidade no Supabase.');
  }
  const pg=await postgres();
  try {
    await pg.query('BEGIN');
    const timestampTrigger=await pg.query("SELECT tgenabled FROM pg_trigger WHERE tgrelid='public.tasks'::regclass AND tgname='update_tasks_updated_at'");
    if(timestampTrigger.rows[0]?.tgenabled==='O') await pg.query('ALTER TABLE public.tasks DISABLE TRIGGER update_tasks_updated_at');
    else if(timestampTrigger.rows.length&&timestampTrigger.rows[0].tgenabled!=='D') throw new MigrationError('Trigger de timestamp inesperado. Revise a importacao antes de continuar.');
    for(const table of TABLE_ORDER) {
      for(const row of snapshot.tables[table]) {
        const fields=Object.keys(row);
        const params=fields.map(key=>['changes','summary_data','summary_record','chat_aliases','participant_aliases'].includes(key)&&row[key]!==null?JSON.stringify(row[key]):row[key]);
        const updates=fields.filter(key=>!tables[table].key.includes(key));
        await pg.query(`INSERT INTO public."${table}" (${fields.map(key=>`"${key}"`).join(',')}) VALUES (${fields.map((_,i)=>`$${i+1}`).join(',')}) ON CONFLICT (${tables[table].key.map(key=>`"${key}"`).join(',')}) DO ${updates.length?'UPDATE SET '+updates.map(key=>`"${key}"=EXCLUDED."${key}"`).join(','):'NOTHING'}`,params);
      }
    }
    for(const row of snapshot.tables.tasks) {
      await pg.query('UPDATE public.tasks SET description_embedding=$1,description_embedding_model=$2,description_embedding_updated_at=$3 WHERE id=$4',[row.description_embedding??null,row.description_embedding_model??null,row.description_embedding_updated_at??null,row.id]);
    }
    if(timestampTrigger.rows[0]?.tgenabled==='O') await pg.query('ALTER TABLE public.tasks ENABLE TRIGGER update_tasks_updated_at');
    await pg.query('COMMIT');
  } catch(error) {await pg.query('ROLLBACK');throw error;} finally {await pg.end();}
}

function extraRows(source,target,table) {
  const wanted=new Set(source.tables[table].map(row=>rowKey(table,row)));
  return target.tables[table].filter(row=>!wanted.has(rowKey(table,row)));
}

async function reconcileDeletions(source,target,{execute}={}) {
  if(target.provider==='d1') {
    const db=createD1Database({execute:execute||createD1Transport(),service:true});
    for(const table of [...TABLE_ORDER].reverse()) {
      for(const row of extraRows(source,target,table)) {
        let q=db.from(table).delete();
        for(const key of tables[table].key) q=q.eq(key,row[key]);
        if((await q).error) throw new MigrationError('Reconciliacao interrompida. Preserve os backups e mantenha o provedor atual.');
      }
    }
    for(const row of extraRows(source,target,'monada_auth_users')) await db.execute([{sql:'DELETE FROM monada_auth_users WHERE id=?',params:[row.id]}]);
    return;
  }
  const pg=await postgres();
  try {
    await pg.query('BEGIN');
    for(const table of [...TABLE_ORDER].reverse()) for(const row of extraRows(source,target,table)) {
      await pg.query(`DELETE FROM public."${table}" WHERE ${tables[table].key.map((key,i)=>`"${key}"=$${i+1}`).join(' AND ')}`,tables[table].key.map(key=>row[key]));
    }
    await pg.query('COMMIT');
  } catch(error) {await pg.query('ROLLBACK');throw error;} finally {await pg.end();}
  const {createClient}=require('@supabase/supabase-js');
  const admin=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{autoRefreshToken:false,persistSession:false}});
  for(const row of extraRows(source,target,'monada_auth_users')) {
    if((await admin.auth.admin.deleteUser(row.id)).error) throw new MigrationError('Reconciliacao de identidades interrompida. Preserve os backups.');
  }
}

async function main(args=process.argv.slice(2)) {
  loadEnvironment();
  const command=args[0];
  const value=name=>args.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
  const apply=args.includes('--apply');
  const from=value('from'),to=value('to');
  if(!['inspect','init','export','copy','verify','restore'].includes(command)) throw new MigrationError('Use inspect, init, export, copy, verify ou restore. Opcoes: --from=supabase|d1 --to=d1|supabase --apply --file=arquivo.monada');
  if(command==='init') {
    if(!apply) {console.log('Simulacao: schema aditivo D1. Use --apply para executar.');return;}
    await initializeD1();console.log('Schema D1 confirmado.');return;
  }
  const read=provider=>provider==='supabase'?readSupabase():provider==='d1'?readD1():Promise.reject(new MigrationError('Provedor invalido.'));
  if(command==='inspect'||command==='export') {
    const snapshot=await read(from);
    console.log(JSON.stringify(snapshotSummary(snapshot),null,2));
    if(command==='export') backup(snapshot,backupKey());
    return;
  }
  if(!['supabase','d1'].includes(to)) throw new MigrationError('Destino invalido.');
  const source=command==='restore'?openSnapshot(fs.readFileSync(path.resolve(value('file')||'')),backupKey()):await read(from);
  if(source.provider===to) throw new MigrationError('Escolha outro provedor de destino.');
  let target;
  if(to==='d1') {
    target=await readD1({allowEmpty:true});
    // A brand-new target has no administrator yet; its tables are still empty.
    if(Object.values(target.tables).every(rows=>!rows.length)) {
      target={...source,provider:'d1',tables:Object.fromEntries(Object.keys(source.tables).map(table=>[table,[]]))};
    }
  } else target=await readSupabase();
  const empty=Object.values(target.tables).every(rows=>!rows.length);
  const plan=empty?Object.fromEntries(Object.entries(source.tables).map(([table,rows])=>[table,{insert:rows.length,update:0,remove:0}])):migrationPlan(source,target);
  console.log(JSON.stringify({from:source.provider,to,plan},null,2));
  if(command==='verify') {if(empty||!verifySnapshots(source,target).equal)throw new MigrationError('Os bancos diferem. Nao altere DATABASE_PROVIDER.');console.log('Conteudo verificado.');return;}
  if(!apply) {console.log('Simulacao concluida. Nenhum dado alterado.');return;}
  if(!args.includes('--maintenance-confirmed')) throw new MigrationError('Interrompa as gravacoes da aplicacao e do WhatsApp e use --maintenance-confirmed.');
  const removes=Object.values(plan).some(row=>row.remove);
  if(removes&&!args.includes('--reconcile-deletions')) throw new MigrationError('Destino contem registros ausentes na origem. Revise as exclusoes do plano e use --reconcile-deletions somente para tornar o destino igual a origem.');
  const key=backupKey();
  backup(source,key);
  if(!empty) backup(target,key);
  if(removes) await reconcileDeletions(source,target);
  if(to==='d1') await importD1(source);else await importSupabase(source);
  const verified=await read(to);
  if(!verifySnapshots(source,verified).equal) throw new MigrationError('A verificacao encontrou diferencas. Mantenha DATABASE_PROVIDER inalterado e preserve os backups.');
  console.log(`Copia verificada. Configure DATABASE_PROVIDER=${to} na aplicacao e no servico WhatsApp e reinicie ambos. As sessoes web exigem novo login.`);
}

if(require.main===module) main().catch(error=>{console.error(error instanceof MigrationError ? error.message : 'Operacao nao concluida. Confira configuracao, acesso e compatibilidade do schema. Nenhum provedor foi ativado automaticamente.');process.exitCode=1;});
module.exports={main,readSupabase,readD1,initializeD1,importD1,importSupabase,reconcileDeletions};
