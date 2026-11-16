// Heli-Berg: ein ganzes Gebirge statt einer Strecke.
//
// Vorbild ist ein echter Horn-Gipfel (Matterhorn, Chugach, Haines): vom Gipfel laufen Grate nach allen Seiten,
// dazwischen liegen konkave Flanken, die mit Rippen und Rinnen in Falllinie durchzogen sind. Unten öffnet sich ein
// Trogtal (U-Form, flacher Talboden mit Fluss und Dörfern), gegenüber und rundherum stehen Nachbargipfel.
//
// Aufbau in Schichten:
//   1. Makroform  – Hörner (Kegel mit Graten, Ausprägung je Winkel), weich vereinigt; Trogtal als Untergrenze.
//   2. Relief     – Rippen und Rinnen in Falllinie (gestrecktes Grat-Rauschen in Polarkoordinaten), Grat-Rauschen.
//   3. Erosion    – Tropfen-Erosion (Wasser trägt ab und lagert an), Hangrutschung (Schutt bis rund 48 Grad).
//   4. Abfluss    – Senken werden aufgefüllt (Priority-Flood mit Mindestgefälle): man bleibt nirgends stecken.
//   5. Klippen    – Felsbänder quer zur örtlichen Falllinie, Landung aus der Flugbahn geprüft.
//   6. Wald       – unter der Baumgrenze, nicht in Lawinenrinnen, nicht auf Steilhängen, in Gruppen.
//   7. Licht      – Gelände-Schatten (Strahlen zur Sonne) werden vorab berechnet.
//
// Koordinaten: x quer, d talwärts (z = -d). Der Gipfel liegt bei (0, 0) auf Höhe 0, das Tal rund 2,2 km tiefer.
import { clamp, lerp, smoothstep, mulberry32, vnoise, fbm } from './mathutil.js';

const G = 9.81;
const TAU = Math.PI * 2;
let S = null;
export const info = () => S;

// Sonne für den Heli-Berg: von links vorne und eher tief, damit Grate und Rinnen Relief bekommen (Richtung ZUR Sonne)
export const SUN = (() => { const v = [-0.74, 0.43, -0.52], l = Math.hypot(...v); return v.map((c) => c / l); })();

// ------------------------------------------------------------------ Hilfen
const ridged = (x, y) => 1 - Math.abs(2 * vnoise(x, y) - 1);
function smax(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.max(a, b) + h * h * k * 0.25; }
const angDiff = (a, b) => { let d = a - b; d -= TAU * Math.round(d / TAU); return d; };
/** Abfall eines Horns über die Entfernung: oben 50 Grad, mittlere Flanke 30 Grad, unten 16 Grad. */
const drop = (r) => 0.28 * r + 430 * (1 - Math.exp(-r / 620)) + 330 * (1 - Math.exp(-r / 2500));

function cubic(p0, p1, p2, p3, t) { return p1 + 0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0))); }
function makeGrid(x0, d0, cell, nx, nd) { return { x0, d0, cell, nx, nd, h: new Float32Array(nx * nd) }; }
const inGrid = (g, x, d, m = 2) => x > g.x0 + m * g.cell && x < g.x0 + (g.nx - 1 - m) * g.cell && d > g.d0 + m * g.cell && d < g.d0 + (g.nd - 1 - m) * g.cell;
/** Catmull-Rom (bikubisch): glatte Normalen, keine Knicke an den Zellgrenzen. */
function sampleCubic(g, x, d) {
  const fx = (x - g.x0) / g.cell, fd = (d - g.d0) / g.cell;
  const i = clamp(Math.floor(fx), 1, g.nx - 3), j = clamp(Math.floor(fd), 1, g.nd - 3);
  const tx = clamp(fx - i, 0, 1), td = clamp(fd - j, 0, 1), h = g.h, nx = g.nx;
  const row = (jj) => { const k = jj * nx + i; return cubic(h[k - 1], h[k], h[k + 1], h[k + 2], tx); };
  return cubic(row(j - 1), row(j), row(j + 1), row(j + 2), td);
}
function sampleLin(g, arr, x, d) {
  const fx = clamp((x - g.x0) / g.cell, 0, g.nx - 1.001), fd = clamp((d - g.d0) / g.cell, 0, g.nd - 1.001);
  const i = Math.floor(fx), j = Math.floor(fd), tx = fx - i, td = fd - j, k = j * g.nx + i;
  return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - td) + (arr[k + g.nx] * (1 - tx) + arr[k + g.nx + 1] * tx) * td;
}

// ------------------------------------------------------------------ Makroform
function hornHeight(hn, x, d, best) {
  const dx = x - hn.x, dd = d - hn.d, r = Math.sqrt(dx * dx + dd * dd);
  const dr = drop(r * hn.rs) / hn.rs;
  if (hn.h - hn.kMin * dr < best - 200) return -1e9;           // kann hier nicht gewinnen
  let th = Math.atan2(dx, dd);
  th += hn.warp * (vnoise(r / 900 + hn.sd, hn.sd * 0.37) - 0.5) * 2;
  let k = 1;
  for (const rg of hn.ridges) {
    const a = rg.a + rg.bend * (vnoise(r / 1100 + rg.sd, 3.3) - 0.5) * 2;
    const t = angDiff(th, a) / (rg.w * (1 + r / 2600));
    k -= rg.amp * (1 + 0.3 * Math.sin(r / 430 + rg.sd)) * Math.exp(-t * t);   // Schultern und Scharten entlang des Grats
  }
  return hn.h - Math.max(hn.kMin, k * hn.k) * dr;
}
function valleyAxis(s, x) { return s.DV + 140 * Math.sin(x / 2600 + s.vp1) + 55 * Math.sin(x / 970 + s.vp2); }
function floorAt(s, x, d) {
  const q = d - valleyAxis(s, x);
  const y = s.Hv - 0.011 * x + 6 * (vnoise(x / 700, s.ns) - 0.5);
  const e = Math.max(0, Math.abs(q) - s.Wv);
  // Trogwand: steigt am Rand des Talbodens an und läuft dann aus (nur Untergrenze, die Berge liegen darüber)
  return y + 170 * (1 - Math.exp(-(e * e * 0.0011) / 170));
}
function riverOffset(s, x) { return 0.42 * s.Wv * Math.sin(x / 520 + s.vp3) + 0.18 * s.Wv * Math.sin(x / 213 + s.vp2); }

