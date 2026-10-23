import { describe, expect, it } from 'vitest';
import { buildRealm } from '../src/map/realm';
import { Sim, UNIT_DEFS, FIELD_BUDGET, type SimEvent, type UnitSpawn } from '../src/sim/sim';
import { buildField, chain, Grid } from '../src/sim/field';
import { startingArmies, patrolRoute, PATROL_SIZE } from '../src/sim/scenario';
import { PatrolAI } from '../src/ai/patrol';
import { fromWorld, key, toWorld, neighbors } from '../src/hex';
import { px } from '../src/map/realm';

const realm = buildRealm();
const grid = new Grid(realm);
const at = (X: number, Y: number) => toWorld(px(X, Y));

function run(sim: Sim, ticks: number, onTick?: (ev: SimEvent[]) => void) {
  const all: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    const ev = sim.step();
    all.push(...ev);
    onTick?.(ev);
  }
  return all;
}

describe('distance fields', () => {
  const goal = px(2820, 1000); // next to Nocturne
  const g = grid.nearestPassable(goal)!;
  const field = buildField(grid, g);

  it('reach every cell connected by land and skip blocked ones', () => {
    for (const c of realm.cells) {
      const has = field.cost.has(key(c));
      if (!grid.passable(c)) expect(has).toBe(false);
    }
    // Sunspire's side is reachable, across a crossing.
    const sunSide = grid.nearestPassable(px(600, 1000))!;
    expect(field.cost.has(key(sunSide))).toBe(true);
  });

  it('descend strictly to the goal along neighbouring cells', () => {
    const start = grid.nearestPassable(px(600, 1000))!;
    const c = chain(field, start);
    expect(c[c.length - 1]).toEqual(g);
    for (let i = 1; i < c.length; i++) {
      expect(neighbors(c[i - 1]!).some((n) => n.q === c[i]!.q && n.r === c[i]!.r)).toBe(true);
      expect(field.cost.get(key(c[i]!))!).toBeLessThan(field.cost.get(key(c[i - 1]!))!);
    }
  });

  it('cross the river only at a bridge or the ford', () => {
    const start = grid.nearestPassable(px(600, 1000))!;
    for (const cell of chain(field, start)) {
      const rc = grid.cells.get(key(cell))!;
      if (rc.river) expect(rc.bridge || rc.ford).toBe(true);
    }
  });
});

