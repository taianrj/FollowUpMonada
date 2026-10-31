'use strict';

const { randomUUID } = require('node:crypto');
const { tables, column, encodeValue, decodeRow } = require('./catalog');
const { DataQuery } = require('./query');
const { createD1Transport } = require('./transport');
const { prepareBlob, hydrateBlobs } = require('./blobs');
const { isValidDate } = require('../message-domain');

const denied = () => { throw new Error('Acesso negado.'); };
const errorResult = (message = 'Falha ao acessar o banco de dados.', code = 'DATABASE_ERROR') => ({ data: null, error: { message, code }, count: null });

function boundedInteger(value, fallback, max) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0 || value > max) throw new Error('Limite de consulta invalido.');
  return value;
}

function buildFilters(table, filters, params) {
  if (!Array.isArray(filters) || filters.length > 20) throw new Error('Filtros invalidos.');
  return filters.map(filter => {
    if (!filter || typeof filter !== 'object') throw new Error('Filtro invalido.');
    const name = column(table, filter.field);
    if (filter.operator === 'is') {
      if (filter.value === null) return `${name} IS NULL`;
      if (typeof filter.value !== 'boolean') throw new Error('Filtro IS invalido.');
      params.push(encodeValue(filter.field, filter.value)); return `${name} IS ?`;
    }
    if (filter.operator === 'in') {
      if (!Array.isArray(filter.value) || filter.value.length > 50) throw new Error('Filtro IN invalido.');
      if (!filter.value.length) return '0';
      params.push(...filter.value.map(value => encodeValue(filter.field, value)));
      return `${name} IN (${filter.value.map(() => '?').join(',')})`;
    }
    const operators = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE' };
    const operator = Object.hasOwn(operators, filter.operator) ? operators[filter.operator] : null;
    if (!operator || filter.value === null) throw new Error('Operador de filtro invalido.');
    params.push(encodeValue(filter.field, filter.value));
    return `${name} ${operator} ?${filter.operator === 'like' ? " ESCAPE '\\'" : ''}`;
  });
}

function projection(table, select) {
  if (typeof select !== 'string' || select.length > 1000) throw new Error('Projecao invalida.');
  const relations = [];
  let fields = select.replace(/\s+/g, '');
  if (table === 'tasks' && fields.includes('clients(name)')) {
    relations.push('clients'); fields = fields.replace(/,?clients\(name\),?/, ',');
  }
  if (table === 'task_history' && fields.includes('profiles:changed_by(name,email)')) {
    relations.push('profiles'); fields = fields.replace(/,?profiles:changed_by\(name,email\),?/, ',');
  }
  const names = fields.split(',').filter(Boolean);
  if (!names.length) throw new Error('Projecao vazia.');
  const columns = names.includes('*') ? tables[table].columns : names;
  columns.forEach(name => column(table, name));
  if (relations.includes('clients') && !columns.includes('client_id')) columns.push('client_id');
  if (relations.includes('profiles') && !columns.includes('changed_by')) columns.push('changed_by');
  return { sql: columns.map(name => column(table, name)).join(','), relations };
}

function authorizeQuery(request, actor, service) {
  const q = structuredClone(request);
  if (!tables[q.table]) throw new Error('Tabela nao permitida.');
  if (!['select','insert','update','upsert','delete'].includes(q.operation)) throw new Error('Operacao nao permitida.');
  q.filters ||= []; q.order ||= [];
  if (service) return q;
  if (!actor?.id || actor.is_active === false || !['admin','collaborator'].includes(actor.role)) denied();
  if (q.table === 'whatsapp_sessions' || q.table === 'whatsapp_summaries_duplicate_archive') denied();
  const admin = actor.role === 'admin';
  const ownedColumn = q.table === 'whatsapp_summaries' ? 'created_by' : ['whatsapp_contacts','whatsapp_messages'].includes(q.table) ? 'user_id' : null;
  if (ownedColumn) q.filters.push({ field: ownedColumn, operator: 'eq', value: actor.id });
  if (['whatsapp_contacts','whatsapp_messages'].includes(q.table) && q.operation !== 'select') denied();
  if (q.table === 'profiles') {
    if (!admin) q.filters.push({ field: 'id', operator: 'eq', value: actor.id });
    if (['insert','upsert','delete'].includes(q.operation)) denied();
    if (q.operation === 'update' && Object.keys(q.values || {}).some(key => !['name','role','is_active','transcribe_audio','interpret_images'].includes(key))) denied();
    if (q.operation === 'update' && !admin && Object.keys(q.values || {}).some(key => !['transcribe_audio','interpret_images'].includes(key))) denied();
  }
  if (['clients','collaborators','statuses','tasks'].includes(q.table) && q.operation === 'delete' && !admin) denied();
  if (q.table === 'task_history' && !['select','insert'].includes(q.operation)) denied();
  if (q.operation !== 'select' && q.values) {
    const rows = Array.isArray(q.values) ? q.values : [q.values];
    for (const row of rows) {
      if (ownedColumn) row[ownedColumn] = actor.id;
      if (q.table === 'task_history') row.changed_by = actor.id;
      if (q.table === 'tasks' && ['insert','upsert'].includes(q.operation)) row.created_by = actor.id;
      if (q.table === 'tasks' && q.operation === 'update' && Object.hasOwn(row, 'created_by')) denied();
    }
  }
  return q;
}

