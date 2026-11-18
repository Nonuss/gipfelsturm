// Kommt man durch den Heli-Wald? Ein Testfahrer, der Bäumen ausweicht (wie ein Spieler: schaut voraus und wählt die
// freieste Richtung nahe der Falllinie), fährt mit den echten Baum- und Fels-Kollisionen 400 m durch bewaldete Hänge.
// Aufruf: node tools/heli_forest_bot.mjs [anzahlBerge]
// Gezählt: Fahrten ohne Sturz, Stürze an Bäumen, zwei Tempi (bis 58 und bis 80 km/h).
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';
const HB = C.HB, clamp = C.clamp;
const NSEEDS = +(process.argv[2] || 3);
const phys = new SkiPhysics();
const T = 100;
let built = new Set();
function ensureTiles(x, d) {
  const ti = Math.floor(x / T), tj = Math.floor(d / T);
  for (let i = ti - 1; i <= ti + 1; i++) for (let j = tj - 1; j <= tj + 1; j++) {
    const k = i + ',' + j;
    if (built.has(k)) continue;
    built.add(k);
    HB.genTile(i, j, T, 1, C.addCollider, (x, z, y, sc, rot, v) => C.addRockCollider(C.addCollider, x, z, y, sc, rot, v));
  }
}
function fallDir(x, d, R = 20) {
  const e = 6; let gx = 0, gd = 0;
  for (const [ox, od] of [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R]]) { gx += HB.heightDU(d + od, x + ox + e) - HB.heightDU(d + od, x + ox - e); gd += HB.heightDU(d + od + e, x + ox) - HB.heightDU(d + od - e, x + ox); }
  const l = Math.hypot(gx, gd) || 1; return [-gx / l, -gd / l];
}
/** freie Strecke entlang Richtung a (Winkel wie heading) bis zu L Meter */
function clearAlong(x, d, a, L) {
  const fx = Math.sin(a), fd = Math.cos(a);
  for (let s = 2; s <= L; s += 1.5) {
    const px = x + fx * s, pd = d + fd * s;
    let hit = false;
    C.nearColliders(-pd, (c) => { if (!hit && Math.hypot(c.x - px, c.z + pd) < c.r + 0.9) hit = true; }, px);
    if (hit) return s;
  }
  return L;
}
function run(x0, d0, vMax) {
  phys.reset(d0, x0); phys.events.length = 0;
  const [fx, fd] = fallDir(x0, d0); phys.heading = Math.atan2(fx, fd);
  const inp = { steer: 0, tuck: 0, brake: 0, jump: false }, dt = 1 / 120;
  let tree = false, other = false, plan = phys.heading, k = 0;
  for (let t = 0; t < 120; t += dt) {
    const x = phys.pos.x, d = -phys.pos.z;
    if (Math.hypot(x - x0, d - d0) > 400 || HB.finished(x, d)) return { ok: true };
    ensureTiles(x, d);
    const sp = phys.speed;
    if (k++ % 6 === 0) {   // 20-mal pro Sekunde neu entscheiden, wie ein Spieler
      const [gx, gd] = fallDir(x, d), want = Math.atan2(gx, gd), L = Math.max(14, sp * 1.7);
      let best = want, bestSc = -1e9;
      for (let i = -8; i <= 8; i++) {
        const a = want + i * 0.11, cl = clearAlong(x, d, a, L);
        const sc = cl - Math.abs(i) * 0.9 - Math.abs(a - plan) * 2;
        if (sc > bestSc) { bestSc = sc; best = a; }
      }
      plan = best;
    }
    let e = plan - phys.heading; e = Math.atan2(Math.sin(e), Math.cos(e));
    inp.steer += clamp(clamp(e * 3, -1, 1) - inp.steer, -10 * dt, 10 * dt);
    inp.brake = sp > vMax ? clamp((sp - vMax) / 3, 0, 1) : 0;
    phys.step(dt, inp);
    for (const ev of phys.events) { if (ev.type === 'hit') { if (ev.what === 'baum') tree = true; else other = ev.what; } if (ev.type === 'crash') return { ok: false, tree, other }; }
    phys.events.length = 0;
  }
  return { ok: true };
}
const res = {};
for (let k = 0; k < NSEEDS; k++) {
  const seed = 1000 + k * 7919;
  C.setMode(true, seed, 'heli');
  built = new Set();
  const s = HB.info();
  let rnd = seed + 99;
  const R = () => ((rnd = (rnd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const starts = [];
  for (let t = 0; t < 30000 && starts.length < 25; t++) {
    const x = -2600 + R() * 5200, d = 300 + R() * (s.DV - 900);
    if (HB.forestAt(x, d) < 0.6 || HB.slopeAt(x, d) < 0.25 || HB.nearCliff(x, d, 80)) continue;
    starts.push([x, d]);
  }
  for (const vMax of [16, 22]) for (const [x, d] of starts) {
    const r = run(x, d, vMax), key = `bis ${Math.round(vMax * 3.6)} km/h`;
    res[key] = res[key] || { fahrten: 0, durch: 0, baum: 0, anderes: 0 };
    res[key].fahrten++; if (r.ok) res[key].durch++; else if (r.tree) res[key].baum++; else res[key].anderes++;
  }
}
console.log('400 m durch bewaldete Hänge, Testfahrer weicht aus:');
for (const k in res) console.log(`${k}: ${res[k].durch} von ${res[k].fahrten} ohne Sturz, Baum ${res[k].baum}, anderes ${res[k].anderes}`);
