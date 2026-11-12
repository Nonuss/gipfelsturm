// Headless-Validierung: Ein Bot fährt generierte Berge mit der echten Spielphysik ab und misst Landungen, Stürze und Tempo.
// Aufruf:  node tools/piste_validate.mjs [anzahlSeeds] [strecke_m]
import * as C from '../src/course.js';
import * as P from '../src/piste.js';
import { SkiPhysics } from '../src/physics.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const NSEEDS = +(process.argv[2] || 10);
const DIST = +(process.argv[3] || 3200);
const phys = new SkiPhysics();
const clamp = C.clamp;

function runBot(seed, o) {
  C.setMode(true, seed);
  const R = P.report;
  phys.reset(-1);
  phys.events.length = 0;
  const inp = { steer: 0, tuck: o.tuck ? 1 : 0, brake: 0, jump: false };
  const dt = 1 / 120;
  const res = { seed, mode: o.name, reached: 0, time: 0, crashes: [], landings: [], topSpeed: 0, stuck: 0, hits: 0, respawns: 0 };
  let t = 0, slow = 0, lastD = 0, airFrom = 0, started = false;
  phys.vel.set(0, 0, -4.5);
  const feats = [];
  for (const z of P.zonesOf(DIST + 600)) for (const f of z.feats) if (f.kind === 'jump' || f.kind === 'cliff') feats.push(f);
  while (t < 700) {
    const p = phys.pos, d = -p.z;
    if (d >= DIST) break;
    const sp = phys.speed;
    const LA = 14 + sp * 0.8;
    // Spur wählen: bevorzugte Spur, sonst Spur A
    const c = P.props(d + LA);
    let li = o.lane;
    if (c.lw[li] < 2.5 || c.lg[li] < 0.4) li = 0;
    const c0 = P.props(d);
    if (c0.lw[li] < 2.5) li = 0;
    const tx = o.sweep ? c.hub + Math.sin(d / o.sweep) * 105 * Math.min(1, c.valley / 110) : o.off !== undefined ? c.hub + o.off * Math.min(1, c.valley / 100) : c.lx[li];   // off: feste Abstände zur Mittellinie = abseits der Pisten fahren
    const e = Math.atan2(tx - p.x, LA) - phys.heading;
    const want = clamp(e * 3.2, -1, 1);
    inp.steer += clamp(want - inp.steer, -9 * dt, 9 * dt);
    const steepAhead = Math.abs(P.props(d + 30).hub - P.props(d).hub);
    inp.brake = sp > o.vMax ? clamp((sp - o.vMax) / 4, 0, 1) : 0;
    inp.tuck = o.tuck && sp < o.vMax ? 1 : 0;
    void steepAhead;
    const wasG = phys.grounded;
    phys.step(dt, inp);
    if (wasG && !phys.grounded) (res.takeoffs = res.takeoffs || []).push({ d: Math.round(-phys.pos.z), v: +phys.speed.toFixed(1), vy: +phys.vel.y.toFixed(1), x: Math.round(phys.pos.x - P.props(-phys.pos.z).hub) });
    t += dt;
    res.topSpeed = Math.max(res.topSpeed, phys.speed);
    for (const ev of phys.events) {
      if (ev.type === 'land') {
        // Welchem Feature gehört die Landung?
        let near = null;
        for (const f of feats) {
          const d0 = f.kind === 'cliff' ? f.dc : f.d;
          const dl = -phys.pos.z;
          if (dl > d0 - 2 && dl < d0 + (f.kind === 'cliff' ? 110 : f.ext1 + 60) && (!near || d0 > (near.kind === 'cliff' ? near.dc : near.d))) near = f;
        }
        res.landings.push({ d: Math.round(-phys.pos.z), impact: +ev.impact.toFixed(1), air: +ev.airTime.toFixed(2), dist: +ev.dist.toFixed(1), feat: near ? near.name || near.kind : '-', lane: near ? near.lane : -1 });
      } else if (ev.type === 'crash') {
        res.crashes.push({ d: Math.round(-phys.pos.z), speed: +phys.speed.toFixed(1), air: !phys.grounded, lastLand: res.landings.length ? res.landings[res.landings.length - 1] : null });
      } else if (ev.type === 'hit') res.hits++;
      else if (ev.type === 'respawn') {
        res.respawns++;
        const dd = -phys.pos.z;
        const cc = P.props(dd);
        phys.reset(dd, cc.lx[0]);
        inp.steer = 0;
      }
    }
    phys.events.length = 0;
    if (phys.speed < 1.2 && phys.grounded && phys.crashed <= 0) slow += dt; else slow = 0;
    if (slow > 12) { res.stuck++; (res.stuckAt = res.stuckAt || []).push({ d: Math.round(-phys.pos.z), x: Math.round(phys.pos.x - P.props(-phys.pos.z).hub), zone: P.zoneAtD(-phys.pos.z).type, pow: +phys.pow.toFixed(2), sl: +P.props(-phys.pos.z).slope.toFixed(2) }); slow = 0; const dd = -phys.pos.z + 6; phys.reset(dd, P.props(dd).lx[0]); phys.vel.set(0, 0, -4); }
    if (!started && d > 5) started = true;
    lastD = d;
  }
  res.reached = Math.round(lastD);
  res.time = +t.toFixed(1);
  res.issues = R.issues.slice(0, 20);
  res.features = R.features.length;
  res.skipped = R.skipped;
  res.zones = R.zones.slice(0, 40).map((z) => z.type[0].toUpperCase() + Math.round(z.len)).join(' ');
  return res;
}

const OFF = process.argv[4] === 'off';   // Freeride-Test: abseits der Pisten, ohne Bäume (nur Gelände)
const modes = OFF ? [
  { name: 'Frei -85 aufrecht', lane: 0, off: -85, tuck: false, vMax: 24 },
  { name: 'Frei +85 Hocke', lane: 0, off: 85, tuck: true, vMax: 30 },
  { name: 'Frei +40 Hocke', lane: 0, off: 40, tuck: true, vMax: 28 },
  { name: 'Quer-Slalom Hocke', lane: 0, sweep: 140, tuck: true, vMax: 26 },
  { name: 'Quer-Slalom aufrecht', lane: 0, sweep: 90, tuck: false, vMax: 22 },
] : [
  { name: 'Spur A aufrecht', lane: 0, tuck: false, vMax: 24 },
  { name: 'Spur A Hocke', lane: 0, tuck: true, vMax: 30 },
  { name: 'Spur B Hocke', lane: 1, tuck: true, vMax: 28 },
];
const out = [];
const t0 = Date.now();
for (let seed = 1; seed <= NSEEDS; seed++) {
  for (const m of modes) {
    const r = runBot(seed * 7 + 1, m);
    out.push(r);
    const lowImp = r.landings.filter((l) => l.impact > 15).length;
    console.log(`seed ${String(seed * 7 + 1).padStart(3)} | ${m.name.padEnd(16)} | ${String(r.reached).padStart(5)} m | ${String(r.time).padStart(6)} s | Stürze ${r.crashes.length} (Treffer ${r.hits}) | Landungen ${r.landings.length}, hart(>15) ${lowImp} | max ${(r.topSpeed * 3.6).toFixed(0)} km/h | stuck ${r.stuck}`);
  }
}
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs', OFF ? 'validation_offpiste.json' : 'validation_results.json'), JSON.stringify(out, null, 1));
console.log(`fertig in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