/** Gebirgsketten rundherum: Ridged-Multifractal (verbundene Grate, verzweigte Täler) mit Verzerrung. 0..1 */
function rangeNoise(s, x, d) {
  const wx = 1100 * (fbm(x / 7000 + s.ns, d / 7000) - 0.5), wd = 1100 * (fbm(x / 7000, d / 7000 + s.ns + 5) - 0.5);
  let px = (x + wx) / 5200 + s.ns, py = (d + wd) / 5200, sum = 0, amp = 1, w = 1, f = 1, nrm = 0;
  for (let o = 0; o < 5; o++) {
    let n = ridged(px * f, py * f);
    n = Math.pow(n, 1.45) * w;          // scharfe Grate, V-förmige Täler dazwischen
    w = clamp(n * 1.6, 0, 1);
    sum += n * amp; nrm += amp;
    amp *= 0.56; f *= 2.07; px += 1.7; py += 9.2;
  }
  return clamp(Math.pow(sum / nrm * 1.7, 1.3) * 0.78 + 0.22 * fbm(x / 9000 + s.ns, d / 9000), 0, 1.3);
}
/** Grobe Form ohne Feinrelief (für Wald, Täler und die Fernsicht). */
function macro(s, x, d) {
  let best = -1e9;
  for (const hn of s.horns) { const v = hornHeight(hn, x, d, best); if (v > -1e8) best = best < -1e8 ? v : smax(best, v, 90); }
  const q = d - valleyAxis(s, x), aq = Math.abs(q), fl = floorAt(s, x, d);
  // Ketten: steigen vom Tal weg an; in der Nordflanke des Hauptgipfels zurückgenommen (die Flanke gehört dem Horn)
  const r = Math.hypot(x, d), th = Math.abs(Math.atan2(x, d));
  const face = smoothstep(1.4, 0.95, th) * smoothstep(s.DV + 300, s.DV - 900, d);
  const mask = smoothstep(s.Wv + 150, s.Wv + 3600, aq);
  const rg = s.Hv + 120 + s.rangeH * rangeNoise(s, x, d) * mask - 1100 * face - 1500 * Math.exp(-(r * r) / (2900 * 2900)) - 650 * Math.exp(-(r * r) / (8000 * 8000));   // der Hauptgipfel überragt seine Nachbarn
  best = smax(best, rg, 160);
  // Trog: unten weitet sich das Tal zur U-Form, die Flanken laufen konkav in den flachen Boden aus
  const t = smoothstep(s.Wv * 0.7, s.Wv + 1500, aq);
  best = fl + Math.max(0, best - fl) * Math.pow(t, 1.25);
  // Abflussgefälle zum Tal: kein Becken zwischen Gipfeln, überall läuft es talwärts
  const B = s.Hv - 30 + 0.16 * Math.max(0, aq - s.Wv);
  return Math.max(smax(best, B, 60), fl);
}

/** Relief auf der Makroform: Rippen und Rinnen in Falllinie, Grat-Rauschen, große Wellen. */
function detail(s, x, d, base, fine) {
  const fl = floorAt(s, x, d), above = base - fl;
  const env = smoothstep(25, 380, above);
  let y = 0;
  if (env > 0) {
    // Rippen am Hauptgipfel: Bogenlänge quer, Radius längs (stark gestreckt) – wie Spines und Couloirs
    const r = Math.hypot(x, d), th = Math.atan2(x, d), u = th * Math.max(r, 200);
    const env2 = smoothstep(40, 420, r) * env;
    if (env2 > 0) {
      const w1 = 160 * (fbm(r / 600 + s.ns, th * 4) - 0.5);
      const fade = 1 - smoothstep(s.DV - 1800, s.DV - 600, d);
      y += env2 * fade * 30 * (Math.pow(ridged((u + w1) / 210 + s.ns, r / 900), 2) - 0.45);
      if (fine) y += env2 * fade * 10 * (Math.pow(ridged((u + w1 * 0.6) / 70 + s.ns * 2, r / 380), 2) - 0.45);
    }
    // Grat-Rauschen überall in den Bergen (Nachbargipfel, Seitenflanken); in der Hauptflanke zurückgenommen,
    // denn richtungsloses Rauschen erzeugt dort Buckel quer zur Falllinie
    const fm = 1 - 0.75 * smoothstep(1.45, 1.05, Math.abs(th)) * smoothstep(s.DV - 300, s.DV - 1400, d);
    const wx = 220 * (vnoise(x / 1500 + 7, d / 1500) - 0.5), wd = 220 * (vnoise(x / 1500, d / 1500 + 3) - 0.5);
    y += fm * env * 34 * (Math.pow(ridged((x + wx) / 620 + s.ns, (d + wd) / 620), 1.6) - 0.4) * (1 - 0.5 * env2);
    y += fm * env * 16 * (ridged((x + wd) / 260, (d + wx) / 260 + s.ns) - 0.5);
    y += 22 * (fbm(x / 1700 + s.ns, d / 1700) - 0.5) * env;
    if (fine) y += env * 4 * (vnoise(x / 70, d / 70 + s.ns) - 0.5);
  }
  // Fluss im Talboden
  const q = d - valleyAxis(s, x) - riverOffset(s, x);
  y -= 2.6 * Math.exp(-(q * q) / 90) * (1 - env);
  return y;
}

