/**
 * Glicko-2 ratings (Glickman, "Example of the Glicko-2 system", 2013),
 * updated after every rated game, the way most chess sites do it.
 * New players start at 1500 with a high deviation, so their first games move
 * the rating a lot; it settles as they play.
 */
export interface GlickoRating {
  rating: number;
  rd: number;
  vol: number;
}

export const NEW_RATING: GlickoRating = { rating: 1500, rd: 350, vol: 0.06 };
/** Shown with a "?" until the deviation drops below this. */
export const PROVISIONAL_RD = 110;

const SCALE = 173.7178;
const TAU = 0.5;
const EPS = 1e-6;
const MIN_RD = 45;
const MAX_RD = 350;

const g = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const E = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

/** New rating for `p` after one game against `opp` with score 1 (win), 0.5 (draw) or 0 (loss). */
export function rate(p: GlickoRating, opp: GlickoRating, score: number): GlickoRating {
  const mu = (p.rating - 1500) / SCALE;
  const phi = p.rd / SCALE;
  const muJ = (opp.rating - 1500) / SCALE;
  const phiJ = opp.rd / SCALE;
  const gJ = g(phiJ);
  const e = E(mu, muJ, phiJ);
  const v = 1 / (gJ * gJ * e * (1 - e));
  const delta = v * gJ * (score - e);

  // New volatility (Illinois algorithm, step 5).
  const a = Math.log(p.vol * p.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * (phi * phi + v + ex) ** 2) - (x - a) / (TAU * TAU);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * TAU) < 0) k++;
    B = a - k * TAU;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > EPS; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const vol = Math.exp(A / 2);

  const phiStar = Math.sqrt(phi * phi + vol * vol);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * gJ * (score - e);
  return {
    rating: Math.max(100, muNew * SCALE + 1500),
    rd: Math.min(MAX_RD, Math.max(MIN_RD, phiNew * SCALE)),
    vol,
  };
}
