import { neon } from '@neondatabase/serverless';

// Neon serverless v1 splits the API: `sql\`...\`` is the tagged-template form,
// `sql.query(text, params)` is the conventional parameterized form. We expose
// both on `db` so prebuilt Engine 2 workers (Pattern B) stay untouched.
const sql: any = neon(process.env.DATABASE_URL!);

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

async function query<T = any>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const rows = (await sql.query(text, params)) as T[];
  return { rows, rowCount: rows.length };
}

async function transaction<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  return fn(db);
}

export const db = { query, transaction, sql };
export type Database = typeof db;
