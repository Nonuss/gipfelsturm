// Strecke: Rennen (fest, 2,4 km) und Freeride-Berg (zufällig, endlos, siehe piste.js).
import * as THREE from 'three';
import { clamp, lerp, smoothstep, mulberry32, vnoise, fbm } from './mathutil.js';
import * as P from './piste.js';
import * as HB from './heliberg.js';
export { HB };

export { clamp, lerp, smoothstep, mulberry32, vnoise, fbm };
export const G = 9.81;
export const EDGE_U = 215;
export const CHUNK = 100;
export const cfg = { endless: false, seed: 1, treeMul: 1, heli: false, disc: 'sg' };
export let FINISH_D = 2400;
/** Startpunkt des Rennens (Meter ab Bergstation). Die Disziplinen teilen sich die Rennpiste, starten aber verschieden hoch. */
export let START_D = 0;
export const RACE_FINISH = 2400;

// ================================================================ Renn-Disziplinen
// Werte angelehnt an die FIS-Regeln (Torbreite, Abstand der Drehstangen), Längen und Höhenmeter für das Spiel gekürzt.
// start: Startpunkt auf der Rennpiste, sp: Abstand der Tore entlang der Falllinie (m), amp: seitlicher Versatz der Tore
// (m bzw. Anteil der Pistenbreite bei rel), half: halbe Torbreite, kick: welche Sprünge stehen, pole: Kippstangen statt Torflaggen
export const DISCIPLINES = {
  sl: { id: 'sl', name: 'Slalom', short: 'SL', start: 1960, sp: [10.5, 12.5], amp: [3.0, 4.0], half: 2.5, kick: [], pole: true, combos: true, penalty: 2 },
  gs: { id: 'gs', name: 'Riesentorlauf', short: 'RS', start: 1480, sp: [28, 34], amp: [5, 6.5], half: 3.2, kick: [], penalty: 2 },
  sg: { id: 'sg', name: 'Super-G', short: 'SG', start: 700, sp: [48, 62], amp: [0.28, 0.4], rel: true, half: 4.0, kick: [1265, 2015], penalty: 2 },
  dh: { id: 'dh', name: 'Abfahrt', short: 'AB', start: 0, sp: [90, 125], amp: [0.12, 0.28], rel: true, half: 5.5, kick: [640, 1265, 2015], allRed: true, penalty: 2 },
};
export const DISC_ORDER = ['sl', 'gs', 'sg', 'dh'];
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
export function centerX(d) { return cfg.heli ? HB.hubX(d) : cfg.endless ? P.hubX(d) : centerXR(d); }
export function halfWidth(d) { return cfg.heli ? 13 : cfg.endless ? P.props(d).lw[0] : halfWidthR(d); }
export function axisX(d) { return centerX(d); }
/** Seitliche Grenze des befahrbaren Geländes um die Mittellinie. */
export function bounds(d) {
  if (cfg.heli) return HB.boundAt(d);
  if (cfg.endless) return P.boundAt(d);
  return { c: centerXR(d), u: EDGE_U - 12 };
}
export function baseH(d) { return cfg.heli ? HB.Hof(d) : cfg.endless ? P.Hof(d) : baseHR(d); }

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
  if (cfg.heli) return HB.heightH(x, z);
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
  if (cfg.heli) return HB.heightH(x, z);
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

