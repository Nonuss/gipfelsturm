// Rails und Boxen im Freestyle: Testfahrer fährt jede Rail und Box mit wechselnder A/D-Eingabe (wie wildes Drehen und
// Lehnen) und mit losgelassener Eingabe. Gezählt wird, wie oft er vor dem Ende herunterfällt.
// Aufruf: node tools/rail_test.mjs [anzahlSeeds]
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';
const N = +(process.argv[2] || 5);
const phys = new SkiPhysics();
const sum = { rails: 0, fahrten: 0, bisEnde: 0, abgesprungen: 0, abgerutscht: 0, stehen: 0 };
for (let k = 0; k < N; k++) {
  C.setMode(true, 40 + k * 7, 'freestyle');
  const seen = new Set();
  for (let d = 50; d < 3000; d += 20) C.nearRails(-d, (g) => { if (!seen.has(g)) seen.add(g); });
  for (const g of seen) {
    sum.rails++;
    for (const mode of ['still', 'wild', 'links']) {
      phys.reset(1);
      phys.grind = null; phys.grindCool = 0;
      const va = 9 + Math.random() * 4;
      phys.pos.set(g.ax, g.ay + 0.05, g.az);
      phys.vel.set(g.dx * va, g.dy * va, g.dz * va);
      phys.grounded = false;
      const inp = { steer: 0, tuck: 0, brake: 0, jump: false };
      let started = false, end = null;
      for (let t = 0; t < 10 && !end; t += 1 / 120) {
        inp.steer = mode === 'wild' ? Math.sign(Math.sin(t * 9)) : mode === 'links' ? -1 : 0;
        phys.step(1 / 120, inp);
        for (const e of phys.events) { if (e.type === 'grindStart') started = true; if (e.type === 'grindEnd') end = e; }
        phys.events.length = 0;
      }
      if (!started) continue;
      sum.fahrten++;
      if (!end) continue;
      if (!end.clean) sum.abgerutscht++; else if (end.dist >= g.L - 1) sum.bisEnde++; else sum.stehen++;
    }
  }
}
console.log(JSON.stringify(sum));
