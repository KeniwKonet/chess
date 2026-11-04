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
- **Streaks and rivals:** every win adds to your win streak, and a loss or a draw ends it. Your best streak is kept. The result screen shows your all-time score against that opponent ("You 3 – 1 Bram"), and the lobby's Rivals tab lists everyone you've played with the score against each.
- **Sharing:** after a win, "Share the win" makes a picture card with your rating change, the head-to-head score and your streak. On a phone it opens the share sheet (WhatsApp, Instagram, X…); on a computer it saves the picture and opens WhatsApp. "Share" in the lobby shares your ratings and record.

## Clusters and Clash of Clusters

A **cluster** is a team that fights as one army.

- **Founding:** whoever founds a cluster is its **King**, the captain. Clusters need a free account.
- **Roles:** there are sixteen, as in a chess army: King, Sorceress (queen), two Siege Towers (rooks), two Rangers (bishops), two Raiders (knights) and eight Footmen (pawns). A cluster can clash with fewer members: the King commands every role nobody holds.
- **Joining:** players ask to join. The King takes each one in as:
  - a **member**, who gets the next free role;
  - a **substitute**, who waits on the bench, ready to come on;
  - a **spectator**, who isn't in the army but can follow the cluster's clashes.
  - Or the King turns the request down.
- **The King's controls:**
  - switch anyone's role: whoever held that role swaps into the old one;
  - bring a substitute on for a member, like a football substitution;
  - pass the crown by giving someone the King's role;
  - remove people.
  - If the King leaves, the crown passes to the longest-serving member.
- **Strength:** joint power is the sum of the members' ratings. Clashes give the cluster its own Glicko-2 clash rating.

**Clash of Clusters:** two clusters on one board. Each member moves only the soldier their role gives them. Chess still allows one move per turn, so on its turn a cluster decides together:

1. Members propose moves with their own soldiers. Proposing again replaces your previous proposal.
2. Members back the proposal they like (one backing each).
3. The King plays any proposal, or makes a move directly with any soldier; the King's move is final.
4. When the turn timer (30 s, 1 min or 2 min) runs out, the most-backed proposal plays. If nobody proposed anything, the army acts on its own with a sound move, so a clash never stalls.

During a clash the King can **hand out soldiers**: give any piece to another member or a substitute (for someone who's away), or keep it. Only the King can offer a draw or surrender. Each cluster sees only its own proposals. Anyone can watch with the clash link (`?clash=CODE`).

**Starting a clash:** a King challenges a named cluster (its King sees the challenge in the Clash tab), or makes an open link that any cluster's King can accept.

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
| `GET /api/clusters?q=` | Clusters, by clash rating. |
| `GET /api/clusters/mine` | Your cluster and your open join requests. |
| `GET /api/clusters/:name` | A cluster: stats, roster, recent clashes. |
| `POST /api/clusters/new {name, motto}` | Found a cluster. |
| `POST /api/clusters/:name/join` | Ask to join. |
| `POST /api/clusters/:name/decide {user, as}` | King: member, sub, spectator or reject. |
| `POST /api/clusters/:name/role {user, role}` | King: give a role (swaps; `k` passes the crown). |
| `POST /api/clusters/:name/sub {out, in}` | King: substitution. |
| `POST /api/clusters/:name/remove {user}` | King: remove someone. |
| `POST /api/clusters/:name/motto {motto}` | King: change the motto. |
| `POST /api/clusters/:name/leave` | Leave (or withdraw a request). |
| `GET /health` | Server status. |

Everything about games goes over a WebSocket at `/online`. The message types are in `packages/chess-core/src/online.ts`.
