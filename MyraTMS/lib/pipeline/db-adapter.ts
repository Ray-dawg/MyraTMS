import { neon } from '@neondatabase/serverless';

// Neon's runtime supports both tagged-template and function-call form, but the
// declared types only model the tagged-template overload — cast through `any`.
const sql: any = neon(process.env.DATABASE_URL!);

export interface QueryResult<T = any> {
  rows: T[];
  rowCount: number;
}

async function query<T = any>(
  text: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  const rows = (await sql(text, params)) as T[];
  return { rows, rowCount: rows.length };
}

async function transaction<T>(fn: (tx: typeof db) => Promise<T>): Promise<T> {
  return fn(db);
}

export const db = { query, transaction, sql };
export type Database = typeof db;
