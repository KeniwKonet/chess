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

## Accounts, friends and notifications

- **Password reset:** add an email (at sign-up or in Your account) to reset a forgotten password. "Forgot your password?" emails a 6-digit code that works for 15 minutes, for up to 5 tries. Using it signs the account out everywhere.
- **Your account:** change your password (other devices are signed out), set your email, bio and country, upload a picture (shrunk to 256×256 in the browser; JPEG, PNG or WebP only, checked on the server), sign out on every device, or delete the account.
- **Deleting an account** removes the name, password, email, picture, friends and notifications; finished games stay in opponents' history as "deleted player".
- **Sessions** end after 90 days without use.
- **Friends:** add someone by name; if they've already asked you, that accepts. Friends show when they're online and your score against them, and you can challenge them directly. They get a notification with the game link.
- **Notifications** (the bell) cover friend requests, challenges, cluster join requests and decisions, tournament games and results, and messages from admins. They're saved, so you see them next time you sign in.
- **Profiles:** tap a name in the leaderboard, rivals, friends or standings to see the player's picture, bio, country, ratings, record, best streak, cluster, recent games and your score against them. From there you can add them as a friend, challenge them or report them.

## Tournaments

Anyone with an account can organise a tournament (three at a time); admins can feature one at the top of the list.

- **Swiss:** every round pairs players on the same score who haven't met yet, balancing colours. An odd player out gets a bye worth a point (never twice). The standings break ties by Buchholz (the total of your opponents' points), then Sonneborn-Berger.
- **Knockout:** players are seeded by rating into a bracket, so the top two seeds can only meet in the final. Top seeds get byes when the numbers aren't a power of two. A drawn game is replayed with colours reversed; if that is drawn too, Black in the replay goes through.
- **Starting:** at a set time, or when the organiser presses Start. With fewer than two players it is called off.
- **Playing:** each round's games start at once. Players who are online are taken straight to their board; everyone gets a notification. A player who doesn't make their first move in 30 seconds loses that game by forfeit. Tournament games can't be called off. The next round starts 15 seconds after the last game of a round ends.
- **Links:** `chessfront.app/?t=<tournament>` opens a tournament's page. Anyone can watch any game from its Rounds or Bracket tab.

## Safety and admin

- **Reports:** players can report someone (cheating, abuse, offensive name or picture, stalling, other), up to 10 a day.
- **Admins:** the names in `ADMIN_NAMES` get an Admin screen in the online lobby:
  - live figures;
  - reports: no action, warned, or suspend;
  - fair-play flags;
  - player search: suspend for 1 day up to permanently with a reason the player sees, lift a suspension, rename, remove a picture and bio;
  - announcements to everyone online;
  - the audit log of every admin action.
- **Suspensions:** a suspended player is signed out at once and can't sign in until the suspension ends.
- **Fair-play checks** run after every game and raise flags for a person to review; nothing is punished automatically. They look for:
  - win trading: four or more quick rated wins between the same two players in a day;
  - leaving games: three of the last ten games lost by walking away;
  - sudden rating climbs: 300 points or more in a day.

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

The full guide, including Orbits, the database and every setting, is in [DEPLOY.md](DEPLOY.md).

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
| `POST /api/account/password {current, password}` | Change password (signs out other devices). |
| `POST /api/account/email {email, password}` | Set or remove your email. |
| `POST /api/account/reset-request {name}` | Email a reset code (name or email). |
| `POST /api/account/reset {name, code, password}` | Set a new password with the code; returns `{token, user}`. |
| `POST /api/account/profile {bio, country}` | Update your profile. |
| `POST /api/account/avatar {data}` / `{remove: true}` | Upload (base64 JPEG/PNG/WebP, 64 KB max) or remove your picture. |
| `GET /api/avatars/:id` | A player's picture. |
| `POST /api/account/logout-all` | Sign out on every device. |
| `POST /api/account/delete {password}` | Delete your account. |
| `GET /api/friends` | Friends and requests. |
| `POST /api/friends/add {name}` / `remove {name}` | Add (or accept) / remove. |
| `GET /api/notifications` | Your notifications and unread count. |
| `POST /api/notifications/read {ids?}` | Mark read (all, without `ids`). |
| `POST /api/report {name, reason, details?, game?}` | Report a player. |
| `GET /api/tournaments` | Open, running and recent tournaments. |
| `GET /api/tournaments/:slug` | A tournament: standings, every round's games, your game. |
| `POST /api/tournaments/new {name, kind, tc, rounds?, maxPlayers?, rated?, startsAt?, description?}` | Organise one. |
| `POST /api/tournaments/:slug/join` / `leave` / `start` / `cancel` / `feature` | Enter, leave or withdraw, start, cancel, feature (admin). |
| `GET /api/admin/stats` / `reports` / `flags` / `users?q=` / `users/:id` / `audit` | Admin: look things up. |
| `POST /api/admin/ban {user, days, reason}` / `unban` / `rename {user, name}` / `clear-profile` / `resolve {id, resolution}` / `review-flag {id}` / `close-cluster {name}` / `announce {text}` | Admin: act. |
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
| `GET /metrics` | Prometheus counters (bearer `METRICS_TOKEN` when set). |

Everything about games goes over a WebSocket at `/online`. The message types are in `packages/chess-core/src/online.ts`.
