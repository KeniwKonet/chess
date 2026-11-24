/**
 * Points for games against the computer: the server times each game and
 * awards points when it ends (signed-in players only). Server side:
 * apps/server/src/online/points.ts.
 */
import { api, useOnline } from './online';
import { toast } from './store';

const LEVEL: Record<string, string> = { squire: 'Squire', knight: 'Knight', lord: 'Lord', warlord: 'Warlord' };
let game: Promise<number | null> | null = null;
let hinted = false;

export function computerGameStarted(level: string) {
  if (!useOnline.getState().token) {
    game = null;
    return;
  }
  game = api<{ id: number }>('/api/computer/start', { level })
    .then((r) => r.id)
    .catch(() => null);
}

export function computerGameEnded(result: 'win' | 'loss' | 'draw' | 'resigned', plies: number, hints = 0) {
  const pending = game;
  game = null;
  if (!pending) {
    if (!hinted && result === 'win' && !useOnline.getState().token) {
      hinted = true;
      setTimeout(() => toast('Nice win! Sign in from Play online to earn points for wins like this.', 'good'), 3500);
    }
    return;
  }
  void pending.then(async (id) => {
    if (id == null) return;
    try {
      const r = await api<{ points: number; total: number; level: string; note: string | null }>('/api/computer/end', { id, result, moves: Math.ceil(plies / 2), hints });
      const u = useOnline.getState().user;
      if (u) useOnline.setState({ user: { ...u, points: r.total } });
      // After the result scene has played.
      setTimeout(() => {
        if (r.points > 0) toast(`+${r.points} point${r.points === 1 ? '' : 's'} (${LEVEL[r.level] ?? r.level} ${result === 'win' ? 'win' : result === 'draw' ? 'draw' : 'game'}${hints ? ', hints used: half points' : ''}) · ${r.total} in total`, 'good');
        else if (r.note) toast(r.note, 'info');
      }, 3500);
    } catch {
      /* the game still counts for nothing; no need to bother the player */
    }
  });
}
