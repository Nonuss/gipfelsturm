// Heli-Berg: ein echter, endlicher Berg vom Gipfel bis ins Tal (kein Endlos-Generator).
//
// Bauplan von oben nach unten (Vorbilder und übernommene Prinzipien siehe PISTE_GENERATION_TEST_REPORT.md):
//   Gipfel       – schmaler Grat, 43 bis 49 Grad, links und rechts fällt es ab. Hier setzt der Helikopter ab.
//   Gipfelflanke – Felsbänder mit Klippen (10 bis 40 m), dazwischen Rinnen; eine Seite mit Spines.
//   Mitte        – Kessel, Gletscherstufen (Eisbruch), Pillows, einzelne Felsköpfe. Man sucht die Linie selbst.
//   Unten        – ab der Baumgrenze Bergwald mit Lawinenschneisen, Talboden mit Ziel.
// Koordinaten: d = Meter talwärts (z = -d), u = Abstand zur Mittellinie hub(d). Alles ist eine geschlossene
// Höhenfunktion, damit Physik, Gelände-Mesh, Fernsicht-Mesh und Bot-Test dieselbe Fläche sehen.
// Klippen: Ein Höhenfeld kann keine Wand. Oberhalb der Kante wird das Gelände zu einem Felsband angehoben (Bank),
// an der Kante fällt es auf 1,6 m Länge ab; davor stellt world.js eine eigene Felswand (buildWalls).
import { clamp, lerp, smoothstep, mulberry32, vnoise, fbm } from './mathutil.js';

const G = 9.81;
const D0 = -220, HSTEP = 1;
export const HALF = 262;            // befahrbare Halbbreite um die Mittellinie
const CORR = 13;                    // freie Hauptlinie: |u| < CORR bleibt ohne Klippen, Felsen und Bäume
let S = null;

export const info = () => S;

