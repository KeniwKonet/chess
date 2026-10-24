# Chess Realms rules: how the War Table commands the battlefield

The battle has two layers that run at the same time:

1. **The battlefield.** A real-time war at 10 ticks per second: soldiers, towers, castles and capture points.
2. **The War Table.** An ordinary game of chess between the Sun (white) and the Moon (black).

The chess is **completely standard**: every legal move, check, checkmate, castling, en passant, promotion and draw rule comes from chess.js, unchanged (`packages/chess-core`). The bonds below are a separate layer (`packages/chess-core/src/bonds.ts`). They never change what is legal; they only decide what each move does on the battlefield.

## Turn order

- The War Table is turn-based, even though the battle is real-time. The board waits for the side to move, and nothing is lost by thinking.
- The Sun moves first.
- Against the computer, the Moon replies after a thinking delay set by difficulty: Recruit 12 s, Captain 8 s, Warlord 5 s. Its search depth is 1, 2 or 3 plies, and it prefers moves whose bond effects help its army.
- Online, the server keeps the board. A move is accepted only on your own turn and only if it is legal.

## Who each piece commands (bonds)

At the start of the battle, each side's opening forces are bound to its pieces:

| Piece | Commands | Effect when it moves | Rule value |
| --- | --- | --- | --- |
| Pawn (8) | One infantry soldier each, files a–h | **Advance**: that soldier attack-moves 3 units toward the enemy castle (unless it is already fighting) | `advanceDistance: 3` |
| Bishop (2) | Three archers each (c-file and f-file companies) | **Volley**: those archers shoot twice as fast | `volleyTicks: 120` (12 s) |
| Rook (2) | Your two watchtowers (a-rook: tower 1, h-rook: tower 2) | **Bombard**: that tower deals double damage | `bombardTicks: 150` (15 s) |
| Queen | The whole army | **Rally**: every one of your soldiers deals +15% damage | `rallyTicks: 150` (15 s) |
| King | Your castle | **Fortify**: the castle is repaired by 120 hit points (up to its maximum) | `fortifyAmount: 120` |
| Knight (2) | No one: cavalry is not in the game yet | None | — |

**Capturing** a piece **breaks** whatever it commands. For 25 s (`breakTicks: 250`), the enemy's bound soldiers deal half damage and take 20% more, and a bound building takes 20% more. A capture also triggers the moving piece's own effect.

Pieces keep their identity through castling (the rook keeps its tower), en passant and promotion. A promoted pawn keeps its one soldier and takes on the new piece's effect where it can: a new queen rallies the army, a new bishop volleys with that one soldier, while a new rook or knight has nothing to command.

The rule values live in `BOND_RULES` (`packages/match/src/warTable.ts`). The tests read them from there, so changing a number there changes the game and the tests together.

## Leaderless pieces

When everything a piece commands is gone (its soldiers are dead, or its tower is destroyed), the piece becomes **leaderless**. It still moves and captures by normal chess rules, but its moves do nothing on the battlefield. The War Table shows leaderless pieces faded. The queen is never leaderless while you have an army.

## How the battle ends

- **Checkmate** on the War Table wins the whole battle immediately.
- **A castle falling** on the battlefield wins the whole battle immediately.
- **A drawn board** (stalemate, threefold repetition, fifty moves, insufficient material) closes the War Table. The battlefield then decides.
- Once a winner is declared, the War Table closes and the battlefield stops accepting orders.

## Battlefield rules that matter here

- **Reinforcements.** Every 90 s, each side's barracks sends 2 infantry and its archery range sends 1 archer, while that building stands and the side has fewer than 40 soldiers. Reinforcements are **not bound** to any piece.
- **Capture points.** Soldiers standing in a ring take it, but only when uncontested: 0.6 points per soldier per tick, counting at most 3 soldiers. Holding Vey Watchtower gives your soldiers +2 sight.
- **Buildings.** Watchtowers and castles shoot at enemies in range. Castles take half damage. A destroyed building becomes rubble and cannot be repaired.
- **Fog of war.** You see only what your soldiers and buildings see. Ground you have seen stays dimly visible; enemies there are hidden.

## Known simplifications

- The Moon's battlefield commander (`packages/game-core/src/ai/commander.ts`) sees the whole map. It **ignores fog**, a classic RTS shortcut. Its War Table player sees only the board.
- Knights command no one until cavalry exists.
- The economy is not simulated: resources are static readouts, and there is no training or building.
