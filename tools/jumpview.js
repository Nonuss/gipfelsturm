import * as C from '../src/course.js';
import * as P from '../src/piste.js';
import { SkiPhysics } from '../src/physics.js';

const WANT = ['Kicker', 'Tisch', 'Tischsprung', 'Step-up', 'Step-down', 'Spine (links)', 'Großer Tisch', 'Big Air', 'Waldkicker'];
const found = {};
for (let seed = 1; seed <= 120 && Object.keys(found).length < WANT.length + 1; seed++) {
  C.setMode(true, seed);
  for (const z of P.zonesOf(5200)) {
    for (const f of z.feats) {
      const key = f.kind === 'cliff' ? 'Klippe' : f.kind === 'jump' ? f.name : null;
      if (key && (WANT.includes(key) || key === 'Klippe') && !found[key]) found[key] = { seed, name: key, d: f.kind === 'cliff' ? f.dc : f.d, lane: f.kind === 'cliff' ? 1 : f.lane, kind: f.kind, slope: z.slope, ext0: f.kind === 'cliff' ? -60 : f.ext0, ext1: f.kind === 'cliff' ? 100 : f.ext1, dxLane: 0, fx: f.kind === 'cliff' ? f.xB : f.x };
    }
  }
}
const list = Object.values(found);
const W = 1000, H = 230, PADL = 56;
const cv = document.getElementById('c');
cv.width = W; cv.height = list.length * H + 10;
const g = cv.getContext('2d');
g.fillStyle = '#0f1722'; g.fillRect(0, 0, cv.width, cv.height);
const phys = new SkiPhysics();
const summary = [];

function runPass(item, tuck) {
  C.setMode(true, item.seed);
  const d0 = Math.max(10, item.d - 420);
  const lane0 = P.props(item.d).lx[item.lane];
  const dx = item.fx - lane0;
  phys.reset(d0, P.props(d0).lx[item.lane] + dx);
  phys.vel.set(0, 0, -5);
  const inp = { steer: 0, tuck: tuck ? 1 : 0, brake: 0, jump: false };
  const dt = 1 / 120, pts = [], lands = [];
  let t = 0, wasAir = false;
  while (t < 60 && -phys.pos.z < item.d + item.ext1 + 90) {
    const p = phys.pos, d = -p.z, sp = phys.speed, LA = 14 + sp * 0.8;
    const c = P.props(d + LA);
    const tx = c.lx[item.lane] + dx;
    const e = Math.atan2(tx - p.x, LA) - phys.heading;
    inp.steer += C.clamp(C.clamp(e * 3.2, -1, 1) - inp.steer, -9 * dt, 9 * dt);
    inp.brake = sp > (tuck ? 30 : 24) ? 1 : 0;
    inp.tuck = tuck && sp < 30 ? 1 : 0;
    phys.step(dt, inp);
    t += dt;
    pts.push([-p.z, p.y, phys.grounded]);
    for (const ev of phys.events) if (ev.type === 'land' && -p.z > item.d - 4) lands.push({ d: -p.z, impact: ev.impact, air: ev.airTime });
    phys.events.length = 0;
    wasAir = !phys.grounded;
    if (phys.crashed > 0) break;
  }
  void wasAir;
  return { pts, lands, crashed: phys.crashed > 0 };
}