// ---------------------------------------------------------------- Fahrflächen über dem Gelände (Hüttendächer)
// Das Höhenfeld kann kein Dach über einem Hohlraum: Dächer sind eigene Flächen, die nur die Physik kennt. Sie zählen erst,
// wenn man schon fast auf Dachhöhe ist (sonst würde man von der Seite auf das Dach gehoben); von der Seite halten Kreise.
export const decks = new Map();
export function addDeck(k) {
  const z0 = Math.floor(-(k.z + k.hd + k.ov) / 20), z1 = Math.floor(-(k.z - k.hd - k.ov) / 20);
  for (let i = Math.min(z0, z1); i <= Math.max(z0, z1); i++) { if (!decks.has(i)) decks.set(i, []); decks.get(i).push(k); }
}
function deckAt(x, z, py) {
  const l = decks.get(Math.floor(-z / 20));
  if (!l) return -Infinity;
  let best = -Infinity;
  for (let i = 0; i < l.length; i++) {
    const k = l[i], dx = Math.abs(x - k.x), dz = Math.abs(z - k.z);
    if (dx > k.hw || dz > k.hd + k.ov) continue;
    const r = k.y + k.E + k.rise * (1 - dz / k.hd) + k.snow;
    if (py === undefined || py > r - 0.7) best = Math.max(best, r);
  }
  return best;
}
/** Boden für die Physik: Gelände oder Hüttendach (py = aktuelle Höhe des Fahrers). */
export function groundAt(x, z, py) { const y = height(x, z); return decks.size ? Math.max(y, deckAt(x, z, py)) : y; }
export function groundNormal(x, z, py, out) {
  if (!decks.size) return terrainNormal(x, z, out);
  const e = 0.3;
  const hx = groundAt(x + e, z, py) - groundAt(x - e, z, py), hz = groundAt(x, z + e, py) - groundAt(x, z - e, py);
  return out.set(-hx, 2 * e, -hz).normalize();
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
  if (cfg.heli) return HB.surf(x, -z);
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

const hKey = (i, j) => (i + 1000) * 100000 + j + 1000;
export function addCollider(x, z, r, type, lx = 0, lz = 0, top) {
  const key = cfg.heli ? hKey(Math.floor(x / 20), Math.floor(-z / 20)) : Math.floor(-z / 20);
  if (!colliders.has(key)) colliders.set(key, []);
  const c = { x, z, r, type, lx, lz, top };   // lx/lz: Richtung der Zaunlinie (Einheitsvektor); top: Oberkante (Welt-Y), darüber fliegt man frei
  colliders.get(key).push(c);
  return { key, c };
}
/** Einzelne Kollisionen wieder entfernen (Heli-Kacheln merken sich genau ihre eigenen). */
export function removeColliders(list) {
  for (const { key, c } of list) { const l = colliders.get(key); if (!l) continue; const i = l.indexOf(c); if (i >= 0) l.splice(i, 1); if (!l.length) colliders.delete(key); }
}
// Halbe Ausdehnung der Felsmodelle (x, z) bei Maßstab 1, gemessen an den Blender-Modellen
const ROCK_EXT = [[1.29, 1.47], [2.04, 1.36], [1.09, 1.07], [0.93, 1.06], [1.65, 1.54], [2.4, 1.42]];
const ROCK_TOP = [0.94, 1.45, 0.81, 1.53, 1.06, 1.02];
/** Fels als Kette von Kreisen entlang seiner Längsachse (längliche Blöcke sind sonst an den Enden durchlässig). */
export function addRockCollider(add, x, z, y, scale, rot, variant) {
  const [ex, ez] = ROCK_EXT[variant % 6], top = y + ROCK_TOP[variant % 6] * scale;
  const long = Math.max(ex, ez), short = Math.min(ex, ez), alongX = ex >= ez;
  // Achse im Weltsystem: Modell-X bzw. -Z um rot (Y-Achse) gedreht
  const ax = alongX ? Math.cos(rot) : Math.sin(rot), az = alongX ? -Math.sin(rot) : Math.cos(rot);
  const r = short * scale * 0.92, n = Math.max(1, Math.ceil((long - short) / short * 1.5) + 1);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (i / (n - 1) - 0.5) * 2 * (long - short) * scale;
    add(x + ax * t, z + az * t, r, 'fels', 0, 0, top);
  }
}
/** Rails und Boxen in der Nähe (Endlos-Welten): Geometrie wird beim ersten Abruf aus dem Gelände berechnet.
 *  g: Anfangspunkt (ax, ay, az) = Oberkante, Richtung (dx, dy, dz), Länge L, halbe Breite w. */
export function nearRails(z, cb) {
  if (!cfg.endless || cfg.heli) return;
  const d = -z;
  for (const r of P.railsIn(d - 30, d + 30)) cb(railGeom(r));
}
/** Gerade Oberkante einer Rail oder Box (Anfangspunkt, Richtung, Länge): Physik und Darstellung nutzen dieselben Werte. */
export function railGeom(r) {
  if (!r.g) {
    const ya = P.heightP(r.x0, -(r.d0 + 0.6)) + r.h, yb = P.heightP(r.x1, -(r.d0 + r.len)) + r.h;
    const ax = r.x0, az = -r.d0, bx = r.x1, bz = -(r.d0 + r.len);
    const L = Math.hypot(bx - ax, yb - ya, bz - az);
    r.g = { ax, ay: ya, az, dx: (bx - ax) / L, dy: (yb - ya) / L, dz: (bz - az) / L, L, w: r.w, h: r.h, kind: r.kind, name: r.name };
  }
  return r.g;
}
export function nearColliders(z, cb, x = 0) {
  if (cfg.heli) {
    const ci = Math.floor(x / 20), cj = Math.floor(-z / 20);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) { const l = colliders.get(hKey(i, j)); if (l) for (let q = 0; q < l.length; q++) cb(l[q]); }
    return;
  }
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

