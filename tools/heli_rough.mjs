// Unebenheit im Heli-Gebirge messen: Wellen und Buckel auf offenen Hängen (ohne Klippen und Geländeformen).
// Aufruf: node tools/heli_rough.mjs [anzahlBerge]
// An zufälligen Stellen wird ein 60 m langes Profil in Falllinie und quer dazu abgetastet (alle 1 m). Gemessen wird die
// größte Abweichung von der 20-m-Sehne (Buckel oder Mulde, wie beim Freeride-Scan) und die Krümmung auf 6 m
// (zweite Ableitung: was den Fahrer bei Tempo abheben lässt).
import * as C from '../src/course.js';
const HB = C.HB;
const NSEEDS = +(process.argv[2] || 4);
const prof = (x, d, ux, ud) => { const a = []; for (let s = -30; s <= 30; s++) a.push(HB.heightDU(d + ud * s, x + ux * s)); return a; };
function bumps(a) {
  let dev = 0, curv = 0;
  for (let i = 10; i < a.length - 10; i++) {
    dev = Math.max(dev, Math.abs(a[i] - (a[i - 10] + a[i + 10]) / 2));
    if (i >= 3 && i < a.length - 3) curv = Math.max(curv, Math.abs(a[i - 3] + a[i + 3] - 2 * a[i]) / 9);
  }
  return { dev, curv };
}
const all = { fall: [], cross: [], curvF: [], curvC: [] };
for (let k = 0; k < NSEEDS; k++) {
  const seed = 1000 + k * 7919;
  C.setMode(true, seed, 'heli');
  const s = HB.info();
  let rnd = seed + 5;
  const R = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let t = 0, n = 0; t < 20000 && n < 600; t++) {
    const x = -2600 + R() * 5200, d = 150 + R() * (s.DV - 700);
    if (HB.nearCliff(x, d, 70) || (s.feats || []).some((q) => Math.hypot(q.x - x, q.d - d) < 120)) continue;
    if (HB.heightDU(d, x) < HB.floorY(x, d) + 30) continue;   // nur Hänge, nicht der Talboden
    const e = 10, gx = HB.heightDU(d, x + e) - HB.heightDU(d, x - e), gd = HB.heightDU(d + e, x) - HB.heightDU(d - e, x), gl = Math.hypot(gx, gd) || 1;
    if (gl / (2 * e) < 0.15 || gl / (2 * e) > 1.0) continue;   // fahrbare Hänge (Felswände ausgenommen)
    const fx = -gx / gl, fd = -gd / gl;
    const a = bumps(prof(x, d, fx, fd)), b = bumps(prof(x, d, fd, -fx));
    all.fall.push(a.dev); all.cross.push(b.dev); all.curvF.push(a.curv); all.curvC.push(b.curv);
    n++;
  }
}
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
const share = (arr, lim) => (arr.filter((v) => v > lim).length / arr.length * 100).toFixed(1) + ' %';
console.log(`${all.fall.length} Stellen auf ${NSEEDS} Bergen`);
for (const [k, nm] of [['fall', 'Falllinie'], ['cross', 'quer']]) console.log(`Buckel ${nm.padEnd(9)} (20-m-Sehne): Median ${q(all[k], 0.5).toFixed(2)} m, 90 % ${q(all[k], 0.9).toFixed(2)} m, über 0,5 m ${share(all[k], 0.5)}, über 1 m ${share(all[k], 1)}`);
for (const [k, nm] of [['curvF', 'Falllinie'], ['curvC', 'quer']]) console.log(`Krümmung ${nm.padEnd(9)} (6 m): Median ${q(all[k], 0.5).toFixed(3)}, 90 % ${q(all[k], 0.9).toFixed(3)}, über 0,05 ${share(all[k], 0.05)}`);
