// Wie dicht ist der Heli-Wald? Freie Weglänge durch den Wald (mit den echten Baum-Kollisionen der Kacheln).
// Aufruf: node tools/heli_trees.mjs [anzahlBerge]
// An zufälligen Stellen im Wald (Waldanteil über 0,5) wird in Falllinie und schräg (±30 Grad) geradeaus gemessen, wie
// weit man kommt, bis ein Baum den Fahrer (halbe Breite 0,35 m) berührt. Dazu: Bäume je Hektar im dichten Wald und wie
// oft man 100 m geradeaus durchkommt. Zum Vergleich: bei Tempo 80 km/h fährt man 22 m pro Sekunde.
import * as C from '../src/course.js';
const HB = C.HB;
const NSEEDS = +(process.argv[2] || 3);
const T = 100;
const all = { free: [], clear100: 0, lines: 0, perHa: [] };
for (let k = 0; k < NSEEDS; k++) {
  const seed = 1000 + k * 7919;
  C.setMode(true, seed, 'heli');
  const s = HB.info();
  const trees = new Map();
  const tile = (i, j) => {
    const key = i + ',' + j;
    if (!trees.has(key)) { const list = []; HB.genTile(i, j, T, 1, (x, z, r, type) => { if (type === 'baum') list.push({ x, d: -z, r }); }, () => {}); trees.set(key, list); }
    return trees.get(key);
  };
  const near = (x, d) => { const out = []; const i0 = Math.floor(x / T), j0 = Math.floor(d / T); for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) out.push(...tile(i, j)); return out; };
  let rnd = seed + 17;
  const R = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let t = 0, n = 0; t < 20000 && n < 250; t++) {
    const x = -2800 + R() * 5600, d = 300 + R() * (s.DV - 300);
    if (HB.forestAt(x, d) < 0.5) continue;
    // Bäume je Hektar um die Stelle (Kreis mit 40 m)
    const list = near(x, d), cnt = list.filter((q) => Math.hypot(q.x - x, q.d - d) < 40).length;
    all.perHa.push(cnt / (Math.PI * 0.16));
    const e = 6, gx = HB.heightDU(d, x + e) - HB.heightDU(d, x - e), gd = HB.heightDU(d + e, x) - HB.heightDU(d - e, x), gl = Math.hypot(gx, gd) || 1;
    for (const a of [-0.52, 0, 0.52]) {
      const c = Math.cos(a), sn = Math.sin(a), fx = (-gx / gl) * c - (-gd / gl) * sn, fd = (-gx / gl) * sn + (-gd / gl) * c;
      let free = 150;
      for (let st = 0; st <= 150; st += 0.5) {
        const px = x + fx * st, pd = d + fd * st;
        if (near(px, pd).some((q) => Math.hypot(q.x - px, q.d - pd) < q.r + 0.35)) { free = st; break; }
      }
      all.free.push(free); all.lines++; if (free >= 100) all.clear100++;
    }
    n++;
  }
}
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
console.log(`${all.lines} Linien im Wald auf ${NSEEDS} Bergen`);
console.log(`Bäume je Hektar im Wald: Median ${q(all.perHa, 0.5).toFixed(0)}, 90 % ${q(all.perHa, 0.9).toFixed(0)}`);
console.log(`freie Weglänge geradeaus: Median ${q(all.free, 0.5).toFixed(0)} m, schlechteste 25 % unter ${q(all.free, 0.25).toFixed(0)} m; 100 m ohne Baum: ${(all.clear100 / all.lines * 100).toFixed(0)} %`);