/** Tore einer Disziplin: abwechselnd links und rechts der Mittellinie, Versatz und Abstand leicht unregelmäßig
 *  (Rhythmuswechsel), im Slalom gelegentlich eine Vertikale (drei Tore fast in Falllinie). Vor und nach Sprüngen gerade. */
function genGates(D) {
  const R = mulberry32(9157 + D.id.charCodeAt(0) * 31 + D.id.charCodeAt(1));
  const rr = (a, b) => a + (b - a) * R();
  let side = R() < 0.5 ? 1 : -1, idx = 0, d = D.start + (D.pole ? 24 : 45);
  const end = FINISH_D - (D.pole ? 28 : 45);
  let nextCombo = D.combos ? 7 + Math.floor(R() * 4) : Infinity;
  const push = (dd, u, half, kind) => {
    const col = D.allRed ? 'red' : idx % 2 ? 'blue' : 'red';
    gates.push({ d: dd, u, x: centerXR(dd) + u, z: -dd, half, color: col, state: 0, pole: !!D.pole, kind });
    idx++;
  };
  while (d < end) {
    const w = halfWidthR(d);
    if (idx >= nextCombo && d + 30 < end) {
      // Vertikale: drei enge Tore beinahe in Falllinie, danach geht es normal weiter
      const n = R() < 0.5 ? 2 : 3;
      for (let k = 0; k < n; k++) push(d + k * 7, (k % 2 ? 1 : -1) * side * 0.9, 2.3, 'vert');
      d += (n - 1) * 7 + rr(D.sp[0], D.sp[1]) + 2;
      nextCombo = idx + 8 + Math.floor(R() * 5);
      continue;
    }
    const lim = Math.max(0, w - D.half - 3);
    let amp = D.rel ? w * rr(D.amp[0], D.amp[1]) : rr(D.amp[0], D.amp[1]);
    let sp = rr(D.sp[0], D.sp[1]);
    if (!D.pole && R() < 0.14) { amp *= 1.22; sp *= 1.25; }   // verzögertes Tor: weiter versetzt, mehr Abstand
    let u = side * Math.min(lim, amp);
    for (const k of kickers) if (d > k.d - 75 && d < k.d + 95) u = side * Math.min(u * side, 2);
    push(d, u, D.half, 'open');
    side = -side;
    d += sp;
  }
}

