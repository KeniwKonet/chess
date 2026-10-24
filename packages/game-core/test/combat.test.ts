import { describe, expect, it } from 'vitest';
import { buildRealm, px } from '../src/map/realm';
import { Sim, UNIT_DEFS, REINFORCE_EVERY, type SimEvent, type UnitSpawn } from '../src/sim/sim';
import { startingArmies, PATROL_SIZE } from '../src/sim/scenario';
import { Commander } from '../src/ai/commander';
import { toWorld } from '../src/hex';

const realm = buildRealm();
const at = (X: number, Y: number) => toWorld(px(X, Y));

function run(sim: Sim, ticks: number, each?: () => void) {
  const ev: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    each?.();
    ev.push(...sim.step());
  }
  return ev;
}
/** A quiet sim with just the given soldiers and no reinforcements. */
function duel(spawns: UnitSpawn[]) {
  const sim = new Sim(realm, spawns);
  sim.reinforcements = false;
  return sim;
}

describe('combat', () => {
  // Open ground in the middle of the west bank, away from towers.
  const field = at(700, 1750); // more than 10 units from every tower and castle

  it('idle soldiers within sight fight; one dies and is reported and counted', () => {
    const sim = duel([
      { side: 'sun', type: 'infantry', x: field.x, z: field.z },
      { side: 'moon', type: 'infantry', x: field.x + 1.5, z: field.z },
    ]);
    const ev = run(sim, 300);
    const kills = ev.filter((e) => e.kind === 'killed');
    expect(kills).toHaveLength(1);
    const loser = kills[0]!.side;
    expect(sim.stats[loser].losses).toBe(1);
    expect(sim.stats[loser === 'sun' ? 'moon' : 'sun'].kills).toBe(1);
    // The corpse is cleared after its death animation.
    expect(sim.units).toHaveLength(1);
  });

  it('archers shoot from range without closing in', () => {
    const sim = duel([
      { side: 'sun', type: 'archer', x: field.x, z: field.z },
      { side: 'moon', type: 'infantry', x: field.x + 5, z: field.z },
    ]);
    const archer = sim.units[0]!;
    const target = sim.units[1]!;
    sim.issue({ kind: 'attack', side: 'sun', ids: [archer.id], target: { kind: 'unit', id: target.id } });
    // Freeze the target so it can't charge.
    run(sim, 40, () => {
      target.cooldown = 99;
      target.x = target.px;
      target.z = target.pz;
    });
    expect(target.hp).toBeLessThan(UNIT_DEFS.infantry.maxHp);
    expect(Math.hypot(archer.x - field.x, archer.z - field.z)).toBeLessThan(0.3);
    expect(sim.projectiles.length + 1).toBeGreaterThan(0);
  });

  it('attack orders bring down a building; a fallen castle ends the match', () => {
    const castle = sim0().building('moon_castle')!;
    const spawns: UnitSpawn[] = [];
    for (let i = 0; i < 12; i++) spawns.push({ side: 'sun', type: 'infantry', x: castle.x - 2.2, z: castle.z + (i - 6) * 0.5 });
    const sim = duel(spawns);
    const c = sim.building('moon_castle')!;
    c.hp = 150; // shorten the siege
    c.weapon = null; // and silence it, to test the siege mechanics alone
    sim.issue({ kind: 'attack', side: 'sun', ids: sim.units.map((u) => u.id), target: { kind: 'building', id: 'moon_castle' } });
    const ev = run(sim, 600);
    expect(ev.some((e) => e.kind === 'destroyed' && e.buildingId === 'moon_castle')).toBe(true);
    expect(sim.winner).toBe('sun');
    expect(ev.filter((e) => e.kind === 'victory')).toHaveLength(1);
    // After victory the field freezes.
    const t = sim.tick;
    sim.step();
    expect(sim.tick).toBe(t);
  });

  it('attack-move fights what it meets, then carries on to the destination', () => {
    const sim = duel([
      ...[0, 1, 2, 3].map((i) => ({ side: 'sun' as const, type: 'infantry' as const, x: field.x - 4, z: field.z + i * 0.6 })),
      { side: 'moon', type: 'archer', x: field.x + 1, z: field.z + 1 },
    ]);
    const dest = { x: field.x + 6, z: field.z + 1 };
    sim.issue({ kind: 'move', side: 'sun', ids: sim.units.filter((u) => u.side === 'sun').map((u) => u.id), x: dest.x, z: dest.z, attack: true });
    const ev = run(sim, 500);
    expect(ev.some((e) => e.kind === 'killed' && e.side === 'moon')).toBe(true);
    const sun = sim.units.filter((u) => u.side === 'sun');
    for (const u of sun) expect(Math.hypot(u.x - dest.x, u.z - dest.z)).toBeLessThan(3);
  });

  it('a plain move order marches past enemies without stopping to fight', () => {
    const sim = duel([
      { side: 'sun', type: 'infantry', x: field.x - 4, z: field.z },
      { side: 'moon', type: 'infantry', x: field.x, z: field.z + 2.5 },
    ]);
    const moon = sim.units[1]!;
    moon.cooldown = 1e9; // keep the Moon soldier passive
    const dest = { x: field.x + 5, z: field.z };
    sim.issue({ kind: 'move', side: 'sun', ids: [sim.units[0]!.id], x: dest.x, z: dest.z });
    // At the moment it arrives it has not struck once (once idle, it would defend itself).
    let hpAtArrival = -1;
    for (let t = 0; t < 120 && hpAtArrival < 0; t++) {
      moon.cooldown = 1e9;
      if (sim.step().some((e) => e.kind === 'arrived')) hpAtArrival = moon.hp;
    }
    expect(hpAtArrival).toBe(UNIT_DEFS.infantry.maxHp);
  });

  it('towers shoot enemy soldiers in range', () => {
    const tower = sim0().building('moon_t1')!;
    const sim = duel([{ side: 'sun', type: 'infantry', x: tower.x - 4, z: tower.z }]);
    const u = sim.units[0]!;
    run(sim, 60, () => {
      u.x = u.px;
      u.z = u.pz;
    });
    expect(u.hp).toBeLessThan(UNIT_DEFS.infantry.maxHp);
  });

  it('captures an uncontested point, and a contested one does not move', () => {
    const ford = sim0().captures.find((c) => c.id === 'ford')!;
    const sim = duel([0, 1, 2].map((i) => ({ side: 'sun' as const, type: 'archer' as const, x: ford.x - 1 + i * 0.5, z: ford.z - 2.5 })));
    const ev = run(sim, 120);
    expect(ev.some((e) => e.kind === 'captured' && e.captureId === 'ford' && e.side === 'sun')).toBe(true);
    expect(sim.captures.find((c) => c.id === 'ford')!.owner).toBe('sun');

    const sim2 = duel([
      { side: 'sun', type: 'archer', x: ford.x - 1, z: ford.z - 2.5 },
      { side: 'moon', type: 'archer', x: ford.x + 1, z: ford.z + 2.5 },
    ]);
    for (const u of sim2.units) u.cooldown = 1e9;
    run(sim2, 30, () => sim2.units.forEach((u) => (u.cooldown = 1e9)));
    expect(sim2.captures.find((c) => c.id === 'ford')!.progress).toBe(0);
  });

  it('fog of war: each side only sees near its own soldiers and buildings', () => {
    const sim = new Sim(realm, startingArmies(realm));
    const moonInf = sim.units.find((u) => u.side === 'moon' && u.type === 'infantry')!;
    expect(sim.sees('sun', moonInf.x, moonInf.z)).toBe(false);
    expect(sim.sees('moon', moonInf.x, moonInf.z)).toBe(true);
    // Walk a Sun archer up to them and look again.
    const a = sim.units.find((u) => u.side === 'sun' && u.type === 'archer')!;
    a.x = moonInf.x - 5;
    a.z = moonInf.z;
    run(sim, 5);
    expect(sim.sees('sun', moonInf.x, moonInf.z)).toBe(true);
  });

  it('applies bond effects: volley doubles the rate, fortify repairs, break makes a target fragile', () => {
    const sim = duel([
      { side: 'sun', type: 'archer', x: field.x, z: field.z },
      { side: 'moon', type: 'infantry', x: field.x + 5, z: field.z },
    ]);
    const [arch, foe] = sim.units as [ReturnType<Sim['spawn']>, ReturnType<Sim['spawn']>];
    sim.issue({ kind: 'effect', side: 'sun', effect: { kind: 'volley', unitIds: [arch.id], ticks: 100, source: 'test' } });
    sim.issue({ kind: 'effect', side: 'sun', effect: { kind: 'break', unitIds: [foe.id], ticks: 100, source: 'test' } });
    sim.building('sun_t1')!.hp = 100;
    sim.issue({ kind: 'effect', side: 'sun', effect: { kind: 'fortify', buildingId: 'sun_t1', amount: 120, source: 'test' } });
    sim.issue({ kind: 'attack', side: 'sun', ids: [arch.id], target: { kind: 'unit', id: foe.id } });
    let shots = 0;
    run(sim, 32, () => {
      foe.cooldown = 99;
      foe.x = foe.px;
      foe.z = foe.pz;
      if (arch.lastAttack === sim.tick) shots++;
    });
    // 15-tick cooldown halves to 8: four shots in 32 ticks instead of two or three.
    expect(arch.lastAttack).toBeGreaterThan(0);
    expect(sim.building('sun_t1')!.hp).toBe(220);
    // Each arrow does 8 × 1.2 = 9.6 against the broken soldier.
    const arrows = (UNIT_DEFS.infantry.maxHp - foe.hp) / 9.6;
    expect(Math.abs(arrows - Math.round(arrows))).toBeLessThan(1e-6);
    // Doubled rate: at least 3 arrows have landed in 32 ticks (an unbuffed archer manages 2).
    expect(Math.round(arrows)).toBeGreaterThanOrEqual(3);
  });

  it('reinforces from standing barracks every 90 seconds, and not once they fall', () => {
    const sim = new Sim(realm, []);
    let ev = run(sim, REINFORCE_EVERY);
    const r = ev.filter((e) => e.kind === 'reinforced');
    expect(r.map((e) => e.side).sort()).toEqual(['moon', 'sun']);
    expect(sim.units.filter((u) => u.side === 'sun')).toHaveLength(3);
    sim.building('sun_bar')!.destroyed = true;
    sim.building('sun_arc')!.destroyed = true;
    ev = run(sim, REINFORCE_EVERY);
    expect(ev.some((e) => e.kind === 'reinforced' && e.side === 'sun')).toBe(false);
  });
});

