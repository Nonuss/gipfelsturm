// Ultra: fein modellierte, verschneite Fichten in drei Feinheitsstufen aus demselben Bauplan (world.js tauscht je nach
// Entfernung zur Kamera): nah rund 5000, mittel rund 1300, fern rund 350 Dreiecke. So sieht auf Ultra jeder Baum gleich aus.
// Gleiche Höhe und gleicher Kronenradius wie die Vorlage TreeA/B/C, damit Wald, Kollisionen und Strecke gleich bleiben.
// Aufbau: Stamm, 16 bis 18 Astquirle aus einzelnen, hängenden Zweigfächern (Querschnitt mit Grat, Ränder gezackt),
// Schneepolster auf der Astmitte, grüne Astränder, dunkle Unterseite; unten lang und hängend, oben kurz und steil.
import * as THREE from 'three';

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Farben wie die Vorlage (Nadeln, Unterseite, Schnee), damit Ultra den Wald verfeinert statt umzufärben
const NEEDLE = [0.024, 0.118, 0.055], NEEDLE_TIP = [0.04, 0.15, 0.07], NEEDLE_DARK = [0.012, 0.042, 0.022];
const SNOW = [0.86, 0.905, 0.97], SNOW_EDGE = [0.74, 0.8, 0.88];
const BARK = [0.13, 0.095, 0.07];