// ------------------------------------------------------------------ Aufbau
export function init(seed) {
  const R = mulberry32((Math.imul(seed, 7919) + 13) >>> 0);
  const rr = (a, b) => a + (b - a) * R();
  const s = { seed, ns: R() * 900 + 7 };
  s.dSum = rr(140, 185);                 // Ende der Gipfelpyramide
  s.dFace = rr(690, 830);                // Ende der Gipfelflanke
  s.dMid = s.dFace + rr(720, 880);       // Baumgrenze
  s.dLow = s.dMid + rr(560, 700);        // Talboden
  s.fin = Math.round(s.dLow + rr(200, 240));
  s.end = s.fin + 260;
  s.sSum = rr(0.93, 1.13); s.sFace = rr(0.74, 0.87); s.sMid = rr(0.47, 0.58); s.sLow = rr(0.31, 0.4);
  s.roll = { a: rr(0.09, 0.15), lam: rr(190, 280), ph: rr(0, 6.28) };      // Gletscherstufen im mittleren Berg
  s.wA = rr(165, 215); s.aL = rr(0.8, 1.2); s.aR = rr(0.8, 1.2);          // Breite der Flanke, links/rechts ungleich
  s.fL = rr(0.9, 1.15); s.fR = rr(0.9, 1.15);                            // wie steil die Seiten abfallen
  s.rib = { a: rr(6.5, 10.5), lam: rr(72, 108) };                        // Rippen und Rinnen in Falllinie
  s.bowl = rr(0.0003, 0.0008);                                           // Kessel in der Mitte
  s.hubA = rr(18, 46) * (R() < 0.5 ? -1 : 1); s.hubL = rr(360, 520); s.hubP = rr(0, 6.28);
  s.treeD = s.dMid + rr(-90, 60);
  s.glades = [rr(-190, -70), rr(60, 190), rr(-40, 40) * 3].map((u) => ({ u, w: rr(9, 17), wob: rr(10, 26), lam: rr(160, 260), ph: rr(0, 6.28) }));

  // Höhenprofil der Mittellinie
  const n = Math.ceil((s.end + 900 - D0) / HSTEP);
  s.H = new Float32Array(n + 1);
  const i0 = Math.round(-D0 / HSTEP);
  let h = 0;
  for (let i = i0 + 1; i <= n; i++) { h -= slopeP(s, D0 + (i - 0.5) * HSTEP) * HSTEP; s.H[i] = h; }
  h = 0;
  for (let i = i0 - 1; i >= 0; i--) { h += slopeP(s, D0 + (i + 0.5) * HSTEP) * HSTEP; s.H[i] = h; }
  s.hn = n;
  s.floorY = s.H[Math.round((s.fin + 120 - D0) / HSTEP)] - 14;
  S = s;

  // ---- Spines (eine Seite der Gipfelflanke) und Pillow-Feld (Mitte)
  const side = R() < 0.5 ? -1 : 1;
  s.spines = { d0: s.dSum + rr(90, 150), d1: s.dFace - rr(30, 110), side, u0: rr(46, 62), u1: rr(165, 215), A: rr(3.2, 5.0), lam: rr(15, 21), sd: rr(0, 90) };
  s.pillows = [];
  {
    const pd = s.dFace + rr(140, 300), pu = -side * rr(60, 120), nP = 38 + Math.floor(R() * 16);
    for (let k = 0; k < nP; k++) s.pillows.push({ d: pd + rr(0, 250), u: pu + rr(-55, 55), r: rr(3.4, 6.2), h: rr(1.3, 3.0) });
    s.pillowBox = { d0: pd - 20, d1: pd + 270, u: pu };
  }

  // ---- Klippen: Felsbänder in der Gipfelflanke, Eisbruch und Felsköpfe weiter unten
  s.cliffs = [];
  const addCliff = (o) => {
    // Gefälle an Ort und Stelle (nicht nur auf der Mittellinie): die Bank darf nie flach werden, sonst bleibt man im Pulver stecken
    const dc = o.dc;
    let sl = 9;
    for (const fu of [0.15, 0.5, 0.85]) { const u = lerp(o.u0, o.u1, fu); sl = Math.min(sl, (heightDU(dc - 55, u) - heightDU(dc, u)) / 55, (heightDU(dc - 14, u) - heightDU(dc, u)) / 14); }
    if (sl < 0.36) return null;
    const c = { ice: false, ...o, Lup: (2 * o.h) / (sl - 0.22), wA: rr(2.5, 8), wL: rr(12, 26), wP: rr(0, 6.28), tilt: rr(-0.07, 0.07), tpL: rr(0.08, 0.34), tpR: rr(0.08, 0.34), wn: rr(0.8, 2.2), id: s.cliffs.length };
    c.um = (c.u0 + c.u1) / 2;
    s.cliffs.push(c);
    return c;
  };
  const nb = R() < 0.55 ? 3 : 2;
  for (let b = 0; b < nb; b++) {
    const dc = s.dSum + ((b + 0.55 + rr(-0.12, 0.12)) / nb) * (s.dFace - s.dSum) * 0.92;
    const hMax = [20, 32, 42][Math.min(2, b + (nb === 2 ? 1 : 0))];
    for (const sg of [-1, 1]) {
      const wMax = Wof(s, dc, sg) - 12;
      // die Spine-Seite bleibt im Spine-Bereich frei
      const lim = sg === s.spines.side && dc > s.spines.d0 - 40 && dc < s.spines.d1 + 60 ? Math.min(wMax, s.spines.u0 - 12) : wMax;
      let u = CORR + rr(1, 9);
      while (u < lim - 14) {
        const w = Math.min(lim - u, rr(26, 74));
        if (w < 14) break;
        const h = clamp(rr(0.35, 1) * hMax, 10, hMax);
        addCliff({ dc: dc + rr(-26, 26), u0: sg > 0 ? u : -(u + w), u1: sg > 0 ? u + w : -u, h });
        u += w + rr(15, 26);   // Rinne zwischen zwei Felsbändern
      }
    }
  }
  // Eisbruch: Gletscherstufe quer über eine Seite des mittleren Bergs
  if (R() < 0.8) {
    const dc = s.dFace + rr(260, 420), sg = -s.pillowBox.u > 0 ? 1 : -1;
    let u = CORR + rr(8, 24);
    for (let k = 0; k < 3 && u < 200; k++) {
      const w = rr(34, 62);
      addCliff({ dc: dc + rr(-22, 22), u0: sg > 0 ? u : -(u + w), u1: sg > 0 ? u + w : -u, h: rr(8, 17), ice: true });
      u += w + rr(14, 24);
    }
    s.icefall = { dc, sg };
  }
  // einzelne Felsköpfe: wenige, dafür große Formationen
  const nK = 9 + Math.floor(R() * 5);
  for (let k = 0; k < nK; k++) {
    const dc = rr(s.dFace + 60, s.dLow - 80), sg = R() < 0.5 ? -1 : 1, w = rr(13, 30), u = rr(CORR + 8, 215);
    if (s.cliffs.some((c) => Math.abs(c.dc - dc) < 95 && u < Math.max(Math.abs(c.u0), Math.abs(c.u1)) + 34 && u + w > Math.min(Math.abs(c.u0), Math.abs(c.u1)) - 34 && Math.sign(c.um) === sg)) continue;
    if (dc > s.pillowBox.d0 - 30 && dc < s.pillowBox.d1 + 30 && Math.abs(sg * (u + w / 2) - s.pillowBox.u) < 80) continue;
    addCliff({ dc, u0: sg > 0 ? u : -(u + w), u1: sg > 0 ? u + w : -u, h: rr(5, 12), knob: true });
  }
  validateCliffs(s);
  s.cliffs = s.cliffs.filter((c) => c.h >= 4.5);
  s.cliffs.forEach((c, i) => { c.id = i; });
  return s;
}

