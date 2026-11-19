// Bot-Test für das Heli-Gebirge (Gipfel bis Tal), mit der echten Spielphysik und den Hindernissen der Kacheln.
// Aufruf: node tools/heli_validate.mjs [anzahlBerge]
//  - Falllinie: der Bot fährt vom Absprungpunkt der steilsten Richtung nach (geglättet), mit verschiedenen
//    Querneigungen (gerade, leicht links, leicht rechts, pendelnd). Erwartet: Ziel im Tal, kein Steckenbleiben.
//  - Klippen: jede Klippe einzeln mit vier Tempi an zwei Stellen; Aufprall muss unter der Sturzgrenze (23 m/s) bleiben.
//  Stürze an Bäumen und Felsen werden getrennt gezählt (der Bot weicht nicht aus).
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';
const HB = C.HB, clamp = C.clamp;
const NSEEDS = +(process.argv[2] || 6);
const NOOBST = process.argv.includes('ohne');   // ohne Bäume und Felsen: prüft nur das Gelände
const phys = new SkiPhysics();
const T = 100;
let built = new Set();
function ensureTiles(x, d) {
  const ti = Math.floor(x / T), tj = Math.floor(d / T);
  for (let i = ti - 1; i <= ti + 1; i++) for (let j = tj - 1; j <= tj + 1; j++) {
    const k = i + ',' + j;
    if (built.has(k)) continue;
    built.add(k);
    if (!NOOBST) HB.genTile(i, j, T, 1, C.addCollider, (x, z, y, sc, rot, v) => C.addRockCollider(C.addCollider, x, z, y, sc, rot, v));
  }
}
function fallDir(x, d, R = 25) {
  const e = 6;
  let gx = 0, gd = 0;
  for (const [ox, od] of [[0, 0], [R, 0], [-R, 0], [0, R], [0, -R]]) {
    gx += HB.heightDU(d + od, x + ox + e) - HB.heightDU(d + od, x + ox - e);
    gd += HB.heightDU(d + od + e, x + ox) - HB.heightDU(d + od - e, x + ox);
  }
  const l = Math.hypot(gx, gd) || 1;
  return [-gx / l, -gd / l];
}

function run(seed, o) {
  const p = phys.pos;
  const dp = o.start || HB.dropPoint();
  phys.reset(dp.d, dp.x);
  phys.events.length = 0;
  if (o.v0) { const [fx, fd] = fallDir(dp.x, dp.d); phys.vel.set(fx * o.v0, 0, -fd * o.v0); phys.heading = Math.atan2(fx, fd); }
  const inp = { steer: 0, tuck: 0, brake: 0, jump: false }, dt = 1 / 120;
  const res = { time: 0, crashes: [], hits: [], lands: [], maxImpact: 0, top: 0, finished: false, stuck: null };
  let slow = 0;
  for (let t = 0; t < 600; t += dt) {
    const x = p.x, d = -p.z;
    if (o.until ? o.until(x, d) : HB.finished(x, d)) { res.finished = true; res.time = t; break; }
    ensureTiles(x, d);
    const sp = phys.speed, LA = 10 + sp * 0.7;
    // im Stand oder sehr langsam: wie ein Spieler zur örtlichen Falllinie drehen (die Kante hält einen sonst quer am Hang)
    let [fx, fd] = sp < 2.5 ? fallDir(x, d, 4) : fallDir(x + Math.sin(phys.heading) * LA, d + Math.cos(phys.heading) * LA);
    const bias = o.bias ? o.bias(t, d) : 0;
    if (o.line) { const tx = o.line(d + LA); fx = (tx - x); fd = LA; }
    const want = Math.atan2(fx, fd) + bias;
    let e = want - phys.heading; e = Math.atan2(Math.sin(e), Math.cos(e));
    inp.steer += clamp(clamp(e * 2.6, -1, 1) - inp.steer, -9 * dt, 9 * dt);
    inp.brake = sp > o.vMax ? clamp((sp - o.vMax) / 4, 0, 1) : 0;
    phys.step(dt, inp);
    res.top = Math.max(res.top, phys.speed);
    for (const ev of phys.events) {
      if (ev.type === 'land') { res.maxImpact = Math.max(res.maxImpact, ev.impact); if (ev.airTime > 0.5) res.lands.push({ d: Math.round(-p.z), imp: +ev.impact.toFixed(1) }); }
      else if (ev.type === 'hit') res.hits.push(ev.what);
      else if (ev.type === 'crash') res.crashes.push({ x: Math.round(p.x), d: Math.round(-p.z), v: Math.round(phys.speed), hit: res.hits.length ? res.hits[res.hits.length - 1] : null });
      else if (ev.type === 'respawn') { res.time = t; return res; }
    }
    phys.events.length = 0;
    if (phys.speed < 1.2 && phys.grounded && phys.crashed <= 0) slow += dt; else slow = 0;
    if (slow > 8) { res.stuck = { x: Math.round(p.x), d: Math.round(-p.z) }; res.time = t; return res; }
  }
  return res;
}