// ------------------------------------------------------------------ Bau
export function init(seed, opts = {}) {
  const t0 = Date.now();
  const R = mulberry32((Math.imul(seed, 7919) + 13) >>> 0);
  const rr = (a, b) => a + (b - a) * R();
  const s = { seed, ns: R() * 300 + 3, vp1: rr(0, 6.28), vp2: rr(0, 6.28), vp3: rr(0, 6.28) };
  s.DV = rr(4700, 5300);                 // Talachse (Meter talwärts vom Gipfel)
  s.Hv = -rr(2350, 2600);                // Talboden unter dem Gipfel
  s.Wv = rr(260, 380);                   // halbe Breite des Talbodens
  s.horns = [];
  const ridgeSet = (n, spread) => { const a0 = R() * TAU, out = []; for (let i = 0; i < n; i++) out.push({ a: a0 + (i / n) * TAU + rr(-spread, spread), amp: rr(0.18, 0.3), w: rr(0.14, 0.24), bend: rr(0.1, 0.3), sd: R() * 50 }); return out; };
  // Hauptgipfel: zwei Hauptgrate rahmen die Nordflanke, zwei Grate hinten, Rippen in der Flanke
  const gL = -rr(0.95, 1.3), gR = rr(0.95, 1.3);
  const main = { x: 0, d: 0, h: 0, k: 1, kMin: 0.55, rs: 1, warp: rr(0.04, 0.1), sd: R() * 40, ridges: [
    { a: gL, amp: 0.3, w: 0.15, bend: rr(0.15, 0.3), sd: R() * 50 },
    { a: gR, amp: 0.3, w: 0.15, bend: rr(0.15, 0.3), sd: R() * 50 },
    { a: Math.PI + rr(-0.6, -0.2), amp: 0.28, w: 0.16, bend: 0.2, sd: R() * 50 },
    { a: Math.PI + rr(0.2, 0.6), amp: 0.28, w: 0.16, bend: 0.2, sd: R() * 50 },
    { a: rr(-0.35, 0.35), amp: rr(0.1, 0.16), w: 0.1, bend: rr(0.2, 0.4), sd: R() * 50 },
  ] };
  if (R() < 0.7) main.ridges.push({ a: (R() < 0.5 ? gL : gR) * rr(0.45, 0.6), amp: rr(0.08, 0.13), w: 0.09, bend: 0.3, sd: R() * 50 });
  s.horns.push(main);
  s.gL = gL; s.gR = gR;
  // Vorgipfel auf den Hauptgraten: Schultern und Scharten
  // Nachbarn auf derselben Talseite, Kette dahinter, Gegenseite des Tals, weit hinten die Hauptkette
  const add = (n, fx, fd, fh, fk) => { for (let i = 0; i < n; i++) s.horns.push({ x: fx(i), d: fd(i), h: fh(i), k: fk ? fk() : rr(0.95, 1.25), kMin: 0.55, rs: rr(0.9, 1.3), warp: rr(0.05, 0.14), sd: R() * 40, ridges: ridgeSet(3 + Math.floor(R() * 3), 0.6) }); };
  add(2, (i) => (i ? 1 : -1) * rr(3000, 4300), () => rr(-300, 1200), () => -rr(350, 750));
  add(3, (i) => -14000 + i * 14000 + rr(-3000, 3000), () => s.DV + rr(3500, 6500), () => -rr(250, 600));   // markante Gipfel gegenüber
  s.rangeH = rr(2300, 2700);

  // ---- grobes Raster (Fernsicht, 42 x 40 km)
  const cc = opts.coarseCell || 100;
  const cg = makeGrid(-21000, -16000, cc, Math.round(42000 / cc) + 1, Math.round(40000 / cc) + 1);
  for (let j = 0; j < cg.nd; j++) for (let i = 0; i < cg.nx; i++) {
    const x = cg.x0 + i * cc, d = cg.d0 + j * cc, b = macro(s, x, d);
    cg.h[j * cg.nx + i] = b + detail(s, x, d, b, false);
  }
  if (!opts.noErosion) {
    const preC = cg.h.slice();
    erode(cg, opts.cDrops ?? 70000, R, 0.6);
    keepFloor(s, cg, preC);
  }
  s.cg = cg;
  // ---- feines Raster (Spielfläche des Massivs)
  const cell = opts.cell || 10;
  const fg = makeGrid(-3400, -800, cell, Math.round(6800 / cell) + 1, Math.round((s.DV + 1700) / cell) + 1);
  for (let j = 0; j < fg.nd; j++) for (let i = 0; i < fg.nx; i++) {
    const x = fg.x0 + i * cell, d = fg.d0 + j * cell, b = macro(s, x, d);
    fg.h[j * fg.nx + i] = b + detail(s, x, d, b, true);
  }
  s.fg = fg;
  s.tMacro = Date.now() - t0;
  const pre = fg.h.slice();
  // Mindestgefälle je Zelle: im Talboden fast null (der Boden ist eben), in den Bergen deutlich
  const epsMap = new Float32Array(fg.nx * fg.nd);
  for (let j = 0; j < fg.nd; j++) for (let i = 0; i < fg.nx; i++) {
    const k = j * fg.nx + i, x = fg.x0 + i * cell, d = fg.d0 + j * cell;
    epsMap[k] = cell * lerp(0.0005, 0.13, smoothstep(20, 220, fg.h[k] - floorAt(s, x, d)));   // aufgefüllte Mulden bleiben fahrbar (Pulver braucht rund 0,15)
  }
  if (!opts.noFill) fillDepressions(fg, 0, epsMap);   // Becken zu Rampen, die Erosion schneidet dann Rinnen hinein
  if (!opts.noErosion) {
    erode(fg, opts.drops ?? 160000, R);
    thermal(fg, 1.1, 8);
    keepFloor(s, fg, pre);
  }
  s.tErode = Date.now() - t0 - s.tMacro;
  // Rand des feinen Rasters weich an das grobe anschließen
  const B = 380;
  for (let j = 0; j < fg.nd; j++) for (let i = 0; i < fg.nx; i++) {
    const e = Math.min(i, j, fg.nx - 1 - i, fg.nd - 1 - j) * cell;
    if (e >= B) continue;
    const w = smoothstep(0, B, e), x = fg.x0 + i * cell, d = fg.d0 + j * cell, k = j * fg.nx + i;
    fg.h[k] = lerp(sampleCubic(cg, x, d), fg.h[k], w);
  }
  if (!opts.noFill) { for (let k = 0; k < epsMap.length; k++) epsMap[k] *= 0.9; fillDepressions(fg, 0, epsMap); }
  // Talboden und Ziel
  s.fin = Math.round(valleyAxis(s, 0) - s.Wv - 60);
  s.end = s.DV + 650;
  s.valleyY = floorAt(s, 0, valleyAxis(s, 0));
  s.treeY = s.valleyY + rr(820, 1020);
  S = s;
  // Gefälle-, Krümmungs- und Waldkarte
  buildMaps(s);
  // Klippen (vor dem Schatten, damit die Felsbänder mitzählen)
  s.cliffs = []; s.cliffBuckets = new Map();
  placeCliffs(s, R, rr);
  // Gelände-Schatten
  s.shF = bakeShadow(s, fg, 2);
  s.shC = bakeShadow(s, cg, 1);
  // Dörfer im Tal
  s.villages = placeVillages(s, R, rr);
  s.summit = { x: 0, d: 0, y: heightDU(0, 0, s) };
  s.tAll = Date.now() - t0;
  return s;
}