/** Gefälle der Mittellinie (tan). Negativ = Rückseite des Gipfels. */
function slopeP(s, d) {
  let v = lerp(-0.8, s.sSum, smoothstep(-6, 9, d));
  v = lerp(v, s.sFace, smoothstep(s.dSum - 30, s.dSum + 40, d));
  v = lerp(v, s.sMid, smoothstep(s.dFace - 60, s.dFace + 70, d));
  v += s.roll.a * Math.sin((6.2832 * d) / s.roll.lam + s.roll.ph) * smoothstep(s.dFace, s.dFace + 120, d) * (1 - smoothstep(s.dMid - 100, s.dMid + 60, d));
  v = lerp(v, s.sLow, smoothstep(s.dMid - 80, s.dMid + 90, d));
  v = lerp(v, 0.13, smoothstep(s.dLow - 90, s.dLow + 70, d));
  v = lerp(v, -0.05, smoothstep(s.fin + 30, s.fin + 170, d));
  return v;
}
function Hof0(s, d) {
  const f = clamp((d - D0) / HSTEP, 0, s.hn - 1e-3), i = Math.floor(f);
  return s.H[i] + (s.H[i + 1] - s.H[i]) * (f - i);
}
/** Halbbreite der Flanke: am Gipfel ein Grat, nach unten ein breiter Hang. */
function Wof(s, d, sg) {
  return (8 + s.wA * Math.pow(Math.max(0, d) / s.dFace, 1.45)) * (sg < 0 ? s.aL : s.aR);
}
const soft = (e, k) => (e <= 0 ? 0 : e < k ? (e * e) / (2 * k) : e - k / 2);

export const hubX = (d) => (S ? S.hubA * Math.sin(d / S.hubL + S.hubP) * smoothstep(320, 950, d) : 0);
export const Hof = (d) => Hof0(S, d);
export const slopeAt = (d) => slopeP(S, d);
export const boundAt = (d) => ({ c: hubX(d), u: HALF, fall: d < S.dFace + 120 });

