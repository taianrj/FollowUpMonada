'use strict';

/** Small, serializable query protocol shared by browser gateway and providers. */
class DataQuery {
  constructor(table, execute) {
    this.request = { table, operation: 'select', select: '*', filters: [], order: [] };
    this.execute = execute;
  }
  select(select = '*', options = {}) {
    this.request.select = select;
    this.request.returning = true;
    if (options.count) this.request.count = options.count;
    if (options.head) this.request.head = true;
    return this;
  }
  insert(values) { this.request.operation = 'insert'; this.request.values = values; return this; }
  update(values) { this.request.operation = 'update'; this.request.values = values; return this; }
  upsert(values, options = {}) { this.request.operation = 'upsert'; this.request.values = values; this.request.onConflict = options.onConflict; return this; }
  delete() { this.request.operation = 'delete'; return this; }
  filter(field, operator, value) { this.request.filters.push({ field, operator, value }); return this; }
  eq(field, value) { return this.filter(field, 'eq', value); }
  neq(field, value) { return this.filter(field, 'neq', value); }
  is(field, value) { return this.filter(field, 'is', value); }
  in(field, value) { return this.filter(field, 'in', value); }
  gte(field, value) { return this.filter(field, 'gte', value); }
  lte(field, value) { return this.filter(field, 'lte', value); }
  lt(field, value) { return this.filter(field, 'lt', value); }
  gt(field, value) { return this.filter(field, 'gt', value); }
  order(field, options = {}) { this.request.order.push({ field, ascending: options.ascending !== false }); return this; }
  limit(limit) { this.request.limit = limit; return this; }
  range(from, to) { this.request.offset = from; this.request.limit = to - from + 1; return this; }
  single() { this.request.cardinality = 'one'; return this; }
  maybeSingle() { this.request.cardinality = 'maybe'; return this; }
  then(resolve, reject) {
    // A query is executed only once, even when a consumer awaits it twice.
    this.pending ||= Promise.resolve().then(() => this.execute(this.request));
    return this.pending.then(resolve, reject);
  }
}

module.exports = { DataQuery };
