# Online play

ChessFront's online play has two parts:

- **The game** (`apps/web`) is a static site. Orbits builds and hosts it at chessfront.app.
- **The server** (`apps/server`) is a small Node program. It runs accounts, ratings and pairing, and referees every game, including the clocks. It has to run somewhere that keeps a program running all the time, so it can't go on Orbits' static hosting.

By default the game looks for the server at `https://api.chessfront.app`. When the game runs on localhost, it uses `http://localhost:8787` instead. To test against a different server, add `?online=https://your-server` to the page address.

## What players get

- **Accounts:** a name and password, or one tap to play as a guest (a name like Guest-48211). A guest can make an account later and keeps their games.
- **Ratings:** Glicko-2, the system most chess sites use, with separate Blitz (3+2, 5+3) and Rapid (10+5, 15+10) ratings. Everyone starts at 1500. A "?" after a rating means it's still provisional. Games without a clock, and games involving a guest, are always casual (unrated).
- **Invite a friend:** you get a link (`chessfront.app/?play=CODE`) to copy, share or send on WhatsApp. The game starts when your friend opens it. If a guest opens a rated invite, they're asked to make a free account first.
- **Find an opponent:** pairs you with whoever is waiting for the same clock, choosing the closest rating.
- **Refereed by the server:** every move is checked against the rules on the server, and the server keeps the clocks. Nobody can cheat by modifying their browser.
- **Reconnecting:** if your connection drops, the game reconnects by itself and picks up the position. The game is saved after every move, so it even survives a server restart.
- **Leaving:** if your opponent disconnects, their clock keeps running. After 60 seconds you can claim the win. If fewer than two moves have been made, the game is called off instead.
- **No-shows:** each side has 30 seconds to make its first move, or the game is called off with no rating change.
- **Draws, resigning and rematches:** offer, accept or decline a draw, and resign. After the game, either player can ask for a rematch; when both agree, it starts with colours swapped.
- **Spectators:** anyone can watch a game with `?watch=CODE`, with no account needed. Live games are listed in the lobby's "Watch live" tab, and players see how many people are watching.
- **Leaderboard:** a table for Blitz and one for Rapid.

## Running it locally

```
npm install
npm run server          # http://localhost:8787 (keeps its data in ./data)
npm run dev             # the game, which finds the local server by itself
```

## Deploying the server

The server needs Node 20 or later. For storage it uses:

- the Postgres database in `DATABASE_URL`, if that's set (recommended); or
- an embedded Postgres saved to files in `DATA_DIR` (default `./data`), which only works if the host keeps that folder between restarts.

| Setting | Meaning |
| --- | --- |
| `PORT` | Port to listen on (default 8787). Most hosts set this for you. |
| `DATABASE_URL` | Postgres connection string. |
| `DATA_DIR` | Folder for the embedded database when there's no `DATABASE_URL`. |
| `FIRST_MOVE_MS` | Time each side has for its first move (default 30000). Only change it for testing. |

The repo includes:

- `Dockerfile`: runs on Render, Railway, Fly.io, Koyeb or any VPS.
- `render.yaml`: a Render Blueprint that creates the server and a Postgres database together, using the domain api.chessfront.app.

**Steps:**
1. Deploy the server. On Render, choose New, then Blueprint, then this repo.
2. Add a DNS record for `api.chessfront.app`: a CNAME pointing to the host name the server's host gives you.
3. Check that `https://api.chessfront.app/health` answers `{"ok":true,…}`.

## The API

Requests that need you signed in send `Authorization: Bearer <token>`.

| | |
| --- | --- |
| `POST /api/register {name, password}` | Make an account (with a guest's token, it upgrades that guest). Returns `{token, user}`. |
| `POST /api/login {name, password}` | Sign in. Returns `{token, user}`. |
| `POST /api/guest` | Make a guest account. Returns `{token, user}`. |
| `POST /api/logout` | Sign out (ends this token). |
| `GET /api/me` | Your account and ratings. |
| `GET /api/users/:name` | A player's profile and their last 20 games. |
| `GET /api/leaderboard?cat=blitz\|rapid` | Top players. |
| `GET /api/live` | Games in play right now. |
| `GET /api/games/:code` | A game's moves and result. |
| `GET /health` | Server status. |

Everything about games goes over a WebSocket at `/online`. The message types are in `packages/chess-core/src/online.ts`.