// Innerer Nadelkern: dunkler, leicht gezackter Kegel um den Stamm. Echte Fichten sind oben nicht durchsichtig; ohne
// Kern sieht man in den gröberen Stufen den Stamm zwischen den Quirlen (Pagodenform) und in der Ferne schwebende Spitzen.
function addCore(vtx, idx, r, h, R, yb, yt, n, rings) {
  const ring = [];
  for (let k = 0; k <= rings; k++) {
    const t = k / rings, y = yb + (yt - yb) * t, rr = R * 0.3 * Math.pow(1 - t, 0.9) + 0.03;
    ring.push(Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2 + k * 0.5, j = 0.85 + r() * 0.3; return vtx(Math.cos(a) * rr * j, y, Math.sin(a) * rr * j, mix3(NEEDLE_DARK, NEEDLE, 0.35 + 0.4 * t)); }));
  }
  for (let k = 0; k < rings; k++) for (let i = 0; i < n; i++) {
    const a = ring[k][i], b = ring[k][(i + 1) % n], c = ring[k + 1][i], d = ring[k + 1][(i + 1) % n];
    idx.push(a, c, b, b, c, d);
  }
}
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** h: Gesamthöhe (ab y = 0), R: Kronenradius unten, y0: Unterkante (wie die Vorlage leicht im Boden), lod 0 nah, 1 mittel, 2 fern. */
function makeFir({ h, R, y0 = -0.4, seed = 1, lod = 0 }) {
  const r = rng(seed);
  const pos = [], col = [], idx = [];
  const vtx = (x, y, z, c) => { pos.push(x, y, z); col.push(c[0], c[1], c[2]); return pos.length / 3 - 1; };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

  // Stamm
  {
    const n = [8, 6, 5][lod], nr = [5, 3, 2][lod], top = h * 0.9, rb = Math.max(0.17, R * 0.07), rt = 0.05;
    const rings = [];
    for (let k = 0; k <= nr; k++) {
      const t = k / nr, y = y0 + (top - y0) * t, rr = rb + (rt - rb) * Math.pow(t, 0.8);
      rings.push(Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return vtx(Math.cos(a) * rr, y, Math.sin(a) * rr, BARK.map((c) => c * (0.8 + 0.25 * Math.cos(a - 2.2)))); }));
    }
    for (let k = 0; k < nr; k++) for (let i = 0; i < n; i++) {
      const a = rings[k][i], b = rings[k][(i + 1) % n], c = rings[k + 1][i], d = rings[k + 1][(i + 1) % n];
      idx.push(a, c, b, b, c, d);
    }
  }

  // Ein Ast: hängender, flacher Zweigfächer vom Stamm nach außen. Querschnitt mit erhöhtem Grat (Oberseite: linker Rand,
  // Grat, rechter Rand), darunter eine dunkle Unterseite. Ränder gezackt (Nadelbüschel), Schnee nur auf der Astmitte.
  const SEG = [3, 2, 1][lod], WK = [1, 1.5, 1.5][lod];   // gröbere Stufen: weniger, dafür breitere Äste (gleiche Dichte)
  const COLS = lod === 0
    ? [[1, -0.3, 0], [0.5, 0.06, 1.4], [0, 0.22, 1.6], [-0.5, 0.06, 1.4], [-1, -0.3, 0]]   // Rand, Polsterrand, Grat, Polsterrand, Rand
    : [[1, -0.28, 0.55], [0, 0.22, 1.6], [-1, -0.28, 0.55]];
  function branch(y, ang, L, W, droop, snow, tipUp) {
    const ca = Math.cos(ang), sa = Math.sin(ang), px = -sa, pz = ca;     // Richtung und Querachse
    const jag = Array.from({ length: SEG + 1 }, () => 0.75 + r() * 0.5);
    const snowEnd = 0.45 + r() * 0.4;                              // bis wohin der Schnee auf dem Ast liegt
    const rowsT = [], rowsB = [];
    for (let j = 0; j <= SEG; j++) {
      const t = j / SEG;
      const d = L * (0.06 + 0.94 * t);
      const yy = y + L * (0.1 * t) - droop * t * t + tipUp * Math.pow(t, 6);
      const w = W * Math.pow(Math.sin(Math.PI * (0.12 + 0.8 * t)), 0.75) * jag[j] * (j === SEG ? 0.25 : 1);
      const cx = ca * d, cz = sa * d;
      const s = snow * (t < 0.1 ? 0.3 : 1) * Math.max(0, Math.min(1, (snowEnd - t) * 5 + 0.3));
      const pile = s * Math.min(0.3, 0.08 + W * 0.16);             // Polster auf der Astmitte
      const green = mix(NEEDLE, NEEDLE_TIP, t * t), edge = mix(NEEDLE_TIP, NEEDLE, 0.4);
      const sc = mix(SNOW_EDGE, SNOW, 0.55 + 0.45 * t);
      // Oberseite quer: Rand (grün, tiefer), Polsterränder, Grat (in den gröberen Stufen nur Rand, Grat, Rand)
      const row = [];
      for (const [q, up, sk] of COLS) {
        const c = Math.abs(q) > 0.9 ? mix(edge, sc, Math.min(1, s * sk) * 0.5) : mix(green, sc, Math.min(1, s * sk));
        const lift = up * w + (Math.abs(q) < 0.9 ? pile * (1 - Math.abs(q) * 0.55) : 0);
        row.push(vtx(cx + px * w * q, yy + lift, cz + pz * w * q, c));
      }
      rowsT.push(row);
      // Unterseite (etwas schmaler, tiefer, dunkel)
      const dark = mix(NEEDLE_DARK, NEEDLE, 0.3 * t);
      rowsB.push([
        vtx(cx + px * w * 0.8, yy - w * 0.42, cz + pz * w * 0.8, dark),
        vtx(cx, yy - w * 0.14 - 0.04, cz, NEEDLE_DARK),
        vtx(cx - px * w * 0.8, yy - w * 0.42, cz - pz * w * 0.8, dark),
      ]);
    }
    const last = COLS.length - 1;
    for (let j = 0; j < SEG; j++) {
      const A = rowsT[j], B = rowsT[j + 1];
      for (let c = 0; c < last; c++) idx.push(A[c], B[c], A[c + 1], A[c + 1], B[c], B[c + 1]);
      const [c0, c1, c2] = rowsB[j], [d0, d1, d2] = rowsB[j + 1];
      idx.push(c0, c1, d0, c1, d1, d0, c1, c2, d1, c2, d2, d1);
      // Ränder zwischen Ober- und Unterseite
      idx.push(A[0], c0, B[0], B[0], c0, d0, A[last], B[last], c2, B[last], d2, c2);
    }
  }

  // Astquirle von unten nach oben: unten lang und hängend, oben kurz und steil; dazwischen kleine Zwischenäste
  const yLow = h * 0.05, yTop = h * 0.95, tiers = Math.round([11, 10, 5][lod] + h * [0.5, 0.45, 0.2][lod]);
  for (let k = 0; k < tiers; k++) {
    const u = k / (tiers - 1);
    const y = yLow + (yTop - yLow) * Math.pow(u, 0.95) + (r() - 0.5) * h * 0.015;
    const reach = R * (Math.pow(1 - u, 0.9) * 0.93 + 0.07);
    const n = Math.max(4, Math.round([5, 4, 4][lod] + (1 - u) * [4, 2, 1][lod] + r() * [2, 1, 1][lod]));
    const rot = r() * Math.PI * 2;
    for (let b = 0; b < n; b++) {
      const ang = rot + (b / n) * Math.PI * 2 + (r() - 0.5) * 0.5;
      const L = reach * (0.75 + r() * 0.35);
      const W = Math.max(0.12, L * (0.3 + r() * 0.08) * WK);
      const droop = L * (0.42 + 0.25 * (1 - u)) * (0.8 + r() * 0.4);
      const snow = r() < 0.22 ? 0 : 0.45 + r() * 0.5;
      branch(y, ang, L, W, droop, snow, L * 0.08);
    }
  }
  addCore(vtx, idx, r, h, R, h * 0.2, h * 0.97, [7, 6, 5][lod], [4, 3, 2][lod]);
  // Spitze
  {
    const n = 7, yb = yTop, ya = h + 0.1, rb = R * 0.05;
    const tip = vtx(0, ya, 0, NEEDLE_TIP), ring = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ring.push(vtx(Math.cos(a) * rb, yb, Math.sin(a) * rb, NEEDLE)); }
    for (let i = 0; i < n; i++) idx.push(tip, ring[(i + 1) % n], ring[i]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  g.userData.shared = true;
  return g;
}

