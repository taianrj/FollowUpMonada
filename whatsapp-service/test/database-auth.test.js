'use strict';

const {test}=require('node:test');
const assert=require('node:assert/strict');
const bcrypt=require('bcryptjs');
const {databaseFixture}=require('./database-fixture');
const {createAuthService,digest}=require('../lib/database/auth');

async function fixture() {
  const f=databaseFixture();
  let now=Date.UTC(2026,9,31,12);
  const auth=createAuthService({execute:f.execute,now:()=>now});
  const hash=await bcrypt.hash('old-password',10);
  f.sqlite.prepare('INSERT INTO monada_auth_users(id,email,password_hash,email_confirmed_at) VALUES (?,?,?,?)').run('u','user@example.test',hash,new Date(now).toISOString());
  f.sqlite.prepare("INSERT INTO profiles(id,email,role) VALUES ('u','user@example.test','collaborator')").run();
  return {...f,auth,advance:milliseconds=>{now+=milliseconds;}};
}

test('imported bcrypt passwords work without Supabase and raw session tokens are never stored',async()=>{
  const f=await fixture();
  const signed=await f.auth.authenticate(' USER@example.test ','old-password');
  assert.equal(signed.user.id,'u');
  assert.equal(Object.hasOwn(signed.user,'password_hash'),false);
  assert.equal(f.sqlite.prepare('SELECT token_hash FROM monada_auth_sessions').get().token_hash,digest(signed.token));
  assert.equal((await f.auth.session(signed.token)).actor.role,'collaborator');
  await f.auth.signOut(signed.token);
  assert.equal(await f.auth.session(signed.token),null);
});

test('password verification, deactivation, expiry and persistent throttling fail closed',async()=>{
  const f=await fixture();
  await assert.rejects(()=>f.auth.authenticate('user@example.test','wrong-password'),/invalidos/);
  await assert.rejects(()=>f.auth.authenticate('missing@example.test','wrong-password'),/invalidos/);
  const signed=await f.auth.authenticate('user@example.test','old-password');
  f.sqlite.exec("UPDATE profiles SET is_active=0 WHERE id='u'");
  assert.equal(await f.auth.session(signed.token),null);
  await assert.rejects(()=>f.auth.authenticate('user@example.test','old-password'),/invalidos/);
  f.sqlite.exec("UPDATE profiles SET is_active=1 WHERE id='u'");
  f.advance(8*24*3600000);
  assert.equal(await f.auth.session(signed.token),null);
  for(let i=0;i<10;i++) { try {await f.auth.authenticate('user@example.test','wrong-password');} catch {} }
  await assert.rejects(()=>f.auth.authenticate('user@example.test','old-password'),/Muitas tentativas/);
});

test('recovery tokens are single use and recovery sessions cannot read application data',async()=>{
  const f=await fixture();
  const previous=await f.auth.authenticate('user@example.test','old-password');
  const link=await f.auth.generateLink({email:'user@example.test',type:'recovery'});
  assert.equal(f.sqlite.prepare('SELECT token_hash FROM monada_auth_tokens').get().token_hash,digest(link.token));
  const recovery=await f.auth.verifyOtp(link.token,'recovery');
  await assert.rejects(()=>f.auth.verifyOtp(link.token,'recovery'),/invalido/);
  assert.equal(await f.auth.session(recovery.token),null);
  assert.equal((await f.auth.session(recovery.token,{allowRecovery:true})).user.id,'u');
  await assert.rejects(()=>f.auth.updatePassword(recovery.token,'short'),/pelo menos 10/);
  const changed=await f.auth.updatePassword(recovery.token,'new-password');
  assert.equal(await f.auth.session(previous.token),null);
  assert.equal(await f.auth.session(recovery.token,{allowRecovery:true}),null);
  assert.equal((await f.auth.session(changed.token)).user.id,'u');
  await assert.rejects(()=>f.auth.authenticate('user@example.test','old-password'),/invalidos/);
  assert.equal((await f.auth.authenticate('user@example.test','new-password')).user.id,'u');
});

test('invitations preserve identity, require confirmation and expire without granting access',async()=>{
  const f=await fixture();
  const invite=await f.auth.generateLink({email:'new@example.test',name:'Novo',type:'invite'});
  assert.equal(f.sqlite.prepare('SELECT role FROM profiles WHERE id=?').get(invite.user.id).role,'collaborator');
  await assert.rejects(()=>f.auth.generateLink({email:'user@example.test',userId:invite.user.id,type:'recovery'}),/nao correspondem/);
  await assert.rejects(()=>f.auth.verifyOtp(invite.token,'recovery'),/invalido/);
  const old=invite.token;
  const replacement=await f.auth.generateLink({email:'new@example.test',type:'invite'});
  assert.equal(replacement.user.id,invite.user.id);
  await assert.rejects(()=>f.auth.verifyOtp(old,'invite'),/invalido/);
  f.advance(31*60000);
  await assert.rejects(()=>f.auth.verifyOtp(replacement.token,'invite'),/invalido/);
});

test('recovery sends links only to the account owner and never returns them to the caller',async()=>{
  const f=await fixture();
  const sent=[];
  const send=async link=>{sent.push(link);};
  assert.deepEqual(await f.auth.requestRecovery('user@example.test',send),{ok:true});
  assert.deepEqual(await f.auth.requestRecovery('missing@example.test',send),{ok:true});
  assert.equal(sent.length,1);
  assert.equal(sent[0].user.email,'user@example.test');
  await assert.rejects(()=>f.auth.requestRecovery('user@example.test'),/administrador/);
});
