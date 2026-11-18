// Lenk-Test im Heli-Gebirge: Greift die Lenkung am steilen Querhang auch bei Tempo?
// Aufruf: node tools/heli_steer.mjs [anzahlBerge]
// Der Testfahrer startet auf einem offenen Steilhang (Gefälle 0,55 bis 0,95, also 29 bis 44 Grad) und lenkt 2 s voll
// gegen den Hang, also bergwärts weg von der Falllinie. Gemessen wird, wie weit sich die Fahrtrichtung (Geschwindigkeit,
// nicht die Ski) in die gewollte Richtung dreht:
//  - "Falllinie": Start gerade in der Falllinie, Lenken nach rechts
//  - "Quer 45":   Start 45 Grad rechts der Falllinie (Hang fällt nach links ab), weiter nach rechts lenken (bergauf)
//  - "Quer 70":   Start 70 Grad rechts der Falllinie (fast quer), weiter nach rechts lenken
// Gelungen heißt: die Fahrtrichtung dreht sich in 2 s um mindestens 20 Grad in die Lenkrichtung.
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';
const HB = C.HB;
const NSEEDS = +(process.argv[2] || 3);
const phys = new SkiPhysics();
const deg = (r) => r * 180 / Math.PI;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

function fall(x, d) {
  const e = 8, gx = HB.heightDU(d, x + e) - HB.heightDU(d, x - e), gd = HB.heightDU(d + e, x) - HB.heightDU(d - e, x), l = Math.hypot(gx, gd) || 1;
  return { fx: -gx / l, fd: -gd / l, sl: l / (2 * e) };
}
function trial(x, d, off, v0, steer, T = 2) {
  const f = fall(x, d), h0 = Math.atan2(f.fx, f.fd) + off;
  phys.reset(d, x);
  phys.events.length = 0;
  phys.heading = h0;
  // Startgeschwindigkeit in der Hangebene (sonst hebt der Fahrer am Steilhang sofort ab)
  const n = phys.normal; C.terrainNormal(x, -d, n);
  phys.vel.set(Math.sin(h0), 0, -Math.cos(h0));
  phys.vel.addScaledVector(n, -phys.vel.dot(n)).normalize().multiplyScalar(v0);
  const inp = { steer: 0, tuck: 0, brake: 0, jump: false }, dt = 1 / 120;
  let crashed = false, air = 0;
  for (let t = 0; t < T; t += dt) {
    inp.steer += Math.max(-9 * dt, Math.min(9 * dt, steer - inp.steer));   // wie die Tastatur: weich einblenden
    phys.step(dt, inp);
    if (!phys.grounded) air += dt;
    for (const e of phys.events) if (e.type === 'crash') crashed = true;
    phys.events.length = 0;
  }
  const va = Math.atan2(phys.vel.x, -phys.vel.z);
  return { turn: deg(wrap(va - h0)) * Math.sign(steer), v: phys.speed, crashed, skid: phys.skid, air: air / T };
}

const rows = { 'Falllinie': [], 'Quer 45': [], 'Quer 70': [] };
const OFF = { 'Falllinie': 0, 'Quer 45': Math.PI / 4, 'Quer 70': 70 * Math.PI / 180 };
let pts = 0;
for (let k = 0; k < NSEEDS; k++) {
  const seed = 1000 + k * 7919;
  C.setMode(true, seed, 'heli');
  const s = HB.info();
  let rnd = seed;
  const R = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let t = 0, n = 0; t < 4000 && n < 40; t++) {
    const x = -2200 + R() * 4400, d = 300 + R() * (s.DV - 1500);
    const f = fall(x, d);
    if (f.sl < 0.55 || f.sl > 0.95 || HB.nearCliff(x, d, 60)) continue;
    // offener, gleichmäßiger Hang: 40 m in alle Richtungen ähnliche Neigung, keine Geländeform in der Nähe
    let ok = true;
    for (const [ox, od] of [[40, 0], [-40, 0], [0, 40], [0, -40]]) { const g = fall(x + ox, d + od); if (Math.abs(g.sl - f.sl) > 0.2) ok = false; }
    if (!ok || (s.feats || []).some((q) => Math.hypot(q.x - x, q.d - d) < 80)) continue;
    n++; pts++;
    for (const v0 of [12, 20, 28]) for (const name in rows) for (const sg of [1, -1]) rows[name].push({ v0, sl: f.sl, ...trial(x, d, OFF[name] * sg, v0, sg) });
  }
}
console.log(`${pts} Steilhang-Stellen, je 3 Tempi, beide Richtungen`);
for (const name in rows) {
  for (const v0 of [12, 20, 28]) {
    const r = rows[name].filter((q) => q.v0 === v0), tr = r.map((q) => q.turn).sort((a, b) => a - b);
    const ok = r.filter((q) => q.turn >= 20 && !q.crashed).length;
    console.log(`${name.padEnd(10)} ${String(Math.round(v0 * 3.6)).padStart(3)} km/h | Drehung Median ${tr[tr.length >> 1].toFixed(0).padStart(4)} Grad, schlechteste 10 % ${tr[Math.floor(tr.length * 0.1)].toFixed(0).padStart(4)} Grad | gelungen ${ok}/${r.length} | Stürze ${r.filter((q) => q.crashed).length} | Luftanteil ${(r.reduce((a, q) => a + q.air, 0) / r.length * 100).toFixed(0)} % | Tempo danach ${Math.round(r.reduce((a, q) => a + q.v, 0) / r.length * 3.6)} km/h`);
  }
}