// ------------------------------------------------------------------ Erosion
function erode(g, nDrops, R, str = 1) {
  const { nx, nd, h } = g;
  const SC = 1 / (g.cell * 5 / str);                        // Höhen in Zellen / 5: Gefälle pro Schritt um 0,1
  const inertia = 0.06, capF = 3.2, minCap = 0.008, depS = 0.25, eroS = 0.32, evap = 0.025, grav = 6, life = 42;
  // Pinsel (Radius 2)
  const bo = [], bw = [];
  let ws = 0;
  for (let y = -2; y <= 2; y++) for (let x = -2; x <= 2; x++) { const dd = Math.hypot(x, y); if (dd <= 2) { bo.push(y * nx + x); const w = 2 - dd + 0.15; bw.push(w); ws += w; } }
  for (let i = 0; i < bw.length; i++) bw[i] /= ws;
  for (let n = 0; n < nDrops; n++) {
    let px = 3 + R() * (nx - 7), py = 3 + R() * (nd - 7), dx = 0, dy = 0, sp = 1, wa = 1, sed = 0;
    for (let l = 0; l < life; l++) {
      const ix = px | 0, iy = py | 0, u = px - ix, v = py - iy, k = iy * nx + ix;
      const a = h[k] * SC, b = h[k + 1] * SC, c = h[k + nx] * SC, e = h[k + nx + 1] * SC;
      const gx = (b - a) * (1 - v) + (e - c) * v, gy = (c - a) * (1 - u) + (e - b) * u;
      const hOld = a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + e * u * v;
      dx = dx * inertia - gx * (1 - inertia); dy = dy * inertia - gy * (1 - inertia);
      const len = Math.hypot(dx, dy);
      if (len < 1e-6) break;
      dx /= len; dy /= len;
      px += dx; py += dy;
      if (px < 3 || py < 3 || px > nx - 4 || py > nd - 4) break;
      const jx = px | 0, jy = py | 0, u2 = px - jx, v2 = py - jy, k2 = jy * nx + jx;
      const hNew = (h[k2] * (1 - u2) * (1 - v2) + h[k2 + 1] * u2 * (1 - v2) + h[k2 + nx] * (1 - u2) * v2 + h[k2 + nx + 1] * u2 * v2) * SC;
      const dH = hNew - hOld;
      const cap = Math.max(-dH * sp * wa * capF, minCap);
      if (sed > cap || dH > 0) {
        const amt = dH > 0 ? Math.min(dH, sed) : (sed - cap) * depS;
        sed -= amt;
        const m = amt / SC;
        h[k] += m * (1 - u) * (1 - v); h[k + 1] += m * u * (1 - v); h[k + nx] += m * (1 - u) * v; h[k + nx + 1] += m * u * v;
      } else {
        const amt = Math.min((cap - sed) * eroS, -dH);
        const m = amt / SC;
        for (let q = 0; q < bo.length; q++) h[k + bo[q]] -= m * bw[q];
        sed += amt;
      }
      sp = Math.sqrt(Math.max(0, sp * sp - dH * grav));
      wa *= 1 - evap;
    }
  }
}
/** Der Fluss trägt den Schutt ab: Talboden bleibt in seiner ursprünglichen Form, zu den Hängen weich übergeblendet. */
function keepFloor(s, g, pre) {
  for (let j = 0; j < g.nd; j++) for (let i = 0; i < g.nx; i++) {
    const k = j * g.nx + i, fl = floorAt(s, g.x0 + i * g.cell, g.d0 + j * g.cell);
    const w = smoothstep(fl + 160, fl + 15, pre[k]);
    if (w > 0) g.h[k] = lerp(g.h[k], Math.min(g.h[k], pre[k] + 3), w);
  }
}
/** Hangrutschung: was steiler als der Schuttwinkel ist, rutscht nach unten. */
function thermal(g, talus, passes) {
  const { nx, nd, h, cell } = g, lim = talus * cell, offs = [-1, 1, -nx, nx];
  for (let p = 0; p < passes; p++) {
    for (let j = 1; j < nd - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      let mx = 0, mk = -1;
      for (let q = 0; q < 4; q++) { const df = h[k] - h[k + offs[q]]; if (df > mx) { mx = df; mk = k + offs[q]; } }
      if (mx > lim) { const mv = (mx - lim) * 0.5; h[k] -= mv; h[mk] += mv; }
    }
  }
}
/** Priority-Flood: jede Zelle bekommt einen Abfluss zum Rand mit Mindestgefälle eps (Meter pro Zelle). */
function fillDepressions(g, eps, epsMap) {
  const { nx, nd, h } = g, n = nx * nd;
  const done = new Uint8Array(n);
  const hk = new Float64Array(n + 1), hi = new Int32Array(n + 1);
  let sz = 0;
  const push = (k) => {
    let c = ++sz; const v = h[k];
    while (c > 1 && hk[c >> 1] > v) { hk[c] = hk[c >> 1]; hi[c] = hi[c >> 1]; c >>= 1; }
    hk[c] = v; hi[c] = k;
  };
  const pop = () => {
    const k = hi[1], lv = hk[sz], lk = hi[sz]; sz--;
    let c = 1;
    for (;;) { let m = c * 2; if (m > sz) break; if (m + 1 <= sz && hk[m + 1] < hk[m]) m++; if (hk[m] >= lv) break; hk[c] = hk[m]; hi[c] = hi[m]; c = m; }
    hk[c] = lv; hi[c] = lk;
    return k;
  };
  for (let i = 0; i < nx; i++) for (const j of [0, nd - 1]) { const k = j * nx + i; if (!done[k]) { done[k] = 1; push(k); } }
  for (let j = 0; j < nd; j++) for (const i of [0, nx - 1]) { const k = j * nx + i; if (!done[k]) { done[k] = 1; push(k); } }
  const OX = [-1, 1, 0, 0, -1, 1, -1, 1], OY = [0, 0, -1, 1, -1, -1, 1, 1], OD = [1, 1, 1, 1, 1.414, 1.414, 1.414, 1.414];
  while (sz > 0) {
    const k = pop(), i = k % nx, j = (k / nx) | 0;
    for (let q = 0; q < 8; q++) {
      const ii = i + OX[q], jj = j + OY[q];
      if (ii < 0 || jj < 0 || ii >= nx || jj >= nd) continue;
      const kk = jj * nx + ii;
      if (done[kk]) continue;
      done[kk] = 1;
      const need = h[k] + (epsMap ? epsMap[kk] : eps) * OD[q];
      if (h[kk] < need) h[kk] = need;
      push(kk);
    }
  }
}