// ------------------------------------------------------------------ Klippen
const edgeD = (c, u) => c.dc + c.wA * Math.sin(u / c.wL + c.wP) + c.tilt * (u - c.um);
/** Seitenkanten des Felsbands: nach oben läuft es schmaler und unregelmäßig aus (ein Pfeiler, kein Kasten). */
const sideLo = (c, dd) => c.u0 + clamp(-dd / c.Lup, 0, 1) * c.tpL * (c.u1 - c.u0) + c.wn * Math.sin(dd / 8.5 + c.wP);
const sideHi = (c, dd) => c.u1 - clamp(-dd / c.Lup, 0, 1) * c.tpR * (c.u1 - c.u0) + c.wn * Math.sin(dd / 7.1 + c.wP * 1.7);
function cliffDelta(c, d, u) {
  if (u < c.u0 - 4 || u > c.u1 + 4) return 0;
  const dd = d - edgeD(c, u);
  if (dd < -c.Lup || dd > 1.6) return 0;
  const lo = sideLo(c, dd), hi = sideHi(c, dd);
  const wl = smoothstep(lo - 1.2, lo + 1.2, u) * (1 - smoothstep(hi - 1.2, hi + 1.2, u));
  if (wl <= 0) return 0;
  if (dd < 0) { const t = 1 + dd / c.Lup; return c.h * t * t * wl * (1 + 0.16 * (1 - t) * 4 * t * (vnoise(u / 13 + c.wP, d / 13) - 0.5) * 2); }
  return c.h * (1 - smoothstep(0, 1.6, dd)) * wl;
}

/** Jede Klippe wird mit echten Flugbahnen geprüft: Aufprall (nach Pulver-Dämpfung) muss klar unter der Sturzgrenze bleiben. */
function validateCliffs(s) {
  for (const c of s.cliffs) {
    for (let it = 0; it < 9; it++) {
      let worst = 0;
      for (const fu of [0.3, 0.5, 0.7]) {
        const u = lerp(c.u0, c.u1, fu);
        for (const v of [3, 7, 12, 18, 25, 32]) worst = Math.max(worst, flightImpact(c, u, v));
      }
      c.worst = worst;
      if (worst < 17) break;
      c.h *= 0.84;
      c.Lup *= 0.84;
    }
    if (c.worst >= 17) c.h = 0;
  }
}
/** Flug über die Kante mit Tempo v: Normalgeschwindigkeit beim Aufsetzen, mit der Pulver-Dämpfung der Spielphysik. */
export function flightImpact(c, u, v, out) {
  const de = edgeD(c, u), d0 = de - 0.3;
  const h0 = heightDU(d0, u), h1 = heightDU(d0 - 2, u);
  const sl = (h1 - h0) / 2, inv = 1 / Math.hypot(1, sl);
  let d = d0, y = h0, vd = v * inv, vy = -v * sl * inv;
  const dt = 0.02;
  for (let t = 0; t < 12; t += dt) {
    vy -= G * dt; d += vd * dt; y += vy * dt;
    const hg = heightDU(d, u);
    if (y <= hg && d > de + 1.6) {
      const sd = (heightDU(d + 0.6, u) - heightDU(d - 0.6, u)) / 1.2;
      const k = 1 / Math.hypot(1, sd);
      const vn = -(vd * -sd * k + vy * k);
      if (out) { out.dist = d - de; out.t = t; }
      return Math.max(0, vn) * 0.58;
    }
  }
  return 99;
}

