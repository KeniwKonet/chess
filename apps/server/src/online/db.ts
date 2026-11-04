/**
 * Storage for accounts, sessions, ratings and games.
 *
 * With DATABASE_URL set it uses that Postgres database (Render, Railway,
 * Neon, Supabase…). Without it, it keeps an embedded Postgres (PGlite) in
 * DATA_DIR (default ./data), so the server also runs on any machine with a
 * disk. Tests pass `memory://` for a throwaway database.
 */
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
}

const SCHEMA = `
create table if not exists users (
  id serial primary key,
  name text not null,
  name_key text not null unique,
  pass_hash text,
  guest boolean not null default false,
  created_at timestamptz not null default now(),
  games int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  draws int not null default 0
);
create table if not exists sessions (
  token_hash text primary key,
  user_id int not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen timestamptz not null default now()
);
create index if not exists sessions_user on sessions(user_id);
create table if not exists ratings (
  user_id int not null references users(id) on delete cascade,
  category text not null,
  rating double precision not null,
  rd double precision not null,
  vol double precision not null,
  games int not null default 0,
  primary key (user_id, category)
);
create index if not exists ratings_board on ratings(category, rating desc);
create table if not exists games (
  code text primary key,
  tc text not null,
  rated boolean not null,
  status text not null,
  white int references users(id),
  black int references users(id),
  creator int references users(id),
  creator_colour text,
  moves text not null default '',
  clock_w bigint,
  clock_b bigint,
  winner text,
  reason text,
  white_before int, white_after int, black_before int, black_after int,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  ended_at timestamptz
);
create index if not exists games_status on games(status);
create index if not exists games_white on games(white, ended_at desc);
create index if not exists games_black on games(black, ended_at desc);
`;

export async function openDb(opts: { url?: string; dataDir?: string } = {}): Promise<Db> {
  const url = opts.url ?? process.env.DATABASE_URL;
  let db: Db;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 8, ssl: /sslmode=disable|localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: false } });
    db = {
      kind: 'postgres',
      query: async (sql, params) => (await pool.query(sql, params as unknown[])).rows,
      close: () => pool.end(),
    };
  } else {
    const lite = new PGlite(opts.dataDir ?? process.env.DATA_DIR ?? './data');
    await lite.waitReady;
    db = {
      kind: 'pglite',
      query: async <T,>(sql: string, params?: unknown[]) => (await lite.query<T>(sql, params)).rows,
      close: () => lite.close(),
    };
  }
  // PGlite runs one statement per query() call with parameters; exec the schema statement by statement.
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  return db;
}
