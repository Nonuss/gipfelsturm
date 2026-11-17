// Flächiger Geländescan: misst die Krümmung des Höhenfelds in Fahrtrichtung, quer und diagonal (auf 0,5 m),
// im ganzen befahrbaren Tal. Fundstellen werden eingeteilt: Kreuzung (zwei Spuren treffen sich), Pistenrand, Spur, frei.
// Absichtliche Features (Sprünge, Rollen, Klippen, Kissen, Steilkurven) und die Talflanken werden ausgelassen.
// Aufruf: node tools/terrain_scan2.mjs [anzahlSeeds] [strecke_m] [stil]
import * as C from '../src/course.js';
import * as P from '../src/piste.js';
const NS = +(process.argv[2] || 6), DIST = +(process.argv[3] || 3000), STYLE = process.argv[4] || 'freeride';
const E = 0.5, LIM = 0.36;   // Krümmungsgrenze (1/m): entspricht einem Gefälleknick von 0,18 auf 0,5 m
const cnt = { Kreuzung: 0, Rand: 0, Spur: 0, frei: 0 }, worst = [];
let samples = 0;
for (let s = 0; s < NS; s++) {
  const seed = 8 + s * 7;
  C.setMode(true, seed, STYLE);
  const zones = P.zonesOf(DIST + 600);
  const inFeat = (x, d) => {
    if (P.inFeatureZone(x, d, 4)) return true;
    for (const z of zones) { if (d < z.d0 - 80 || d > z.d1 + 80) continue; for (const f of z.feats) if (d >= f.s0 - 3 && d <= f.s1 + 3 && (f.kind === 'cliff' || f.kind === 'drop' || f.kind === 'berm' || f.kind === 'lip' || f.kind === 'onramp' || f.kind === 'ridge' || f.kind === 'pinch')) return true; }
    return false;
  };
  for (let d = 40; d < DIST; d += 1.5) {
    const c = P.props(d), hub = c.hub, val = c.valley, zt = zones[c.zi].type;
    if (zt === 'couloir') continue;
    const lx = c.lx.slice(), lw = c.lw.slice();
    for (let x = hub - val + 4; x <= hub + val - 4; x += 1.5) {
      const z = -d, h = P.heightP(x, z);
      const hx = P.heightP(x + E, z) + P.heightP(x - E, z) - 2 * h;
      const hd = P.heightP(x, z - E) + P.heightP(x, z + E) - 2 * h;
      const h1 = P.heightP(x + E, z - E) + P.heightP(x - E, z + E) - 2 * h;
      const h2 = P.heightP(x + E, z + E) + P.heightP(x - E, z - E) - 2 * h;
      const k = Math.max(Math.abs(hx), Math.abs(hd), Math.abs(h1) / 2, Math.abs(h2) / 2) / (E * E);
      samples++;
      if (k < LIM) continue;
      if (inFeat(x, d)) continue;
      let near = 0, onLane = false, rim = false;
      for (let i = 0; i < P.NL; i++) {
        if (lw[i] < 0.3) continue;
        const e = Math.abs(x - lx[i]) - lw[i];
        if (e < 5) near++;
        if (e < -0.5) onLane = true; else if (e < 4) rim = true;
      }
      const cat = near >= 2 ? 'Kreuzung' : onLane ? 'Spur' : rim ? 'Rand' : 'frei';
      cnt[cat]++;
      if (worst.length < 400) worst.push({ seed, d: +d.toFixed(1), u: Math.round(x - hub), k: +k.toFixed(2), cat, zone: zt });
    }
  }
}
console.log('Proben', samples, 'auffällig', Object.values(cnt).reduce((a, b) => a + b, 0), cnt);
worst.sort((a, b) => b.k - a.k);
for (const w of worst.slice(0, +(process.argv[5] || 20))) console.log(JSON.stringify(w));