// ------------------------------------------------------------------ Höhe
/** Höhe in Berg-Koordinaten (d talwärts, u quer zur Mittellinie). */
export function heightDU(d, u) {
  const s = S, x = hubX(d) + u, au = Math.abs(u), sg = u < 0 ? -1 : 1;
  let y = Hof0(s, d);
  // Grat und Flanken: außerhalb der Halbbreite fällt der Berg ab (oben), im Tal steigen die Hänge an
  // Der Grat ist keine gerade Kante: seine Breite schwankt, die Flanken haben Rippen und Rinnen, der First kleine Stufen
  const W = Wof(s, d, sg) * (1 + 0.34 * (vnoise(d / 85 + sg * 9.3 + s.ns, 1.7) - 0.5) * smoothstep(12, 110, d));
  const fall = lerp(0.98, 0.64, smoothstep(0, s.dFace, d)) * (sg < 0 ? s.fL : s.fR);
  const e = au - W;
  if (e > 0) {
    // die ersten 150 m fallen steil ab, weiter außen läuft die Flanke flacher zum Tal aus
    y -= fall * (e < 150 ? soft(e, 6) : 147 + (e - 150) * 0.62) * (1 + 0.3 * (vnoise(d / 42 + s.ns * 1.3 + sg * 31, e / 240 + 5) - 0.5));
    y += Math.min(1, e / 26) * 10 * (0.5 - Math.abs(2 * vnoise(d / 55 + sg * 17 + s.ns, e / 300) - 1));
  }
  if (d < 0) y += 8 * (0.5 - Math.abs(2 * vnoise(u / 60 + s.ns, d / 200) - 1)) * clamp(-d / 40, 0, 1);
  y += 1.8 * Math.sin(d / 23 + s.ns) * smoothstep(14, 60, d) * (1 - smoothstep(s.dSum, s.dSum + 90, d));
  const low = smoothstep(s.dFace + 150, s.dMid, d);
  if (low > 0) y += 0.3 * low * soft(Math.min(au, 900) - lerp(235, 125, smoothstep(s.dMid - 200, s.dLow, d)), 40);
  // Kessel im mittleren Berg
  const bw = smoothstep(s.dFace - 80, s.dFace + 160, d) * (1 - smoothstep(s.dMid - 160, s.dMid + 120, d));
  if (bw > 0) y += s.bowl * Math.min(au * au, 240 * 240) * bw;
  // Rippen und Rinnen in Falllinie, große Wellen, feine Unruhe
  const ribA = s.rib.a * smoothstep(50, 230, d) * lerp(1, 0.32, smoothstep(s.dFace, s.dMid, d)) * (0.3 + 0.7 * smoothstep(7, 42, au)) * (1 - smoothstep(s.dLow - 60, s.fin, d));
  if (ribA > 0.01) y += ribA * (0.5 - Math.abs(2 * vnoise(u / s.rib.lam + s.ns, d / 540 + s.ns * 0.37) - 1));
  y += 5 * (fbm(x / 130 + s.ns, d / 130) - 0.5) * smoothstep(90, 320, d) * (1 - 0.75 * smoothstep(s.dLow, s.fin, d));
  y += 0.9 * (vnoise(x / 17 + 3, d / 17 + s.ns) - 0.5) * smoothstep(30, 130, d);
  // Spines
  const sp = s.spines;
  if (d > sp.d0 - 40 && d < sp.d1 + 40 && sg === sp.side && au > sp.u0 - 12) {
    const w = smoothstep(sp.d0 - 40, sp.d0 + 30, d) * (1 - smoothstep(sp.d1 - 30, sp.d1 + 40, d)) * smoothstep(sp.u0 - 12, sp.u0 + 8, au) * (1 - smoothstep(sp.u1 - 14, sp.u1 + 10, au));
    if (w > 0) y += sp.A * w * (1 - Math.abs(Math.sin(Math.PI * (u / sp.lam + 0.35 * (vnoise(d / 90 + sp.sd, s.ns) * 2 - 1)))));
  }
  // Pillows
  const pb = s.pillowBox;
  if (d > pb.d0 && d < pb.d1 && Math.abs(u - pb.u) < 70) {
    for (let i = 0; i < s.pillows.length; i++) {
      const p = s.pillows[i], dd = d - p.d;
      if (dd > 14 || dd < -14) continue;
      const q = (dd * dd + (u - p.u) * (u - p.u)) / (p.r * p.r);
      if (q < 6) y += p.h * Math.exp(-q);
    }
  }
  // Klippen (Bank + Abbruch)
  for (let i = 0; i < s.cliffs.length; i++) {
    const c = s.cliffs[i];
    if (c.h > 0 && d > c.dc - c.Lup - 12 && d < c.dc + 14) y += cliffDelta(c, d, u);
  }
  // Talboden: der Berg steht auf einem Tal, er fällt nicht ins Bodenlose
  const fl = s.floorY + 6 * (vnoise(x / 400, d / 400) - 0.5);
  if (y < fl + 60) { const t = clamp((fl + 60 - y) / 120, 0, 1); y = lerp(y, Math.max(y, fl), t * t * (3 - 2 * t)); if (y < fl) y = fl; }
  return y;
}
export function heightH(x, z) { const d = -z; return heightDU(d, x - hubX(d)); }

