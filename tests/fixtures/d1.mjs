import { DatabaseSync } from 'node:sqlite';
export function d1() {
  const sql = new DatabaseSync(':memory:');
  return {
    sql,
    prepare(text) {
      let params = [];
      return {
        bind(...v) {
          params = v;
          return this;
        },
        async run() {
          const r = sql.prepare(text).run(...params);
          return { meta: { changes: Number(r.changes) } };
        },
        async all() {
          return { results: sql.prepare(text).all(...params) };
        },
        async first(column) {
          const row = sql.prepare(text).get(...params) ?? null;
          return column ? (row?.[column] ?? null) : row;
        },
      };
    },
    async batch(statements) {
      sql.exec('BEGIN');
      try {
        const out = [];
        for (const s of statements) out.push(await s.all());
        sql.exec('COMMIT');
        return out;
      } catch (e) {
        sql.exec('ROLLBACK');
        throw e;
      }
    },
  };
}
