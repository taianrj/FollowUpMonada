'use strict';

const { randomBytes, randomUUID, createHash } = require('node:crypto');

const SESSION_SECONDS = 60 * 60 * 24 * 7;
const RECOVERY_SECONDS = 60 * 30;
const cookieName = 'monada_session';
const digest = value => createHash('sha256').update(value).digest('hex');
const publicUser = row => row ? { id: row.id, email: row.email, email_confirmed_at: row.email_confirmed_at, last_sign_in_at: row.last_sign_in_at } : null;

function normalizeEmail(value) {
  if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) throw new Error('E-mail invalido.');
  return value.trim().toLowerCase();
}

function validatePassword(value) {
  // bcrypt uses at most 72 bytes; never silently truncate a password.
  if (typeof value !== 'string' || value.length < 10 || Buffer.byteLength(value) > 72) throw new Error('A senha deve ter pelo menos 10 caracteres e no maximo 72 bytes.');
  return value;
}

function createAuthService({ execute, now = () => Date.now(), passwordCodec } = {}) {
  if (typeof execute !== 'function') throw new Error('Transporte de autenticacao ausente.');
  const codec = () => passwordCodec || require('bcryptjs');
  const expiry = seconds => new Date(now() + seconds * 1000).toISOString();
  const stamp = () => new Date(now()).toISOString();
  async function read(sql, params) { return (await execute([{sql,params}]))[0].results; }

  async function throttle(kind, identifier) {
    const bucket = digest(`${kind}:${identifier}`);
    const window = Math.floor(now() / 900000);
    const results = await execute([{
      sql: 'INSERT INTO monada_auth_attempts(bucket,attempts,window_start) VALUES (?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=CASE WHEN window_start=excluded.window_start THEN attempts+1 ELSE 1 END,window_start=excluded.window_start RETURNING attempts',
      params: [bucket,window]
    }]);
    if (results[0].results[0].attempts > (kind === 'login' ? 10 : 5)) throw new Error('Muitas tentativas. Aguarde alguns minutos.');
  }

  async function session(token, { allowRecovery = false } = {}) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const rows = await read('SELECT u.id,u.email,u.email_confirmed_at,u.last_sign_in_at,p.role,p.is_active,s.purpose FROM monada_auth_sessions s JOIN monada_auth_users u ON u.id=s.user_id JOIN profiles p ON p.id=u.id WHERE s.token_hash=? AND s.expires_at>?', [digest(token),stamp()]);
    const row = rows[0];
    if (!row || !row.is_active || (!allowRecovery && row.purpose !== 'session')) return null;
    return { user:publicUser(row), actor:{ id:row.id,role:row.role,is_active:!!row.is_active }, purpose:row.purpose };
  }

  async function authenticate(emailInput, password) {
    const email = normalizeEmail(emailInput);
    await throttle('login',email);
    if (typeof password !== 'string' || Buffer.byteLength(password) > 72) throw new Error('E-mail ou senha invalidos.');
    const rows = await read('SELECT u.*,p.is_active FROM monada_auth_users u JOIN profiles p ON p.id=u.id WHERE u.email=?', [email]);
    const row=rows[0];
    // A valid dummy bcrypt hash prevents an unknown account from skipping password work.
    const hash = row?.password_hash || '$2b$12$R9h/cIPz0gi.URNNX3kh2OPST9/PgBkqquzi.Ss7KIUgO2t0jWMUW';
    const valid = await codec().compare(password,hash);
    if (!valid || !row?.password_hash || !row.is_active || !row.email_confirmed_at) throw new Error('E-mail ou senha invalidos.');
    const token=randomBytes(32).toString('hex');
    await execute([
      {sql:'INSERT INTO monada_auth_sessions(token_hash,user_id,expires_at,purpose) VALUES (?,?,?,?)',params:[digest(token),row.id,expiry(SESSION_SECONDS),'session']},
      {sql:'UPDATE monada_auth_users SET last_sign_in_at=? WHERE id=?',params:[stamp(),row.id]}
    ]);
    return { token,user:publicUser(row),maxAge:SESSION_SECONDS };
  }

  async function signOut(token) {
    if (typeof token==='string') await execute([{sql:'DELETE FROM monada_auth_sessions WHERE token_hash=?',params:[digest(token)]}]);
  }

  async function generateLink({ email:emailInput, type, name = '', userId, role = 'collaborator' }) {
    const email=normalizeEmail(emailInput);
    if (!['invite','recovery'].includes(type) || !['admin','collaborator'].includes(role)) throw new Error('Convite invalido.');
    if (typeof name!=='string' || name.length>160) throw new Error('Nome invalido.');
    let user=(await read('SELECT * FROM monada_auth_users WHERE email=?',[email]))[0];
    if (userId && (!user || user.id!==userId)) throw new Error('Identidade e e-mail nao correspondem.');
    if (!user && type!=='invite') throw new Error('Usuario nao encontrado.');
    const token=randomBytes(32).toString('hex');
    const newId=user?.id || randomUUID();
    const statements=[];
    if(!user) {
      statements.push({sql:'INSERT INTO monada_auth_users(id,email,created_at) VALUES (?,?,?)',params:[newId,email,stamp()]});
      statements.push({sql:'INSERT INTO profiles(id,email,name,role,created_at) VALUES (?,?,?,?,?)',params:[newId,email,name,role,stamp()]});
    }
    statements.push({sql:'DELETE FROM monada_auth_tokens WHERE user_id=?',params:[newId]});
    statements.push({sql:'INSERT INTO monada_auth_tokens(token_hash,user_id,kind,expires_at) VALUES (?,?,?,?)',params:[digest(token),newId,type,expiry(RECOVERY_SECONDS)]});
    await execute(statements);
    user ||= {id:newId,email};
    return {user:publicUser(user),token,type,isNewUser:!user.email_confirmed_at};
  }

  async function verifyOtp(token, kind) {
    if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token) || !['invite','recovery'].includes(kind)) throw new Error('Link invalido ou expirado.');
    const sessionToken=randomBytes(32).toString('hex');
    // Both statements run atomically: a token can create at most one session.
    const result=await execute([
      {sql:"INSERT INTO monada_auth_sessions(token_hash,user_id,expires_at,purpose) SELECT ?,t.user_id,?,'recovery' FROM monada_auth_tokens t JOIN profiles p ON p.id=t.user_id WHERE t.token_hash=? AND t.kind=? AND t.expires_at>? AND p.is_active=1 RETURNING user_id",params:[digest(sessionToken),expiry(RECOVERY_SECONDS),digest(token),kind,stamp()]},
      {sql:'DELETE FROM monada_auth_tokens WHERE token_hash=?',params:[digest(token)]}
    ]);
    if(!result[0].results.length) throw new Error('Link invalido ou expirado.');
    const user=(await session(sessionToken,{allowRecovery:true})).user;
    return {token:sessionToken,user,maxAge:RECOVERY_SECONDS};
  }

  async function updatePassword(token,password) {
    validatePassword(password);
    const current=await session(token,{allowRecovery:true});
    if(!current) throw new Error('Sessao invalida ou expirada.');
    const hash=await codec().hash(password,12);
    const nextToken=randomBytes(32).toString('hex');
    const id=current.user.id;
    await execute([
      {sql:'UPDATE monada_auth_users SET password_hash=?,email_confirmed_at=coalesce(email_confirmed_at,?) WHERE id=?',params:[hash,stamp(),id]},
      {sql:'DELETE FROM monada_auth_sessions WHERE user_id=?',params:[id]},
      {sql:'DELETE FROM monada_auth_tokens WHERE user_id=?',params:[id]},
      {sql:"INSERT INTO monada_auth_sessions(token_hash,user_id,expires_at,purpose) VALUES (?,?,?,'session')",params:[digest(nextToken),id,expiry(SESSION_SECONDS)]}
    ]);
    return {token:nextToken,user:current.user,maxAge:SESSION_SECONDS};
  }

  async function requestRecovery(emailInput,sendMail) {
    const email=normalizeEmail(emailInput);
    await throttle('recovery',email);
    if(typeof sendMail!=='function') throw new Error('Recuperacao por e-mail indisponivel. Solicite um link ao administrador.');
    const existing=await read('SELECT id FROM monada_auth_users WHERE email=?',[email]);
    if(existing.length) await sendMail(await generateLink({email,type:'recovery'}));
    return {ok:true};
  }

  return {session,authenticate,signOut,generateLink,verifyOtp,updatePassword,requestRecovery};
}

module.exports={createAuthService,cookieName,digest,normalizeEmail,validatePassword,SESSION_SECONDS};