// ------------------------------------------------------------------ Oberfläche, Wald
/** Walddichte 0..1: Baumgrenze mit unruhigem Rand, Baumgruppen und Lawinenschneisen. */
export function forestAt(d, u) {
  const s = S;
  if (d < s.treeD - 220) return 0;
  const x = hubX(d) + u;
  let f = smoothstep(s.treeD - 70, s.treeD + 430, d + 190 * (fbm(u / 170 + s.ns, d / 320) - 0.5));
  if (f <= 0) return 0;
  f *= 0.22 + 0.78 * smoothstep(0.36, 0.6, fbm(x / 60 + s.ns, d / 60));
  for (const g of s.glades) {
    const gu = g.u + g.wob * Math.sin(d / g.lam + g.ph);
    f *= smoothstep(g.w * 0.55, g.w * 1.5, Math.abs(u - gu));
  }
  f *= smoothstep(CORR - 5, CORR + 9, Math.abs(u));
  if (d > s.fin - 150) f *= smoothstep(22, 60, Math.abs(u));    // Zielwiese
  return f;
}
export const SI = { edge: 30, groom: 0, pow: 1, forest: 0, lane: 0, u: 0, lx: 0, kind: 0, hub: 0, valley: HALF };
export function surf(x, d) {
  const hub = hubX(d), u = x - hub;
  SI.u = u; SI.hub = hub; SI.lx = hub;
  SI.pow = lerp(1, 0.28, smoothstep(S.dLow - 60, S.fin - 60, d));
  SI.forest = forestAt(d, u);
  SI.groom = 0;
  return SI;
}
export function zoneAt(d) {
  const s = S;
  const type = d < s.dSum ? 'summit' : d < s.dFace ? 'face' : d < s.dMid ? 'bowl' : d < s.dLow ? 'forest' : 'valley';
  return { type, idx: 0, label: '' };
}
/** Felswand in der Nähe? (für Bäume, Felsen, Tests) */
export function nearCliff(d, u, m) {
  for (const c of S.cliffs) if (u > c.u0 - m && u < c.u1 + m && d > c.dc - c.Lup - m && d < c.dc + 30 + c.h * 2.2 + m) return true;
  return false;
}