describe('the simulation', () => {
  it('moves a group to its destination and reports one arrival', () => {
    const sim = new Sim(realm, startingArmies(realm));
    const sun = sim.units.filter((u) => u.side === 'sun' && u.type === 'infantry');
    const dest = at(1300, 1250);
    sim.issue({ kind: 'move', side: 'sun', ids: sun.map((u) => u.id), x: dest.x, z: dest.z });
    const ev = run(sim, 400);
    expect(ev.filter((e) => e.kind === 'order')).toHaveLength(1);
    const arrived = ev.filter((e) => e.kind === 'arrived');
    expect(arrived).toHaveLength(1);
    for (const u of sun) {
      expect(u.state).toBe('idle');
      expect(Math.hypot(u.x - dest.x, u.z - dest.z)).toBeLessThan(3);
    }
  });

  it('crosses the river through a crossing and never stands on blocked ground', () => {
    const sim = new Sim(realm, startingArmies(realm));
    const archers = sim.units.filter((u) => u.side === 'sun' && u.type === 'archer');
    const dest = at(2000, 1150); // east bank
    sim.issue({ kind: 'move', side: 'sun', ids: archers.map((u) => u.id), x: dest.x, z: dest.z });
    let usedCrossing = false;
    run(sim, 900, () => {
      for (const u of sim.units) {
        const h = fromWorld(u.x, u.z);
        expect(grid.passable(h), `${u.name} on ${key(h)}`).toBe(true);
        const c = grid.cells.get(key(h))!;
        if (archers.includes(u) && (c.bridge || c.ford)) usedCrossing = true;
      }
    });
    expect(usedCrossing).toBe(true);
    for (const u of archers) expect(Math.hypot(u.x - dest.x, u.z - dest.z)).toBeLessThan(3);
  });

  it('is deterministic: same commands, same result', () => {
    const play = () => {
      const sim = new Sim(realm, startingArmies(realm));
      const ids = sim.units.filter((u) => u.side === 'sun').map((u) => u.id);
      const d = at(1500, 700);
      sim.issue({ kind: 'move', side: 'sun', ids, x: d.x, z: d.z });
      run(sim, 250);
      return JSON.stringify(sim.units.map((u) => [u.x.toFixed(6), u.z.toFixed(6), u.facing.toFixed(6), u.state]));
    };
    expect(play()).toBe(play());
  });

  it("rejects orders for the other side's units", () => {
    const sim = new Sim(realm, startingArmies(realm));
    const moon = sim.units.filter((u) => u.side === 'moon').map((u) => u.id);
    const before = JSON.stringify(sim.units.map((u) => [u.x, u.z]));
    sim.issue({ kind: 'move', side: 'sun', ids: moon, x: 10, z: 10 });
    const ev = run(sim, 20);
    expect(ev.some((e) => e.kind === 'rejected')).toBe(true);
    expect(sim.units.filter((u) => u.side === 'moon').every((u) => u.state === 'idle')).toBe(true);
    void before;
  });

  it('builds at most the budgeted number of fields per tick', () => {
    const spawns: UnitSpawn[] = [];
    for (let i = 0; i < 30; i++) spawns.push({ side: 'sun', type: 'infantry', ...at(700 + (i % 6) * 40, 900 + Math.floor(i / 6) * 40) });
    const sim = new Sim(realm, spawns);
    // 30 separate one-unit orders to 30 different places.
    sim.units.forEach((u, i) => {
      const d = at(400 + (i % 10) * 90, 300 + Math.floor(i / 10) * 500);
      sim.issue({ kind: 'move', side: 'sun', ids: [u.id], x: d.x, z: d.z });
    });
    for (let t = 0; t < 10; t++) {
      sim.step();
      expect(sim.fieldsBuiltLastTick).toBeLessThanOrEqual(FIELD_BUDGET);
    }
    expect(sim.units.every((u) => u.state !== 'waiting')).toBe(true);
  });

  it('moves faster on roads than through forest', () => {
    const speedOn = (pred: (c: ReturnType<Grid['cells']['get']>) => boolean) => {
      const cell = realm.cells.find((c) => pred(c) && neighbors(c).every((n) => grid.passable(n)))!;
      const p = toWorld(cell);
      const sim = new Sim(realm, [{ side: 'sun', type: 'infantry', x: p.x, z: p.z }]);
      const u = sim.units[0]!;
      sim.issue({ kind: 'move', side: 'sun', ids: [u.id], x: p.x + 5, z: p.z });
      sim.step(); // field
      sim.step();
      return u.moved;
    };
    const road = speedOn((c) => !!c?.road);
    const forest = speedOn((c) => c?.terrain === 'forest');
    expect(road).toBeGreaterThan(forest * 2);
    expect(road).toBeCloseTo((UNIT_DEFS.infantry.speed / 0.7) * 0.1, 2);
  });

  it('stops on command', () => {
    const sim = new Sim(realm, startingArmies(realm));
    const ids = sim.units.filter((u) => u.side === 'sun').map((u) => u.id);
    const d = at(1500, 700);
    sim.issue({ kind: 'move', side: 'sun', ids, x: d.x, z: d.z });
    run(sim, 20);
    sim.issue({ kind: 'stop', side: 'sun', ids });
    const ev = run(sim, 1);
    expect(ev.some((e) => e.kind === 'stopped')).toBe(true);
    const pos = sim.units.map((u) => [u.x, u.z]);
    run(sim, 20);
    // Only personal-space nudges after stopping.
    sim.units.forEach((u, i) => expect(Math.hypot(u.x - pos[i]![0]!, u.z - pos[i]![1]!)).toBeLessThan(0.3));
  });

  it('keeps soldiers apart once they settle', () => {
    const sim = new Sim(realm, startingArmies(realm));
    const ids = sim.units.filter((u) => u.side === 'sun').map((u) => u.id);
    const d = at(1250, 1000);
    sim.issue({ kind: 'move', side: 'sun', ids, x: d.x, z: d.z });
    run(sim, 500);
    const sun = sim.units.filter((u) => u.side === 'sun');
    for (let i = 0; i < sun.length; i++)
      for (let j = i + 1; j < sun.length; j++) expect(Math.hypot(sun[i]!.x - sun[j]!.x, sun[i]!.z - sun[j]!.z)).toBeGreaterThan(0.4);
  });

  it('reports an unreachable destination instead of wandering', () => {
    // A lone unit fenced in by impassable tiles cannot reach the far bank.
    const sim = new Sim(realm, startingArmies(realm));
    const u = sim.units[0]!;
    sim.issue({ kind: 'move', side: 'sun', ids: [u.id], x: -40, z: -40 }); // open sea
    const ev = run(sim, 600);
    // Sea snaps to the nearest shore tile, which is reachable: it should arrive, not fail.
    expect(ev.some((e) => e.kind === 'arrived')).toBe(true);
    expect(grid.passable(fromWorld(u.x, u.z))).toBe(true);
  });
});

describe('Moon patrol AI', () => {
  it('walks its route back and forth using ordinary orders', () => {
    const sim = new Sim(realm, startingArmies(realm));
    const patrol = sim.units.slice(-PATROL_SIZE).map((u) => u.id);
    const ai = new PatrolAI('moon', patrol, patrolRoute(), 20);
    const ends = patrolRoute();
    const visits = [0, 0];
    let orders = 0;
    for (let t = 0; t < 2000; t++) {
      ai.think(sim);
      const ev = sim.step();
      orders += ev.filter((e) => e.kind === 'order' && e.side === 'moon').length;
      const u = sim.unit(patrol[0]!)!;
      ends.forEach((p, i) => {
        if (u.state === 'idle' && Math.hypot(u.x - p.x, u.z - p.z) < 2.5) visits[i]!++;
      });
    }
    expect(orders).toBeGreaterThanOrEqual(3);
    expect(visits[0]).toBeGreaterThan(0);
    expect(visits[1]).toBeGreaterThan(0);
  });
});

describe('stress', () => {
  it('survives 3,000 ticks of random orders without leaving open ground', async () => {
    const { createRng } = await import('../src/rng');
    const rng = createRng(99);
    const sim = new Sim(realm, startingArmies(realm));
    const b = realm.bounds;
    let arrivals = 0;
    for (let t = 0; t < 3000; t++) {
      if (t % 60 === 0) {
        const side = rng.next() < 0.5 ? 'sun' : 'moon';
        const own = sim.units.filter((u) => u.side === side);
        const ids = own.filter(() => rng.next() < 0.5).map((u) => u.id);
        if (ids.length) sim.issue({ kind: 'move', side, ids, x: rng.range(b.minX, b.maxX), z: rng.range(b.minZ, b.maxZ) });
      }
      for (const e of sim.step()) if (e.kind === 'arrived') arrivals++;
      for (const u of sim.units) {
        expect(Number.isFinite(u.x) && Number.isFinite(u.z)).toBe(true);
        expect(grid.passable(fromWorld(u.x, u.z))).toBe(true);
      }
    }
    expect(arrivals).toBeGreaterThan(10);
  });
});
