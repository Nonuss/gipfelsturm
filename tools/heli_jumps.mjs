// Gerade über die großen Sprünge des Heli-Bergs fahren: Windlippen (Kicker) und Klippen-Bänke, in der Mitte und nahe
// am Rand, mit mehreren Tempi, ohne Lenken. Gezählt werden Stürze und ihr Grund (Wand, harte Landung, sonstiges).
// Aufruf: node tools/heli_jumps.mjs [anzahlBerge] [mit]   (mit = mit Felswänden, Felsen und Bäumen der Kacheln)
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';
const HB = C.HB;
const NSEEDS = +(process.argv[2] || 3);
const phys = new SkiPhysics();
const WITH = process.argv.includes('mit');   // mit den Kollisionen der Kacheln (Felswände, Felsen, Bäume)
const T = 100; let built = new Set();
function ensureTiles(x, d) {
  if (!WITH) return;
  const ti = Math.floor(x / T), tj = Math.floor(d / T);
  for (let i = ti - 1; i <= ti + 1; i++) for (let j = tj - 1; j <= tj + 1; j++) {
    const k = i + ',' + j; if (built.has(k)) continue; built.add(k);
    HB.genTile(i, j, T, 1, C.addCollider, (x, z, y, sc, rot, v) => C.addRockCollider(C.addCollider, x, z, y, sc, rot, v));
  }
}
const sum = {};
const ex = [];
function drive(kind, x, d, fx, fd, v0, maxT) {
  phys.reset(d, x); phys.events.length = 0;
  phys.heading = Math.atan2(fx, fd);
  const n = phys.normal; C.terrainNormal(x, -d, n);
  phys.vel.set(fx, 0, -fd); phys.vel.addScaledVector(n, -phys.vel.dot(n)).normalize().multiplyScalar(v0);
  const inp = { steer: 0, tuck: 0, brake: 0, jump: false };
  let why = null, maxImp = 0;
  for (let t = 0; t < maxT; t += 1 / 120) {
    // geradeaus halten (Lenken nur gegen das Wegdrehen, wie ein Spieler, der gerade fährt)
    let e = Math.atan2(fx, fd) - phys.heading; e = Math.atan2(Math.sin(e), Math.cos(e));
    inp.steer = Math.max(-1, Math.min(1, e * 2));
    ensureTiles(phys.pos.x, -phys.pos.z);
    phys.step(1 / 120, inp);
    for (const ev of phys.events) {
      if (ev.type === 'land') maxImp = Math.max(maxImp, ev.impact);
      if (ev.type === 'hit') why = why || ev.what;
      if (ev.type === 'crash') { why = why || (maxImp > 23 ? 'harte Landung' : 'sonst'); }
    }
    const crashed = phys.events.some((q) => q.type === 'crash');
    phys.events.length = 0;
    if (crashed) break;
  }
  const k = sum[kind] = sum[kind] || { fahrten: 0, stuerze: 0, gruende: {} };
  k.fahrten++;
  if (why) { k.stuerze++; k.gruende[why] = (k.gruende[why] || 0) + 1; if (ex.length < 40) ex.push({ kind, seed: C.cfg.seed, x: Math.round(x), d: Math.round(d), v0, why, imp: +maxImp.toFixed(1) }); }
}
for (let k = 0; k < NSEEDS; k++) {
  const seed = 1000 + k * 7919;
  C.setMode(true, seed, 'heli');
  built = new Set();
  const s = HB.info();
  for (const f of s.feats) {
    if (f.k !== 'kick') continue;
    for (const fu of [0, 0.5, 0.85, 1.0]) for (const sg of [-1, 1]) for (const v0 of [10, 18, 26, 34, 40]) for (const ang of [0, 0.3]) {
      const u = sg * fu * f.w, al = -f.L - 25, c = Math.cos(ang * sg), sn = Math.sin(ang * sg);
      drive('Windlippe', f.x + f.fx * al + f.ax * u, f.d + f.fd * al + f.ad * u, f.fx * c - f.fd * sn, f.fx * sn + f.fd * c, v0, 5);
    }
  }
  for (const c of s.cliffs) {
    for (const fu of [0, 0.35, 0.47]) for (const sg of [-1, 1]) for (const v0 of [10, 20, 30, 36, 42]) for (const ang of [0, 0.3]) {
      const u = (sg < 0 ? c.u0 : c.u1) * fu * 2, p = HB.cliffPoint(c, -Math.min(c.Lup * 0.6, 40), u), cs = Math.cos(ang * sg), sn = Math.sin(ang * sg);
      drive('Klippen-Bank', p.x, p.d, c.fx * cs - c.fd * sn, c.fx * sn + c.fd * cs, v0, 6);
    }
  }
}
console.log(JSON.stringify(sum));
console.log(JSON.stringify(ex));