// ------------------------------------------------------------------ Karten: Gefälle, Krümmung, Wald, Gletscher
function buildMaps(s) {
  const g = s.fg, { nx, nd, h, cell } = g, n = nx * nd;
  s.slope = new Float32Array(n); s.curv = new Float32Array(n); s.forest = new Float32Array(n); s.glacier = new Float32Array(n);
  for (let j = 1; j < nd - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const k = j * nx + i;
    const gx = (h[k + 1] - h[k - 1]) / (2 * cell), gd = (h[k + nx] - h[k - nx]) / (2 * cell);
    s.slope[k] = Math.hypot(gx, gd);
    // Krümmung auf 30 m: positiv = Mulde/Rinne, negativ = Rücken/Grat
    const i3 = clamp(i, 3, nx - 4), j3 = clamp(j, 3, nd - 4), k3 = j3 * nx + i3;
    s.curv[k] = (h[k3 - 3] + h[k3 + 3] + h[k3 - 3 * nx] + h[k3 + 3 * nx] - 4 * h[k3]) / (9 * cell * cell);
  }
  for (let j = 0; j < nd; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = g.x0 + i * cell, d = g.d0 + j * cell, y = h[k];
    const fl = floorAt(s, x, d);
    // Baumgrenze: unregelmäßig, oben nur Baumgruppen
    const tl = s.treeY + 140 * (fbm(x / 600 + s.ns, d / 600) - 0.5);
    let f = smoothstep(tl + 30, tl - 160, y);
    f *= smoothstep(0.95, 0.55, s.slope[k]);                                             // zu steil für Wald
    f *= 1 - smoothstep(0.0012, 0.006, s.curv[k]) * smoothstep(fl + 60, fl + 260, y);    // Lawinenrinnen bleiben frei
    const cl = fbm(x / 95 + s.ns * 3, d / 95);
    f *= lerp(smoothstep(0.32, 0.62, cl), 1, smoothstep(tl - 150, tl - 420, y) * 0.75);  // oben Baumgruppen, unten dichter
    f *= smoothstep(fl + 28, fl + 70, y) * 0.97 + 0.03 * smoothstep(0.7, 0.78, cl);      // Talboden offen (Wiesen), nur vereinzelt Gehölze
    const q = d - valleyAxis(s, x) - riverOffset(s, x);
    f *= smoothstep(10, 26, Math.abs(q));                                                // nicht im Fluss
    s.forest[k] = clamp(f, 0, 1);
    // Gletscher: hohe, flache Mulden (Kare)
    s.glacier[k] = smoothstep(0.0003, 0.0018, s.curv[k]) * smoothstep(0.75, 0.4, s.slope[k]) * smoothstep(s.treeY + 600, s.treeY + 900, y);
  }
}