const sum = { berge: 0, fahrten: 0, ziel: 0, geländeStürze: 0, hindernis: 0, stecken: 0, zeiten: [], topKmh: 0, klippen: 0, klippenSprünge: 0, klippenStürze: 0, maxKlippenAufprall: 0, genMs: [] };
let fail = 0;
for (let k = 0; k < NSEEDS; k++) {
  const seed = 1000 + k * 7919;
  C.setMode(true, seed, 'heli');
  built = new Set();
  const s = HB.info();
  sum.berge++; sum.genMs.push(s.tAll);
  const lines = [
    ['gerade', { vMax: 30 }],
    ['links', { vMax: 30, bias: () => -0.35 }],
    ['rechts', { vMax: 30, bias: () => 0.35 }],
    ['pendel', { vMax: 26, bias: (t) => 0.55 * Math.sin(t / 5) }],
    ['langsam', { vMax: 16, bias: (t) => 0.4 * Math.sin(t / 7 + 1) }],
  ];
  for (const [name, o] of lines) {
    const r = run(seed, o);
    sum.fahrten++;
    sum.topKmh = Math.max(sum.topKmh, Math.round(r.top * 3.6));
    const terr = r.crashes.filter((c) => !c.hit), obst = r.crashes.filter((c) => c.hit);
    if (r.finished && !r.crashes.length) { sum.ziel++; sum.zeiten.push(Math.round(r.time)); }
    sum.hindernis += obst.length;
    if (terr.length) { sum.geländeStürze += terr.length; fail++; console.log('GELÄNDE-STURZ', seed, name, JSON.stringify(terr), 'Landungen', JSON.stringify(r.lands.slice(-3))); }
    if (r.stuck) { sum.stecken++; fail++; console.log('STECKT', seed, name, JSON.stringify(r.stuck)); }
    if (obst.length) console.log('hindernis', seed, name, JSON.stringify(obst));
    if (!r.finished && !r.stuck && !r.crashes.length) console.log('ZEIT', seed, name, 'bei', Math.round(phys.pos.x), Math.round(-phys.pos.z), 'Höhe über Tal', Math.round(phys.pos.y - HB.floorY(phys.pos.x, -phys.pos.z)), 'v', phys.speed.toFixed(1));
  }
  // Von jedem wählbaren Absprungpunkt (Grate, Couloir, Klippenband) ins Tal
  for (const dp of HB.dropPoints().slice(1)) {
    for (const [name, o] of [['gerade', { vMax: 28 }], ['leicht pendelnd', { vMax: 24, bias: (t) => 0.25 * Math.sin(t / 6) }]]) {
      built = new Set();
      const r = run(seed, { ...o, start: { x: dp.x, d: dp.d }, v0: 3 });
      sum.fahrten++; sum.absprung = (sum.absprung || 0) + 1;
      const terr = r.crashes.filter((c) => !c.hit);
      if (r.finished && !r.crashes.length) { sum.ziel++; sum.zeiten.push(Math.round(r.time)); }
      if (terr.length) { sum.geländeStürze += terr.length; fail++; console.log('ABSPRUNG-STURZ', seed, dp.name, name, JSON.stringify(terr), JSON.stringify(r.lands.slice(-3))); }
      if (r.stuck) { sum.stecken++; fail++; console.log('ABSPRUNG-STECKT', seed, dp.name, name, JSON.stringify(r.stuck)); }
      if (!r.finished && !r.stuck && !r.crashes.length) console.log('ABSPRUNG-ZEIT', seed, dp.name, name);
    }
  }
  console.log('Absprungpunkte', seed, HB.dropPoints().map((q) => `${q.name} (${Math.round(q.x)}/${Math.round(q.d)}, Schwierigkeit ${q.diff}, Gefälle ${q.slope}, Klippen ${q.cliffs})`).join(' | '));
  // Klippen einzeln
  for (const c of s.cliffs) {
    sum.klippen++;
    for (const v of [6, 12, 20, 28]) for (const fu of [-0.2, 0.2]) {
      const u = (c.u1 - c.u0) * fu, a = HB.cliffPoint(c, -Math.min(c.Lup * 0.7, 45), u), b = HB.cliffPoint(c, 60, u);
      built = new Set();
      const r = run(seed, { start: { x: a.x, d: a.d }, v0: Math.min(v, 10), vMax: v,
        line: (dd) => a.x + (b.x - a.x) * clamp((dd - a.d) / (b.d - a.d || 1), 0, 1),
        until: (x, d) => (x - a.x) * c.fx + (d - a.d) * c.fd > Math.min(c.Lup * 0.7, 45) + 55 });
      sum.klippenSprünge++;
      for (const l of r.lands) sum.maxKlippenAufprall = Math.max(sum.maxKlippenAufprall, l.imp);
      const terr = r.crashes.filter((x) => !x.hit);
      if (terr.length) { sum.klippenStürze++; fail++; console.log('KLIPPE', seed, `h=${c.h.toFixed(0)} v=${v}`, JSON.stringify(terr), JSON.stringify(r.lands)); }
    }
  }
}
console.log(JSON.stringify(sum));
process.exit(fail ? 1 : 0);