/** Grobe Fassung für die Ferne: je Etage eine sternförmige, hängende Astschürze (grüne Zweigspitzen, Schnee innen und
 * auf den Graten), dazu Stamm und Spitze. Wirkt aus der Ferne so voll wie die feine Fichte, mit rund 300 Dreiecken. */
function makeFirFar({ h, R, y0 = -0.4, seed = 1 }) {
  const r = rng(seed + 7);
  const pos = [], col = [], idx = [];
  const vtx = (x, y, z, c) => { pos.push(x, y, z); col.push(c[0], c[1], c[2]); return pos.length / 3 - 1; };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  { // Stamm (unten sichtbar)
    const n = 5, rb = Math.max(0.17, R * 0.07), ring0 = [], ring1 = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ring0.push(vtx(Math.cos(a) * rb, y0, Math.sin(a) * rb, BARK)); ring1.push(vtx(Math.cos(a) * rb * 0.6, h * 0.35, Math.sin(a) * rb * 0.6, BARK)); }
    for (let i = 0; i < n; i++) { const a = ring0[i], b = ring0[(i + 1) % n], c = ring1[i], d = ring1[(i + 1) % n]; idx.push(a, c, b, b, c, d); }
  }
  const tiers = Math.round(6 + h * 0.22), yLow = h * 0.06, yTop = h * 0.93;
  for (let k = 0; k < tiers; k++) {
    const u = k / (tiers - 1), y = yLow + (yTop - yLow) * u;
    const Rk = R * (Math.pow(1 - u, 0.9) * 0.95 + 0.08) * (0.95 + r() * 0.1);
    const lobes = 7, seg = lobes * 2, rot = r() * Math.PI * 2, droop = Rk * (0.5 + 0.2 * (1 - u)), lift = Rk * 0.35;
    const top = vtx(0, y + lift, 0, mix(NEEDLE, SNOW, 0.75)), bot = vtx(0, y + lift - Rk * 0.25, 0, NEEDLE_DARK);
    const rim = [], rimB = [];
    for (let i = 0; i < seg; i++) {
      const tip = i % 2 === 0, a = rot + (i / seg) * Math.PI * 2, rr = Rk * (tip ? 1 : 0.62) * (0.9 + r() * 0.2);
      const yy = y - droop * (tip ? 1 : 0.7), c = tip ? NEEDLE_TIP : mix(NEEDLE, SNOW_EDGE, 0.55 * (0.6 + 0.4 * u));
      rim.push(vtx(Math.cos(a) * rr, yy, Math.sin(a) * rr, c));
      rimB.push(vtx(Math.cos(a) * rr * 0.92, yy - Rk * 0.12, Math.sin(a) * rr * 0.92, NEEDLE_DARK));
    }
    for (let i = 0; i < seg; i++) { const i2 = (i + 1) % seg; idx.push(top, rim[i2], rim[i]); idx.push(bot, rimB[i], rimB[i2]); idx.push(rim[i], rim[i2], rimB[i], rim[i2], rimB[i2], rimB[i]); }
  }
  addCore(vtx, idx, r, h, R * 1.15, h * 0.15, h * 0.97, 5, 2);
  { const n = 5, ya = h + 0.1, yb = yTop, rb = R * 0.06, tip = vtx(0, ya, 0, NEEDLE_TIP), ring = [];
    for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; ring.push(vtx(Math.cos(a) * rb, yb, Math.sin(a) * rb, NEEDLE)); }
    for (let i = 0; i < n; i++) idx.push(tip, ring[(i + 1) % n], ring[i]); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals(); g.computeBoundingBox(); g.computeBoundingSphere();
  g.userData.shared = true;
  return g;
}

const cache = [null, null, null];
/** Drei Ultra-Fichten passend zu TreeA, TreeB, TreeC (Maße aus den Vorlagen) in der Feinheitsstufe lod (0 nah, 1 mittel, 2 fern). */
export function ultraTrees(models, lod = 0) {
  if (cache[lod]) return cache[lod];
  cache[lod] = ['TreeA', 'TreeB', 'TreeC'].map((name, v) => {
    const src = models[name];
    src.computeBoundingBox();
    const b = src.boundingBox, h = b.max.y, R = Math.max(b.max.x, -b.min.x, b.max.z, -b.min.z) * 0.96;
    return lod === 2 ? makeFirFar({ h, R, y0: b.min.y, seed: 101 + v * 37 }) : makeFir({ h, R, y0: b.min.y, seed: 101 + v * 37, lod });
  });
  return cache[lod];
}
