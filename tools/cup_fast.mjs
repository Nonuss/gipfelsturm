// Schnellster fehlerfreier Bot je Rennen (Rennserie und die vier Standardrennen): sucht das höchste Tempolimit, bei dem
// der Bot noch alle Tore trifft und nicht stürzt, Hocke in allen Disziplinen, mehrere Vorausschau-Weiten. Grundlage für
// die Medaillenzeiten (cup.js) und die Legenden-Zeiten (shop.js). Aufruf:  node tools/cup_fast.mjs
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';
import { CUP } from '../src/cup.js';

const clamp = C.clamp;
const LOOK = { sl: 3, gs: 5, sg: 8, dh: 12 };

function run(disc, cup, vMax, lookK, gain) {
  C.setMode(false, 1, 'freeride', disc, cup);
  const phys = new SkiPhysics();
  phys.reset(C.START_D - 1);
  phys.vel.copy(phys.fwd).multiplyScalar(4.5);
  const inp = { steer: 0, tuck: 0, brake: 0, jump: false };
  const dt = 1 / 120, G = C.gates;
  let t = 0, gi = 0, passed = 0, missed = 0, crashes = 0;
  const PTS = G.map((g, k) => { const n = G[k + 1]; const inner = n ? Math.sign(n.x - g.x) : 0; return { d: g.d, x: g.x + inner * g.half * 0.45 }; });
  while (t < 400) {
    const p = phys.pos, d = -p.z;
    if (d >= C.FINISH_D) break;
    while (gi < G.length && d >= G[gi].d) { if (Math.abs(p.x - G[gi].x) < G[gi].half + 0.25) passed++; else missed++; gi++; }
    if (missed) break;
    const LA = LOOK[disc] * lookK + phys.speed * 0.32, dT = d + LA;
    let tx = C.centerX(dT);
    for (let k = Math.max(0, gi - 1); k < G.length; k++) {
      if (G[k].d >= dT) { const a = k > 0 ? PTS[k - 1] : { d: C.START_D, x: C.centerX(C.START_D) }, b = PTS[k]; tx = a.x + (b.x - a.x) * clamp((dT - a.d) / Math.max(1, b.d - a.d), 0, 1); break; }
    }
    const e = Math.atan2(tx - p.x, LA) - phys.heading;
    inp.steer += clamp(clamp(e * gain, -1, 1) - inp.steer, -9 * dt, 9 * dt);
    inp.brake = phys.speed > vMax ? clamp((phys.speed - vMax) / 3, 0, 1) : 0;
    inp.tuck = phys.speed < vMax - 1 && Math.abs(inp.steer) < 0.35 ? 1 : 0;
    phys.step(dt, inp);
    for (const ev of phys.events) if (ev.type === 'crash') crashes++;
    phys.events.length = 0;
    if (crashes) break;
    t += dt;
  }
  const ok = !missed && !crashes && -phys.pos.z >= C.FINISH_D;
  return { ok, time: t };
}
function best(disc, cup) {
  let b = Infinity, how = '';
  for (const lookK of [0.7, 1, 1.4]) for (const gain of [2.6, 3.4, 4.5]) for (let v = 8; v <= 46; v += 1) {
    const r = run(disc, cup, v, lookK, gain);
    if (r.ok && r.time < b) { b = r.time; how = `v${v} look${lookK} gain${gain}`; }
  }
  return { t: b, how };
}
const out = {};
for (const disc of C.DISC_ORDER) { const r = best(disc, null); out['std_' + disc] = r; console.log(`Standard ${disc}: ${r.t.toFixed(1)} s (${r.how})`); }
for (const cup of CUP) { const r = best(cup.disc, cup); out[cup.id] = r; console.log(`${cup.name.padEnd(18)} ${cup.disc}: ${r.t.toFixed(1)} s (${r.how})`); }
console.log('\nFAST = ' + JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, +v.t.toFixed(1)]))));