list.forEach((item, idx) => {
  const oy = idx * H + 10;
  const a = runPass(item, false), b = runPass(item, true);
  C.setMode(true, item.seed);
  const dA = item.d + item.ext0 - 40, dB = item.d + item.ext1 + 60;
  const lane0 = P.props(item.d).lx[item.lane];
  const dx = item.fx - lane0;
  const yRef = C.height(lane0 + dx, -item.d);
  const s = P.zoneAtD(item.d).slope;
  const base = (d) => yRef - s * (d - item.d);
  // Terrain
  const terr = [];
  for (let d = dA; d <= dB; d += 0.5) terr.push([d, C.height(P.props(d).lx[item.lane] + dx, -d) - base(d)]);
  let ymin = 1e9, ymax = -1e9;
  for (const q of terr) { ymin = Math.min(ymin, q[1]); ymax = Math.max(ymax, q[1]); }
  for (const r of [a, b]) for (const q of r.pts) if (q[0] > dA && q[0] < dB) { const v = q[1] - base(q[0]); ymin = Math.min(ymin, v); ymax = Math.max(ymax, v); }
  ymin -= 2; ymax += 3;
  const sx = (W - PADL - 12) / (dB - dA), sy = Math.min(sx * 1.3, (H - 44) / (ymax - ymin));
  const X = (d) => PADL + (d - dA) * sx, Y = (v) => oy + H - 26 - (v - ymin) * sy;
  g.fillStyle = '#16263d'; g.fillRect(0, oy, W, H - 6);
  // Gitter
  g.strokeStyle = 'rgba(255,255,255,0.07)'; g.lineWidth = 1; g.fillStyle = 'rgba(234,242,255,0.5)'; g.font = '10px sans-serif';
  for (let d = Math.ceil(dA / 10) * 10; d <= dB; d += 10) { g.beginPath(); g.moveTo(X(d), oy + 22); g.lineTo(X(d), oy + H - 26); g.stroke(); if (d % 20 === 0) g.fillText(String(Math.round(d - item.d)), X(d) - 8, oy + H - 12); }
  // Gelände
  g.fillStyle = '#d6e6ff'; g.beginPath(); g.moveTo(X(terr[0][0]), Y(ymin - 1));
  for (const q of terr) g.lineTo(X(q[0]), Y(q[1]));
  g.lineTo(X(terr[terr.length - 1][0]), Y(ymin - 1)); g.closePath(); g.fill();
  g.strokeStyle = '#ffffff'; g.lineWidth = 1.5; g.beginPath(); terr.forEach((q, i) => (i ? g.lineTo(X(q[0]), Y(q[1])) : g.moveTo(X(q[0]), Y(q[1])))); g.stroke();
  // Bahnen
  const draw = (r, col) => {
    g.strokeStyle = col; g.lineWidth = 2.2; g.beginPath(); let first = true;
    for (const q of r.pts) { if (q[0] < dA || q[0] > dB) continue; const x = X(q[0]), y = Y(q[1] - base(q[0]) + 0.75); if (first) { g.moveTo(x, y); first = false; } else g.lineTo(x, y); }
    g.stroke();
    for (const l of r.lands.filter((l) => l.air > 0.4)) { g.fillStyle = col; g.beginPath(); g.arc(X(l.d), Y(C.height(P.props(l.d).lx[item.lane] + dx, -l.d) - base(l.d)), 4, 0, 6.3); g.fill(); }
  };
  draw(a, '#ff9f0a'); draw(b, '#ff453a');
  g.fillStyle = '#eaf2ff'; g.font = 'bold 13px sans-serif';
  g.fillText(`${item.name}  (Seed ${item.seed}, Hang ${(s * 100).toFixed(0)} %)`, 12, oy + 16);
  const big = (r) => r.lands.filter((l) => l.air > 0.4).sort((p, q) => q.air - p.air)[0];
  const ba = big(a), bb = big(b);
  g.font = '12px sans-serif';
  const txt = (r, bl, label, col, y) => { g.fillStyle = col; g.fillText(`${label}: ${bl ? `${bl.impact.toFixed(1)} m/s · ${bl.air.toFixed(1)} s · ${(bl.d - item.d).toFixed(0)} m` : r.crashed ? 'Sturz' : 'kein Flug'}${r.crashed ? ' (Sturz)' : ''}`, W - 330, y); };
  txt(a, ba, 'aufrecht', '#ff9f0a', oy + 16); txt(b, bb, 'Hocke', '#ff453a', oy + 32);
  summary.push({ name: item.name, seed: item.seed, slope: +s.toFixed(2), upright: ba ? { impact: +ba.impact.toFixed(1), air: +ba.air.toFixed(2), dist: Math.round(ba.d - item.d) } : null, tuck: bb ? { impact: +bb.impact.toFixed(1), air: +bb.air.toFixed(2), dist: Math.round(bb.d - item.d) } : null, crashU: a.crashed, crashT: b.crashed });
});
window.__summary = summary;
window.__done = true;
