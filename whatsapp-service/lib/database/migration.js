'use strict';

const {createHash,randomBytes,createCipheriv,createDecipheriv}=require('node:crypto');
const {gzipSync,gunzipSync}=require('node:zlib');
const {tables}=require('./catalog');

const TABLE_ORDER=['profiles','clients','collaborators','statuses','tasks','task_history','whatsapp_summaries','whatsapp_summaries_duplicate_archive','whatsapp_contacts','whatsapp_messages','whatsapp_sessions'];
const AUTH_FIELDS=['id','email','password_hash','email_confirmed_at','last_sign_in_at','created_at'];

function canonical(value) {
  if(value instanceof Date) return value.toISOString();
  if(Array.isArray(value)) return value.map(canonical);
  if(value&&typeof value==='object') return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]));
  return value;
}

function rowKey(table,row) {
  const fields=table==='monada_auth_users'?['id']:tables[table]?.key;
  if(!fields||fields.some(key=>typeof row[key]!=='string'||!row[key])) throw new Error('Chave de registro invalida no snapshot.');
  return JSON.stringify(fields.map(key=>row[key]));
}

function normalizeRow(table,row) {
  const fields=table==='monada_auth_users'?AUTH_FIELDS:tables[table]?.columns;
  if(!fields) throw new Error('Tabela nao permitida no snapshot.');
  if(Object.keys(row).some(key=>!fields.includes(key))) throw new Error('Snapshot possui colunas nao mapeadas. Atualize o adaptador antes de migrar.');
  const normalized=canonical(row);
  rowKey(table,normalized);
  return normalized;
}

function validateSnapshot(snapshot) {
  if(!snapshot||snapshot.version!==1||!['supabase','d1'].includes(snapshot.provider)||!snapshot.tables||typeof snapshot.tables!=='object') throw new Error('Formato de snapshot invalido.');
  const expected=['monada_auth_users',...TABLE_ORDER];
  if(Object.keys(snapshot.tables).length!==expected.length||expected.some(table=>!Array.isArray(snapshot.tables[table]))) throw new Error('Snapshot incompleto.');
  const users=new Set();
  for(const table of expected) {
    const seen=new Set();
    if(snapshot.tables[table].length>1000000) throw new Error('Snapshot excede o limite de registros.');
    for(const row of snapshot.tables[table]) {
      normalizeRow(table,row);
      const key=rowKey(table,row);
      if(seen.has(key)) throw new Error('Snapshot possui chaves duplicadas.');
      seen.add(key);
      if(table==='monada_auth_users') {
        users.add(row.id);
        if(row.password_hash&&!/^\$2[aby]\$\d\d\$[./A-Za-z0-9]{53}$/.test(row.password_hash)) throw new Error('Hash de senha nao suportado; migracao interrompida.');
      }
    }
  }
  if(snapshot.tables.profiles.some(row=>!users.has(row.id))) throw new Error('Snapshot possui perfil sem identidade de autenticacao.');
  if(!snapshot.tables.profiles.some(row=>row.role==='admin'&&row.is_active!==false)) throw new Error('Snapshot precisa preservar pelo menos um administrador ativo.');
  return snapshot;
}

function fingerprint(rows) {
  return createHash('sha256').update(JSON.stringify(rows.map(canonical).map(row=>JSON.stringify(row)).sort())).digest('hex');
}

function snapshotSummary(snapshot) {
  validateSnapshot(snapshot);
  return Object.fromEntries(Object.entries(snapshot.tables).map(([table,rows])=>[table,{rows:rows.length,sha256:fingerprint(rows),jsonBytes:Buffer.byteLength(JSON.stringify(rows))}]));
}

function migrationPlan(source,target) {
  validateSnapshot(source);validateSnapshot(target);
  return Object.fromEntries(Object.keys(source.tables).map(table=>{
    const wanted=new Map(source.tables[table].map(row=>[rowKey(table,row),JSON.stringify(canonical(row))]));
    const existing=new Map(target.tables[table].map(row=>[rowKey(table,row),JSON.stringify(canonical(row))]));
    return [table,{
      insert:[...wanted.keys()].filter(key=>!existing.has(key)).length,
      update:[...wanted.keys()].filter(key=>existing.has(key)&&wanted.get(key)!==existing.get(key)).length,
      remove:[...existing.keys()].filter(key=>!wanted.has(key)).length
    }];
  }));
}

function verifySnapshots(source,target) {
  const plan=migrationPlan(source,target);
  const fields=['id','email','password_hash'];
  const identity=s=>s.tables.monada_auth_users.map(row=>({...Object.fromEntries(fields.map(field=>[field,row[field]??null])),confirmed:!!row.email_confirmed_at}));
  const differences=Object.entries(plan).filter(([table,item])=>table!=='monada_auth_users'&&(item.insert||item.update||item.remove)).map(([table])=>table);
  if(fingerprint(identity(source))!==fingerprint(identity(target))) differences.push('monada_auth_users');
  return {equal:differences.length===0,differences};
}

function sealSnapshot(snapshot,key) {
  validateSnapshot(snapshot);
  if(!Buffer.isBuffer(key)||key.length!==32) throw new Error('Chave de backup invalida.');
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',key,iv);
  cipher.setAAD(Buffer.from('FollowUpMonada snapshot v1'));
  const ciphertext=Buffer.concat([cipher.update(gzipSync(Buffer.from(JSON.stringify(snapshot)))),cipher.final()]);
  return Buffer.concat([Buffer.from('MONADA01'),iv,cipher.getAuthTag(),ciphertext]);
}

function openSnapshot(bytes,key) {
  if(!Buffer.isBuffer(bytes)||bytes.length<36||bytes.subarray(0,8).toString()!=='MONADA01'||!Buffer.isBuffer(key)||key.length!==32) throw new Error('Backup invalido.');
  try {
    const decipher=createDecipheriv('aes-256-gcm',key,bytes.subarray(8,20));
    decipher.setAAD(Buffer.from('FollowUpMonada snapshot v1'));
    decipher.setAuthTag(bytes.subarray(20,36));
    const plain=Buffer.concat([decipher.update(bytes.subarray(36)),decipher.final()]);
    return validateSnapshot(JSON.parse(gunzipSync(plain,{maxOutputLength:256000000}).toString('utf8')));
  } catch {throw new Error('Nao foi possivel validar o backup. Verifique o arquivo e a chave.');}
}

module.exports={TABLE_ORDER,AUTH_FIELDS,canonical,rowKey,normalizeRow,validateSnapshot,fingerprint,snapshotSummary,migrationPlan,verifySnapshots,sealSnapshot,openSnapshot};
