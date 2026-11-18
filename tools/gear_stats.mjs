// Wirken die Ski- und Brett-Werte aus dem Shop in der Physik? Für jedes Teil mit der echten Spielphysik gemessen:
//  - Tempo: Endtempo in der Hocke auf der Rennpiste (Abfahrt, gerade Linie zur Mitte, 1200 m)
//  - Wendigkeit und Kante: kleinster Kurvenradius bei 54 km/h auf hartem Schnee (volle Lenkung, 3 s)
//  - Pulver: Bremswirkung im Tiefschnee bei 72 km/h (m/s², kleiner = gleitet besser); Heli-Berg, mit POW=freeride
//    im Freeride-Pulver neben der Piste
//  - Butter: Tempoverlust bei einer Butter-Drehung über 1 s (quer zur Fahrt, 54 km/h)
// Aufruf: node tools/gear_stats.mjs
import * as C from '../src/course.js';
import { SkiPhysics } from '../src/physics.js';
import { SKIS, BOARDS, statMul } from '../src/gear.js';
const phys = new SkiPhysics();
const dt = 1 / 120;

function topSpeed() {
  C.setMode(false, 1, 'race', 'dh');
  phys.reset(C.START_D + 5);
  phys.vel.set(0, 0, -8);
  const inp = { steer: 0, tuck: 1, brake: 0, jump: false };
  let top = 0;
  for (let t = 0; t < 120 && -phys.pos.z < C.START_D + 1200; t += dt) {
    const d = -phys.pos.z, tx = C.centerX(d + 25), e = Math.atan2(tx - phys.pos.x, 25) - phys.heading;
    inp.steer = Math.max(-1, Math.min(1, e * 3));
    phys.step(dt, inp); phys.events.length = 0;
    top = Math.max(top, phys.speed);
  }
  return top * 3.6;
}
function turnRadius() {
  C.setMode(false, 1, 'race', 'sg');
  phys.reset(C.START_D + 40);
  const n = phys.normal; C.terrainNormal(phys.pos.x, phys.pos.z, n);
  phys.vel.set(Math.sin(phys.heading), 0, -Math.cos(phys.heading)); phys.vel.addScaledVector(n, -phys.vel.dot(n)).normalize().multiplyScalar(15);
  let minR = 1e9, h0 = Math.atan2(phys.vel.x, -phys.vel.z), a0 = h0;
  for (let t = 0; t < 1.2; t += dt) {
    phys.step(dt, { steer: 1, tuck: 0, brake: 0, jump: false }); phys.events.length = 0;
    phys.vel.multiplyScalar(15 / Math.max(1, phys.speed));   // Tempo konstant halten: nur der Radius zählt
    const a = Math.atan2(phys.vel.x, -phys.vel.z), da = Math.abs(Math.atan2(Math.sin(a - a0), Math.cos(a - a0)));
    if (da > 1e-4) minR = Math.min(minR, 15 * dt / da);
    a0 = a;
  }
  return minR;
}
function powderSpeed() {
  // Bremswirkung des Tiefschnees: an 30 festen Stellen im Heli-Pulver je einen Rechenschritt mit 72 km/h in der
  // Falllinie, Tempoänderung gemittelt (ohne Hangabtrieb: der ist für alle Teile gleich und hebt sich im Vergleich auf)
  C.setMode(true, 1000, process.env.POW || 'heli');
  const H = (d, x) => C.height(x, -d);
  let sum = 0, n = 0;
  for (let k = 0; k < 600 && n < 30; k++) {
    const x = (process.env.POW ? C.centerX(800 + k * 23) + ((k * 37) % 160) - 80 : -1500 + k * 100), d = process.env.POW ? 800 + k * 23 : 1500 + (k % 5) * 120, e = 8;
    const gx = H(d, x + e) - H(d, x - e), gd = H(d + e, x) - H(d - e, x), l = Math.hypot(gx, gd) || 1;
    phys.reset(d, x);
    const nn = phys.normal; C.terrainNormal(x, -d, nn);
    phys.heading = Math.atan2(-gx / l, -gd / l);
    phys.vel.set(-gx / l, 0, gd / l); phys.vel.addScaledVector(nn, -phys.vel.dot(nn)).normalize().multiplyScalar(20);
    if (C.surfaceAt(x, -d).pow < 0.9) continue;
    const v0 = phys.vel.clone();
    phys.step(dt, { steer: 0, tuck: 0, brake: 0, jump: false }); phys.events.length = 0;
    const g = 9.81 * Math.sqrt(Math.max(0, 1 - nn.y * nn.y));   // Hangabtrieb entlang der Falllinie
    sum += (20 - phys.speed) / dt + g; n++;
  }
  return sum / n;
}
function butterLoss() {
  C.setMode(false, 1, 'race', 'sg');
  phys.reset(C.START_D + 40);
  const n = phys.normal; C.terrainNormal(phys.pos.x, phys.pos.z, n);
  phys.vel.set(Math.sin(phys.heading), 0, -Math.cos(phys.heading)); phys.vel.addScaledVector(n, -phys.vel.dot(n)).normalize().multiplyScalar(15);
  const ref = { steer: 0, tuck: 0, brake: 0, jump: false, butter: 0, press: 0.8 };
  const p0 = phys.pos.clone(), v0 = phys.vel.clone(), h0 = phys.heading;
  for (let t = 0; t < 1; t += dt) { phys.step(dt, ref); phys.events.length = 0; }
  const vRef = phys.speed;
  phys.pos.copy(p0); phys.vel.copy(v0); phys.heading = h0; phys.grounded = true;
  for (let t = 0; t < 1; t += dt) { ref.butter = Math.abs(Math.sin(Math.PI * 2 * t)); phys.step(dt, ref); phys.events.length = 0; }
  return (vRef - phys.speed) * 3.6;
}

const rows = [];
const parts = [];
for (const [cat, list] of [['Ski', SKIS], ['Brett', BOARDS]]) for (const id in list) parts.push([cat, list[id]]);
// erst alles auf der Rennpiste, dann alles am Heli-Berg (der Berg wird nur einmal erzeugt)
for (const [cat, d] of parts) {
  phys.setGearStats(statMul(d.st));
  rows.push({ teil: `${cat} ${d.name}`, werte: Object.values(d.st).join('/'), endtempo: topSpeed().toFixed(0), radius: turnRadius().toFixed(1), butterVerlust: butterLoss().toFixed(1) });
}
parts.forEach(([, d], i) => { phys.setGearStats(statMul(d.st)); rows[i].pulver = powderSpeed().toFixed(2); });
console.log('Werte = Tempo/Wendigkeit/Pulver/Tricks/Kante | Endtempo km/h | Kurvenradius m bei 54 km/h | Bremswirkung Pulver m/s² | Tempoverlust Butter km/h');
for (const r of rows) console.log(`${r.teil.padEnd(30)} ${r.werte.padEnd(12)} ${r.endtempo.padStart(4)} km/h | ${r.radius.padStart(5)} m | ${r.pulver.padStart(5)} m/s² | ${r.butterVerlust.padStart(4)} km/h`);
