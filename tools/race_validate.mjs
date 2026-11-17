// Bot-Test für die Renn-Disziplinen: Ein Bot fährt jede Disziplin mit der echten Spielphysik durch die Tore.
// Gemessen: getroffene Tore, Stürze, Zeit, Höchsttempo. Je Disziplin drei Fahrstile (vorsichtig, mittel, schnell).
// Aufruf:  node tools/race_validate.mjs
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';

const clamp = C.clamp;
// Tempo-Obergrenzen je Disziplin und Fahrstil (m/s)
const VMAX = { sl: [9, 10.5, 12], gs: [14, 16, 18], sg: [22, 26, 30], dh: [28, 34, 99] };
const LOOK = { sl: 3, gs: 5, sg: 8, dh: 12 };

function run(disc, style) {
  C.setMode(false, 1, 'freeride', disc);
  const phys = new SkiPhysics();
  phys.reset(C.START_D - 1);
  phys.vel.copy(phys.fwd).multiplyScalar(4.5);
  const inp = { steer: 0, tuck: 0, brake: 0, jump: false };
  const dt = 1 / 120, vMax = VMAX[disc][style];
  let t = 0, gi = 0, passed = 0, missed = [], crashes = 0, top = 0, minMargin = 9;
  const G = C.gates;
  // Zielpunkte: etwas innerhalb des Tors (Richtung nächstes Tor), damit die Linie früh dreht
  const PTS = G.map((g, k) => { const n = G[k + 1]; const inner = n ? Math.sign(n.x - g.x) : 0; return { d: g.d, x: g.x + inner * g.half * 0.45 }; });
  while (t < 400) {
    const p = phys.pos, d = -p.z;
    if (d >= C.FINISH_D) break;
    // Torprüfung wie im Spiel (main.js checkGates)
    while (gi < G.length && d >= G[gi].d) {
      const g = G[gi], off = Math.abs(p.x - g.x);
      if (off < g.half + 0.25) { passed++; minMargin = Math.min(minMargin, g.half - off); } else missed.push(Math.round(g.d));
      gi++;
    }
    // Ideallinie: Linienzug durch die Torinnenseiten (wie ein Rennfahrer, der vor dem Tor schon andreht);
    // gelenkt wird auf einen Punkt in Vorausschau-Entfernung auf diesem Linienzug
    const LA = LOOK[disc] + phys.speed * 0.32;
    const dT = d + LA;
    let tx = C.centerX(dT);
    for (let k = Math.max(0, gi - 1); k < G.length; k++) {
      if (G[k].d >= dT) {
        const a = k > 0 ? PTS[k - 1] : { d: C.START_D, x: C.centerX(C.START_D) }, b = PTS[k];
        tx = a.x + (b.x - a.x) * clamp((dT - a.d) / Math.max(1, b.d - a.d), 0, 1);
        break;
      }
    }
    const e = Math.atan2(tx - p.x, LA) - phys.heading;
    const want = clamp(e * 3.4, -1, 1);
    inp.steer += clamp(want - inp.steer, -9 * dt, 9 * dt);
    inp.brake = phys.speed > vMax ? clamp((phys.speed - vMax) / 3, 0, 1) : 0;
    inp.tuck = disc === 'dh' || disc === 'sg' ? (phys.speed < vMax - 2 && Math.abs(inp.steer) < 0.3 ? 1 : 0) : 0;
    phys.step(dt, inp);
    for (const ev of phys.events) if (ev.type === 'crash') crashes++;
    phys.events.length = 0;
    top = Math.max(top, phys.speed);
    t += dt;
  }
  return { disc, style, time: +t.toFixed(1), gates: G.length, passed, missed, crashes, top: Math.round(top * 3.6), minMargin: +minMargin.toFixed(2), len: C.FINISH_D - C.START_D, drop: Math.round(C.baseH(C.START_D) - C.baseH(C.FINISH_D)) };
}

let bad = 0;
for (const disc of C.DISC_ORDER) {
  for (let s = 0; s < 3; s++) {
    const r = run(disc, s);
    if (r.missed.length || r.crashes) bad++;
    console.log(`${C.DISCIPLINES[disc].name.padEnd(14)} Stil ${s}  ${r.len} m, ${r.drop} Hm, ${r.gates} Tore  ->  ${r.passed} getroffen, verpasst ${r.missed.length ? r.missed.join(',') : '-'}, Stürze ${r.crashes}, Zeit ${r.time} s, max ${r.top} km/h, knappster Abstand ${r.minMargin} m`);
  }
}
console.log(bad ? `\n${bad} Fahrten mit Fehlern` : '\nAlle Fahrten fehlerfrei');