// ------------------------------------------------------------------ Klippen
// Ein Höhenfeld kann keine Wand: oberhalb der Kante wird eine Bank angehoben, an der Kante fällt sie auf 1,6 m ab.
// Davor stellt world.js eine eigene Felswand. Ausrichtung: quer zur örtlichen Falllinie.
const toLocal = (c, x, d) => [(x - c.x) * c.fx + (d - c.d) * c.fd, (x - c.x) * c.ax + (d - c.d) * c.ad];
const edgeA = (c, u) => c.wA * Math.sin(u / c.wL + c.wP) + c.tilt * u;
const sideLo = (c, dd) => c.u0 + clamp(-dd / c.Lup, 0, 1) * c.tpL * (c.u1 - c.u0) + c.wn * Math.sin(dd / 8.5 + c.wP);
const sideHi = (c, dd) => c.u1 - clamp(-dd / c.Lup, 0, 1) * c.tpR * (c.u1 - c.u0) + c.wn * Math.sin(dd / 7.1 + c.wP * 1.7);
function cliffDelta(c, x, d) {
  const al = (x - c.x) * c.fx + (d - c.d) * c.fd, u = (x - c.x) * c.ax + (d - c.d) * c.ad;
  if (u < c.u0 - 4 || u > c.u1 + 4) return 0;
  const dd = al - edgeA(c, u);
  if (dd < -c.Lup || dd > 1.6) return 0;
  const lo = sideLo(c, dd), hi = sideHi(c, dd);
  const wl = smoothstep(lo - 1.2, lo + 1.2, u) * (1 - smoothstep(hi - 1.2, hi + 1.2, u));
  if (wl <= 0) return 0;
  if (dd < 0) { const t = 1 + dd / c.Lup; return c.h * t * t * wl * (1 + 0.16 * (1 - t) * 4 * t * (vnoise(u / 13 + c.wP, al / 13) - 0.5) * 2); }
  return c.h * (1 - smoothstep(0, 1.6, dd)) * wl;
}
const bucketKey = (x, d) => (Math.floor(x / 100) + 500) * 1000 + Math.floor(d / 100) + 500;
function placeCliffs(s, R, rr) {
  const g = s.fg, { nx, cell } = g;
  for (let t = 0; t < 2600 && s.cliffs.length < 46; t++) {
    const x = rr(-2600, 2600), d = rr(250, s.DV - 900);
    const i = Math.round((x - g.x0) / cell), j = Math.round((d - g.d0) / cell), k = j * nx + i;
    const sl = s.slope[k];
    if (sl < 0.42 || sl > 0.95) continue;
    if (s.forest[k] > 0.25 || s.glacier[k] > 0.3) continue;
    const y = g.h[k];
    if (R() > lerp(1, 0.25, smoothstep(s.treeY + 900, s.treeY, y))) continue;   // oben häufiger
    // Falllinie aus einem größeren Fenster, damit die Kante nicht schräg im Hang liegt
    const gx = (g.h[k + 4] - g.h[k - 4]) / (8 * cell), gd = (g.h[k + 4 * nx] - g.h[k - 4 * nx]) / (8 * cell);
    const gl = Math.hypot(gx, gd);
    if (gl < 0.35) continue;
    const fx = -gx / gl, fd = -gd / gl;
    const w = rr(18, 60), h = rr(8, 38) * lerp(0.55, 1, smoothstep(s.treeY + 100, s.treeY + 900, y));
    const c = { x, d, fx, fd, ax: fd, ad: -fx, u0: -w / 2, u1: w / 2, h, ice: s.glacier[k] > 0.1, wA: rr(1.5, 5), wL: rr(12, 26), wP: rr(0, 6.28), tilt: rr(-0.06, 0.06), tpL: rr(0.08, 0.34), tpR: rr(0.08, 0.34), wn: rr(0.8, 2.2) };
    if (s.cliffs.some((o) => Math.hypot(o.x - x, o.d - d) < 70 + (o.u1 - o.u0) / 2 + w / 2)) continue;
    // Bank nach örtlichem Gefälle auslegen: oberhalb der Kante darf es nie flach werden
    let sMin = 9;
    for (const fu of [-0.4, 0, 0.4]) {
      const px = x + c.ax * w * fu, pd = d + c.ad * w * fu;
      const a = sampleCubic(g, px - fx * 55, pd - fd * 55), b = sampleCubic(g, px, pd), m = sampleCubic(g, px - fx * 14, pd - fd * 14);
      sMin = Math.min(sMin, (a - b) / 55, (m - b) / 14);
    }
    if (sMin < 0.4) continue;
    c.Lup = (2 * h) / (sMin - 0.24);
    if (c.Lup > 220) continue;
    // Landung prüfen (mit eingetragener Bank), notfalls niedriger machen
    s.cliffs.push(c); addBucket(s, c);
    let ok = false;
    for (let it = 0; it < 8; it++) {
      let worst = 0;
      for (const fu of [-0.25, 0, 0.25]) for (const v of [4, 9, 15, 22, 30]) worst = Math.max(worst, flightImpact(c, (c.u1 - c.u0) * fu, v, null, s));
      c.worst = worst;
      if (worst < 16) { ok = true; break; }
      c.h *= 0.82; c.Lup *= 0.82;
    }
    if (!ok || c.h < 6) { s.cliffs.pop(); removeBucket(s, c); }
  }
  s.cliffs.forEach((c, i) => { c.id = i; });
}
function addBucket(s, c) {
  const r = Math.max(c.Lup, 8) + Math.max(Math.abs(c.u0), Math.abs(c.u1)) + 12;
  for (let x = Math.floor((c.x - r) / 100); x <= Math.floor((c.x + r) / 100); x++) for (let d = Math.floor((c.d - r) / 100); d <= Math.floor((c.d + r) / 100); d++) {
    const key = (x + 500) * 1000 + d + 500;
    if (!s.cliffBuckets.has(key)) s.cliffBuckets.set(key, []);
    s.cliffBuckets.get(key).push(c);
  }
}
function removeBucket(s, c) { for (const l of s.cliffBuckets.values()) { const i = l.indexOf(c); if (i >= 0) l.splice(i, 1); } }

/** Flug über die Kante mit Tempo v: Normalgeschwindigkeit beim Aufsetzen (mit Pulver-Dämpfung wie in der Physik). */
export function flightImpact(c, u, v, out, s = S) {
  const P = (al) => { const ae = edgeA(c, u) + al; return heightDU(c.d + c.fd * ae + c.ad * u, c.x + c.fx * ae + c.ax * u, s); };
  const a0 = -0.3, h0 = P(a0), h1 = P(a0 - 2), sl = (h1 - h0) / 2, inv = 1 / Math.hypot(1, sl);
  let al = a0, y = h0, va = v * inv, vy = -v * sl * inv;
  const dt = 0.02;
  for (let t = 0; t < 12; t += dt) {
    vy -= G * dt; al += va * dt; y += vy * dt;
    if (al > 1.6 && y <= P(al)) {
      const sd = (P(al + 0.6) - P(al - 0.6)) / 1.2, k = 1 / Math.hypot(1, sd);
      const vn = -(va * -sd * k + vy * k);
      if (out) { out.dist = al; out.t = t; }
      return Math.max(0, vn) * 0.58;
    }
  }
  return 99;
}
export const cliffPoint = (c, al, u) => ({ x: c.x + c.fx * (edgeA(c, u) + al) + c.ax * u, d: c.d + c.fd * (edgeA(c, u) + al) + c.ad * u });

