/** Prints the realm as text, one row per line (odd rows indented), for quick review. */
import { buildRealm, key, fromOffset, COLS, ROWS } from '../packages/game-core/src/index';

const realm = buildRealm();
const byKey = new Map(realm.cells.map((c) => [key(c), c]));
const glyph: Record<string, string> = { castle: 'C', barracks: 'b', archery: 'a', stable: 's', farm: 'F', mine: 'M', lumber: 'L', forge: 'f', workshop: 'w', tower: 't', site: 'p', rubble: 'x', watchtower: 'V', village: 'O', home: 'h', market: 'k' };
for (let row = -1; row <= ROWS; row++) {
  let line = row & 1 ? ' ' : '';
  for (let col = -1; col <= COLS; col++) {
    const c = byKey.get(key(fromOffset(col, row)));
    let g = '~';
    if (c) {
      const b = c.building ? realm.buildings.find((x) => x.id === c.building) : undefined;
      if (b) g = glyph[b.type] ?? '?';
      else if (c.bridge) g = '#';
      else if (c.ford) g = '%';
      else if (c.river) g = '|';
      else if (c.road) g = '=';
      else g = { grass: '.', forest: '♣', hill: 'n', mountain: '▲', field: '"', water: '~' }[c.terrain];
    }
    line += g + ' ';
  }
  console.log(line);
}
