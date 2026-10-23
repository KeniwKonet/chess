import { useEffect, useReducer } from 'react';
import { fromWorld, key, moveCost, UNIT_DEFS, type Unit, type UnitType } from '@cr/game-core';
import { useUi, IS_MOBILE } from '../state/ui';
import { cellByKey, nearestPlaceXZ } from '../game';
import { game, orderStop, ownUnits, PLAYER, describeUnits } from '../sim/runner';
import { focusPick } from '../camera/CameraRig';

/** Re-render while units are moving (positions change every tick), otherwise only on events. */
function useLiveUnits(ids: number[]) {
  const rev = useUi((s) => s.unitRev);
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(() => {
      if (ids.some((i) => game.sim.unit(i)?.state !== 'idle')) tick();
    }, 300);
    return () => clearInterval(id);
  }, [ids]);
  void rev;
  return ids.map((id) => game.sim.unit(id)).filter((u): u is Unit => !!u && u.hp > 0);
}

const STATE_TEXT = { idle: 'Holding position', waiting: 'Finding a path', moving: 'Marching' } as const;

function terrainNote(u: Unit) {
  const c = cellByKey.get(key(fromWorld(u.x, u.z)));
  if (!c) return '';
  const cost = moveCost(c);
  const where = c.bridge ? 'on a bridge' : c.ford ? 'wading the ford' : c.road ? 'on the road' : c.terrain === 'forest' ? 'in forest' : c.terrain === 'hill' ? 'in the hills' : c.terrain === 'field' ? 'in a wheat field' : 'on open ground';
  const pace = cost < 1 ? 'faster' : cost > 1 ? 'slower' : 'normal pace';
  return `${where[0]!.toUpperCase()}${where.slice(1)} · ${pace} (${(UNIT_DEFS[u.type].speed / cost).toFixed(1)} per second)`;
}

export function UnitPanel() {
  const selected = useUi((s) => s.selectedUnits);
  const selectUnits = useUi((s) => s.selectUnits);
  const addLog = useUi((s) => s.addLog);
  const units = useLiveUnits(selected);
  if (!units.length) return null;
  const own = units[0]!.side === PLAYER;
  const side = units[0]!.side;

  if (units.length === 1) {
    const u = units[0]!;
    const def = UNIT_DEFS[u.type];
    const pct = Math.round((u.hp / u.maxHp) * 100);
    return (
      <section className={`selection panel side-${side}`} aria-label="Selected soldier">
        <header>
          <div>
            <div className="sel-kicker">{def.plural} · {own ? 'Yours (Sun)' : 'Enemy (Moon)'}</div>
            <h2>{u.name}</h2>
            <div className="sel-where">
              {STATE_TEXT[u.state]} {u.goal ? nearestPlaceXZ(u.goal.x, u.goal.z, true) : nearestPlaceXZ(u.x, u.z, false)}
            </div>
          </div>
          <button className="btn icon" onClick={() => selectUnits([])} aria-label="Close">×</button>
        </header>
        <div className="hp">
          <div className="hp-row"><span>Health</span><span>{u.hp} / {u.maxHp}</span></div>
          <div className="bar-track big"><div className="bar-fill" style={{ width: `${pct}%` }} /></div>
        </div>
        <p className="sel-text">{terrainNote(u)}</p>
        <UnitActions own={own} onFocus={() => { focusPick(); addLog(`Camera focused on ${u.name}`, 'system'); }} moving={u.state !== 'idle'} />
        <p className="sel-foot">{own ? (IS_MOBILE ? 'Tap the map to send them there.' : 'Right-click the map to send them there.') : 'Moon soldiers can be inspected but not commanded.'} Combat starts in milestone 3.</p>
      </section>
    );
  }

  const byType = new Map<UnitType, Unit[]>();
  for (const u of units) byType.set(u.type, [...(byType.get(u.type) ?? []), u]);
  const moving = units.filter((u) => u.state !== 'idle').length;
  return (
    <section className={`selection panel side-${side}`} aria-label="Selected soldiers">
      <header>
        <div>
          <div className="sel-kicker">{own ? 'Your soldiers (Sun)' : 'Enemy soldiers (Moon)'}</div>
          <h2>{describeUnits(units.map((u) => u.id))}</h2>
          <div className="sel-where">{moving ? `${moving} marching, ${units.length - moving} holding` : `Holding position ${nearestPlaceXZ(units[0]!.x, units[0]!.z, false)}`}</div>
        </div>
        <button className="btn icon" onClick={() => selectUnits([])} aria-label="Close">×</button>
      </header>
      <div className="roster" role="list">
        {[...byType].map(([type, us]) =>
          us.map((u) => (
            <button
              key={u.id}
              role="listitem"
              className={`roster-chip type-${type}${u.state !== 'idle' ? ' moving' : ''}`}
              title={`${u.name}: ${STATE_TEXT[u.state]}. Click to select only this soldier.`}
              onClick={() => selectUnits([u.id])}
            >
              <span className="roster-glyph" aria-hidden="true">{type === 'infantry' ? '♟' : '♝'}</span>
              <span className="roster-hp" style={{ width: `${(u.hp / u.maxHp) * 100}%` }} />
            </button>
          )),
        )}
      </div>
      <UnitActions own={own} onFocus={() => { focusPick(); addLog('Camera focused on the selection', 'system'); }} moving={moving > 0} />
      <p className="sel-foot">{own ? (IS_MOBILE ? 'Tap the map to send them there. They form up in ranks, infantry in front.' : 'Right-click the map to send them. They form up in ranks, infantry in front.') : 'Moon soldiers can be inspected but not commanded.'}</p>
    </section>
  );
}

