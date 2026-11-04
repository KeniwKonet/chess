# Putting ChessFront live

ChessFront has two parts, deployed separately from the same repository:

| Part | What it is | Where | Address |
| --- | --- | --- | --- |
| **The game** | A static site (`npm run build` → `dist/`) | Orbits (already live) | chessfront.app |
| **The server** | A Node program that runs all the time (`npm start`) | Any host that runs Node | api.chessfront.app |

The game looks for the server at `https://api.chessfront.app` by itself. Until the server is up, everything still works except online play, clusters and tournaments.

## 1. A database

Use a hosted Postgres database. It's the safest choice, because the host backs it up for you. Free options include:

- Neon (neon.tech)
- Supabase (supabase.com)
- Render Postgres

Create a database and copy its connection string. It looks like `postgres://user:password@host/dbname?sslmode=require`; this becomes `DATABASE_URL`.

(Without `DATABASE_URL`, the server keeps an embedded database in `DATA_DIR` and writes a compressed backup next to it every day, keeping 7. This only works on a host with a persistent disk.)

### Using Supabase

1. In the Supabase dashboard, open your project and press **Connect** (top of the page).
2. Choose **Session pooler** and copy the URI. It looks like `postgresql://postgres.<project-ref>:[YOUR-PASSWORD]@aws-0-<region>.pooler.supabase.com:5432/postgres`. Use the session pooler because the direct connection only works over IPv6, which many hosts don't have.
3. Put in your database password (Project Settings → Database, where you can reset it if you've forgotten it). That full URI is `DATABASE_URL`.

You don't need to create any tables. The server creates them the first time it starts, and switches on Row Level Security for every one of them, so Supabase's public Data API (and its public key) can't read players' emails or password hashes. Only the server, connecting with the database password, can.

The GitHub connection in Supabase isn't needed for ChessFront. It's for projects that keep a `supabase/` migrations folder, and this one doesn't. You can leave it connected (it does nothing) or disconnect it.

Free Supabase projects pause after a week with no activity. Once players are online every day this won't happen; otherwise, restore the project from the dashboard.

## 2. The server on Orbits

If Orbits can run Node web services, create a **second project** from this same GitHub repository, with these settings:

| Setting | Value |
| --- | --- |
| Type | Web service / Node server (not a static site) |
| Branch | `main` |
| Install command | `npm ci` |
| Build command | (leave empty) |
| Start command | `npm start` |
| Node version | 22 |
| Port | Orbits usually sets `PORT` itself; the server listens on it (default 8787) |
| Health check path | `/health` |
| WebSockets | must be allowed (the game uses `/online`) |

Then add the environment variables from the table below. Under Domains, add `api.chessfront.app`.

If Orbits only hosts static sites, use **Render** instead: New → Blueprint → this repo, which uses `render.yaml`. Railway, Fly.io, Koyeb and any VPS work too, using the `Dockerfile`. All of these hosts use the same settings and variables.

## 3. Environment variables

| Name | Needed | What it does |
| --- | --- | --- |
| `DATABASE_URL` | yes (recommended) | The Postgres connection string from step 1. |
| `ADMIN_NAMES` | yes | Comma-separated account names that get the admin dashboard, e.g. `Kenneth`. Create that account in the game first, or sign up with that name after. |
| `RESEND_API_KEY` | for password resets | An API key from resend.com, used to email reset codes. Without it, codes only appear in the server log. |
| `MAIL_FROM` | with Resend | Sender, e.g. `ChessFront <no-reply@chessfront.app>`. The domain must be verified in Resend. |
| `ALLOWED_ORIGINS` | optional | Limits which sites may call the API, e.g. `https://chessfront.app,https://www.chessfront.app`. Default: any. |
| `METRICS_TOKEN` | optional | Protects `/metrics`. When set, requests must send it as a bearer token. |
| `LOG_LEVEL` | optional | `debug`, `info` (default), `warn` or `error`. |
| `DATA_DIR` | without Postgres | Folder for the embedded database (on a persistent disk). |
| `PORT` | set by the host | The port to listen on. |

## 4. The address

At your domain registrar, add a DNS record for `api` (a CNAME to the host name your server host gives you). Wait until the host shows a valid certificate; `.app` domains only work over HTTPS. Then check that:

- `https://api.chessfront.app/health` answers `{"ok":true,…}`;
- in the game, Play online shows "Connected".

## 5. After launch

- **Admin:** sign in with a name listed in `ADMIN_NAMES`. The online lobby then shows an **Admin** button with live figures, reports, fair-play flags, players (suspend, lift, rename, remove picture), announcements and the audit log.
- **Logs:** the server writes one JSON line per event, so you can filter by `level` in the host's log viewer.
- **Monitoring:**
  - `/health` is for uptime checks.
  - `/metrics` gives Prometheus-format counters: players online, games in play, requests, errors, sign-ups and memory.
- **Backups:** hosted Postgres backs itself up. The embedded database writes daily backups to `<DATA_DIR>-backups/`.
- **Updates:** pushing to `main` redeploys the game (Orbits) and the server (if its host deploys automatically). Games in play survive a restart: they are saved after every move, and clocks pause while the server is down.
