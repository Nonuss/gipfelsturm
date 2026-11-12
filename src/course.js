// Strecke: Rennen (fest, 2,4 km) und Freeride-Berg (zufällig, endlos, siehe piste.js).
import * as THREE from 'three';
import { clamp, lerp, smoothstep, mulberry32, vnoise, fbm } from './mathutil.js';
import * as P from './piste.js';

export { clamp, lerp, smoothstep, mulberry32, vnoise, fbm };
export const G = 9.81;
export const EDGE_U = 215;
export const CHUNK = 100;
export const cfg = { endless: false, seed: 1, treeMul: 1 };
export let FINISH_D = 2400;
export let MESH_D0 = -60;
export let MESH_D1 = 2760;

const gauss = (d, c, s) => Math.exp(-((d - c) * (d - c)) / (2 * s * s));

// ================================================================ Rennen
function centerXR(d) {
  const s = smoothstep(30, 240, d) * (1 - 0.75 * smoothstep(2250, 2450, d));
  return s * (55 * Math.sin(d / 220) + 26 * Math.sin(d / 110 + 1.3) + 8 * Math.sin(d / 47 + 0.5));
}
function halfWidthR(d) {
  let w = 20 + 5 * Math.sin(d / 150 + 2);
  w = lerp(7, w, smoothstep(0, 70, d));
  w += 16 * smoothstep(2330, 2420, d);
  return w;
}
function slopeR(d) {
  if (d < -5) return 0.45;
  if (d < 3) return 0.0;
  const main = 0.26 + 0.09 * Math.sin(d / 240 + 1) + 0.045 * Math.sin(d / 71) + 0.13 * gauss(d, 900, 110) + 0.12 * gauss(d, 1750, 100);
  if (d < 45) return lerp(0.02, 0.42, smoothstep(2, 24, d));
  let s = lerp(0.42, main, smoothstep(45, 140, d));
  if (d > 2400) s = lerp(s, -0.05, smoothstep(2400, 2540, d));
  return s;
}
const H_STEP = 0.5, H_D0 = -420, H_N = Math.ceil((3800 - H_D0) / H_STEP);
const H_TAB = new Float32Array(H_N + 1);
(() => {
  let h = 0;
  const i0 = Math.round((0 - H_D0) / H_STEP);
  H_TAB[i0] = 0;
  for (let i = i0 + 1; i <= H_N; i++) {
    h -= slopeR(H_D0 + (i - 0.5) * H_STEP) * H_STEP;
    H_TAB[i] = h;
  }
  h = 0;
  for (let i = i0 - 1; i >= 0; i--) {
    h += slopeR(H_D0 + (i + 0.5) * H_STEP) * H_STEP;
    H_TAB[i] = h;
  }
})();
function baseHR(d) {
  const f = clamp((d - H_D0) / H_STEP, 0, H_N - 1e-3);
  const i = Math.floor(f);
  return H_TAB[i] + (H_TAB[i + 1] - H_TAB[i]) * (f - i);
}

// ================================================================ Gemeinsame Funktionen
export function centerX(d) { return cfg.endless ? P.hubX(d) : centerXR(d); }
export function halfWidth(d) { return cfg.endless ? P.props(d).lw[0] : halfWidthR(d); }
export function axisX(d) { return centerX(d); }
/** Seitliche Grenze des befahrbaren Geländes um die Mittellinie. */
export function bounds(d) {
  if (cfg.endless) return P.boundAt(d);
  return { c: centerXR(d), u: EDGE_U - 12 };
}
export function baseH(d) { return cfg.endless ? P.Hof(d) : baseHR(d); }

export const kickers = [];
const RACE_KICKERS = [
  { d: 640, u: 0, w: 9, L: 16, h: 1.6 },
  { d: 1265, u: 0, w: 9, L: 18, h: 1.9 },
  { d: 2015, u: 0, w: 9, L: 16, h: 1.7 },
];
function oneKicker(k, d, u) {
  const dd = d - k.d;
  if (dd < -k.L || dd > 4) return 0;
  const lat = 1 - smoothstep(k.w * 0.55, k.w, Math.abs(u - k.u));
  if (lat <= 0) return 0;
  if (dd <= 0) {
    const s = (dd + k.L) / k.L;
    return k.h * s * s * lat;
  }
  return k.h * (1 - smoothstep(0, 4, dd)) * lat;
}
function kickerH(d, u) {
  let y = 0;
  for (const k of kickers) y += oneKicker(k, d, u);
  return y;
}