// ------------------------------------------------------------------ Gelände-Schatten
function bakeShadow(s, g, step) {
  const nx = Math.ceil(g.nx / step), nd = Math.ceil(g.nd / step), out = new Uint8Array(nx * nd);
  const sx = SUN[0], sy = SUN[1], sdd = -SUN[2];   // d = -z
  const hl = Math.hypot(sx, sdd), tanE = sy / hl, ux = sx / hl, ud = sdd / hl;
  const fg = s.fg, cg = s.cg;
  const H = (x, d) => (inGrid(fg, x, d, 1) ? sampleLin(fg, fg.h, x, d) : sampleLin(cg, cg.h, x, d));
  for (let j = 0; j < nd; j++) for (let i = 0; i < nx; i++) {
    const ii = Math.min(g.nx - 1, i * step), jj = Math.min(g.nd - 1, j * step);
    const x = g.x0 + ii * g.cell, d = g.d0 + jj * g.cell, y0 = g.h[jj * g.nx + ii] + 1.5;
    let lit = 1, dist = g.cell * 0.8, st = g.cell * 0.8;
    while (dist < 9000) {
      const ter = H(x + ux * dist, d + ud * dist), ray = y0 + tanE * dist;
      lit = Math.min(lit, (ray - ter) / (dist * 0.035) + 0.5);   // weicher Halbschatten
      if (lit <= 0) { lit = 0; break; }
      if (ray > 1200) break;
      dist += st; st *= 1.06;
    }
    out[j * nx + i] = Math.round(clamp(lit, 0, 1) * 255);
  }
  return { nx, nd, x0: g.x0, d0: g.d0, cell: g.cell * step, data: out };
}
/** Sonnenlicht 0..1 an (x, d) aus dem vorab berechneten Gelände-Schatten. */
export function sunAt(x, d) {
  const s = S, sh = inGrid(s.fg, x, d, 1) ? s.shF : s.shC;
  const fx = clamp((x - sh.x0) / sh.cell, 0, sh.nx - 1.001), fd = clamp((d - sh.d0) / sh.cell, 0, sh.nd - 1.001);
  const i = Math.floor(fx), j = Math.floor(fd), tx = fx - i, td = fd - j, k = j * sh.nx + i, a = sh.data;
  return ((a[k] * (1 - tx) + a[k + 1] * tx) * (1 - td) + (a[k + sh.nx] * (1 - tx) + a[k + sh.nx + 1] * tx) * td) / 255;
}

// ------------------------------------------------------------------ Dörfer
function placeVillages(s, R, rr) {
  const out = [];
  const spots = [rr(-500, 500), rr(-6500, -3500), rr(3500, 7000), rr(-12000, -9000), rr(9000, 12500)];
  spots.forEach((vx, n) => {
    const side = R() < 0.5 ? -1 : 1;
    const cx = vx, cd = valleyAxis(s, vx) + side * s.Wv * rr(0.3, 0.7);
    const houses = [];
    const N = n === 0 ? 24 : 10 + Math.floor(R() * 16);
    for (let h = 0; h < N; h++) {
      const a = R() * TAU, r = Math.sqrt(R()) * (n === 0 ? 170 : 130);
      const x = cx + Math.cos(a) * r * 1.6, d = cd + Math.sin(a) * r * 0.6;
      const q = d - valleyAxis(s, x) - riverOffset(s, x);
      if (Math.abs(q) < 24) continue;
      houses.push({ x, d, rot: (R() < 0.5 ? 0 : Math.PI / 2) + rr(-0.15, 0.15), sc: rr(0.85, 1.25), big: R() < 0.12 });
    }
    out.push({ x: cx, d: cd, houses });
  });
  return out;
}

// ------------------------------------------------------------------ Abfragen für Spiel, Physik und Grafik
/** Höhe in Berg-Koordinaten (d talwärts, x quer). */
export function heightDU(d, x, s = S) {
  const fg = s.fg;
  if (!inGrid(fg, x, d)) return sampleCubic(s.cg, x, d);
  let y = sampleCubic(fg, x, d);
  // feine Unruhe im Schnee (das Raster hat 10 m)
  y += 0.9 * (vnoise(x / 19 + 3, d / 19 + s.ns) - 0.5) + 0.3 * (vnoise(x / 6.5, d / 6.5) - 0.5);
  const l = s.cliffBuckets && s.cliffBuckets.get(bucketKey(x, d));
  if (l) for (let i = 0; i < l.length; i++) y += cliffDelta(l[i], x, d);
  return y;
}
/** Höhe ohne Feinrauschen und Klippen (für Fernsicht und Bäume in der Ferne). */
export function heightCoarse(x, d) { const s = S; return inGrid(s.fg, x, d) ? sampleCubic(s.fg, x, d) : sampleCubic(s.cg, x, d); }
export function heightH(x, z) { return heightDU(-z, x); }
export const hubX = () => 0;
export const Hof = () => S.valleyY;
export const boundAt = () => ({ c: 0, u: 3150, fall: false });
export function slopeAt(x, d) { const g = S.fg; return inGrid(g, x, d, 1) ? sampleLin(g, S.slope, x, d) : 0.3; }
export function forestAt(x, d) { const g = S.fg; return inGrid(g, x, d, 1) ? sampleLin(g, S.forest, x, d) : 0; }
export function glacierAt(x, d) { const g = S.fg; return inGrid(g, x, d, 1) ? sampleLin(g, S.glacier, x, d) : 0; }
export function curvAt(x, d) { const g = S.fg; return inGrid(g, x, d, 1) ? sampleLin(g, S.curv, x, d) : 0; }
export const floorY = (x, d) => floorAt(S, x, d);
export const riverD = (x) => valleyAxis(S, x) + riverOffset(S, x);
export const valleyD = (x) => valleyAxis(S, x);
/** Ziel erreicht: unten im Talboden angekommen. */
export function finished(x, d) {
  if (d < S.DV - S.Wv - 1300) return false;
  const ax = valleyAxis(S, x);
  return heightDU(d, x) < floorAt(S, x, ax) + 45;   // auf Höhe des Talbodens angekommen (auch am Hangfuß)
}

export const SI = { edge: 30, groom: 0, pow: 1, forest: 0, lane: 0, u: 0, lx: 0, kind: 0, hub: 0, valley: 3150 };
export function surf(x, d) {
  SI.u = x; SI.hub = 0; SI.lx = x;
  const fl = floorAt(S, x, d), y = inGrid(S.fg, x, d, 1) ? sampleLin(S.fg, S.fg.h, x, d) : fl + 100;
  SI.pow = lerp(0.4, 1, smoothstep(fl + 4, fl + 40, y));
  SI.forest = forestAt(x, d);
  SI.groom = 0;
  return SI;
}
export function zoneAt() { return { type: 'heli', idx: 0, label: '' }; }
export function nearCliff(x, d, m) {
  const l = S.cliffBuckets.get(bucketKey(x, d));
  if (!l) return false;
  for (const c of l) { const [al, u] = toLocal(c, x, d); if (u > c.u0 - m && u < c.u1 + m && al > -c.Lup - m && al < 30 + c.h * 2.2 + m) return true; }
  return false;
}

