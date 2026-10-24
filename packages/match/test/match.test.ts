import { describe, expect, it } from 'vitest';
import { Match, BOND_RULES } from '../src/index';
import { DIFFICULTY, type SimEvent } from '@cr/game-core';

const steps = (m: Match, n: number) => {
  const ev: SimEvent[] = [];
  for (let i = 0; i < n; i++) ev.push(...m.step());
  return ev;
};

describe('War Table in a match', () => {
  it('a Sun pawn move advances its bound soldier on the battlefield', () => {
    const m = new Match({ difficulty: 'captain' });
    const pawnSoldier = m.warTable.bonds.on('e2')!.units[0]!;
    const before = m.sim.unit(pawnSoldier)!.x;
    const r = m.playChess('sun', 'e4');
    expect(r.ok).toBe(true);
    const ev = steps(m, 40);
    expect(ev.some((e) => e.kind === 'effect' && e.effect.kind === 'advance' && e.side === 'sun')).toBe(true);
    // Sun advances east, toward Nocturne.
    expect(m.sim.unit(pawnSoldier)!.x).toBeGreaterThan(before + 1);
  });

  it('enforces turns and legality, and the Moon replies after its thinking time', () => {
    const m = new Match({ difficulty: 'captain' });
    expect(m.playChess('moon', 'e5')).toEqual({ ok: false, reason: "It is the Sun's turn on the War Table" });
    expect(m.playChess('sun', 'e5')).toEqual({ ok: false, reason: 'That move is not legal' });
    expect(m.playChess('sun', 'd4').ok).toBe(true);
    expect(m.playChess('sun', 'e4').ok).toBe(false);
    steps(m, DIFFICULTY.captain.chessThink - 2);
    expect(m.warTable.log).toHaveLength(1);
    steps(m, 4);
    expect(m.warTable.log).toHaveLength(2);
    expect(m.warTable.log[1]!.side).toBe('moon');
    expect(m.warTable.turn).toBe('sun');
  });

  it('a bishop move makes its archers fire twice as fast for the documented time', () => {
    const m = new Match({ difficulty: 'captain' });
    m.playChess('sun', 'e4');
    steps(m, DIFFICULTY.captain.chessThink + 2);
    const r = m.playChess('sun', 'Bc4');
    expect(r.ok).toBe(true);
    steps(m, 2);
    const archers = m.warTable.bonds.on('c4')!.units.map((id) => m.sim.unit(id)!);
    for (const a of archers) {
      const buff = a.buffs.find((b) => b.stat === 'rate');
      expect(buff?.mul).toBe(2);
      expect(buff!.until - m.sim.tick).toBeGreaterThan(BOND_RULES.volleyTicks - 5);
    }
  });

  it('checkmate on the War Table wins the battle', () => {
    const m = new Match({ difficulty: 'recruit', moonAi: false });
    for (const [side, mv] of [['sun', 'f3'], ['moon', 'e5'], ['sun', 'g4'], ['moon', 'Qh4#']] as const) {
      expect(m.playChess(side, mv).ok).toBe(true);
    }
    const ev = steps(m, 2);
    expect(m.sim.winner).toBe('moon');
    expect(ev.some((e) => e.kind === 'victory' && e.reason === 'Checkmate on the War Table')).toBe(true);
    expect(m.playChess('sun', 'a3').ok).toBe(false);
  });

  it('pieces whose soldiers have fallen still move but trigger nothing', () => {
    const m = new Match({ moonAi: false });
    const id = m.warTable.bonds.on('e2')!.units[0]!;
    m.sim.unit(id)!.hp = 0;
    const r = m.playChess('sun', 'e4');
    expect(r.ok && r.entry.effects).toEqual([]);
  });

  it('a full single-player match with both AIs is deterministic', () => {
    const play = () => {
      const m = new Match({ difficulty: 'warlord' });
      const moves = ['e4', 'Nf3', 'Bc4', 'O-O', 'd3', 'Nc3', 'Be3', 'Qd2'];
      let k = 0;
      for (let t = 0; t < 1500; t++) {
        if (m.warTable.turn === 'sun' && k < moves.length && !m.warTable.over) {
          const r = m.playChess('sun', moves[k]!);
          if (r.ok) k++;
          else k++; // skip moves the position no longer allows
        }
        m.step();
      }
      return JSON.stringify({ log: m.warTable.log.map((e) => e.san), units: m.sim.units.map((u) => [u.id, u.hp.toFixed(2), u.x.toFixed(3)]) });
    };
    expect(play()).toBe(play());
  });
});