function genRace() {
  const R = mulberry32(4711);
  const D = DISCIPLINES[cfg.disc] || DISCIPLINES.sg;
  START_D = D.start;
  kickers.push(...RACE_KICKERS.filter((k) => D.kick.includes(k.d)));
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
  genGates(D);
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
  if (cfg.heli) return HB.genChunk(i, CHUNK, cfg.treeMul, addCollider);
  const d0 = i * CHUNK, d1 = d0 + CHUNK;
  const R = mulberry32((Math.imul(cfg.seed, 2654435761) ^ Math.imul(i + 1000, 40503)) >>> 0);
  const out = { trees: [], rocks: [], markers: [], decor: [], caves: [] };
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

  const heli = cfg.style === 'heli';   // Heli-Berg: Hochgebirge, keine Pistenausstattung
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
    if (!heli || c.forest > 0.05) dens = Math.max(dens, 0.4 * smoothstep(c.valley - 5, c.valley + 45, au));   // Heli: über der Baumgrenze kein Waldrand
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
  for (let n = 0; n < Math.round((34 * cfg.treeMul + 8) * (heli ? 2.2 : 1)); n++) {
    const dd = d0 + R() * CHUNK, ur = R() * 2 - 1, sc = R(), rot = R() * 6.283, vr = Math.floor(R() * 6), wallPref = R();
    const c = P.props(dd);
    let x, wall = false;
    if (wallPref < 0.55 && c.rock > 0.25 && c.wall > 0.5) { x = c.hub + Math.sign(ur || 1) * (c.valley + 2 + Math.abs(ur) * 46); wall = true; }
    else x = c.hub + ur * Math.min(c.valley + 40, 200);
    const z = -dd;
    const sf = P.surf(x, dd);
    // keine Brocken auf oder direkt neben der Strecke (Felswände an den Talflanken bleiben)
    if (dd < 25 || sf.edge < (wall ? 3.5 : 12) || P.inFeatureZone(x, dd, 6)) continue;
    const hh = P.heightP(x, z);
    const steep = Math.abs(P.heightP(x + 2, z) - P.heightP(x - 2, z)) / 4;
    if (wall && steep < 0.5) continue;
    const scale = (wall ? 1.6 + sc * 3.2 + Math.min(2, steep) : 0.6 + sc * 1.6) * (heli ? 1.35 : 1);
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
        if (P.surf(gx, dd).edge < 18 || P.inFeatureZone(gx, dd, 10)) continue;
        const n = 2 + Math.floor(R() * 4), big = 1.2 + R() * 1.8;
        for (let k = 0; k < n; k++) {
          const x = gx + (R() - 0.5) * 7, z = -(dd + (R() - 0.5) * 7), sc = big * (k ? 0.45 + R() * 0.5 : 1);
          if (P.surf(x, -z).edge < 13) continue;
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
    if (!heli) for (const sgn of [-1, 1]) for (let k = 0; k < 3; k++) { const xa = f.xB + sgn * (f.wB + 1.5 + k * 4), xb = xa + sgn * 4; addFence(Math.min(xa, xb), f.dc - 2.5, Math.max(xa, xb), f.dc - 2.5, false); }
  }
  // ---- Gletscher: Séracs (Eistürme) und Eisbrocken im offenen Gelände
  if (heli) {
    const zg = P.zoneAtD(d0 + CHUNK / 2);
    if (zg.type === 'glacier') {
      for (let n = 0; n < Math.round(9 * Math.max(0.6, cfg.treeMul)); n++) {
        const dd = d0 + R() * CHUNK, c = P.props(dd), x = c.hub + (R() * 2 - 1) * Math.min(c.valley + 10, 210);
        if (P.surf(x, dd).edge < 7 || P.inFeatureZone(x, dd, 6)) continue;
        const sc = 1.4 + R() * 2.2;
        addD('IceCluster', x, dd, { rot: R() * 6.28, scale: sc, dy: -0.3 * sc, r: 1.1 * sc, type: 'fels' });
      }
    }
  }
  // ---- Eishöhlen: Querschnitte alle 2 m (Mitte und Bodenhöhe links/rechts), Wände bekommen Kollision
  for (const f of P.featuresIn(d0, d1)) {
    if (f.kind !== 'icecave') continue;
    const pts = [];
    for (let dd = f.d; dd <= f.d + f.len + 0.01; dd += 2) {
      const c = P.props(dd), cx = c.lx[f.lane];
      pts.push({ d: dd, x: cx, gl: P.heightP(cx - f.W, -dd), gr: P.heightP(cx + f.W, -dd), gc: P.heightP(cx, -dd) });
    }
    out.caves.push({ pts, W: f.W, H: f.H, seed: Math.floor(f.d) });
    for (let k = 1; k < pts.length; k++) {
      const a = pts[k - 1], b = pts[k], ln = Math.hypot(b.x - a.x, 2);
      for (const sg of [-1, 1]) addCollider(b.x + sg * (f.W - 0.4), -b.d, 0.55, 'zaun', (b.x - a.x) / ln, -2 / ln);
    }
    // Séracs um den Eingang
    for (let k = 0; k < 6; k++) { const sg = k % 2 ? 1 : -1, dd = f.d - 3 + R() * 6; addD('IceCluster', pts[0].x + sg * (f.W + 3 + R() * 9), dd, { rot: R() * 6.28, scale: 1.6 + R() * 2.2, dy: -0.5 }); }
  }
  // ---- Klippen-Drops: Felsen an den Seiten der Kante und am Wandfuß rahmen die Drops ein
  for (const f of P.featuresIn(d0, d1)) {
    if (f.kind !== 'drop') continue;
    for (const sg of [-1, 1]) for (let k = 0; k < 4; k++) {
      const x = f.x + sg * (f.w + 3 + k * 3.2 + R() * 2), dd = f.dc + (R() - 0.3) * 6, sc = 1.6 + R() * 2.6;
      out.rocks.push({ x, z: -dd, y: rockY(x, -dd, sc), scale: sc, rot: R() * 6.283, variant: Math.floor(R() * 6) });
      addCollider(x, -dd, 1.1 * sc, 'fels');
    }
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
  // ---- Rails und Boxen (Freestyle): Modell auf Länge und Höhe skaliert, folgt dem Hang
  out.rails = [];
  for (const r of P.railsIn(d0, d1)) {
    if (r.d0 < d0 || r.d0 >= d1) continue;
    out.rails.push({ ...railGeom(r), seed: Math.floor(r.d0 * 7 + r.x0) });   // eigenes Modell in world.buildRails (Länge beliebig)
    const az = -(r.d0 + 0.6);
    for (const sg of [-1, 1]) out.markers.push({ x: r.x0 + sg * 3.2, z: az + 6, y: P.heightP(r.x0 + sg * 3.2, az + 6), kicker: true });
  }
  // Gaps: rote Stangen an beiden Grabenkanten
  for (const f of P.featuresIn(d0, d1)) {
    if (f.kind !== 'jump' || !f.gap) continue;
    for (const dd of [f.d + f.gap.a, f.d + f.gap.b]) for (const sg of [-1, 1]) {
      const x = f.x + sg * (f.wT + 1.2);
      out.markers.push({ x, z: -dd, y: P.heightP(x, -dd), cliff: true });
    }
  }
  // ---- Markierungsstangen entlang der Spuren, Farbe nach Schwierigkeit
  // alle 50 m ein Paar: genug zur Orientierung, ohne dass die Piste wie ein Stangenwald aussieht
  const MSP = 50;
  for (let dm = Math.ceil(d0 / MSP) * MSP; dm < d1; dm += MSP) {
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
    } else if (f.kind === 'cliff' && !heli) {
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
  for (let dm = d0; dm < d1 && !heli; dm += 8) {
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
        for (let k = 0; k < 3; k++) {
          const dd = dm + 6 + k * 14, cc = P.props(dd);
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
  for (let dm = Math.ceil(d0 / 30) * 30; dm < d1 && !heli; dm += 30) {
    if (dm < 40) continue;
    const z = P.zoneAtD(dm), c = P.props(dm), type = z.type;
    const k = Math.floor(dm / 30);
    const h = ((Math.imul(k, 2654435761) ^ Math.imul(cfg.seed, 40503)) >>> 0) / 4294967296;
    const side = (k & 1) ? 1 : -1;
    if (ZONE_DECOR_CANNON[type] && h < 0.34 * ZONE_DECOR_CANNON[type] && c.lw[0] > 5) addD('SnowCannon', c.lx[0] + side * (c.lw[0] + 6.5), dm, { rot: R() * 6.28, r: 0.6, type: 'haus' });
    if (type === 'park') {
      if (dm - z.d0 < 36) addD('Banner', c.lx[0], dm + 10);
    }
    if (type === 'bigair' && dm - z.d0 < 36) addD('Banner', c.lx[0], dm + 12);
    if (type === 'flat' && dm - z.d0 > 50 && dm - z.d0 < 80) {
      const sx = c.hub + side * c.valley * 0.58;
      addD('MountainHut', sx, dm, { rot: side > 0 ? -Math.PI / 2 : Math.PI / 2, scale: 1.1, dy: -0.15, r: 5.2, type: 'haus' });
    }
    if ((type === 'cruise' || type === 'flat' || type === 'bowl') && h > 0.93) addD('Snowman', c.lx[0] + side * (c.lw[0] + 8), dm, { rot: R() * 0.6 - 0.3 + (side > 0 ? 0.4 : -0.4) });
  }
  // ---- Dörfer (Freeride): Häuser auf ihren Terrassen, Kollision über ein bis zwei Kreise je Haus
  for (const h of P.housesIn(d0, d1)) {
    decor.push({ m: h.m, x: h.x, z: -h.d, y: h.y - 0.05, rot: h.rot, scale: 1 });
    const ca = Math.cos(h.rot), sa = Math.sin(h.rot);
    for (const [lx, ly, r] of P.HOUSES[h.m].col) {
      // Modell: Blender-Y zeigt im Spiel nach -Z; Drehung um die Hochachse
      const tx = lx, tz = -ly;
      addCollider(h.x + tx * ca + tz * sa, -h.d - tx * sa + tz * ca, r, 'haus', 0, 0, h.y + 6);
    }
  }
  // ---- Holzhackerhütten: Modell, befahrbares Dach, Kreise an Talseite und Flanken (oben fliegt man frei darüber)
  for (const h of P.hutsIn(d0, d1)) {
    const H = P.WOOD_HUT, z = -h.d;
    decor.push({ m: 'WoodHut', x: h.x, z, y: h.y, rot: 0, scale: 1 });
    addDeck({ x: h.x, z, y: h.y, hw: H.hw + H.ovX, hd: H.hd, ov: H.ovY, E: H.E, rise: H.rise, snow: H.snow });
    for (const lx of [-1.8, 0, 1.8]) addCollider(h.x + lx, z - 1.6, 1.25, 'haus', 0, 0, h.y + H.E);                  // Talseite
    for (const sx of [-1, 1]) for (const lz of [-1.3, 1.3]) addCollider(h.x + sx * 2.4, z + lz, 0.95, 'haus', 0, 0, h.y + 1.2);   // Seiten (nur Wandfuß: wer von der Wechte kommt, ist darüber)
  }
  // ---- Totholz, Bäume und Büsche in Wald und Lichtungen
  const nDec = Math.round(70 * cfg.treeMul);
  for (let n = 0; n < nDec; n++) {
    const dd = d0 + R() * CHUNK, pick = R(), sx = R() < 0.5 ? -1 : 1, off = 10 + R() * 22, r1 = R(), r2 = R(), r3 = R();
    const c = P.props(dd);
    const act = [];
    for (let q = 0; q < NL; q++) if (c.lw[q] >= 2.5) act.push(q);
    const li = act[Math.floor(r1 * act.length)];
    const x = c.lx[li] + sx * (c.lw[li] + off);
    const sf = P.surf(x, dd);
    if (sf.edge < 10 || P.inFeatureZone(x, dd, 6)) continue;   // keine kleinen Hindernisse neben der Strecke
    const forestOk = sf.forest > 0.2 || (r2 < 0.3 && (!heli || c.forest > 0.05));   // Heli: kein Totholz über der Baumgrenze
    if (!forestOk) continue;
    if (pick < 0.3) addD('Bush', x, dd, { rot: r3 * 6.28, scale: 0.8 + r2 * 0.8 });
    else if (pick < 0.46) addD('Log', x, dd, { rot: r3 * 3.14, scale: 0.9 + r2 * 0.5 });
    else if (pick < 0.62) addD('DeadTree', x, dd, { rot: r3 * 6.28, scale: 0.8 + r2 * 0.6, r: 0.35, type: 'baum' });
  }
  return out;
}
/** Heli-Berg: Kollisionen einer Kachel (Kante T, Vielfaches von 20 m) entfernen. */
export function dropTile(ti, tj, T) {
  const n = T / 20;
  for (let i = ti * n; i < (ti + 1) * n; i++) for (let j = tj * n; j < (tj + 1) * n; j++) colliders.delete(hKey(i, j));
}
export function dropChunk(i) {
  for (let k = i * 5; k < i * 5 + 5; k++) { colliders.delete(k); decks.delete(k); }
}

export function setMode(endless, seed = 1, style = 'freeride', disc) {
  if (disc && DISCIPLINES[disc]) cfg.disc = disc;
  START_D = 0;
  cfg.endless = endless;
  cfg.seed = seed;
  cfg.style = style;
  cfg.heli = endless && style === 'heli';
  for (const a of [gates, trees, rocks, chalets, markers, kickers, pads, lift.pylons]) a.length = 0;
  colliders.clear();
  decks.clear();
  if (cfg.heli) {
    const hb = HB.initOrAdopt(seed);
    FINISH_D = hb.fin;
    MESH_D1 = hb.end;
    chalets.push(...HB.chalets());
  } else if (endless) {
    P.pisteInit(seed, style);
    FINISH_D = Infinity;
    MESH_D1 = Infinity;
  } else {
    FINISH_D = RACE_FINISH;
    MESH_D1 = 2760;
    genRace();
  }
}
setMode(false);

export const laneX = (d, i = 0) => (cfg.endless && !cfg.heli ? P.props(d).lx[i] : centerX(d));
export const featuresIn = (a, b) => (cfg.endless && !cfg.heli ? P.featuresIn(a, b) : []);
export const mapSlice = (d0, d1, step) => P.mapSlice(d0, d1, step);
export const zoneAt = (d) => (cfg.heli ? HB.zoneAt(d) : cfg.endless ? P.zoneAtD(d) : null);
export const pisteReport = P.report;
export const tmpV = new THREE.Vector3();