/** actor must be resolved from the current session and profiles table by a trusted server. */
function createD1Database({ execute = createD1Transport(), actor = null, service = false } = {}) {
  async function query(input) {
    try {
      const q = authorizeQuery(input, actor, service);
      const table = q.table;
      const params = [];
      const predicates = buildFilters(table, q.filters, params);
      const where = predicates.length ? ` WHERE ${predicates.join(' AND ')}` : '';
      const selection = projection(table, q.select || '*');
      if (table === 'whatsapp_sessions' && /"creds"/.test(selection.sql) && !/"id"/.test(selection.sql)) selection.sql += ',"id"';
      const limit = boundedInteger(q.limit, 1000, service ? 20000 : 1000);
      const offset = boundedInteger(q.offset, 0, 1000000);
      let rows = [], count = null;
      if (q.operation === 'select') {
        if (q.count === 'exact') {
          const result = await execute([{ sql: `SELECT count(*) AS count FROM "${table}"${where}`, params }]);
          count = result[0].results[0].count;
        }
        if (!q.head) {
          if (!Array.isArray(q.order) || q.order.length > 5) throw new Error('Ordenacao invalida.');
          const order = q.order.length ? ' ORDER BY ' + q.order.map(item => `${column(table, item.field)} ${item.ascending === false ? 'DESC' : 'ASC'}`).join(',') : '';
          const result = await execute([{ sql: `SELECT ${selection.sql} FROM "${table}"${where}${order} LIMIT ? OFFSET ?`, params: [...params, limit, offset] }]);
          rows = result[0].results.map(decodeRow);
        }
      } else if (q.operation === 'delete') {
        if (!q.filters.length) throw new Error('Exclusao sem filtro nao permitida.');
        const result = await execute([{ sql: `DELETE FROM "${table}"${where} RETURNING ${selection.sql}`, params }]);
        rows = result[0].results.map(decodeRow);
      } else if (q.operation === 'update') {
        if (!q.filters.length || Array.isArray(q.values)) throw new Error('Atualizacao sem filtro nao permitida.');
        const values = validateValues(table, q.values);
        if (tables[table].key.some(key => Object.hasOwn(values, key))) throw new Error('Chave primaria imutavel.');
        if (table === 'tasks') values.updated_at = new Date().toISOString();
        const fields = Object.keys(values);
        if (!fields.length) throw new Error('Atualizacao vazia.');
        const result = await execute([{ sql: `UPDATE "${table}" SET ${fields.map(key => `${column(table,key)}=?`).join(',')}${where} RETURNING ${selection.sql}`, params: [...fields.map(key => encodeValue(key,values[key])),...params] }]);
        rows = result[0].results.map(decodeRow);
      } else {
        const inputRows = Array.isArray(q.values) ? q.values : [q.values];
        if (!inputRows.length || inputRows.length > 500) throw new Error('Lote invalido.');
        const statements = [];
        const mainResults = [];
        for (const raw of inputRows) {
          const blob = table === 'whatsapp_sessions' && typeof raw?.creds === 'string' ? prepareBlob(raw.id,raw.creds) : null;
          const values = validateValues(table, blob ? { ...raw,creds:blob.value } : raw);
          if (tables[table].key.length === 1 && table !== 'whatsapp_sessions' && !values[tables[table].key[0]]) values[tables[table].key[0]] = randomUUID();
          const fields = Object.keys(values);
          let conflict = '';
          if (q.operation === 'upsert') {
            const key = (q.onConflict || tables[table].key.join(',')).split(',');
            const allowed = [tables[table].key.join(','), ...(table === 'whatsapp_summaries' ? ['created_by,summary_date'] : [])];
            if (!allowed.includes(key.join(','))) throw new Error('Chave de conflito invalida.');
            if (ownedKeyConflict(table, key, service)) denied();
            const updates = fields.filter(field => !tables[table].key.includes(field));
            conflict = ` ON CONFLICT (${key.map(field=>column(table,field)).join(',')}) DO ` + (updates.length ? `UPDATE SET ${updates.map(field=>`${column(table,field)}=excluded.${column(table,field)}`).join(',')}` : 'NOTHING');
          }
          mainResults.push(statements.length);
          statements.push({ sql: `INSERT INTO "${table}" (${fields.map(key=>column(table,key)).join(',')}) VALUES (${fields.map(()=>'?').join(',')})${conflict} RETURNING ${selection.sql}`, params: fields.map(key=>encodeValue(key,values[key])) });
          if (blob) {
            statements.push({sql:'DELETE FROM monada_blob_chunks WHERE session_id=?',params:[values.id]});
            blob.chunks.forEach((content,index)=>statements.push({sql:'INSERT INTO monada_blob_chunks(session_id,chunk_index,content) VALUES (?,?,?)',params:[values.id,index,content]}));
          }
        }
        const result = await execute(statements);
        rows = mainResults.flatMap(index=>result[index].results.map(decodeRow));
      }
      if (table === 'whatsapp_sessions' && q.operation !== 'delete') await hydrateBlobs(rows,execute);
      for (const relation of selection.relations) {
        const foreignKey = relation === 'clients' ? 'client_id' : 'changed_by';
        const ids = [...new Set(rows.map(row=>row[foreignKey]).filter(Boolean))];
        const related = [];
        for (let i=0;i<ids.length;i+=50) {
          const chunk = ids.slice(i,i+50).filter(id => relation !== 'profiles' || service || actor?.role === 'admin' || id === actor?.id);
          if (!chunk.length) continue;
          const fields = relation === 'clients' ? 'id,name' : 'id,name,email';
          const result = await execute([{sql:`SELECT ${fields} FROM "${relation}" WHERE id IN (${chunk.map(()=>'?').join(',')})`,params:chunk}]);
          related.push(...result[0].results);
        }
        for (const row of rows) {
          const found = related.find(item=>item.id===row[foreignKey]);
          row[relation] = found ? Object.fromEntries(Object.entries(found).filter(([key])=>key!=='id')) : null;
        }
      }
      if (q.cardinality && (rows.length > 1 || (q.cardinality === 'one' && rows.length !== 1))) return errorResult('Registro unico nao encontrado.', 'PGRST116');
      return { data: q.head ? null : q.cardinality ? rows[0] || null : q.operation !== 'select' && !q.returning ? null : rows, error: null, count };
    } catch (error) {
      if (error.code === '23505' || /UNIQUE constraint failed/i.test(error.message)) return errorResult('Registro ja existe.', '23505');
      return errorResult(error.message === 'Acesso negado.' ? error.message : undefined, error.message === 'Acesso negado.' ? 'FORBIDDEN' : 'DATABASE_ERROR');
    }
  }
  return { query, from: table => new DataQuery(table, query), execute };
}

function ownedKeyConflict(table, key, service) {
  // A caller must never overwrite another user's row by guessing its UUID.
  return !service && table === 'whatsapp_summaries' && key.join(',') !== 'created_by,summary_date';
}

function validateValues(table, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw new Error('Registro invalido.');
  const values = { ...raw };
  if (!Object.keys(values).length) throw new Error('Registro vazio.');
  for (const [key,value] of Object.entries(values)) {
    column(table,key);
    if (['summary_date','message_date'].includes(key) && !isValidDate(value)) throw new Error('Data de calendario invalida.');
    const encoded = encodeValue(key,value);
    if (typeof encoded === 'string' && Buffer.byteLength(encoded) > 1800000) throw new Error('Registro excede o limite permitido.');
  }
  if (Buffer.byteLength(JSON.stringify(values)) > 1800000) throw new Error('Registro excede o limite permitido.');
  return values;
}

module.exports = { createD1Database, authorizeQuery, buildFilters, projection, validateValues };
