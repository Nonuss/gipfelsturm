// Ränder der Klippen-Bänke und Windlippen im Heli-Gebirge: seitlich und schräg anfahren.
// Aufruf: node tools/heli_edges.mjs [anzahlBerge]
// Gezählt wird, wie oft der Fahrer an einer Wand steiler als 60 Grad hinauffährt (Glitch durch die Felswand der Bank),
// wie oft er in einem Rechenschritt um mehr als 0,5 m nach oben springt, wie oft er unter die Oberfläche gerät und stürzt.
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';
const HB = C.HB;
const NSEEDS = +(process.argv[2] || 3);
const phys = new SkiPhysics();
const sum = { fahrten: 0, hochsprung: 0, fahrtenMitSprung: 0, wandfahrt: 0, maxWandHoehe: 0, unterBoden: 0, stuerze: 0, wand: 0, maxSprung: 0 };
const ex = [];
function drive(x, d, hx, hd, v0, steer = 0) {
  phys.reset(d, x);
  phys.events.length = 0;
  phys.heading = Math.atan2(hx, hd);
  const n = phys.normal; C.terrainNormal(x, -d, n);
  phys.vel.set(hx, 0, -hd);
  phys.vel.addScaledVector(n, -phys.vel.dot(n)).normalize().multiplyScalar(v0);
  const inp = { steer, tuck: 0, brake: 0, jump: false }, dt = 1 / 120;
  let jumps = 0, under = 0, crash = false, wall = false, maxJ = 0, wallT = 0, wallH = 0;
  for (let t = 0; t < 4; t += dt) {
    const y0 = phys.pos.y, g0 = phys.grounded;
    phys.step(dt, inp);
    const dy = phys.pos.y - y0;
    if (g0 && phys.grounded && dy > 0.5) { jumps++; maxJ = Math.max(maxJ, dy); }
    // an einer Wand steiler als 60 Grad fahren (am Boden): das ist der Glitch durch die Felswand
    // gezählt wird nur der Höhengewinn in Schritten, in denen man auf der Wand steht
    if (phys.grounded && phys.normal.y < 0.5) { wallT += dt; if (dy > 0) wallH += dy; }
    if (phys.pos.y < C.height(phys.pos.x, phys.pos.z) - 0.3) under++;
    for (const e of phys.events) { if (e.type === 'crash') crash = true; if (e.type === 'hit' && e.what === 'wand') wall = true; }
    phys.events.length = 0;
    if (crash) break;
  }
  sum.fahrten++; sum.hochsprung += jumps; if (jumps) sum.fahrtenMitSprung++; sum.unterBoden += under ? 1 : 0; if (crash) sum.stuerze++; if (wall) sum.wand++;
  sum.maxSprung = Math.max(sum.maxSprung, maxJ);
  if (wallT > 0.1 && wallH > 0.5) { sum.wandfahrt++; sum.maxWandHoehe = Math.max(sum.maxWandHoehe, +wallH.toFixed(1)); if (ex.length < 6) ex.push({ x: Math.round(x), d: Math.round(d), v0, wandHoch: +wallH.toFixed(1) }); }
  if (jumps && ex.length < 6) ex.push({ x: Math.round(x), d: Math.round(d), v0, sprung: +maxJ.toFixed(1) });
}
for (let k = 0; k < NSEEDS; k++) {
  const seed = 1000 + k * 7919;
  C.setMode(true, seed, 'heli');
  const s = HB.info();
  for (const c of s.cliffs) {
    // seitlich: quer zur Falllinie auf die Seite der Bank zu, an mehreren Stellen hinter der Kante
    for (const t of [4, 12, 25, 45]) {
      if (t > c.Lup * 0.8) continue;
      for (const side of [-1, 1]) {
        const u = (side < 0 ? c.u0 : c.u1) + side * 26;
        const p = HB.cliffPoint(c, -t, u);
        for (const v0 of [6, 14, 24]) {
          drive(p.x, p.d, -side * c.ax, -side * c.ad, v0);                                                  // genau quer
          drive(p.x, p.d, -side * c.ax * 0.7 + c.fx * 0.7, -side * c.ad * 0.7 + c.fd * 0.7, v0);              // schräg talwärts
        }
      }
    }
  }
  for (const f of s.feats || []) {
    if (f.k !== 'kick') continue;
    for (const side of [-1, 1]) for (const al of [-f.L * 0.6, -2]) {
      const u = side * (f.w + 20), x = f.x + f.fx * al + f.ax * u, d = f.d + f.fd * al + f.ad * u;
      for (const v0 of [8, 16, 26]) drive(x, d, -side * f.ax * 0.8 + f.fx * 0.6, -side * f.ad * 0.8 + f.fd * 0.6, v0);
    }
  }
}
console.log(JSON.stringify(sum));
if (ex.length) console.log('Beispiele', JSON.stringify(ex));
