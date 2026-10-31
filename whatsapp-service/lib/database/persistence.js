'use strict';

const {databaseProvider,d1Configuration}=require('./config');
const {createD1Database}=require('./d1');

function persistenceConfiguration(env=process.env) {
  if(databaseProvider(env)==='d1') {
    d1Configuration(env);
    return {cleanUrl:'https://d1.monada.invalid',key:'server-provider'};
  }
  const url=env.SUPABASE_URL||env.NEXT_PUBLIC_SUPABASE_URL;
  const key=env.SUPABASE_SERVICE_ROLE_KEY||env.SUPABASE_KEY||env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  return url&&key ? {cleanUrl:url.replace(/\/$/,''),key} : null;
}

function parsePersistenceRequest(url,options={}) {
  const uri=new URL(url);
  const table=uri.pathname.match(/^\/rest\/v1\/([a-z_]+)$/)?.[1];
  if(!table||!['profiles','whatsapp_contacts','whatsapp_messages','whatsapp_sessions'].includes(table)) throw new Error('Tabela de persistencia nao permitida.');
  const method=(options.method||'GET').toUpperCase();
  if(!['GET','POST','PATCH','DELETE'].includes(method)) throw new Error('Metodo nao permitido.');
  const q={table,operation:{GET:'select',POST:'upsert',PATCH:'update',DELETE:'delete'}[method],select:uri.searchParams.get('select')||'*',filters:[],order:[],returning:true};
  for(const [field,expression] of uri.searchParams) {
    if(['select','order','limit','offset','on_conflict'].includes(field)) continue;
    const dot=expression.indexOf('.');
    if(dot<1) throw new Error('Filtro de persistencia invalido.');
    const operator=expression.slice(0,dot);
    let value=expression.slice(dot+1);
    if(operator==='like') value=value.replace(/[\\%_]/g,'\\$&').replace(/\*/g,'%');
    if(operator==='is'&&value==='null') value=null;
    q.filters.push({field,operator,value});
  }
  if(uri.searchParams.has('limit')) q.limit=Number(uri.searchParams.get('limit'));
  if(uri.searchParams.has('offset')) q.offset=Number(uri.searchParams.get('offset'));
  if(uri.searchParams.has('on_conflict')) q.onConflict=uri.searchParams.get('on_conflict');
  if(uri.searchParams.has('order')) q.order=uri.searchParams.get('order').split(',').map(item=>{const [field,direction]=item.split('.');if(!['asc','desc'].includes(direction))throw new Error('Ordenacao invalida.');return {field,ascending:direction==='asc'};});
  if(options.body) q.values=JSON.parse(options.body);
  return q;
}

function createPersistenceFetch({env=process.env,fetchImpl=fetch,execute}={}) {
  let d1;
  return async (url,options={})=>{
    if(databaseProvider(env)==='supabase') return fetchImpl(url,options);
    const config=persistenceConfiguration(env);
    if(new URL(url).origin!==config.cleanUrl) throw new Error('Origem de persistencia nao permitida.');
    d1 ||= createD1Database(execute?{execute,service:true}:{service:true});
    const result=await d1.query(parsePersistenceRequest(url,options));
    return Response.json(result.error?{message:result.error.message}:result.data,{status:result.error?503:200});
  };
}

module.exports={persistenceConfiguration,parsePersistenceRequest,createPersistenceFetch};