// ------------------------------------------------------------------ Inhalte eines 100-m-Stücks
export function genChunk(i, CH, treeMul, addCollider) {
  const s = S, d0 = i * CH, d1 = d0 + CH;
  const R = mulberry32((Math.imul(s.seed, 2654435761) ^ Math.imul(i + 1000, 40503)) >>> 0);
  const out = { trees: [], rocks: [], markers: [], decor: [], caves: [], walls: [] };
  // Wald
  if (d1 > s.treeD - 220) {
    const N = Math.round(3000 * treeMul), maxT = Math.round(760 * treeMul);
    for (let n = 0; n < N && out.trees.length < maxT; n++) {
      const dd = d0 + R() * CH, u = (R() * 2 - 1) * (HALF + 8), pr = R(), sc0 = R(), rot = R() * 6.283, tint = 0.82 + R() * 0.36, vr = R(), vr2 = R();
      const dens = forestAt(dd, u);
      if (dens < 0.02 || pr > dens) continue;
      if (dd > s.end - 30 || nearCliff(dd, u, 5)) continue;
      const x = hubX(dd) + u, z = -dd, hh = heightH(x, z);
      if (Math.abs(heightH(x + 1.4, z) - hh) > 1.7 || Math.abs(heightH(x, z - 1.4) - hh) > 1.9) continue;
      const scale = 0.7 + sc0 * 0.85;
      out.trees.push({ x, z, y: hh - 0.15, scale, rot, variant: vr < 0.45 ? 0 : vr2 < 0.6 ? 1 : 2, tint });
      addCollider(x, z, 0.5 * scale + 0.15, 'baum');
    }
  }
  // Felswände dieses Stücks, dazu wenige große Blöcke am Wandfuß
  for (const c of s.cliffs) {
    if (c.dc < d0 || c.dc >= d1) continue;
    out.walls.push(c);
    const nB = c.ice ? 0 : 1 + Math.floor(R() * 2.4);
    for (let k = 0; k < nB; k++) {
      const u = (R() < 0.5 ? c.u0 - 3 - R() * 5 : c.u1 + 3 + R() * 5), dd = edgeD(c, clamp(u, c.u0, c.u1)) + 4 + R() * 7, sc = 1.7 + R() * 2.3;
      if (Math.abs(u) < CORR + 1.5 * sc) continue;
      const x = hubX(dd) + u;
      out.rocks.push({ x, z: -dd, y: heightH(x, -dd) - 0.35 * sc, scale: sc, rot: R() * 6.283, variant: Math.floor(R() * 6) });
      addCollider(x, -dd, 1.15 * sc, 'fels');
    }
    // Eistürme (Séracs) seitlich neben dem Eisbruch, nie in der Landezone
    if (c.ice) for (let k = 0; k < 4; k++) {
      const u = k % 2 ? c.u1 + 4 + R() * 7 : c.u0 - 4 - R() * 7, dd = edgeD(c, clamp(u, c.u0, c.u1)) - 6 + R() * 16, x = hubX(dd) + u, sc = 1.3 + R() * 1.8;
      if (Math.abs(u) < CORR + 3) continue;
      out.decor.push({ m: 'IceCluster', x, z: -dd, y: heightH(x, -dd) - 0.3 * sc, rot: R() * 6.28, scale: sc });
      addCollider(x, -dd, 1.0 * sc, 'fels');
    }
  }
  // Tal: Hütten neben der Zielwiese
  for (const h of chaletsIn(d0, d1)) addCollider(h.x, h.z, 5.4, 'haus');
  return out;
}
function chaletsIn(d0, d1) {
  const s = S, list = [];
  for (const [dd, u, rot] of [[s.fin + 46, -40, 0.5], [s.fin + 78, 34, -0.4], [s.fin - 30, 62, -1.2], [s.fin + 120, -12, 0.1]]) {
    if (dd < d0 || dd >= d1) continue;
    const x = hubX(dd) + u;
    list.push({ x, z: -dd, y: heightH(x, -dd), rot });
  }
  return list;
}
export const chalets = () => chaletsIn(-1e9, 1e9);

/** Stützpunkte einer Felswand für world.buildWalls: Kante von links nach rechts, dazu die Seitenwände bergauf. */
export function wallLine(c) {
  const pts = [];
  const push = (d, u, nd, nu) => pts.push({ d, u, nd, nu });
  // linke Seitenwand (von oben zur Ecke), Normale zeigt nach außen (−u)
  for (let t = Math.min(c.Lup * 0.85, 76); t > 3; t -= 3.2) push(edgeD(c, c.u0) - t, sideLo(c, -t), 0, -1);
  push(edgeD(c, c.u0) - 0.5, sideLo(c, -0.5) + 0.4, 0.7, -0.7);
  for (let u = sideLo(c, 0) + 2.4; u < sideHi(c, 0) - 2.0; u += 1.9) push(edgeD(c, u) + 0.2, u, 1, 0);
  push(edgeD(c, c.u1) - 0.5, sideHi(c, -0.5) - 0.4, 0.7, 0.7);
  for (let t = 3.2; t < Math.min(c.Lup * 0.85, 76); t += 3.2) push(edgeD(c, c.u1) - t, sideHi(c, -t), 0, 1);
  return pts;
}
