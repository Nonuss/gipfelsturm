// Sucht Sprünge und Knicke im Höhenprofil entlang der Spuren (außerhalb absichtlicher Features).
// Aufruf: node tools/terrain_scan.mjs [anzahlSeeds] [strecke_m]
import * as C from '../src/course.js';
import * as P from '../src/piste.js';
const NS = +(process.argv[2] || 8), DIST = +(process.argv[3] || 3500);
const STEP = 0.5;
const MODE = process.argv[4] || 'lane';   // lane = Spurmitten, hub = feste Abstände zur Mittellinie
const OFFS = [-70, -35, 0, 35, 70];
let total = 0; const bad = [];
for (let sIdx = 0; sIdx < NS; sIdx++) {
  const seed = 8 + sIdx * 7;
  C.setMode(true, seed);
  const zones = P.zonesOf(DIST + 600);
  const inFeat = (d) => { for (const z of zones) for (const f of z.feats) if (d >= f.s0 - 2 && d <= f.s1 + 2) return f.kind; return null; };
  for (let li = 0; li < (MODE === 'lane' ? P.NL : OFFS.length); li++) {
    let prev2 = null, prev1 = null;
    for (let d = 40; d < DIST; d += STEP) {
      const c = P.props(d);
      if (MODE === 'lane' && c.lw[li] < 2.5) { prev1 = prev2 = null; continue; }
      const x = MODE === 'lane' ? c.lx[li] : c.hub + OFFS[li];
      const h = P.heightP(x, -d);
      if (prev1 !== null && prev2 !== null) {
        const s1 = (prev1 - prev2) / STEP, s2 = (h - prev1) / STEP;
        const kink = Math.abs(s2 - s1);          // Gefälleänderung auf 0.5 m
        const zi = P.props(d).zi;
        total++;
        if (kink > 0.16 && !inFeat(d)) bad.push({ seed, li, d, kink: +kink.toFixed(2), zone: zones[zi]?.type, z0: Math.round(zones[zi]?.d0), z1: Math.round(zones[zi]?.d1) });
      }
      prev2 = prev1; prev1 = h;
    }
  }
}
console.log('Proben', total, 'auffällige Knicke', bad.length);
const byZone = {};
for (const b of bad) { const near = Math.min(Math.abs(b.d - b.z0), Math.abs(b.d - b.z1)); const k = near < 8 ? 'Zonengrenze' : 'frei'; byZone[k] = (byZone[k] || 0) + 1; }
console.log(byZone);
for (const b of bad.slice(0, 25)) console.log(JSON.stringify(b));