export const pads = [];
function addPad(d, u, r) {
  const x = centerX(d) + u, z = -d;
  const p = { x, z, r, y: 0 };
  p.y = rawHeight(x, z);
  pads.push(p);
  return p;
}

export function rawHeight(x, z) {
  if (cfg.endless) return P.heightP(x, z);
  const d = -z;
  const cx = centerXR(d);
  const u = x - cx;
  const w = halfWidthR(d);
  const e = Math.abs(u) - w;
  let y = baseHR(d);
  y += 0.0012 * Math.min(u * u, w * w);
  y += (vnoise(x / 34, z / 34) - 0.5) * 1.1 + (vnoise(x / 11 + 7, z / 11) - 0.5) * 0.22;
  if (e > 0) {
    const t = Math.min(1, e / 14);
    y += smoothstep(0, 5, e) * 0.5;
    y += 0.14 * Math.pow(e, 1.27);
    y += t * ((fbm(x / 26, z / 26) - 0.5) * 5.5 + (vnoise(x / 6, z / 6) - 0.5) * 0.7) * (1 + e * 0.012);
  } else {
    y += kickerH(d, u);
  }
  return y;
}

export function height(x, z) {
  let y = rawHeight(x, z);
  for (let i = 0; i < pads.length; i++) {
    const p = pads[i];
    const dx = x - p.x, dz = z - p.z;
    const r2 = dx * dx + dz * dz;
    const ro = p.r + 9;
    if (r2 < ro * ro) y = lerp(y, p.y, 1 - smoothstep(p.r, ro, Math.sqrt(r2)));
  }
  return y;
}

export function terrainNormal(x, z, out) {
  const e = 0.6;
  const hx = height(x + e, z) - height(x - e, z);
  const hz = height(x, z + e) - height(x, z - e);
  return out.set(-hx, 2 * e, -hz).normalize();
}

/** Oberfläche an (x, z): Abstand zur Spur (edge < 0 = auf der Spur), Pflege-Grad, Pulverschnee, Wald. */
export const SF = { edge: 0, groom: 0, pow: 0, forest: 0, u: 0 };
export function surfaceAt(x, z) {
  if (cfg.endless) return P.surf(x, -z);
  const d = -z;
  const e = Math.abs(x - centerXR(d)) - halfWidthR(d);
  SF.edge = e; SF.groom = 1 - smoothstep(-1.5, 2.5, e); SF.pow = 0; SF.forest = 0; SF.u = x - centerXR(d);
  return SF;
}
/** Abstand zum Pistenrand: <0 auf der Piste. */
export function pisteEdge(x, z) { return surfaceAt(x, z).edge; }
export const powder = (x, z) => surfaceAt(x, z).pow;

// ================================================================ Inhalte
export const lift = { a: { x: 70, d: 2530 }, b: { x: -55, d: -25 }, pylons: [] };
export function liftX(d) {
  const t = (d - lift.b.d) / (lift.a.d - lift.b.d);
  return lerp(lift.b.x, lift.a.x, t);
}
export const gates = [];
export const trees = [];
export const rocks = [];
export const chalets = [];
export const markers = [];
export const colliders = new Map();

function addCollider(x, z, r, type, lx = 0, lz = 0) {
  const key = Math.floor(-z / 20);
  if (!colliders.has(key)) colliders.set(key, []);
  colliders.get(key).push({ x, z, r, type, lx, lz });   // lx/lz: Richtung der Zaunlinie (Einheitsvektor)
}
export function nearColliders(z, cb) {
  const k = Math.floor(-z / 20);
  for (let i = k - 1; i <= k + 1; i++) {
    const l = colliders.get(i);
    if (l) for (let j = 0; j < l.length; j++) cb(l[j]);
  }
}
const nearPad = (x, z, m) => pads.some((p) => (x - p.x) ** 2 + (z - p.z) ** 2 < (p.r + m) ** 2);

