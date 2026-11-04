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
  /** A compressed copy of the whole embedded database (PGlite only; hosted Postgres has its own backups). */
  backup?: () => Promise<Uint8Array>;
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
alter table users add column if not exists streak int not null default 0;
alter table users add column if not exists best_streak int not null default 0;
create table if not exists clusters (
  id serial primary key,
  name text not null,
  name_key text not null unique,
  motto text not null default '',
  king int not null references users(id),
  created_at timestamptz not null default now(),
  rating double precision not null default 1500,
  rd double precision not null default 350,
  vol double precision not null default 0.06,
  clashes int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  draws int not null default 0
);
create table if not exists cluster_members (
  cluster_id int not null references clusters(id) on delete cascade,
  user_id int not null references users(id) on delete cascade,
  status text not null,
  role text,
  joined_at timestamptz not null default now(),
  primary key (cluster_id, user_id)
);
create unique index if not exists cluster_members_one on cluster_members(user_id) where status <> 'pending';
create unique index if not exists cluster_roles on cluster_members(cluster_id, role) where role is not null;
create table if not exists clashes (
  code text primary key,
  white int references clusters(id) on delete set null,
  black int references clusters(id) on delete set null,
  status text not null,
  turn_secs int not null,
  state text not null default '{}',
  moves text not null default '',
  winner text,
  reason text,
  white_before int, white_after int, black_before int, black_after int,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists clashes_white on clashes(white, ended_at desc);
create index if not exists clashes_black on clashes(black, ended_at desc);
alter table users add column if not exists email text;
alter table users add column if not exists email_key text;
alter table users add column if not exists bio text not null default '';
alter table users add column if not exists country text not null default '';
alter table users add column if not exists avatar bytea;
alter table users add column if not exists avatar_ver int not null default 0;
alter table users add column if not exists is_admin boolean not null default false;
alter table users add column if not exists banned_until timestamptz;
alter table users add column if not exists ban_reason text;
alter table users add column if not exists deleted boolean not null default false;
create unique index if not exists users_email on users(email_key) where email_key is not null;
create table if not exists reset_codes (
  user_id int primary key references users(id) on delete cascade,
  code_hash text not null,
  expires_at timestamptz not null,
  tries int not null default 0
);
create table if not exists friends (
  a int not null references users(id) on delete cascade,
  b int not null references users(id) on delete cascade,
  status text not null,
  requested_by int not null,
  created_at timestamptz not null default now(),
  primary key (a, b)
);
create index if not exists friends_b on friends(b);
create table if not exists notifications (
  id serial primary key,
  user_id int not null references users(id) on delete cascade,
  kind text not null,
  text text not null,
  data text not null default '{}',
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user on notifications(user_id, id desc);
create table if not exists reports (
  id serial primary key,
  reporter int references users(id) on delete set null,
  target int not null references users(id) on delete cascade,
  game_code text,
  reason text not null,
  details text not null default '',
  status text not null default 'open',
  resolved_by int references users(id) on delete set null,
  resolution text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index if not exists reports_status on reports(status, id desc);
create table if not exists flags (
  id serial primary key,
  user_id int not null references users(id) on delete cascade,
  kind text not null,
  details text not null,
  reviewed boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists flags_open on flags(reviewed, id desc);
create table if not exists audit (
  id serial primary key,
  admin int references users(id) on delete set null,
  action text not null,
  details text not null,
  created_at timestamptz not null default now()
);
create table if not exists tournaments (
  id serial primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  kind text not null,
  tc text not null,
  rated boolean not null,
  rounds int not null,
  max_players int not null,
  starts_at timestamptz,
  status text not null default 'open',
  current_round int not null default 0,
  created_by int references users(id) on delete set null,
  featured boolean not null default false,
  winner int references users(id) on delete set null,
  created_at timestamptz not null default now(),
  ended_at timestamptz
);
create index if not exists tournaments_status on tournaments(status, starts_at);
create table if not exists tournament_players (
  tournament_id int not null references tournaments(id) on delete cascade,
  user_id int not null references users(id) on delete cascade,
  seed int,
  rating int not null default 1500,
  score double precision not null default 0,
  byes int not null default 0,
  withdrawn boolean not null default false,
  eliminated boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (tournament_id, user_id)
);
create table if not exists tournament_games (
  id serial primary key,
  tournament_id int not null references tournaments(id) on delete cascade,
  round int not null,
  board int not null,
  white int references users(id) on delete set null,
  black int references users(id) on delete set null,
  game_code text,
  result text,
  reason text
);
create index if not exists tgames_t on tournament_games(tournament_id, round);
create index if not exists tgames_code on tournament_games(game_code);
alter table tournament_games add column if not exists replay int not null default 0;
alter table games add column if not exists tournament text;
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
      backup: async () => new Uint8Array(await (await lite.dumpDataDir('gzip')).arrayBuffer()),
    };
  }
  // PGlite runs one statement per query() call with parameters; exec the schema statement by statement.
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  // Lock every table to the server alone. On Supabase, tables in "public" are otherwise
  // reachable through its Data API with the public key; with row level security on and
  // no policies, only the database owner (this server) can read or write them.
  const tables = await db.query<{ tablename: string }>("select tablename from pg_tables where schemaname = 'public'");
  for (const t of tables) await db.query(`alter table public."${t.tablename.replace(/"/g, '')}" enable row level security`);
  return db;
}