function UnitActions({ own, onFocus, moving }: { own: boolean; onFocus: () => void; moving: boolean }) {
  return (
    <div className="sel-actions">
      <button className="btn" onClick={onFocus}>Focus (F)</button>
      {own && (
        <>
          <button className="btn" onClick={() => orderStop()} disabled={!moving} title="Stop and hold position (X)">Stop (X)</button>
          <button className="btn btn-locked" disabled title="Attacking needs combat, which arrives in milestone 3">Attack <small>M3</small></button>
        </>
      )}
    </div>
  );
}

/** Quick company selection, mostly for touch screens. */
export function ArmyBar() {
  const selected = useUi((s) => s.selectedUnits);
  const selectUnits = useUi((s) => s.selectUnits);
  const addLog = useUi((s) => s.addLog);
  useUi((s) => s.unitRev);
  const inf = ownUnits('infantry');
  const arc = ownUnits('archer');
  const all = ownUnits();
  const sel = new Set(selected);
  const isSel = (us: Unit[]) => us.length > 0 && us.every((u) => sel.has(u.id)) && selected.length === us.length;
  const pickGroup = (us: Unit[], label: string) => {
    selectUnits(us.map((u) => u.id));
    addLog(`Selected ${label}`, 'sun');
  };
  return (
    <div className="army panel" role="group" aria-label="Your army">
      <span className="army-label">Army</span>
      <button className={`btn${isSel(inf) ? ' on' : ''}`} onClick={() => pickGroup(inf, describeUnits(inf.map((u) => u.id)))} title="Select all infantry">
        <span aria-hidden="true">♟</span> {inf.length}
      </button>
      <button className={`btn${isSel(arc) ? ' on' : ''}`} onClick={() => pickGroup(arc, describeUnits(arc.map((u) => u.id)))} title="Select all archers">
        <span aria-hidden="true">♝</span> {arc.length}
      </button>
      <button className={`btn${isSel(all) ? ' on' : ''}`} onClick={() => pickGroup(all, 'the whole army')} title="Select all (Ctrl+A)">All</button>
    </div>
  );
}