function genTreesRace(R, d0, d1, out) {
  for (let d = d0; d < d1; d += 2.1) {
    for (let s = -1; s <= 1; s += 2) {
      for (let a = 0; a < 5; a++) {
        const dd = d + R() * 2.1;
        const e = 3.5 + Math.pow(R(), 1.7) * 185;
        const x = centerXR(dd) + s * (halfWidthR(dd) + e) + (R() - 0.5) * 2;
        const z = -dd;
        const clump = vnoise(x / 45 + 3, z / 45);
        const keep = R() < (e < 40 ? 0.42 : 0.3) * (0.35 + clump * 1.5);
        const scale = 0.7 + R() * 0.75;
        const variant = R() < 0.45 ? 0 : R() < 0.6 ? 1 : 2;
        const rot = R() * 6.283, tint = 0.82 + R() * 0.36;
        if (!keep) continue;
        if (Math.abs(x - centerXR(dd)) > EDGE_U - 6) continue;
        if (pisteEdge(x, z) < 3) continue;
        if (Math.abs(x - liftX(dd)) < 7.5 && dd > lift.b.d - 10 && dd < lift.a.d + 10) continue;
        if (nearPad(x, z, 5)) continue;
        if (dd < 8 && Math.abs(x + 3) < 12) continue;
        out.push({ x, z, y: height(x, z) - 0.15, scale, rot, variant, tint });
        addCollider(x, z, 0.5 * scale + 0.15, 'baum');
      }
    }
  }
}

function genRocksRace(R, d0, d1, count, out) {
  for (let i = 0; i < count; i++) {
    const dd = d0 + R() * (d1 - d0);
    const s = R() < 0.5 ? -1 : 1;
    const e = 2.5 + Math.pow(R(), 1.5) * 110;
    const scale = 0.6 + R() * 1.5, rot = R() * 6.283, variant = Math.floor(R() * 6);
    const x = centerXR(dd) + s * (halfWidthR(dd) + e), z = -dd;
    if (dd < 20 || nearPad(x, z, 4) || pisteEdge(x, z) < 2.5) continue;
    out.push({ x, z, y: height(x, z) - 0.25 * scale, scale, rot, variant });
    addCollider(x, z, 1.3 * scale, 'fels');
  }
}

function genRace() {
  const R = mulberry32(4711);
  kickers.push(...RACE_KICKERS);
  const chaletDefs = [
    { d: 2590, u: -56, rot: Math.PI / 2 }, { d: 2640, u: 52, rot: -Math.PI / 2 }, { d: 2565, u: 64, rot: -Math.PI / 2 },
    { d: 2700, u: -34, rot: 0.3 }, { d: 2715, u: 22, rot: -0.25 }, { d: 1105, u: 0, side: 1, e: 15, rot: -Math.PI / 2 },
    { d: 1820, u: 0, side: -1, e: 16, rot: Math.PI / 2 },
  ];
  for (const c of chaletDefs) {
    const u = c.side ? c.side * (halfWidthR(c.d) + c.e) : c.u;
    const p = addPad(c.d, u, 7.5);
    chalets.push({ x: p.x, z: p.z, y: p.y, rot: c.rot });
    addCollider(p.x, p.z, 5.6, 'haus');
  }
  for (let d = lift.b.d; d <= lift.a.d + 1; d += 142) {
    let best = null;
    for (const off of [0, 20, -20, 40, -40, 60, -60]) {
      const dd = clamp(d + off, lift.b.d, lift.a.d);
      const x = liftX(dd);
      if (Math.abs(x - centerXR(dd)) - halfWidthR(dd) > 5 && !nearPad(x, -dd, 6)) { best = dd; break; }
    }
    if (best === null) continue;
    const x = liftX(best), z = -best;
    lift.pylons.push({ x, z, y: height(x, z), d: best });
    addCollider(x, z, 1.1, 'stuetze');
  }
  let side = 1, idx = 0;
  for (let d = 150; d < 2360; d += 58) {
    const w = halfWidthR(d);
    let u = side * w * (0.36 + 0.14 * R());
    for (const k of kickers) if (d > k.d - 75 && d < k.d + 95) u = 0;
    const x = centerXR(d) + u;
    gates.push({ d, u, x, z: -d, half: 4.3, color: idx % 2 ? 'blue' : 'red', state: 0 });
    side = -side;
    idx++;
  }
  genTreesRace(R, MESH_D0 + 4, MESH_D1 - 6, trees);
  genRocksRace(R, 20, 2700, 300, rocks);
  for (let d = 30; d < 2440; d += 36) {
    for (const s of [-1, 1]) {
      const x = centerXR(d) + s * (halfWidthR(d) - 0.4), z = -d;
      markers.push({ x, z, y: height(x, z) });
    }
  }
  for (const k of kickers) {
    for (const s of [-1, 1]) {
      const x = centerXR(k.d) + k.u + s * (k.w * 0.62), z = -k.d;
      markers.push({ x, z, y: height(x, z), kicker: true });
    }
  }
}