/** Bäume, Felsen und Felswände einer Kachel (Weltkoordinaten, Kante T Meter), deterministisch. */
export function genTile(ti, tj, T, treeMul, addCollider) {
  const s = S, x0 = ti * T, d0 = tj * T;
  const R = mulberry32((Math.imul(s.seed, 2654435761) ^ Math.imul(ti + 7000, 40503) ^ Math.imul(tj + 9000, 69069)) >>> 0);
  const out = { trees: [], rocks: [], markers: [], decor: [], caves: [], walls: [], houses: [] };
  if (!inGrid(s.fg, x0 + T / 2, d0 + T / 2, 3)) return out;
  // Wald
  const N = Math.round(900 * treeMul);
  for (let n = 0; n < N; n++) {
    const x = x0 + R() * T, d = d0 + R() * T, pr = R(), sc0 = R(), rot = R() * TAU, tint = 0.82 + R() * 0.36, vr = R(), vr2 = R();
    const f = forestAt(x, d);
    if (f < 0.02 || pr > f * 0.28) continue;   // etwa 6 bis 7 m Baumabstand im dichten Wald: fahrbar wie echter Heli-Wald
    if (nearCliff(x, d, 4)) continue;
    const z = -d, hh = heightH(x, z);
    if (Math.abs(heightH(x + 1.4, z) - hh) > 1.6 || Math.abs(heightH(x, z - 1.4) - hh) > 1.8) continue;
    const scale = (0.7 + sc0 * 0.9) * lerp(0.75, 1.15, f);
    out.trees.push({ x, z, y: hh - 0.15, scale, rot, variant: vr < 0.45 ? 0 : vr2 < 0.6 ? 1 : 2, tint });
    addCollider(x, z, 0.5 * scale + 0.15, 'baum');
  }
  // Felsblöcke: wenige, große, auf steilen Rippen
  for (let n = 0; n < 14; n++) {
    const x = x0 + R() * T, d = d0 + R() * T, sc = R(), vr = Math.floor(R() * 6), rot = R() * TAU, pr = R();
    const sl = slopeAt(x, d), cv = curvAt(x, d);
    if (sl < 0.85 || cv > -0.001 || pr > 0.2 || forestAt(x, d) > 0.3 || Math.hypot(x, d) < 220) continue;
    const scale = 1.8 + sc * 3.4;
    let y = heightH(x, -d);
    for (let q = 0; q < 6; q++) { const a = q * 1.047; y = Math.min(y, heightH(x + Math.cos(a) * scale, -d + Math.sin(a) * scale)); }
    out.rocks.push({ x, z: -d, y: y - 0.2 * scale, scale, rot, variant: vr });
    addCollider(x, -d, 1.1 * scale, 'fels');
  }
  // Felswände der Klippen, deren Kante in dieser Kachel liegt, dazu Blöcke am Wandfuß
  for (const c of s.cliffs) {
    if (c.x < x0 || c.x >= x0 + T || c.d < d0 || c.d >= d0 + T) continue;
    out.walls.push(c);
    const nB = c.ice ? 0 : 1 + Math.floor(R() * 2.4);
    for (let k = 0; k < nB; k++) {
      const u = R() < 0.5 ? c.u0 - 3 - R() * 5 : c.u1 + 3 + R() * 5, p = cliffPoint(c, 4 + R() * 7, u), sc = 1.7 + R() * 2.3;
      out.rocks.push({ x: p.x, z: -p.d, y: heightH(p.x, -p.d) - 0.35 * sc, scale: sc, rot: R() * TAU, variant: Math.floor(R() * 6) });
      addCollider(p.x, -p.d, 1.15 * sc, 'fels');
    }
  }
  // Häuser im Tal
  for (const v of s.villages) for (const h of v.houses) {
    if (h.x < x0 || h.x >= x0 + T || h.d < d0 || h.d >= d0 + T) continue;
    out.houses.push(h);
    addCollider(h.x, -h.d, 5.2 * h.sc, 'haus');
  }
  return out;
}
export const chalets = () => [];

/** Stützpunkte einer Felswand in Weltkoordinaten: Kante von links nach rechts, dazu die Seitenwände bergauf. */
export function wallLine(c) {
  const pts = [];
  const push = (al, u, nal, nu) => {
    const x = c.x + c.fx * al + c.ax * u, d = c.d + c.fd * al + c.ad * u;
    const wx = c.fx * nal + c.ax * nu, wd = c.fd * nal + c.ad * nu, l = Math.hypot(wx, wd) || 1;
    pts.push({ x, d, z: -d, nx: wx / l, nz: -wd / l });
  };
  for (let t = Math.min(c.Lup * 0.85, 76); t > 3; t -= 3.2) push(edgeA(c, c.u0) - t, sideLo(c, -t), 0, -1);
  push(edgeA(c, c.u0) - 0.5, sideLo(c, -0.5) + 0.4, 0.7, -0.7);
  for (let u = sideLo(c, 0) + 2.4; u < sideHi(c, 0) - 2.0; u += 1.9) push(edgeA(c, u) + 0.2, u, 1, 0);
  push(edgeA(c, c.u1) - 0.5, sideHi(c, -0.5) - 0.4, 0.7, 0.7);
  for (let t = 3.2; t < Math.min(c.Lup * 0.85, 76); t += 3.2) push(edgeA(c, c.u1) - t, sideHi(c, -t), 0, 1);
  return pts;
}
/** Absprungpunkt des Helikopters: knapp unter dem Gipfel auf der Talseite. */
export function dropPoint() { const d = 34, x = 0; return { x, d, y: heightDU(d, x) }; }
