/**
 * The War Table: the chessboard that commands the battlefield. Standard chess
 * (chess.js) decides what is legal; each move triggers its piece's bond effect
 * (docs/RULES.md). You play the Sun (white); the Moon replies after thinking.
 */
import { useEffect, useMemo, useReducer, useState } from 'react';
import { useUi } from '../state/ui';
import { game, playChess, describeEffect, describeUnits, PLAYER } from '../sim/runner';
import { BOND_RULES } from '@cr/match';

const GLYPH: Record<string, string> = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
const FILES = 'abcdefgh';

const LEGEND: [string, string][] = [
  ['♟ Pawn', `Advance: its swordsman attack-moves ${BOND_RULES.advanceDistance} units toward the enemy castle`],
  ['♝ Bishop', `Volley: its 3 archers shoot twice as fast for ${BOND_RULES.volleyTicks / 10} s`],
  ['♜ Rook', `Bombard: its watchtower hits twice as hard for ${BOND_RULES.bombardTicks / 10} s`],
  ['♛ Queen', `Rally: every soldier strikes 15% harder for ${BOND_RULES.rallyTicks / 10} s`],
  ['♚ King', `Fortify: your castle regains ${BOND_RULES.fortifyAmount} structure`],
  ['♞ Knight', 'No effect: knights command cavalry, which is not fielded in this battle'],
  ['Capture', `Break: the captured piece's regiment fights at half strength and takes 20% more for ${BOND_RULES.breakTicks / 10} s`],
  ['Checkmate', 'Wins the battle outright'],
];

export function WarTable() {
  const show = useUi((s) => s.showWarTable);
  const toggle = useUi((s) => s.toggle);
  const rev = useUi((s) => s.unitRev);
  const [sel, setSel] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [, tick] = useReducer((x: number) => x + 1, 0);
  // Refresh the thinking countdown.
  useEffect(() => {
    if (!show) return;
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [show]);
  const wt = game.match.warTable;
  const board = useMemo(() => {
    const b = new Map<string, { type: string; color: 'w' | 'b' }>();
    for (let r = 1; r <= 8; r++) for (const f of FILES) {
      const p = wt.game.pieceAt(`${f}${r}` as never);
      if (p) b.set(`${f}${r}`, p);
    }
    return b;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wt, rev, wt.log.length]);
  if (!show) return null;
  const myTurn = wt.turn === PLAYER && !wt.over;
  const targets = sel && myTurn ? new Set(wt.targets(sel)) : new Set<string>();
  const thinking = wt.thinkingLeft();
  const out = wt.game.outcome();

  const click = (sq: string) => {
    if (!myTurn) return;
    const p = board.get(sq);
    if (sel && targets.has(sq)) {
      const piece = board.get(sel)!;
      const promo = piece.type === 'p' && (sq[1] === '8' || sq[1] === '1');
      const r = playChess({ from: sel, to: sq, ...(promo ? { promotion: 'q' as const } : {}) });
      setSel(null);
      if (r.ok) tick();
      return;
    }
    setSel(p && p.color === 'w' ? (sel === sq ? null : sq) : null);
  };

  const describeBinding = (sq: string) => {
    const b = wt.bonds.on(sq);
    if (!b) return '';
    if (wt.bonds.leaderless(b, wt.live)) return b.role === 'n' ? 'Commands no one (no cavalry in this battle)' : 'Leaderless: its regiment has fallen';
    if (b.army) return 'Commands the whole army';
    if (b.building) return `Bound to ${game.sim.building(b.building)?.name}`;
    const alive = b.units.filter(wt.live.unitAlive);
    return alive.length ? `Commands ${describeUnits(alive)}` : '';
  };

  const status = out.over
    ? out.result === 'checkmate'
      ? `Checkmate: the ${out.winner === 'w' ? 'Sun' : 'Moon'} wins`
      : `Drawn (${out.result}). The battlefield decides.`
    : game.sim.winner
      ? 'The battle is decided'
      : myTurn
        ? `Your move${wt.game.inCheck() ? ': you are in check' : ''}`
        : thinking !== null
          ? `The Moon is thinking… ${Math.ceil(thinking)} s`
          : 'The Moon to move';

  const recent = wt.log.slice(-6).reverse();
  return (
    <section className="wartable panel" aria-label="War Table">
      <header className="wt-head">
        <div>
          <div className="sel-kicker">War Table</div>
          <h2>{status}</h2>
        </div>
        <button className="btn icon" onClick={() => toggle('showWarTable')} aria-label="Close the War Table">×</button>
      </header>
      <div className="wt-body">
        <div className="wt-board" role="grid" aria-label="Chessboard, Sun at the bottom">
          {[8, 7, 6, 5, 4, 3, 2, 1].map((r) =>
            [...FILES].map((f, fi) => {
              const sq = `${f}${r}`;
              const p = board.get(sq);
              const b = p ? wt.bonds.on(sq) : undefined;
              const faded = b ? wt.bonds.leaderless(b, wt.live) : false;
              const last = wt.log.length ? (wt.log[wt.log.length - 1]!.san, null) : null;
              void last;
              return (
                <button
                  key={sq}
                  role="gridcell"
                  className={`sq ${(r + fi) % 2 ? 'light' : 'dark'}${sel === sq ? ' sel' : ''}${targets.has(sq) ? ' target' : ''}${p?.type === 'k' && wt.game.inCheck() && p.color === wt.game.turn ? ' check' : ''}`}
                  onClick={() => click(sq)}
                  onMouseEnter={() => setHover(sq)}
                  onMouseLeave={() => setHover(null)}
                  aria-label={`${sq}${p ? `, ${p.color === 'w' ? 'Sun' : 'Moon'} ${{ k: 'king', q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' }[p.type]}. ${describeBinding(sq)}` : ''}${targets.has(sq) ? ', legal move' : ''}`}
                >
                  {p && <span className={`pc ${p.color === 'w' ? 'sun' : 'moon'}${faded ? ' faded' : ''}`}>{GLYPH[p.type]}</span>}
                  {fi === 0 && <span className="rank">{r}</span>}
                  {r === 1 && <span className="file">{f}</span>}
                </button>
              );
            }),
          )}
        </div>
        <div className="wt-side">
          <p className="wt-hover">{hover && board.get(hover) ? describeBinding(hover) || ' ' : 'Hover a piece to see what it commands.'}</p>
          <h3>Recent orders</h3>
          <ol className="wt-log">
            {recent.length === 0 && <li className="log-empty">No moves yet. You play the Sun (white): move first.</li>}
            {recent.map((e) => (
              <li key={e.ply} className={`tone-${e.side}`}>
                <b>{e.side === 'sun' ? 'Sun' : 'Moon'} {e.san}</b>
                {e.effects.length ? e.effects.map((fx, i) => <span key={i}>{describeEffect(fx, e.side)}</span>) : <span>No battlefield effect</span>}
              </li>
            ))}
          </ol>
          <details className="wt-legend">
            <summary>What each piece does</summary>
            <dl>
              {LEGEND.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      </div>
    </section>
  );
}