// ================================================================ Freeride-Berg: Inhalte eines 100-m-Stücks
const MARK = { blue: [0.2, 0.55, 2.4], red: [2.5, 0.22, 0.2], black: [0.1, 0.1, 0.12], trail: [2.4, 1.8, 0.2] };
export const NL = P.NL;
const ZONE_DECOR_CANNON = { cruise: 1, flat: 1, start: 1, bowl: 0.4 };

/** Bäume, Felsen, Markierungen und Dekoration eines 100-m-Stücks (deterministisch aus Startwert + Index). */
export function genChunk(i) {
  const d0 = i * CHUNK, d1 = d0 + CHUNK;
  const R = mulberry32((Math.imul(cfg.seed, 2654435761) ^ Math.imul(i + 1000, 40503)) >>> 0);
  const out = { trees: [], rocks: [], markers: [], decor: [] };
  const decor = out.decor;
  const addD = (m, x, d, o = {}) => {
    const z = -d;
    let y = P.heightP(x, z) + (o.dy || 0), sl = 0;
    if (m === 'SnowFence') {
      // Zaunfeld folgt dem Hang: Pfosten bleiben senkrecht, Bahn und Oberkante laufen parallel zum Boden (Scherung im Shader-freien Matrixaufbau)
      const yaw = o.rot || 0, ax = Math.cos(yaw) * 2, az = -Math.sin(yaw) * 2;
      const h1 = P.heightP(x - ax, z - az), h2 = P.heightP(x + ax, z + az);
      sl = (h2 - h1) / 4;
      y = (h1 + h2) / 2 + (o.dy || 0) - 0.04;
    }
    decor.push({ m, x, z, y, rot: o.rot || 0, scale: o.scale || 1, col: o.col, sl });
    if (o.r) addCollider(x, z, o.r, o.type || 'haus');
  };
  // Zaunfeld exakt von A nach B: Länge, Richtung und Hangneigung aus den Endpunkten, damit Felder lückenlos aneinanderstoßen.
  // Kollision: kleine Körper entlang der Linie (kein breiter Abstoß-Radius); Hineinfahren lässt stürzen.
  const fenceHash = (a, b) => { let t = Math.imul(Math.round(a * 10) + b * 977 + cfg.seed * 7919, 2654435761); t ^= t >>> 15; t = Math.imul(t, 2246822519); t ^= t >>> 13; return (t >>> 0) / 4294967296; };
  const addFence = (ax, ad, bx, bd, coll = true) => {
    const az = -ad, bz = -bd;
    const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz);
    if (len < 0.5) return;
    const ha = P.heightP(ax, az), hb = P.heightP(bx, bz);
    const yaw = Math.atan2(-dz, dx);
    const mx = (ax + bx) / 2, mz = (az + bz) / 2;
    const sy = 0.9 + 0.18 * fenceHash(ad, Math.round(ax));   // Scherung wirkt vor der Skalierung: durch sy teilen
    decor.push({ m: 'SnowFence', x: mx, z: mz, y: (ha + hb) / 2 - 0.04, rot: yaw, scale: 1, sx: (len / 4) * 1.012, sy, sl: (hb - ha) / (4 * sy) });
    if (coll) for (const t of [0.17, 0.5, 0.83]) addCollider(ax + dx * t, az + dz * t, 0.45, 'zaun', dx / len, dz / len);
  };
  // Felsen aufs Gelände setzen: tiefster Punkt unter der Grundfläche, damit nirgends eine Kante in der Luft hängt
  const rockY = (x, z, sc) => {
    let m = P.heightP(x, z);
    const r = 1.05 * sc;
    for (let k = 0; k < 6; k++) { const a = k * 1.0472; m = Math.min(m, P.heightP(x + Math.cos(a) * r, z + Math.sin(a) * r)); }
    return m - 0.12 * sc;
  };
  // Querrichtung der Spur: Modelle mit Längsachse X werden entlang der Fahrtrichtung gedreht
  const laneYaw = (li, d) => Math.atan2(12, P.props(d + 6).lx[li] - P.props(d - 6).lx[li]);

  // ---- Wald: dichte Inseln und lichte Lichtungen, auch weit abseits der Spuren
  const N = Math.round(2800 * cfg.treeMul), maxTrees = Math.round(720 * cfg.treeMul);
  for (let n = 0; n < N && out.trees.length < maxTrees; n++) {
    const dd = d0 + R() * CHUNK, ur = R() * 2 - 1, pr = R(), scale0 = R(), rot = R() * 6.283, tint = 0.82 + R() * 0.36, vr = R(), vr2 = R();
    const c = P.props(dd);
    const reach = Math.min(c.valley + 90, 258);
    const x = c.hub + ur * reach;
    const z = -dd;
    const sf = P.surf(x, dd);
    const au = Math.abs(x - c.hub);
    const edge = sf.edge;
    const trailNear = c.lk[sf.lane] === 1;
    if (edge < (trailNear ? 1.3 : 2.8)) continue;
    let dens = sf.forest * (0.12 + 0.88 * smoothstep(0.8, 8, edge));
    dens = Math.max(dens, 0.4 * smoothstep(c.valley - 5, c.valley + 45, au));
    // Zonen „mit Baum-Inseln“: dichte Baumgruppen mitten im offenen Gelände zwischen den Pisten
    const zm = P.zoneAtD(dd).mods;
    if (zm && zm.islands) dens = Math.max(dens, zm.islands.amt * smoothstep(0.56, 0.7, fbm(x / 38 + cfg.seed * 0.13, dd / 38)) * smoothstep(7, 16, edge));
    if (dens < 0.02 || pr > dens) continue;
    if (dd < 14 && Math.abs(x + 3) < 16) continue;
    if (P.inFeatureZone(x, dd, 3)) continue;
    const hh = P.heightP(x, z);
    if (Math.abs(P.heightP(x + 1.4, z) - hh) > 1.9 || Math.abs(P.heightP(x, z - 1.4) - hh) > 1.9) continue;   // zu steil für Bäume
    const variant = vr < 0.45 ? 0 : vr2 < 0.6 ? 1 : 2;
    const scale = (0.65 + scale0 * 0.8) * (1 + 0.25 * smoothstep(5, 40, edge));
    out.trees.push({ x, z, y: hh - 0.15, scale, rot, variant, tint });
    addCollider(x, z, 0.5 * scale + 0.15, 'baum');
  }
  // ---- Felsblöcke und Felsen an steilen Flanken
  for (let n = 0; n < Math.round(34 * cfg.treeMul + 8); n++) {
    const dd = d0 + R() * CHUNK, ur = R() * 2 - 1, sc = R(), rot = R() * 6.283, vr = Math.floor(R() * 6), wallPref = R();
    const c = P.props(dd);
    let x, wall = false;
    if (wallPref < 0.55 && c.rock > 0.25 && c.wall > 0.5) { x = c.hub + Math.sign(ur || 1) * (c.valley + 2 + Math.abs(ur) * 46); wall = true; }
    else x = c.hub + ur * Math.min(c.valley + 40, 200);
    const z = -dd;
    const sf = P.surf(x, dd);
    if (dd < 25 || sf.edge < 3.5 || P.inFeatureZone(x, dd, 3)) continue;
    const hh = P.heightP(x, z);
    const steep = Math.abs(P.heightP(x + 2, z) - P.heightP(x - 2, z)) / 4;
    if (wall && steep < 0.5) continue;
    const scale = wall ? 1.6 + sc * 3.2 + Math.min(2, steep) : 0.6 + sc * 1.6;
    out.rocks.push({ x, z, y: rockY(x, z, scale), scale, rot, variant: vr });
    addCollider(x, z, 1.3 * scale, 'fels');
  }
  // ---- Zonen „mit Felsinseln“: Gruppen aus mehreren Brocken im offenen Gelände (mit Abstand zu den Pisten)
  {
    const zr = P.zoneAtD(d0 + CHUNK / 2);
    if (zr.mods && zr.mods.rocks) {
      const nG = Math.round(3 + 4 * zr.mods.rocks.amt * cfg.treeMul);
      for (let g = 0; g < nG; g++) {
        const dd = d0 + R() * CHUNK, c = P.props(dd), gx = c.hub + (R() * 2 - 1) * Math.min(c.valley + 20, 200);
        if (P.surf(gx, dd).edge < 9 || P.inFeatureZone(gx, dd, 8)) continue;
        const n = 2 + Math.floor(R() * 4), big = 1.2 + R() * 1.8;
        for (let k = 0; k < n; k++) {
          const x = gx + (R() - 0.5) * 7, z = -(dd + (R() - 0.5) * 7), sc = big * (k ? 0.45 + R() * 0.5 : 1);
          if (P.surf(x, -z).edge < 4) continue;
          out.rocks.push({ x, z, y: rockY(x, z, sc), scale: sc, rot: R() * 6.283, variant: Math.floor(R() * 6) });
          addCollider(x, z, 1.05 * sc, 'fels');
        }
      }
    }
  }
  // ---- Klippenbänder: Felsblöcke und Eis entlang Kante und Fuß
  for (const f of P.featuresIn(d0, d1)) {
    if (f.kind !== 'cliff') continue;
    const c = P.props(f.dc);
    for (let x = c.hub - c.valley - 6; x < c.hub + c.valley + 6; x += 2.6 + R() * 2.4) {
      if (f.xAs.some((xa) => Math.abs(x - xa) < 13) || Math.abs(x - f.xB) < f.wB + 4) continue;
      const dd = f.dc + (R() - 0.5) * 7;
      const sc = 1.8 + R() * 3.4;
      const z = -dd;
      out.rocks.push({ x, z, y: rockY(x, z, sc), scale: sc, rot: R() * 6.283, variant: Math.floor(R() * 6) });
      addCollider(x, z, 1.3 * sc, 'fels');
    }
    for (let x = c.hub - c.valley + 8; x < c.hub + c.valley - 8; x += 7 + R() * 9) {
      if (f.xAs.some((xa) => Math.abs(x - xa) < 16) || Math.abs(x - f.xB) < f.wB + 6) continue;
      addD('IceCluster', x, f.dc + 3 + R() * 3, { rot: R() * 6.28, scale: 0.8 + R() * 1.1 });
    }
    // Zaun beidseits der Sprunglinie am Klippenrand
    for (const sgn of [-1, 1]) for (let k = 0; k < 3; k++) { const xa = f.xB + sgn * (f.wB + 1.5 + k * 4), xb = xa + sgn * 4; addFence(Math.min(xa, xb), f.dc - 2.5, Math.max(xa, xb), f.dc - 2.5, false); }
  }
  // ---- Engstellen in Rinnen: die Felsnase besteht aus echten Brocken (zwei Reihen, innen kleiner, außen größer)
  for (const f of P.featuresIn(d0, d1)) {
    if (f.kind !== 'pinch') continue;
    for (const sgn of [-1, 1]) for (let row = 0; row < 2; row++) {
      for (let dd = f.d - f.len * 0.95; dd <= f.d + f.len * 0.95; dd += row ? 4.6 : 3.4) {
        const t = (dd - f.d) / f.len;
        const bell = Math.cos((Math.PI * t) / 2) ** 2;
        if (bell < 0.08) continue;
        const sc = (row ? 1.5 : 0.9) + (row ? 1.7 : 1.3) * bell + R() * 0.35;
        const c = P.props(dd);
        const inner = f.gap + 0.4 + (1 - bell) * 3.5;               // Innenkante der Felsnase
        const x = c.lx[0] + sgn * (inner + (row ? 2.9 * sc : 1.4 * sc));
        const z = -(dd + (R() - 0.5) * 1.2);
        const vr = [0, 1, 3][Math.floor(R() * 3)];
        out.rocks.push({ x, z, y: rockY(x, z, sc), scale: sc, rot: R() * 6.283, variant: vr });
        addCollider(x, z, 1.05 * sc, 'fels');
      }
    }
  }
  // ---- Markierungsstangen entlang der Spuren, Farbe nach Schwierigkeit
  for (let dm = Math.ceil(d0 / 22) * 22; dm < d1; dm += 22) {
    if (dm < 30) continue;
    const c = P.props(dm);
    const col = MARK[P.difficultyColor(c.slope)];
    for (let li = 0; li < NL; li++) {
      if (c.lw[li] < 2.5 || c.lg[li] < 0.4) continue;
      const tr = c.lk[li] === 1;
      for (const s of [-1, 1]) {
        const x = c.lx[li] + s * (c.lw[li] - 0.3);
        out.markers.push({ x, z: -dm, y: P.heightP(x, -dm), col: tr ? MARK.trail : col });
      }
    }
  }
  for (const f of P.featuresIn(d0, d1)) {
    if (f.kind === 'jump') {
      for (const s of [-1, 1]) out.markers.push({ x: f.x + s * (f.wT + 1.6), z: -f.d, y: P.heightP(f.x + s * (f.wT + 1.6), -f.d), kicker: true, big: f.J.h > 5.5 });
      // Zäune flankieren die Landefläche größerer Sprünge
      if (f.J.h > 3.4) {
        for (const sgn of [-1, 1]) for (let k = 0; k < 4; k++) {
          const dd = f.d + f.J.xk * 0.55 + k * 4;
          addFence(f.x + sgn * (f.wL + 5.2), dd, f.x + sgn * (f.wL + 5.2), dd + 4, false);
        }
      }
    } else if (f.kind === 'cliff') {
      for (const t of [-1, 1]) {
        const x = f.xB + t * (f.wB + 1.4), z = -(f.dc - 2);
        out.markers.push({ x, z, y: P.heightP(x, z), cliff: true });
      }
    } else if (f.kind === 'berm') {
      // Strohballen schützen die Außenseite der Steilkurve
      const c = P.props(f.d);
      // Netz an der Außenseite der Steilkurve
      const ox = (dd) => { const cc = P.props(dd); return cc.lx[f.lane] - f.side * (cc.lw[f.lane] + 2.4); };
      for (let k = -2; k < 2; k++) addFence(ox(f.d + k * 4), f.d + k * 4, ox(f.d + k * 4 + 4), f.d + k * 4 + 4, false);
    }
  }
  // ---- Zäune entlang der Waldbahnen und Wald-Pisten: halten auf der Spur, damit man sich im Wald nicht verirrt.
  // An Abzweigungen und Kreuzungen (andere Spur in der Nähe) bleibt der Zaun offen.
  const FST = 4;
  const fencePt = (li, sgn, dm) => {
    const c = P.props(dm);
    // sanftes seitliches Schwingen statt Zufallsversatz: Felder bleiben verbunden, die Linie wirkt trotzdem nicht starr
    return c.lx[li] + sgn * (c.lw[li] + 0.7 + 0.28 * Math.sin(dm * 0.083 + sgn * 1.7 + li * 2.3));
  };
  for (let dm = Math.ceil(d0 / FST) * FST; dm < d1; dm += FST) {
    if (dm < 30) continue;
    const dmid = dm + FST / 2;
    const c = P.props(dmid);
    const zt = P.zoneAtD(dmid).type, cf = c.forest;
    const cw = c.lw.slice(), cx = c.lx.slice(), ck = c.lk.slice();
    const wa = P.props(dmid + 9).lw.slice(), wb = P.props(dmid - 9).lw.slice();
    for (let li = 0; li < NL; li++) {
      const w = cw[li];
      if (w < 2.8 || Math.abs(wa[li] - w) > 0.9 || Math.abs(wb[li] - w) > 0.9) continue;
      const isTrail = ck[li] === 1;
      if (!(zt === 'glade' || (isTrail && cf > 0.45))) continue;
      for (const sgn of [-1, 1]) {
        const fx = cx[li] + sgn * (w + 0.7);
        let open = false;
        for (let q = 0; q < NL; q++) if (q !== li && cw[q] >= 2 && Math.abs(fx - cx[q]) < cw[q] + 4.5) open = true;
        if (open) continue;
        addFence(fencePt(li, sgn, dm), dm, fencePt(li, sgn, dm + FST), dm + FST);
      }
    }
  }
  // ---- Wegweiser und Torbögen an Abzweigungen
  for (let dm = d0; dm < d1; dm += 8) {
    const aw = P.props(Math.max(0, dm - 8)).lw.slice(), b = P.props(dm);   // props() liefert ein wiederverwendetes Objekt: Werte vorher kopieren
    for (let li = 1; li < NL; li++) {
      if (aw[li] < 2.2 && b.lw[li] >= 2.2) {
        let par = 0, bd = 1e9;
        for (let q = 0; q < NL; q++) if (q !== li && b.lw[q] >= 3 && Math.abs(b.lx[q] - b.lx[li]) < bd) { bd = Math.abs(b.lx[q] - b.lx[li]); par = q; }
        const dir = Math.sign(b.lx[li] - b.lx[par]) || 1;
        const col = b.lk[li] === 1 ? MARK.trail : MARK[P.difficultyColor(b.slope)];
        const sx = b.lx[par] + dir * (b.lw[par] + 3.5);
        addD(dir > 0 ? 'SignArrow' : 'SignArrowL', sx, dm, { col, r: 0.4, type: 'haus' });
        if (b.lk[li] === 1) addD('TrailArch', b.lx[li], dm + 26, { rot: laneYaw(li, dm + 26) + Math.PI / 2 });
        // Einfahrt mit farbigen Leitstangen markieren: zeigt schon von weitem, wo die neue Piste hinführt
        for (let k = 0; k < 8; k++) {
          const dd = dm + 4 + k * 9, cc = P.props(dd);
          if (cc.lw[li] < 2.2) continue;
          for (const sg of [-1, 1]) {
            const x = cc.lx[li] + sg * (cc.lw[li] - 0.3);
            if (Math.abs(x - cc.lx[par]) < cc.lw[par] - 1) continue;   // nicht mitten auf der Elternpiste
            out.markers.push({ x, z: -dd, y: P.heightP(x, -dd), col, big: false });
          }
        }
      }
    }
  }
  // ---- Zonenbezogene Dekoration
  for (let dm = Math.ceil(d0 / 30) * 30; dm < d1; dm += 30) {
    if (dm < 40) continue;
    const z = P.zoneAtD(dm), c = P.props(dm), type = z.type;
    const k = Math.floor(dm / 30);
    const h = ((Math.imul(k, 2654435761) ^ Math.imul(cfg.seed, 40503)) >>> 0) / 4294967296;
    const side = (k & 1) ? 1 : -1;
    if (ZONE_DECOR_CANNON[type] && h < 0.34 * ZONE_DECOR_CANNON[type] && c.lw[0] > 5) addD('SnowCannon', c.lx[0] + side * (c.lw[0] + 3.2), dm, { rot: R() * 6.28, r: 0.6, type: 'haus' });
    if (type === 'park') {
      if (h < 0.28) addD('Rail', c.lx[0] + side * (c.lw[0] + 7 + h * 20), dm, { rot: laneYaw(0, dm) });
      else if (h < 0.5) addD('ParkBox', c.lx[0] + side * (c.lw[0] + 7 + h * 18), dm, { rot: laneYaw(0, dm) });
      if (dm - z.d0 < 36) addD('Banner', c.lx[0], dm + 10);
    }
    if (type === 'bigair' && dm - z.d0 < 36) addD('Banner', c.lx[0], dm + 12);
    if (type === 'flat' && dm - z.d0 > 50 && dm - z.d0 < 80) {
      const sx = c.hub + side * c.valley * 0.58;
      addD('MountainHut', sx, dm, { rot: side > 0 ? -Math.PI / 2 : Math.PI / 2, scale: 1.1, dy: -0.15, r: 5.2, type: 'haus' });
    }
    if ((type === 'cruise' || type === 'flat' || type === 'bowl') && h > 0.93) addD('Snowman', c.lx[0] + side * (c.lw[0] + 4), dm, { rot: R() * 0.6 - 0.3 + (side > 0 ? 0.4 : -0.4) });
  }
  // ---- Totholz, Bäume und Büsche in Wald und Lichtungen
  const nDec = Math.round(70 * cfg.treeMul);
  for (let n = 0; n < nDec; n++) {
    const dd = d0 + R() * CHUNK, pick = R(), sx = R() < 0.5 ? -1 : 1, off = 1.8 + R() * 16, r1 = R(), r2 = R(), r3 = R();
    const c = P.props(dd);
    const act = [];
    for (let q = 0; q < NL; q++) if (c.lw[q] >= 2.5) act.push(q);
    const li = act[Math.floor(r1 * act.length)];
    const x = c.lx[li] + sx * (c.lw[li] + off);
    const sf = P.surf(x, dd);
    if (sf.edge < 1.6 || P.inFeatureZone(x, dd, 3)) continue;
    const forestOk = sf.forest > 0.2 || r2 < 0.3;
    if (!forestOk) continue;
    if (pick < 0.3) addD('Bush', x, dd, { rot: r3 * 6.28, scale: 0.8 + r2 * 0.8 });
    else if (pick < 0.46) addD('Log', x, dd, { rot: r3 * 3.14, scale: 0.9 + r2 * 0.5 });
    else if (pick < 0.62) addD('DeadTree', x, dd, { rot: r3 * 6.28, scale: 0.8 + r2 * 0.6, r: 0.35, type: 'baum' });
  }
  return out;
}
export function dropChunk(i) {
  for (let k = i * 5; k < i * 5 + 5; k++) colliders.delete(k);
}

export function setMode(endless, seed = 1) {
  cfg.endless = endless;
  cfg.seed = seed;
  for (const a of [gates, trees, rocks, chalets, markers, kickers, pads, lift.pylons]) a.length = 0;
  colliders.clear();
  if (endless) {
    P.pisteInit(seed);
    FINISH_D = Infinity;
    MESH_D1 = Infinity;
  } else {
    FINISH_D = 2400;
    MESH_D1 = 2760;
    genRace();
  }
}
setMode(false);

export const mapSlice = (d0, d1, step) => P.mapSlice(d0, d1, step);
export const zoneAt = (d) => (cfg.endless ? P.zoneAtD(d) : null);
export const pisteReport = P.report;
export const tmpV = new THREE.Vector3();