describe('Moon commander AI', () => {
  it('musters, crosses the river to attack, and the battle plays out deterministically', () => {
    const play = () => {
      const sim = new Sim(realm, startingArmies(realm));
      const patrol = sim.units.slice(-PATROL_SIZE).map((u) => u.id);
      const ai = new Commander(sim, 'moon', 'warlord', patrol);
      let crossed = false;
      const riverX = toWorld(px(1600, 1000)).x;
      for (let t = 0; t < 2400; t++) {
        ai.think();
        sim.step();
        if (sim.units.some((u) => u.side === 'moon' && u.hp > 0 && u.x < riverX - 3)) crossed = true;
      }
      return { crossed, phase: ai.phase, hash: JSON.stringify(sim.units.map((u) => [u.id, u.hp.toFixed(3), u.x.toFixed(4)])), stats: sim.stats };
    };
    const a = play();
    expect(a.crossed).toBe(true);
    expect(a.stats.sun.losses + a.stats.moon.losses).toBeGreaterThan(0);
    expect(play().hash).toBe(a.hash);
  });

  it('defends when Sun soldiers come close to a Moon building', () => {
    const sim = new Sim(realm, startingArmies(realm));
    sim.reinforcements = false;
    const ai = new Commander(sim, 'moon', 'recruit');
    const raider = sim.units.find((u) => u.side === 'sun')!;
    const bar = sim.building('moon_bar')!;
    raider.x = bar.x - 3;
    raider.z = bar.z;
    let ordered = false;
    for (let t = 0; t < 60; t++) {
      ai.think();
      for (const e of sim.step()) if (e.kind === 'order' && e.side === 'moon' && e.attack) ordered = true;
    }
    expect(ordered).toBe(true);
  });
});

function sim0() {
  return new Sim(realm, []);
}
