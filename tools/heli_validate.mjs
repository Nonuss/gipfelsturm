// Bot-Test für den Heli-Berg (endlicher Berg vom Gipfel bis ins Tal), mit der echten Spielphysik.
// Aufruf: node tools/heli_validate.mjs [anzahlSeeds]
//  - Hauptlinie (Mittellinie): muss ohne Sturz vom Gipfel ins Ziel führen.
//  - Klippen: jede Klippe wird mit mehreren Anfahrtstempi gesprungen; Aufprall muss unter 23 m/s bleiben (Sturzgrenze).
//  - freie Linien (links/rechts versetzt, pendelnd): Stürze werden gezählt und mit Ort gemeldet.
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';
const HB = C.HB, clamp = C.clamp;
const NSEEDS = +(process.argv[2] || 12);
const phys = new SkiPhysics();

function run(seed, o) {
  C.setMode(true, seed, 'heli');
  for (let i = -1; i < 30; i++) C.genChunk(i);          // Bäume und Felsen als Hindernisse
  const s = HB.info();
  const d0 = o.d0 ?? 7, u0 = o.u0 ?? 0;
  phys.reset(d0, HB.hubX(d0) + u0);
  phys.events.length = 0;
  if (o.v0) phys.vel.set(0, 0, -o.v0);
  const inp = { steer: 0, tuck: 0, brake: 0, jump: false }, dt = 1 / 120;
  const res = { seed, name: o.name, time: 0, crashes: [], maxImpact: 0, top: 0, stuck: 0, finished: false, lands: [] };
  let slow = 0, hitNow = null;
  res.hits = 0;
  for (let t = 0; t < 400; t += dt) {
    const p = phys.pos, d = -p.z;
    if (d >= (o.dEnd ?? s.fin)) { res.finished = true; res.time = t; break; }
    const sp = phys.speed, LA = 14 + sp * 0.8;
    const tu = o.line ? o.line(d + LA) : 0;
    const tx = HB.hubX(d + LA) + tu;
    const e = Math.atan2(tx - p.x, LA) - phys.heading;
    inp.steer += clamp(clamp(e * 3.2, -1, 1) - inp.steer, -9 * dt, 9 * dt);
    inp.brake = sp > o.vMax ? clamp((sp - o.vMax) / 4, 0, 1) : 0;
    inp.tuck = 0;
    phys.step(dt, inp);
    res.top = Math.max(res.top, phys.speed);
    for (const ev of phys.events) {
      if (ev.type === 'land') { res.maxImpact = Math.max(res.maxImpact, ev.impact); if (ev.airTime > 0.5) res.lands.push({ d: Math.round(-p.z), imp: +ev.impact.toFixed(1), air: +ev.airTime.toFixed(1) }); }
      else if (ev.type === 'hit') hitNow = ev.what;
      else if (ev.type === 'crash') { res.crashes.push({ d: Math.round(-p.z), u: Math.round(p.x - HB.hubX(-p.z)), v: +phys.speed.toFixed(0), hit: hitNow }); if (hitNow) res.hits++; hitNow = null; }
      else if (ev.type === 'respawn') { res.time = t; return res; }       // im Spiel: zurück zum Gipfel
    }
    phys.events.length = 0;
    if (phys.speed < 1 && phys.grounded && phys.crashed <= 0) slow += dt; else slow = 0;
    if (slow > 8) { res.stuck++; res.stuckAt = { d: Math.round(d), u: Math.round(p.x - HB.hubX(d)) }; res.time = t; return res; }
  }
  return res;
}

let fail = 0;
const sum = { main: 0, mainCrash: 0, cliffJumps: 0, cliffCrash: 0, maxCliffImpact: 0, free: 0, freeCrash: 0, stuck: 0, times: [] };
for (let k = 0; k < NSEEDS; k++) {
  const seed = 1000 + k * 7919;
  // Hauptlinie mit drei Tempi
  for (const vMax of [16, 24, 34]) {
    const r = run(seed, { name: `haupt${vMax}`, vMax });
    sum.main++;
    if (!r.finished || r.crashes.length) { sum.mainCrash++; fail++; console.log('HAUPTLINIE', seed, vMax, JSON.stringify(r.crashes), r.stuckAt || '', 'fertig', r.finished); }
    else if (vMax === 34) sum.times.push(r.time);
    sum.stuck += r.stuck;
  }
  // jede Klippe einzeln: Anfahrt 60 m oberhalb auf der Bank, verschiedene Tempi
  C.setMode(true, seed, 'heli');
  const cliffs = HB.info().cliffs.map((c) => ({ dc: c.dc, um: c.um, h: c.h, Lup: c.Lup, u0: c.u0, u1: c.u1 }));
  for (const c of cliffs) {
    for (const vMax of [6, 12, 20, 30]) {
      for (const fu of [0.35, 0.65]) {
        const u = c.u0 + (c.u1 - c.u0) * fu;
        const r = run(seed, { name: 'klippe', d0: c.dc - Math.min(c.Lup * 0.8, 60), u0: u, v0: Math.min(vMax, 10), vMax, line: () => u, dEnd: c.dc + 48 });
        sum.cliffJumps++;
        if (r.stuck) { sum.stuck++; console.log('KLIPPE fest', seed, c.dc.toFixed(0), JSON.stringify(r.stuckAt)); }
        const big = r.lands.filter((l) => l.d > c.dc);
        for (const l of big) sum.maxCliffImpact = Math.max(sum.maxCliffImpact, l.imp);
        if (r.crashes.length) { sum.cliffCrash++; fail++; console.log('KLIPPE', seed, `h=${c.h.toFixed(0)} dc=${c.dc.toFixed(0)} u=${u.toFixed(0)} v=${vMax}`, JSON.stringify(r.crashes), JSON.stringify(r.lands)); }
      }
    }
  }
  // freie Linien
  for (const [name, line] of [['links', () => -70], ['rechts', () => 70], ['pendel', (d) => Math.sin(d / 130) * 110], ['weit', (d) => Math.sin(d / 210 + 1) * 190]]) {
    const r = run(seed, { name, vMax: 24, line: (d) => line(d) * clamp((d - 120) / 400, 0, 1) });
    sum.free++;
    if (r.crashes.length && r.crashes.every((c) => c.hit)) { sum.freeHit = (sum.freeHit || 0) + 1; continue; }   // gegen Baum oder Fels gefahren: der Bot weicht nicht aus
    if (r.crashes.length || !r.finished) { sum.freeCrash++; console.log('frei', seed, name, JSON.stringify(r.crashes), r.stuckAt || '', 'max', r.maxImpact.toFixed(1)); }
  }
}
sum.times = sum.times.map((t) => +t.toFixed(1));
console.log(JSON.stringify(sum));
process.exit(fail ? 1 : 0);
