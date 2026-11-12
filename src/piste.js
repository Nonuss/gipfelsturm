// Prozeduraler Freeride-Berg: Zonen-Grammatik, Routen (Pisten, Waldbahnen, Klippen-Linien), Gelände, Features.
//
// Aufbau (siehe PISTE_REFERENCE_RESEARCH.md):
//  1. Routenplanung    – Zonen (Wald, Pulverhang, Klippen, Rinne, Park, Big Air …) werden nach einer Grammatik gewürfelt.
//  2. Mittellinie      – „Hub“: aus Kurswinkel integriert (Sweeper, Esses), driftet nie weg.
//  3. Routen           – drei Spuren (A/B/C) spalten sich von der Mittellinie ab und laufen wieder zusammen (Abzweigungen).
//  4. Höhenprofil      – Gefälle je Zone, Steilstufen, Auslaufflächen; Features (Sprünge, Rollen, Steilkurven, Klippen) additiv.
//  5. Validierung      – Landungen werden mit der echten Flugbahn berechnet, Radien und Gefälle geprüft.
import { clamp, lerp, smoothstep, mulberry32, vnoise, fbm, snoise } from './mathutil.js';
import { designJump, designCliff, terminalSpeed, ramp01, jumpRel, cliffDrop, slopeTan } from './jumps.js';

export const PCFG = {
  transition: 70,        // halbe Länge der Übergänge zwischen Zonen (m): hier wachsen Abzweigungen aus der Spur
  lookahead: 1100,       // so weit wird die Zonenfolge vorausgeplant (m)
  minLaneW: 3.0,         // kleinste Halbbreite einer Spur (m)
  rmin: 42,              // kleinster Kurvenradius der Mittellinie (m)
  maxGroomedSlope: 0.46, // steilstes Gefälle auf präparierten Spuren
  edge: 5,               // Randweichheit der Features (m)
};
const TAU = Math.PI * 2;
export const NL = 5;      // Spuren pro Hang (A bis E)
const HS = 1.0, HST = 0.5;

let S = null;
export const report = { seed: 0, zones: [], features: [], issues: [] };

// ------------------------------------------------------------------ Zustand
export function pisteInit(seed) {
  S = { seed, Z: [], hub: [0], H: [0], busy: false, types: [], slopes: [] };
  // Berg-Charakter: jeder Startwert bevorzugt andere Zonen und hat eigene Grundzüge (Waldberg, Pulverberg, Felsberg …)
  const Rc = mulberry32((Math.imul(seed, 2246822519) ^ 0x5bd1e995) >>> 0);
  const ch = { w: {}, wide: 0.85 + Rc() * 0.35, steep: 0.92 + Rc() * 0.16, forest: 0.7 + Rc() * 0.6, pow: 0.75 + Rc() * 0.5, curvy: 0.75 + Rc() * 0.6, mods: 0.6 + Rc() * 0.8 };
  for (const k of Object.keys(W)) ch.w[k] = 0.45 + Rc() * 1.2;
  S.ch = ch;
  PR.d = NaN;
  report.seed = seed; report.zones = []; report.features = []; report.issues = []; report.skipped = 0;
  ensureZones(PCFG.lookahead);
}
const issue = (msg) => { if (report.issues.length < 400) report.issues.push(msg); };

// ------------------------------------------------------------------ Zonen
const W = { cruise: 0.85, glade: 1.25, bowl: 1.0, park: 0.8, bigair: 0.6, couloir: 0.55, cliff: 0.85, steep: 1.15, flat: 0.25 };
function pickType(idx, R) {
  const hist = S.types;
  if (idx === 0) return 'start';
  if (idx === 1) return R() < 0.5 ? 'glade' : 'cruise';
  const last = hist[hist.length - 1];
  const w = {};
  for (const k in W) w[k] = W[k] * (S.ch ? S.ch.w[k] : 1);
  if (idx < 3) { w.park = 0; w.couloir = 0; w.bigair = 0; w.steep = 0.5; }
  if (idx >= 6) { w.couloir = 0.8; w.bigair = 0.75; w.cliff = 1.0; w.steep = 1.3; }
  // nach harten Zonen (Rinne, Klippe, Big Air, Steilhang) kommt eine Verschnaufpause, hier laufen alle Spuren zusammen
  if (last === 'couloir' || last === 'cliff' || last === 'bigair' || last === 'steep') { w.flat = 1.6; w.cruise = 1.3; w.glade = 1.4; w.couloir = w.cliff = w.bigair = w.steep = 0; }
  // zwei sanfte Zonen hintereinander sind genug: danach muss es steil werden
  const sl = S.slopes, n = sl.length;
  if (n >= 2 && sl[n - 1] < 0.25 && sl[n - 2] < 0.25) { for (const k of ['cruise', 'glade', 'park', 'bigair', 'flat']) w[k] *= 0.08; w.steep = Math.max(w.steep, 1.6); w.bowl *= 1.5; if (idx >= 4) { w.cliff *= 1.4; w.couloir = Math.max(w.couloir, 0.7); } }
  for (const t of hist.slice(-3)) if (t !== 'flat' && w[t] !== undefined) w[t] *= 0.2;
  if (w[last] !== undefined) w[last] = 0;
  let sum = 0;
  for (const k in w) sum += w[k];
  let r = R() * sum;
  for (const k in w) { r -= w[k]; if (r <= 0) return k; }
  return 'cruise';
}

const lane = (w, off = 0, o = {}) => ({ w, off, wob: o.wob || 0, wl: o.wl || 100, ph: o.ph || 0, groom: o.groom === undefined ? 1 : o.groom, kind: o.kind || 0 });
const noLane = () => lane(0, 0, { groom: 0 });
const KIND = { groomed: 0, trail: 1, chute: 2, jump: 3 };

function makeZone(type, idx, d0) {
  const R = mulberry32((Math.imul(S.seed, 1000003) + Math.imul(idx + 1, 7919)) >>> 0);
  const rr = (a, b) => a + (b - a) * R();
  const sg = R() < 0.5 ? -1 : 1;
  const ph = () => rr(0, TAU);
  const z = {
    type, idx, d0, len: 300, d1: 0, slope: 0.25, valley: 90, wall: 0.1, rock: 0.2, pow: 0.3, forest: 0.3, rough: 0.8, cross: 0, hill: 6, cap: 22,
    head: { A: 0, lam: 600, ph: ph() }, lanes: Array.from({ length: NL }, noLane), feats: [], pitches: [], cliff: null, sign: sg,
  };
  const L = z.lanes;
  switch (type) {
    case 'start':
      Object.assign(z, { len: 220, slope: 0.24, valley: 80, wall: 0.08, rock: 0.15, pow: 0.15, forest: 0.2, rough: 0.5, hill: 3 });
      L[0] = lane(16);
      break;
    case 'cruise':
      Object.assign(z, { len: rr(290, 400), slope: rr(0.22, 0.3), valley: rr(115, 150), wall: rr(0.04, 0.1), rock: 0.2, pow: 0.45, forest: rr(0.1, 0.32), rough: 0.8, cross: sg * rr(0, 0.06), hill: rr(6, 11) });
      z.head = { A: rr(0.26, 0.4), lam: rr(620, 900), ph: ph() };
      L[0] = lane(rr(8, 10.5), sg * rr(0, 22), { wob: rr(4, 8), wl: rr(140, 220), ph: ph() });
      L[1] = lane(rr(6, 8), -sg * rr(50, 72), { wob: 6, wl: rr(110, 150), ph: ph(), groom: 0.95 });
      if (R() < 0.85) L[2] = lane(rr(5.5, 7), sg * rr(78, 100), { wob: 6, wl: rr(100, 140), ph: ph(), groom: 0.9 });
      if (R() < 0.45) L[3] = lane(rr(3, 3.6), -sg * rr(98, 112), { wob: 5, wl: rr(90, 120), ph: ph(), groom: 0.6, kind: KIND.trail });
      break;
    case 'glade':
      Object.assign(z, { len: rr(300, 430), slope: rr(0.22, 0.3), valley: rr(100, 130), wall: rr(0.08, 0.16), rock: 0.3, pow: 0.6, forest: 1, rough: 1, cross: sg * rr(0, 0.05), hill: rr(5, 9) });
      z.head = { A: rr(0.3, 0.42), lam: rr(300, 400), ph: ph() };
      L[0] = lane(rr(6.5, 8), sg * rr(0, 12), { wob: rr(3, 6), wl: rr(110, 170), ph: ph() });
      L[2] = lane(rr(3, 3.7), sg * rr(30, 46), { wob: rr(5, 7), wl: rr(95, 125), ph: ph(), groom: 0.6, kind: KIND.trail });
      L[1] = lane(rr(3, 3.6), -sg * rr(28, 44), { wob: rr(4, 6), wl: rr(90, 120), ph: ph(), groom: 0.6, kind: KIND.trail });
      if (R() < 0.6) L[3] = lane(rr(3, 3.5), sg * rr(72, 92), { wob: rr(4, 7), wl: rr(100, 130), ph: ph(), groom: 0.6, kind: KIND.trail });
      if (R() < 0.5) L[4] = lane(rr(3, 3.5), -sg * rr(70, 90), { wob: rr(4, 7), wl: rr(100, 130), ph: ph(), groom: 0.6, kind: KIND.trail });
      break;
    case 'bowl':
      Object.assign(z, { len: rr(300, 420), slope: rr(0.3, 0.4), valley: rr(150, 190), wall: rr(0.04, 0.1), rock: 0.3, pow: 1, forest: 0.12, rough: 1.2, cross: sg * rr(0.03, 0.1), hill: rr(8, 15), cap: 20 });
      z.head = { A: rr(0.2, 0.34), lam: rr(520, 800), ph: ph() };
      L[0] = lane(rr(9, 11), sg * rr(65, 95), { wob: rr(5, 9), wl: rr(150, 230), ph: ph() });
      if (R() < 0.8) L[1] = lane(rr(7, 9), -sg * rr(65, 95), { wob: rr(5, 9), wl: rr(150, 230), ph: ph(), groom: 0.95 });
      if (R() < 0.5) L[3] = lane(rr(3, 3.6), sg * rr(0, 20), { wob: 7, wl: rr(90, 120), ph: ph(), groom: 0.6, kind: KIND.trail });
      break;
    case 'park':
      Object.assign(z, { len: rr(470, 580), slope: rr(0.15, 0.2), valley: rr(84, 104), wall: rr(0.08, 0.15), rock: 0.2, pow: 0.1, forest: 0.1, rough: 0.35, hill: rr(4, 7) });
      z.head = { A: rr(0.2, 0.28), lam: rr(300, 380), ph: ph() };
      L[0] = lane(rr(12, 14));
      L[1] = lane(rr(6, 7.2), -sg * rr(34, 42), { groom: 0.95, wob: 2, wl: 140, ph: ph() });
      if (R() < 0.65) L[2] = lane(6, sg * rr(36, 46), { groom: 0.95, wob: 2, wl: 150, ph: ph() });
      break;
    case 'bigair':
      Object.assign(z, { len: rr(420, 500), slope: 0.16, valley: rr(84, 104), wall: rr(0.08, 0.15), rock: 0.3, pow: 0.2, forest: 0.2, rough: 0.4, hill: rr(4, 8) });
      z.head = { A: 0.06, lam: 600, ph: ph() };
      L[0] = lane(rr(11, 13));
      L[1] = lane(rr(5, 6), sg * rr(34, 46), { groom: 0.9 });
      if (R() < 0.6) L[2] = lane(5, -sg * rr(38, 50), { groom: 0.9 });
      break;
    case 'steep':
      Object.assign(z, { len: rr(220, 320), slope: rr(0.42, 0.56), valley: rr(130, 170), wall: rr(0.05, 0.12), rock: 0.4, pow: 0.85, forest: 0.1, rough: 1.1, hill: rr(6, 12), cap: 22 });
      z.head = { A: rr(0.18, 0.3), lam: rr(380, 520), ph: ph() };
      L[0] = lane(rr(10, 12), sg * rr(25, 45), { wob: rr(4, 8), wl: rr(140, 200), ph: ph() });
      if (R() < 0.75) L[1] = lane(rr(7, 9), -sg * rr(60, 90), { wob: 6, wl: rr(120, 170), ph: ph(), groom: 0.95 });
      break;
    case 'couloir':
      Object.assign(z, { len: rr(200, 280), slope: rr(0.46, 0.6), valley: rr(11, 14), wall: rr(1.8, 2.4), rock: 1, pow: 0.45, forest: 0, rough: 0.7, hill: 2, cap: 70 });
      z.head = { A: rr(0.22, 0.32), lam: rr(260, 340), ph: ph() };   // Kurvenradius ≥ ca. 130 m: bei Höchsttempo noch fahrbar
      L[0] = lane(rr(4.2, 5.2), 0, { kind: KIND.chute, groom: 0.55, wob: 1.4, wl: 40, ph: ph() });
      break;
    case 'cliff':
      Object.assign(z, { len: rr(360, 440), slope: rr(0.2, 0.26), valley: rr(110, 140), wall: rr(0.06, 0.12), rock: 0.9, pow: 0.7, forest: 0.25, rough: 0.9, cross: sg * rr(0, 0.06), hill: rr(5, 9), cap: 24 });
      z.head = { A: rr(0.1, 0.18), lam: rr(500, 700), ph: ph() };
      L[0] = lane(rr(7.5, 9), sg * rr(55, 75), { groom: 0.95, wob: 3, wl: 160, ph: ph() });
      L[1] = lane(6.5, -sg * rr(8, 25), { groom: 0.55, kind: KIND.jump });
      if (R() < 0.55) L[2] = lane(rr(7, 8), -sg * rr(70, 92), { groom: 0.95, wob: 3, wl: 150, ph: ph() });
      break;
    case 'flat':
      Object.assign(z, { len: rr(110, 170), slope: rr(0.09, 0.12), valley: rr(100, 125), wall: 0.06, rock: 0.2, pow: 0.25, forest: 0.4, rough: 0.6, hill: 4 });
      z.head = { A: rr(0.12, 0.2), lam: rr(380, 460), ph: ph() };
      L[0] = lane(rr(13, 15));
      break;
  }
  varyZone(z, R, rr, ph);
  z.d1 = z.d0 + z.len;
  // Kurvenradius prüfen: R = lam / (2π A) darf nicht unter rmin fallen
  const A = z.head.A, lam = z.head.lam;
  if (A > 0 && lam / (TAU * A) < PCFG.rmin) { z.head.A = lam / (TAU * PCFG.rmin); issue(`Zone ${idx} (${type}): Kurve entschärft`); }
  spreadLanes(z);
  return z;
}

// ------------------------------------------------------------------ Variation
// Jede Zone wird zusätzlich abgewandelt, damit sich kein Abschnitt wiederholt: Länge, Kurvenstil, Spuren,
// Gelände-Formen (lange Wellen, Mulde/natürliche Halfpipe, Rücken in der Mitte, Kuppen), Baum- und Felsinseln.
// Alle Formen sind glatt (Krümmung begrenzt) und laufen an den Zonengrenzen weich aus.
const MOD_NAMES = { waves: 'wellig', gully: 'Mulde', ridge: 'mit Rücken', knolls: 'kuppig', islands: 'mit Baum-Inseln', rocks: 'mit Felsinseln', wide: 'weit', narrow: 'eng' };
function varyZone(z, R, rr, ph) {
  const ch = S.ch || { wide: 1, steep: 1, forest: 1, pow: 1, curvy: 1, mods: 1 };
  z.mods = {};
  z.label = '';
  if (z.type === 'start' || z.type === 'couloir') return;
  // Grundwerte leicht verschieben (Berg-Charakter + Zufall)
  z.len *= rr(0.75, 1.3);
  z.valley *= ch.wide * rr(0.9, 1.12);
  z.forest = clamp(z.forest * ch.forest * rr(0.7, 1.35), 0, 1);
  z.pow = clamp(z.pow * ch.pow * rr(0.8, 1.2), 0, 1);
  if (z.type !== 'park' && z.type !== 'bigair' && z.type !== 'flat') z.slope = clamp(z.slope * ch.steep * rr(0.94, 1.08), 0.12, 0.6);
  // Kurvenstil: gerade Schüsse, enge S-Kurven oder weite Bögen
  if (z.type !== 'bigair') {
    const st = R();
    if (st < 0.2) z.head.A *= 0.35;
    else if (st < 0.45) { z.head.lam *= 0.65; z.head.A *= 1.05 * ch.curvy; }
    else if (st < 0.65) { z.head.lam *= 1.4; z.head.A *= 1.15 * ch.curvy; }
    else z.head.A *= ch.curvy;
  }
  // Spuren durchmischen: Breiten, Seiten, gelegentlich wird aus einer Piste eine Waldbahn oder umgekehrt
  for (let i = 1; i < NL; i++) {
    const l = z.lanes[i];
    if (l.w <= 0) {
      if (z.type !== 'park' && z.type !== 'bigair' && z.type !== 'cliff' && R() < 0.22) {   // zusätzliche Spur
        const trail = R() < 0.6;
        z.lanes[i] = lane(trail ? rr(3, 3.6) : rr(5.5, 7.5), (R() < 0.5 ? -1 : 1) * rr(40, z.valley - 20), { wob: rr(3, 8), wl: rr(90, 180), ph: ph(), groom: trail ? 0.6 : 0.9, kind: trail ? KIND.trail : 0 });
      }
      continue;
    }
    if (l.kind === KIND.jump || l.kind === KIND.chute) continue;
    l.w *= rr(0.85, 1.2);
    l.off *= rr(0.8, 1.2);
    l.wob *= rr(0.6, 1.5);
    if (R() < 0.15) {
      if (l.kind === KIND.trail) { l.kind = 0; l.w = Math.max(l.w, rr(5, 6.5)); l.groom = 0.9; }
      else if (z.forest > 0.3) { l.kind = KIND.trail; l.w = rr(3, 3.6); l.groom = 0.6; }
    }
    if (R() < 0.12) { l.w = 0; l.groom = 0; }      // Spur fällt weg
  }
  // Gelände-Formen (0 bis 2 pro Zone)
  const flatZone = z.type === 'park' || z.type === 'bigair' || z.type === 'flat';
  const pool = flatZone || z.type === 'cliff' ? ['islands', 'rocks', 'wide', 'gully'] : ['waves', 'gully', 'ridge', 'knolls', 'islands', 'rocks', 'wide', 'narrow', 'waves'];
  const nm = Math.min(2, Math.floor(R() * 2.6 * ch.mods));
  const names = [];
  for (let k = 0; k < nm; k++) {
    const m = pool[Math.floor(R() * pool.length)];
    if (z.mods[m]) continue;
    switch (m) {
      case 'waves': { const lam = rr(75, 130); z.mods.waves = { lam, a: Math.min(rr(0.9, 2.0), 0.0065 * (lam / TAU) ** 2), ph: ph(), sk: rr(-0.25, 0.25) }; break; }   // Krümmung ≤ 0,0065/m: bei 100 km/h unter 0,6 g
      case 'gully': { const w = rr(45, 80); z.mods.gully = { k: rr(0.06, 0.1) / w, w }; break; }   // Querneigung am Rand höchstens 0,2
      case 'ridge': if (z.lanes.filter((l) => l.w > 0).length >= 2) z.mods.ridge = { h: rr(2.5, 5), w: rr(9, 15) }; else continue; break;
      case 'knolls': z.mods.knolls = { a: rr(0.5, 0.9), s: rr(40, 60), sd: R() * 100 }; break;
      case 'islands': z.mods.islands = { amt: rr(0.5, 0.9) }; break;
      case 'rocks': z.mods.rocks = { amt: rr(0.6, 1.2) }; break;
      case 'wide': z.valley *= 1.18; break;
      case 'narrow': z.valley = Math.max(70, z.valley * 0.78); break;
    }
    names.push(MOD_NAMES[m]);
  }
  // Mittelspur über einem Rücken liegt seitlich daneben
  if (z.mods.ridge && Math.abs(z.lanes[0].off) < z.mods.ridge.w + z.lanes[0].w + 4) z.lanes[0].off = (z.lanes[0].off >= 0 ? 1 : -1) * (z.mods.ridge.w + z.lanes[0].w + 6);
  z.label = names.join(', ');
}

/** Glatte Gelände-Formen einer Zone (Höhe relativ zum Grundgelände). u = Abstand zur Mittellinie. */
function modHeight(z, x, d, u, run) {
  const m = z.mods;
  if (!m) return 0;
  let y = 0;
  const fade = smoothstep(z.d0 - 70, z.d0 + 50, d) * (1 - smoothstep(z.d1 - 50, z.d1 + 70, d));
  if (fade <= 0) return 0;
  if (m.waves) y += m.waves.a * Math.sin(TAU * d / m.waves.lam + m.waves.ph + m.waves.sk * u / 20) * (1 - run);
  if (m.gully) { const g = m.gully; const uu = Math.min(Math.abs(u), g.w); y += g.k * uu * uu + g.k * 2 * g.w * Math.max(0, Math.abs(u) - g.w); }
  if (m.ridge) { const r = m.ridge; y += r.h * Math.exp(-(u * u) / (r.w * r.w)) * (1 - run); }
  if (m.knolls) { const k = m.knolls; y += k.a * (vnoise(x / k.s + k.sd, d / k.s) - 0.5) * 2 * (1 - run); }
  return y * fade;
}

/** Spuren dürfen sich nicht überlappen und müssen ins Tal passen; zu enge werden weggelassen. */
function spreadLanes(z) {
  const act = z.lanes.map((l, i) => ({ l, i })).filter((q) => q.l.w > 0).sort((a, b) => a.l.off - b.l.off);
  for (let k = 1; k < act.length; k++) {
    const a = act[k - 1].l, b = act[k].l;
    const need = a.w + b.w + 12 + a.wob + b.wob;
    if (b.off - a.off < need) b.off = a.off + need;
  }
  for (const { l } of act) {
    const maxOff = z.valley - l.w - 5 - l.wob;
    if (Math.abs(l.off) > maxOff) {
      if (maxOff < 8 && Math.abs(l.off) > 0) { l.w = 0; l.groom = 0; l.off = 0; l.wob = 0; issue(`Zone ${z.idx} (${z.type}): Spur passt nicht ins Tal`); } else l.off = Math.sign(l.off) * maxOff;
    }
  }
}

/** Abzweigungen entstehen aus bestehenden Spuren: neue Spuren wachsen aus ihrer Nachbarspur heraus, endende laufen in sie hinein. */
function linkLanes(prev, z) {
  const near = (zone, off, skip) => {
    let best = null;
    zone.lanes.forEach((l, i) => { if (i !== skip && l.w > 0 && (!best || Math.abs(l.off - off) < Math.abs(best.off - off))) best = l; });
    return best;
  };
  z.lanes.forEach((l, i) => {
    const pl = prev.lanes[i];
    if (l.w > 0 && pl.w <= 0) { const par = near(prev, l.off, i); if (par) { pl.off = par.off; pl.wob = 0; } }
    else if (l.w <= 0 && pl.w > 0) { const tgt = near(z, pl.off, i); if (tgt) { l.off = tgt.off; l.wob = 0; } }
  });
}

export function ensureZones(dTarget) {
  if (S.busy) return;
  S.busy = true;
  while (S.Z.length === 0 || S.Z[S.Z.length - 1].d1 < dTarget) {
    const idx = S.Z.length;
    const d0 = idx ? S.Z[idx - 1].d1 : 0;
    const R = mulberry32((Math.imul(S.seed, 4099) + Math.imul(idx + 1, 31337)) >>> 0);
    const type = pickType(idx, R);
    S.types.push(type);
    const z = makeZone(type, idx, d0);
    S.slopes.push(z.slope);
    if (idx) linkLanes(S.Z[idx - 1], z);
    S.Z.push(z);
    genFeatures(z, R);
    report.zones.push({ idx, type, d0: Math.round(d0), len: Math.round(z.len), slope: +z.slope.toFixed(2), lanes: z.lanes.filter((l) => l.w > 0).length, feats: z.feats.length });
  }
  S.busy = false;
}

function zoneIndex(d) {
  const Z = S.Z;
  let lo = 0, hi = Z.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (Z[mid].d0 <= d) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** Wählt die beiden Zonen und den Mischfaktor für Position d (weicher Übergang um die Zonengrenzen). */
let bz_a = null, bz_b = null, bz_t = 0, bz_i = 0;
function blendZones(d) {
  const Z = S.Z, T = PCFG.transition;
  const j = zoneIndex(d), z = Z[j];
  bz_i = j; bz_a = z; bz_b = z; bz_t = 0;
  if (j > 0 && d < z.d0 + T) { bz_a = Z[j - 1]; bz_t = smoothstep(z.d0 - T, z.d0 + T, d); }
  else if (d > z.d1 - T && Z[j + 1]) { bz_b = Z[j + 1]; bz_t = smoothstep(z.d1 - T, z.d1 + T, d); }
}

// ------------------------------------------------------------------ Mittellinie (Hub)
const headingFn = (z, d) => z.head.A * Math.sin((TAU * (d - z.d0)) / z.head.lam + z.head.ph);
function extendHub(n) {
  const hub = S.hub;
  while (hub.length <= n) {
    const k = hub.length - 1;
    const d = (k + 0.5) * HS;
    blendZones(d);
    const psi = clamp(lerp(headingFn(bz_a, d), headingFn(bz_b, d), bz_t) - 0.0042 * hub[k], -0.8, 0.8);
    hub.push(hub[k] + HS * Math.tan(psi));
  }
}
export function hubX(d) {
  if (d <= 0) return 0;
  if (!S.busy) ensureZones(d + PCFG.lookahead);
  const f = d / HS, i = Math.floor(f);
  extendHub(i + 2);
  return S.hub[i] + (S.hub[i + 1] - S.hub[i]) * (f - i);
}

// ------------------------------------------------------------------ Eigenschaften an Position d (zwischengespeichert)
const PR = { d: NaN, zi: 0, hub: 0, valley: 0, wall: 0, rock: 0, pow: 0, forest: 0, rough: 0, slope: 0, cross: 0, hill: 0, cap: 26, lx: Array(NL).fill(0), lw: Array(NL).fill(0), lg: Array(NL).fill(0), lk: Array(NL).fill(0), lkw: Array(NL).fill(0) };
export function props(d) {
  if (d < 0) d = 0;
  if (d === PR.d) return PR;
  if (!S.busy) ensureZones(d + PCFG.lookahead);
  const hub = hubX(d);
  blendZones(d);
  const A = bz_a, B = bz_b, tt = bz_t;
  PR.d = d; PR.zi = bz_i; PR.hub = hub;
  PR.valley = lerp(A.valley, B.valley, tt);
  PR.wall = lerp(A.wall, B.wall, tt);
  PR.rock = lerp(A.rock, B.rock, tt);
  PR.pow = lerp(A.pow, B.pow, tt);
  PR.forest = lerp(A.forest, B.forest, tt);
  PR.rough = lerp(A.rough, B.rough, tt);
  PR.slope = lerp(A.slope, B.slope, tt);
  PR.cross = lerp(A.cross, B.cross, tt);
  PR.hill = lerp(A.hill, B.hill, tt);
  PR.cap = lerp(A.cap, B.cap, tt);
  for (let i = 0; i < NL; i++) {
    const la = A.lanes[i], lb = B.lanes[i];
    const oa = la.off + la.wob * Math.sin(d / la.wl + la.ph);
    const ob = lb.off + lb.wob * Math.sin(d / lb.wl + lb.ph);
    PR.lx[i] = hub + lerp(oa, ob, tt);
    // Abzweigung: die neue Spur ist früh voll breit (liegt dort noch auf der Elternspur) und zieht dann seitlich weg –
    // so ist die Einfahrt breit statt eines schmalen Streifens. Endende Spuren bleiben bis kurz vor dem Zusammenfluss breit.
    const ga = la.groom * (la.w > 0 ? 1 : 0), gb = lb.groom * (lb.w > 0 ? 1 : 0);
    if (la.w <= 0 && lb.w > 0) { const k = smoothstep(0, 0.3, tt); PR.lw[i] = lb.w * k; PR.lg[i] = gb * k; }
    else if (lb.w <= 0 && la.w > 0) { const k = 1 - smoothstep(0.7, 1, tt); PR.lw[i] = la.w * k; PR.lg[i] = ga * k; }
    else { PR.lw[i] = lerp(la.w, lb.w, tt); PR.lg[i] = lerp(ga, gb, tt); }
    PR.lk[i] = tt < 0.5 ? la.kind : lb.kind;
    PR.lkw[i] = lerp(la.kind === 1 ? 1 : 0, lb.kind === 1 ? 1 : 0, tt);   // stetiger Waldbahn-Anteil (für die Rinne)
  }
  return PR;
}

// ------------------------------------------------------------------ Höhenprofil
function zoneSlopeAt(z, d) {
  let s = z.slope;
  for (const p of z.pitches) s += p.amt * smoothstep(p.d - p.e, p.d + p.e, d) * (1 - smoothstep(p.d + p.len - p.e, p.d + p.len + p.e, d));
  return s;
}
const GENTLE = 130;   // Länge der sanften Rampe (Spur A), über die die Klippenhöhe verteilt wird
function cliffSlope(z, d) {
  const f = z.cliffF;
  if (!f) return 0;
  const t = (d - f.dc + 55) / GENTLE, h = 0.02;
  return (f.hs * (ramp01(t + h, 0.3) - ramp01(t - h, 0.3))) / (2 * h * GENTLE);
}
/** Anlauf vor Sprüngen: 1 = völlig glatt und gerade (ca. 90 m vor dem Absprung), blendet davor und seitlich weich aus. */
let RW_U = 0;
function runwayAt(z, d, x) {
  let m = 0;
  const feats = z.feats;
  for (let k = 0; k < feats.length; k++) {
    const f = feats[k];
    if (f.kind !== 'jump') continue;
    const xx = d - f.d + f.J.Lr;          // 0 = Beginn der Absprungrampe
    const xe = f.J.Lr + f.ext1;           // Ende der Landung
    if (xx > xe + 40 || xx < -150) continue;
    // Anlauf ganz glatt; über Sprung und Landung keine Zusatzformen (Wellen, Kuppen), damit die berechnete Landung stimmt
    let a = smoothstep(-150, -90, xx) * (1 - smoothstep(xe + 10, xe + 40, xx));
    if (x !== undefined) a *= 1 - smoothstep(f.wT + 5, f.wT + 14, Math.abs(x - f.x));
    if (a > m) { m = a; RW_U = f.x - hubX(f.d); }
  }
  return m;
}
function slopeAt(d) {
  blendZones(d);
  const s = lerp(zoneSlopeAt(bz_a, d), zoneSlopeAt(bz_b, d), bz_t) + cliffSlope(bz_a === bz_b ? bz_a : (bz_t < 0.5 ? bz_a : bz_b), d);
  const base = d < 3 ? 0 : d < 45 ? lerp(0.02, 0.42, smoothstep(2, 24, d)) : lerp(0.42, s, smoothstep(45, 140, d));
  const run = runwayAt(S.Z[bz_i], d);
  return Math.max(0.03, base + (0.022 * snoise(d / 85, 3, S.seed) + 0.01 * snoise(d / 27, 9, S.seed) * (d > 60 ? 1 : 0)) * (1 - run));
}
export function Hof(d) {
  if (d <= 0) return d < -5 ? 0.45 * (-5 - d) : 0;
  if (!S.busy) ensureZones(d + PCFG.lookahead);
  const f = d / HST, i = Math.floor(f);
  const H = S.H;
  while (H.length <= i + 1) {
    const n = H.length;
    H.push(H[n - 1] - slopeAt((n - 0.5) * HST) * HST);
  }
  return H[i] + (H[i + 1] - H[i]) * (f - i);
}

// ------------------------------------------------------------------ Oberflächenmasken
export const SI = { edge: 1e9, groom: 0, pow: 0, forest: 0, lane: 0, u: 0, lx: 0, kind: 0, hub: 0, valley: 0 };
/** Abstand zur nächsten Spur, Pflege-Grad, Pulverschnee und Waldanteil an Position (x, d). */
export function surf(x, d) {
  const c = props(d);
  let edge = 1e9, groom = 0, ln = 0, uu = 0, lxx = c.hub;
  for (let i = 0; i < NL; i++) {
    const w = c.lw[i];
    if (w < 0.3) continue;
    const u = x - c.lx[i];
    const e = Math.abs(u) - w;
    if (e < edge) { edge = e; ln = i; uu = u; lxx = c.lx[i]; }
    const m = (1 - smoothstep(-0.5, 3.2, e)) * c.lg[i];
    if (m > groom) groom = m;
  }
  const patch = 0.55 + 0.45 * vnoise(x / 47 + 5, d / 47 + S.seed);
  const au = Math.abs(x - c.hub);
  const open = 1 - smoothstep(c.valley * 0.9, c.valley + 25, au) * 0.6;
  SI.edge = edge; SI.groom = groom; SI.lane = ln; SI.u = uu; SI.lx = lxx; SI.kind = c.lk[ln]; SI.hub = c.hub; SI.valley = c.valley;
  SI.pow = clamp(c.pow * patch * open * (1 - groom) * (1 - 0.7 * smoothstep(0.7, 1.1, slopeNow(c))), 0, 1);
  const clump = smoothstep(0.34, 0.6, fbm(x / 95 + S.seed * 0.37, d / 95));
  SI.forest = clamp(c.forest * (0.35 + 0.9 * clump), 0, 1);
  return SI;
}
const slopeNow = (c) => c.slope;

// ------------------------------------------------------------------ Gelände
const kinkOf = (f, x) => x - f.x;
function featRel(f, d, x, c) {
  switch (f.kind) {
    case 'jump': {
      const xx = d - f.d;
      if (xx < f.ext0 || xx > f.ext1) return 0;
      const J = f.J;
      const w = f.wT + (f.wL - f.wT) * smoothstep(0, J.xk, xx);
      const lat = 1 - smoothstep(w, w + PCFG.edge, Math.abs(kinkOf(f, x)));
      return lat > 0 ? jumpRel(xx, J) * lat : 0;
    }
    case 'roller': {
      const xx = d - f.d;
      if (xx < 0 || xx > f.len) return 0;
      const u = x - c.lx[f.lane];
      const lat = 1 - smoothstep(f.w, f.w + 4, Math.abs(u));
      if (lat <= 0) return 0;
      // n Wellen mit leicht ungleichen Abständen (FIS: nie identisch)
      const t = xx / f.len;
      const q = Math.sin(Math.PI * (t * f.n + 0.18 * Math.sin(t * Math.PI * 2)));
      return f.h * q * q * lat * Math.sin(Math.PI * t) ** 0.35;
    }
    case 'berm': {
      const xx = d - f.d;
      if (Math.abs(xx) > f.len / 2) return 0;
      const bell = Math.cos((Math.PI * xx) / f.len) ** 2;
      const u = (x - c.lx[f.lane]) * f.side;
      const bank = smoothstep(f.w * 0.1, f.w * 0.95, u) * (1 - smoothstep(f.w * 1.1, f.w * 1.7, u));
      return f.h * bell * bank;
    }
    case 'pillow': {
      const dx = x - f.x, dz = d - f.d;
      const r2 = (dx * dx) / (f.rx * f.rx) + (dz * dz) / (f.rz * f.rz);
      if (r2 >= 1) return 0;
      const s = 1 - r2;
      return f.h * s * s * (dz > 0 ? 1 : 1.1);
    }
    case 'moguls': {
      if (d < f.d || d > f.d + f.len) return 0;
      const lat = 1 - smoothstep(f.w * 0.7, f.w, Math.abs(x - f.x));
      const env = smoothstep(f.d, f.d + 14, d) * (1 - smoothstep(f.d + f.len - 14, f.d + f.len, d));
      return f.h * lat * env * (Math.sin(x / 3.4 + 1.7 * Math.sin(d / 9.5)) * Math.sin(d / 5.4 + x / 11) * 0.5 + 0.2);
    }
    case 'pinch': {
      const xx = d - f.d;
      if (Math.abs(xx) > f.len) return 0;
      const bell = Math.cos((Math.PI * xx) / (2 * f.len)) ** 2;
      const e = Math.abs(x - c.lx[0]) - f.gap;
      if (e < -1) return 0;
      // nur noch ein flacher Sockel: die eigentliche Engstelle bilden Felsbrocken (course.js), die darauf liegen
      return f.h * 0.3 * bell * smoothstep(-1, 4, e) * (1 - smoothstep(6, 16, e));
    }
    case 'ridge': {
      const xx = d - f.d;
      const lat = 1 - smoothstep(f.w, f.w + 1.3, Math.abs(x - f.x));
      if (lat <= 0 || xx < -f.J.Lr || xx > f.J.xk + 14) return 0;
      return lat * (jumpRel(xx, f.J) * 0.25 + 1.5 * smoothstep(-f.J.Lr * 0.6, 0, xx) * (1 - smoothstep(f.J.xk - 4, f.J.xk + 10, xx)));
    }
    case 'lip': {
      const xx = d - f.d;
      if (xx < -f.len || xx > 1) return 0;
      const lat = 1 - smoothstep(f.w, f.w + 3.5, Math.abs(x - f.x));
      return f.h * smoothstep(-f.len, -0.8, xx) * (1 - smoothstep(-0.8, 0.8, xx)) * lat;
    }
    default:
      return 0;
  }
}

/** Absenkung durch Klippenband (positiv = tiefer). */
function cliffDelta(f, d, x) {
  let mA = 0;
  for (const xa of f.xAs) mA = Math.max(mA, 1 - smoothstep(0, 24, Math.abs(x - xa)));
  const mB = 1 - smoothstep(f.wB, f.wB + 10, Math.abs(x - f.xB));
  const jag = 5.5 * snoise(x / 12.5, f.dc * 0.013, S.seed) * (1 - mB);
  const dd = d - f.dc - jag;
  if (dd < -60) return 0;
  const wallK = 1 + 0.28 * snoise(x / 19, f.dc * 0.011 + 4, S.seed) * (1 - mB);
  const C = f.C;
  const wallH = C.wall * wallK;
  let sharp = wallH * smoothstep(0, 3.2, dd);
  if (dd > C.a) sharp += (f.hs - wallH) * ramp01((dd - C.a) / C.L2, 0.3);   // der Geröllhang gleicht die Wandhöhe aus: Gesamthöhe bleibt hs
  const gentle = f.hs * ramp01((d - f.dc + 55) / GENTLE, 0.3);
  return (1 - mA * 0.96) * (sharp - gentle);
}

let lastZoneHint = 0;
export function heightP(x, z) {
  const d = -z;
  const dc = d < 0 ? 0 : d;
  const c = props(dc);
  let y = Hof(d);
  const hub = c.hub;
  const u = x - hub, au = Math.abs(u);
  const Zc = S.Z[c.zi];
  const runM = runwayAt(Zc, dc, x);
  const ue = u + runM * (RW_U - u);   // im Anlauf: seitliche Anteile des Geländes (Mulde, Querneigung) nicht mit der Mittellinie mitschwenken
  // Talflanken: im Normalfall sanfte Hügel mit Panorama, nur in Rinnen steile Felswände
  const e = au - c.valley;
  let lat = 0;
  if (e > 0) {
    const steepRock = c.rock > 0.8 && c.wall > 1.2;
    const rockN = (fbm(x / 13 + 3, dc / 13) - 0.5) * 3.2 * c.rock * smoothstep(0, 10, e) + (vnoise(x / 4.3, dc / 4.3) - 0.5) * 0.8 * c.rock * smoothstep(0, 14, e);
    lat += c.wall * e * (steepRock ? 1 + 0.012 * e : 1) + rockN;
    if (steepRock) lat += (fbm(x / 28 + 9, dc / 28) - 0.5) * 9 * smoothstep(4, 24, e);
  }
  y += 0.0007 * Math.min(ue * ue, c.valley * c.valley);
  // Spuren: Pflege-Grad glättet das Gelände, Waldbahnen liegen in einer flachen Rinne
  let groom = 0, chan = 0, bestM = 0, sumM = 0, sumMU = 0;
  for (let i = 0; i < NL; i++) {
    const w = c.lw[i];
    if (w < 0.3) continue;
    const e2 = Math.abs(x - c.lx[i]) - w;
    const m = (1 - smoothstep(-0.5, 3.2, e2)) * c.lg[i];
    if (m > groom) groom = m;
    if (m > bestM) bestM = m;
    sumM += m; sumMU += m * (c.lx[i] - hub);   // gewichteter Mittelwert statt harter Auswahl: keine Stufe, wenn die stärkste Spur wechselt
    if (c.lkw[i] > 0.001) chan = Math.max(chan, (1 - smoothstep(0, w * 1.2, Math.abs(x - c.lx[i]))) * c.lg[i] * c.lkw[i]);
  }
  // Querneigung: Hangpisten sind quer ausgeglichen, die Talseite bleibt offen
  if (c.cross !== 0) lat += c.cross * (ue + bestM * ((sumM > 1e-6 ? sumMU / sumM : ue) - ue));
  // seitlicher Anstieg wird weich begrenzt: offene Panoramen statt Schlucht (nur die Rinne darf hoch aufragen)
  y += c.cap * Math.tanh(lat / c.cap);
  // Zonen-Formen (Wellen, Mulde, Rücken, Kuppen) – im Übergang beide Zonen gewichtet
  const Za = S.Z[c.zi];
  y += modHeight(Za, x, dc, ue, runM);
  if (Za.idx > 0 && dc < Za.d0 + 70) y += modHeight(S.Z[Za.idx - 1], x, dc, ue, runM);
  else if (dc > Za.d1 - 70 && S.Z[Za.idx + 1]) y += modHeight(S.Z[Za.idx + 1], x, dc, ue, runM);
  // Hügel und Rücken außerhalb des Tals
  if (e > 0) y += c.hill * (fbm(x / 70 + S.seed * 0.9, dc / 85) - 0.45) * 2 * smoothstep(0, 40, e);
  y -= 0.3 * chan;
  const rough = c.rough * (1 - 0.9 * groom) * (1 - runM);
  y += rough * ((vnoise(x / 40, z / 40) - 0.5) * 1.0 + (vnoise(x / 16 + 7, z / 16) - 0.5) * 0.07);
  const powM = c.pow * (1 - groom) * (1 - runM);
  if (powM > 0.02) y += powM * ((vnoise(x / 15 + 31, dc / 15) - 0.5) * 0.22 + (vnoise(x / 34, dc / 34 + 8) - 0.5) * 0.55);
  // Features der aktuellen Zone
  const feats = Zc.feats;
  for (let k = 0; k < feats.length; k++) {
    const f = feats[k];
    if (dc < f.s0 || dc > f.s1) continue;
    if (f.kind === 'cliff') y -= cliffDelta(f, dc, x);
    else if (f.kind === 'roller' || f.kind === 'pillow' || f.kind === 'moguls' || f.kind === 'berm') y += featRel(f, dc, x, c) * (1 - runM);   // kein Kleinkram im Anlauf
    else y += featRel(f, dc, x, c);
  }
  // Nach einem Klippenband bleibt die Absenkung bestehen (die Zone danach beginnt auf tieferem Niveau)
  const ec = Math.abs(x) - 1e9;
  void ec;
  // Außenrand der Welt: Gelände steigt hinter dem befahrbaren Bereich sanft an (Wald am Hang), kein abrupter Rand
  const rimU = Math.min(262, c.valley + 55);
  const ee = au - (rimU - 25);
  if (ee > 0) y += 0.12 * ee + 0.0032 * ee * ee;
  void lastZoneHint;
  return y;
}

export function boundAt(d) {
  const c = props(d);
  return { c: c.hub, u: Math.min(262, c.valley + 55) };
}

// ------------------------------------------------------------------ Features erzeugen
const curvature = (z, d) => (z.head.A * TAU / z.head.lam) * Math.cos((TAU * (d - z.d0)) / z.head.lam + z.head.ph);

/** Nächster gerader Punkt der Mittellinie (Kurswinkel am Extrem) – hier stehen Sprünge. */
function snapStraight(z, d, range) {
  if (z.head.A < 0.03) return d;
  let best = d, bc = Math.abs(curvature(z, d));
  for (let k = -range; k <= range; k += 2) {
    const c = Math.abs(curvature(z, d + k));
    if (c < bc) { bc = c; best = d + k; }
  }
  return best;
}
/** Nächster Punkt stärkster Krümmung – hier stehen Steilkurven. */
function snapCurve(z, d, range) {
  let best = d, bc = -1;
  for (let k = -range; k <= range; k += 2) {
    const c = Math.abs(curvature(z, d + k));
    if (c > bc) { bc = c; best = d + k; }
  }
  return best;
}
function laneX(z, i, d) {
  const L = z.lanes[i];
  return hubXq(d) + L.off + L.wob * Math.sin(d / L.wl + L.ph);
}
const hubXq = (d) => hubX(d);

function laneKind(i, z) { return z.lanes[i].kind; }

/** Sprung auf Spur i bei etwa d einfügen. Gibt das Ende des Features (Meter) zurück oder null. */
function addJump(z, R, o) {
  const d = o.exactD !== undefined ? o.exactD : snapStraight(z, o.d, 40);
  const x = laneX(z, o.lane, d) + (o.dx || 0);
  // Keine Steilstufe im Anlauf, über dem Sprung oder in der Landung: sonst stimmt weder der gerade Anlauf noch die Landung
  const w0 = d - (o.Lr || 14) - 165, w1 = d + 140;
  z.pitches = z.pitches.filter((p) => p.own || p.d + p.len + p.e < w0 || p.d - p.e > w1);
  const sRun = zoneSlopeAt(z, d - 70) * 0.5 + zoneSlopeAt(z, d - 20) * 0.5;
  const sHere = zoneSlopeAt(z, d);
  const vu = terminalSpeed(sRun, 0), vt = terminalSpeed(sRun, 1);
  const v = Math.sqrt(vu * vt);
  const steep = o.steep ? { t2: o.steep, xb: 4, len: 160 } : null;
  const des = designJump({
    kind: o.kind === 'stepup' ? 'stepup' : 'table', theta: Math.atan(sHere), steep, vDes: v, vRange: [vu * 0.95, vt * 1.03],
    phiDeg: o.phi, Lr: o.Lr, hMax: o.hMax, su: o.su || 0, sd: o.sd || 0,
  });
  const rec = { zone: z.idx, kind: o.name || o.kind, d: Math.round(d), lane: o.lane };
  if (!des || !des.ok) { issue(`Zone ${z.idx}: ${o.name || o.kind} bei ${Math.round(d)} m verworfen (keine sichere Landung)`); return null; }
  if (d + des.ext1 > z.d1 - PCFG.transition - 8) { report.skipped = (report.skipped || 0) + 1; return null; }
  const wT = o.wT, wL = wT * 1.7;
  z.feats.push({ kind: 'jump', d, x, J: des.J, wT, wL: o.wL || wT * 1.7, ext0: des.ext0, ext1: des.ext1, s0: d - des.J.Lr - 10, s1: d + des.ext1 + 10, lane: o.lane, name: o.name || o.kind });
  if (steep) z.pitches.push({ d: d + 4, amt: o.steep - sHere, len: des.ext1 + 40, e: 14, own: true });
  Object.assign(rec, {
    flight: +des.flight.toFixed(1), airT: +des.airT.toFixed(2), height: +des.J.h.toFixed(1), vn: +des.vn.toFixed(1),
    vnLow: +des.vnLow.toFixed(1), vnHigh: +des.vnHigh.toFixed(1), speed: `${vu.toFixed(0)}-${vt.toFixed(0)}`,
  });
  report.features.push(rec);
  if (des.vnHigh > 17) issue(`Zone ${z.idx}: ${rec.kind} bei ${rec.d} m landet bei Höchsttempo hart (${rec.vnHigh} m/s)`);
  return { end: d + Math.max(des.ext1, des.xHigh + 10) + 14, d, des };
}

function addRoller(z, o) {
  const d = snapStraight(z, o.d, 30);
  const len = o.n * o.spacing;
  if (d + len > z.d1 - PCFG.transition - 8) return null;
  z.feats.push({ kind: 'roller', d, len, n: o.n, h: o.h, w: o.w, lane: o.lane, s0: d - 6, s1: d + len + 6 });
  report.features.push({ zone: z.idx, kind: `Roller x${o.n}`, d: Math.round(d), lane: o.lane, height: o.h, wave: o.spacing });
  return d + len + 6;
}

function addBerm(z, o) {
  const d = snapCurve(z, o.d, 40);
  const len = o.len || 44;
  if (d + len / 2 > z.d1 - PCFG.transition - 6 || d - len / 2 < z.d0 + PCFG.transition + 6) return null;
  // Krümmungsrichtung der Spur (zweite Ableitung der Seitenlage)
  const x0 = laneX(z, o.lane, d - 12), x1 = laneX(z, o.lane, d), x2 = laneX(z, o.lane, d + 12);
  const k = x2 - 2 * x1 + x0;
  if (Math.abs(k) < 0.25) return null;
  const side = -Math.sign(k);
  z.feats.push({ kind: 'berm', d, len, h: o.h, w: o.w, lane: o.lane, side, s0: d - len / 2 - 3, s1: d + len / 2 + 3 });
  report.features.push({ zone: z.idx, kind: 'Steilkurve', d: Math.round(d), lane: o.lane, height: o.h, radius: Math.round(144 / Math.abs(k)) });
  return d + len / 2 + 6;
}

function addPillow(z, R, d, x, big) {
  const rx = big ? 9 + R() * 5 : 4.5 + R() * 3, rz = big ? 14 + R() * 6 : 7 + R() * 4, h = big ? 1.3 + R() * 1 : 0.4 + R() * 0.5;
  z.feats.push({ kind: 'pillow', d, x, rx, rz, h, s0: d - rz, s1: d + rz });
}

/** Steilstufen: kurze steile Abbrüche mit anschließendem Absatz, damit lange sanfte Pisten abwechslungsreich werden. */
function addPitches(z, R, n) {
  const T = PCFG.transition;
  for (let k = 0; k < n; k++) {
    const d = z.d0 + T + 30 + R() * Math.max(10, z.len - 2 * T - 140);
    const amt = 0.16 + R() * 0.16, len = 45 + R() * 50;
    z.pitches.push({ d, amt, len, e: 18 });
    z.pitches.push({ d: d + len + 28, amt: -0.07, len: 36, e: 14 });
  }
}

/** Zonenspezifische Strecken-Rhythmen: Features werden in sinnvoller Reihenfolge entlang der Spur gesetzt. */
function genFeatures(z, R) {
  const rr = (a, b) => a + (b - a) * R();
  const T = PCFG.transition;
  const a = z.d0 + T + 18, b = z.d1 - T - 14;
  let cur = a;
  const chain = (list) => {
    for (const it of list) {
      if (cur > b - 30) break;
      let end = null;
      if (it.t === 'roller') end = addRoller(z, { d: cur, lane: it.lane || 0, n: it.n, spacing: Math.max(17, (it.sp || rr(9, 12)) * 1.75), h: Math.min(0.7, it.h || rr(0.45, 0.7)),   /* lange, flache Wellen: man kann sie wegdrücken, statt ausgehebelt zu werden */ w: it.w || z.lanes[it.lane || 0].w * 0.85 });
      else if (it.t === 'berm') end = addBerm(z, { d: cur + 20, lane: it.lane || 0, h: it.h || rr(1.5, 2.3), w: z.lanes[it.lane || 0].w, len: it.len });
      else if (it.t === 'spine') {
        const d = snapStraight(z, cur + 25, 40);
        const a1 = addJump(z, R, { d, exactD: d, lane: 0, kind: 'table', name: 'Spine (links)', phi: 8, Lr: 13, hMax: 4.4, wT: 3.1, wL: 4.6, dx: -6.4 });
        const a2 = addJump(z, R, { d, exactD: d, lane: 0, kind: 'table', name: 'Spine (rechts)', phi: 8, Lr: 13, hMax: 4.4, wT: 3.1, wL: 4.6, dx: 6.4 });
        if (a1 && a2) {
          z.feats.push({ kind: 'ridge', d, x: laneX(z, 0, d), J: a1.des.J, w: 0.9, s0: d - 20, s1: d + a1.des.ext1 + 10 });
          report.features.push({ zone: z.idx, kind: 'Spine', d: Math.round(d), lane: 0 });
          end = a1.end;
        }
      } else if (it.t === 'jump') {
        const j = addJump(z, R, { d: cur + 25, lane: it.lane || 0, ...it });
        end = j ? j.end : null;
      }
      cur = (end === null ? cur + 20 : end) + (it.gap === undefined ? (it.t === 'jump' ? rr(8, 18) : rr(26, 44)) : Math.min(it.gap, it.t === 'jump' ? 18 : 99));
    }
  };
  const sideLine = (li, start, items) => { if (z.lanes[li].w > 0) { cur = a + start; chain(items.map((x) => ({ lane: li, ...x }))); } };
  switch (z.type) {
    case 'cruise': {
      addPitches(z, R, 1);
      chain([
        { t: 'roller', n: 2 }, { t: 'jump', kind: 'table', name: 'Kicker', phi: 5, Lr: 11, hMax: 3.2, wT: 4.2 },
        { t: 'berm' }, { t: 'jump', kind: 'table', name: 'Tisch', phi: 9, Lr: 14, hMax: 5, wT: 4.6 }, { t: 'roller', n: 3 },
      ]);
      sideLine(1, 40, [{ t: 'jump', kind: 'table', name: 'Kicker (Seitenlinie)', phi: 6, Lr: 11, hMax: 3.4, wT: 3.2, gap: 50 }, { t: 'roller', n: 2, w: 5 }]);
      sideLine(2, 70, [{ t: 'roller', n: 3, w: 4.5, sp: 10, gap: 40 }, { t: 'jump', kind: 'table', name: 'Kicker (Seitenlinie)', phi: 6, Lr: 11, hMax: 3.4, wT: 3.2 }]);
      break;
    }
    case 'glade': {
      addPitches(z, R, 1);
      chain([{ t: 'roller', n: 2, lane: 0 }, { t: 'berm', lane: 0 }, { t: 'jump', kind: 'table', name: 'Kicker', phi: 5, Lr: 10, hMax: 3, wT: 3.4 }]);
      for (const li of [2, 1, 3, 4]) {
        if (z.lanes[li].w <= 0) continue;
        cur = a + 15 + li * 12;
        chain([{ t: 'berm', lane: li, h: rr(1.1, 1.7), len: 36, gap: 14 }, { t: 'berm', lane: li, h: rr(1.1, 1.7), len: 36, gap: 14 }, { t: 'jump', lane: li, kind: 'table', name: 'Waldkicker', phi: 4, Lr: 9, hMax: 2.3, wT: 2.2, gap: 14 }, { t: 'berm', lane: li, h: 1.3, len: 36 }]);
      }
      break;
    }
    case 'bowl': {
      z.pitches.push({ d: z.d0 + z.len * 0.36, amt: 0.13, len: 60, e: 22 }, { d: z.d0 + z.len * 0.7, amt: -0.1, len: 50, e: 22 });
      for (let k = 0; k < 9; k++) {
        const dd = rr(a + 15, b - 15);
        const sd = R() < 0.5 ? -1 : 1;
        addPillow(z, R, dd, hubX(dd) + sd * rr(12, z.valley * 0.8), k % 3 === 0);
      }
      for (let k = 0; k < 2; k++) {
        const dm = rr(a + 10, Math.max(a + 12, b - 150));
        z.feats.push({ kind: 'moguls', d: dm, len: rr(90, 150), x: hubX(dm) + (k ? 1 : -1) * z.sign * rr(25, 50), w: rr(16, 26), h: rr(0.16, 0.24), s0: dm - 4, s1: dm + 170 });
      }
      chain([{ t: 'roller', n: 2, lane: 0 }]);
      sideLine(1, 60, [{ t: 'roller', n: 2, w: 6, gap: 30 }]);
      break;
    }
    case 'steep': {
      // Steilhang: Roll-over, dann Mogelpiste und Pulverrinnen
      z.pitches.push({ d: z.d0 + T + 20, amt: 0.1, len: 50, e: 20 });
      for (let k = 0; k < 7; k++) {
        const dd = rr(a + 10, b - 10), sd = R() < 0.5 ? -1 : 1;
        addPillow(z, R, dd, hubX(dd) + sd * rr(20, z.valley * 0.85), k % 2 === 0);
      }
      for (let k = 0; k < 2; k++) {
        const dm = rr(a, Math.max(a + 5, b - 120));
        z.feats.push({ kind: 'moguls', d: dm, len: rr(80, 120), x: hubX(dm) + (k ? -1 : 1) * z.sign * rr(30, 60), w: rr(16, 22), h: rr(0.18, 0.26), s0: dm - 4, s1: dm + 140 });
      }
      chain([{ t: 'berm', lane: 0, h: 1.6, len: 40 }]);
      break;
    }
    case 'park': {
      // Rhythmus wie im Ski-Cross: Anlauf, Wellen, Steilkurve, Sprungkombination, Landung auslaufen lassen
      chain([
        { t: 'roller', n: 3, sp: 10 }, { t: 'berm', len: 48 }, { t: 'jump', kind: 'table', name: 'Tischsprung', phi: 9, Lr: 14, hMax: 5, wT: 5, gap: 18 },
        { t: 'roller', n: 2, sp: 11 }, { t: 'jump', kind: 'stepup', su: 1.5, name: 'Step-up', phi: 10, Lr: 14, hMax: 5, wT: 4.6, gap: 24 },
        { t: 'berm', len: 50 }, { t: 'jump', kind: 'table', sd: 2.2, name: 'Step-down', phi: 9, Lr: 14, hMax: 5, wT: 4.6, gap: 30 }, { t: 'spine', gap: 34 },
        { t: 'jump', kind: 'table', name: 'Großer Tisch', phi: 14, Lr: 20, hMax: 9, wT: 5.6 },
      ]);
      sideLine(1, 70, [{ t: 'jump', kind: 'table', name: 'Kicker (Seitenlinie)', phi: 6, Lr: 11, hMax: 3.4, wT: 3, gap: 40 }, { t: 'roller', n: 3, w: 5, sp: 9 }, { t: 'jump', kind: 'table', name: 'Kicker (Seitenlinie)', phi: 7, Lr: 12, hMax: 3.8, wT: 3, gap: 30 }]);
      sideLine(2, 90, [{ t: 'roller', n: 3, w: 4.5, sp: 10, gap: 36 }, { t: 'berm', h: 1.4, len: 40 }, { t: 'roller', n: 2, w: 4.5, sp: 11 }]);
      break;
    }
    case 'bigair': {
      // Anlauf auf mäßigem Gefälle (kalkulierbares Tempo), dann Mausefalle-artiger Abbruch hinter der Kante
      cur = z.d0 + z.len * 0.5;
      addJump(z, R, { d: cur, lane: 0, kind: 'table', name: 'Big Air', phi: 16, Lr: 23, hMax: 11, wT: 6, steep: 0.55 });
      chain([{ t: 'roller', n: 2, gap: 20 }]);
      sideLine(1, 50, [{ t: 'jump', kind: 'table', name: 'Kicker (Seitenlinie)', phi: 6, Lr: 11, hMax: 3.2, wT: 3, gap: 40 }]);
      sideLine(2, 60, [{ t: 'roller', n: 3, w: 4, sp: 10 }]);
      break;
    }
    case 'couloir': {
      // Engstellen: Felsen schieben sich von beiden Seiten in die Rinne
      for (let k = 0; k < 3; k++) {
        const dd = a + 20 + k * ((b - a - 40) / 2.4) + rr(-8, 8);
        const gap = rr(3.6, 4.6);
        z.feats.push({ kind: 'pinch', d: dd, len: 20, h: rr(2.5, 4), gap, s0: dd - 22, s1: dd + 22 });
        report.features.push({ zone: z.idx, kind: 'Engstelle', d: Math.round(dd), gap: +(gap * 2).toFixed(1) });
      }
      break;
    }
    case 'cliff': {
      // Schelf (flach, bremst), Klippenband quer über das Tal, Rampen für sichere Linien, Sprungspur für Mutige
      const dc = z.d0 + z.len * 0.58;
      const sShelf = 0.09;
      z.pitches.push({ d: dc - 110, amt: sShelf - z.slope, len: 108, e: 16 });
      const hs = rr(9, 19);
      const des = designCliff({ theta: Math.atan(sShelf), vDes: 17.5, drop: hs, maxWall: 11 });
      if (!des) { issue(`Zone ${z.idx}: Klippe nicht konstruierbar`); break; }
      const xB = laneX(z, 1, dc), xAs = [laneX(z, 0, dc)];
      if (z.lanes[2].w > 0) xAs.push(laneX(z, 2, dc));
      const cf = { kind: 'cliff', dc, hs, C: des.C, xAs, xB, wB: z.lanes[1].w, s0: dc - 70, s1: dc + 140 };
      z.feats.push(cf);
      z.cliffF = cf;
      z.feats.push({ kind: 'lip', d: dc, x: xB, w: 4, h: 0.9, len: 12, s0: dc - 16, s1: dc + 3 });
      z.cliff = { dc, hs, ...des.C };
      report.features.push({
        zone: z.idx, kind: 'Klippe', d: Math.round(dc), lane: 1, drop: +hs.toFixed(1), wall: +des.C.wall.toFixed(1), talus: +des.C.talus.toFixed(1),
        flight: +des.flight.toFixed(1), vn: +des.vn.toFixed(1), vnLow: +des.vnLow.toFixed(1), vnHigh: +des.vnHigh.toFixed(1),
      });
      if (!des.ok) issue(`Zone ${z.idx}: Klippe landet hart (${des.vn.toFixed(1)} m/s)`);
      chain([{ t: 'roller', n: 2, gap: 10 }]);
      break;
    }
    case 'flat': {
      cur = a + 5;
      chain([{ t: 'roller', n: 2, h: 0.6 }]);
      break;
    }
    default:
      break;
  }
  z.feats.sort((p, q) => p.s0 - q.s0);
}

// ------------------------------------------------------------------ Abfragen für Welt, Physik und Karte
export const pisteSeed = () => (S ? S.seed : 0);

/** Pulverschnee-Tiefe an Position (x, z): 0 = präpariert/hart, 1 = tiefer Pulverschnee. */
export function powderAt(x, z) { return surf(x, -z).pow; }

/** Nächste Spur an Position: Abstand zum Rand (negativ = auf der Spur). */
export function laneEdge(x, z) { return surf(x, -z).edge; }

/** Daten für die Minikarte: Spuren, Features und Tal im Bereich [d0, d1]. */
export function mapSlice(d0, d1, step) {
  const rows = [];
  for (let d = d0; d <= d1; d += step) {
    const c = props(d);
    rows.push({ d, hub: c.hub, valley: c.valley, lanes: Array.from({ length: NL }, (_, i) => ({ x: c.lx[i], w: c.lw[i], g: c.lg[i], k: c.lk[i] })), slope: c.slope });
  }
  const feats = [];
  for (const z of S.Z) {
    if (z.d1 < d0 - 300 || z.d0 > d1 + 300) continue;
    for (const f of z.feats) {
      const d = f.kind === 'cliff' ? f.dc : f.d;
      if (d >= d0 && d <= d1 && (f.kind === 'jump' || f.kind === 'cliff' || f.kind === 'berm')) feats.push({ kind: f.kind, d, x: f.kind === 'cliff' ? f.xB : f.x, size: f.J ? f.J.h : f.hs || 1, name: f.name });
    }
  }
  const zones = S.Z.filter((z) => z.d1 >= d0 && z.d0 <= d1).map((z) => ({ type: z.type, d0: z.d0, d1: z.d1 }));
  return { rows, feats, zones };
}

/** Rohe Zonenliste (für Tests und die Dokumentation). */
export const zonesOf = (dMax) => { ensureZones(dMax); return S.Z; };
export const zoneAtD = (d) => { props(d); return S.Z[zoneIndex(d)]; };
export function slopeTanAt(d) { return slopeAt(d); }

// ------------------------------------------------------------------ Hilfen für die Welt-Erzeugung
/** Alle Features, deren Referenzpunkt im Bereich [d0, d1) liegt. */
export function featuresIn(d0, d1) {
  ensureZones(d1 + PCFG.lookahead);
  const out = [];
  for (const z of S.Z) {
    if (z.d1 < d0 - 300 || z.d0 > d1 + 300) continue;
    for (const f of z.feats) {
      const fd = f.kind === 'cliff' ? f.dc : f.d;
      if (fd >= d0 && fd < d1) out.push(f);
    }
  }
  return out;
}
/** Steht an (x, d) ein Feature (Sprung, Landung, Rollen, Mogulfeld, Kissen), das frei von Bäumen und Felsen bleiben muss? */
export function inFeatureZone(x, d, m = 3) {
  const z = zoneAtD(d);
  for (const f of z.feats) {
    if (f.kind === 'jump') {
      const xx = d - f.d;
      if (xx > f.ext0 - m && xx < f.ext1 + m && Math.abs(x - f.x) < f.wL + PCFG.edge + m) return true;
    } else if (f.kind === 'cliff') {
      if (d > f.dc - 25 && d < f.dc + 95 && Math.abs(x - f.xB) < 15 + m) return true;
    } else if (f.kind === 'pillow') {
      const dx = (x - f.x) / (f.rx + m), dz = (d - f.d) / (f.rz + m);
      if (dx * dx + dz * dz < 1) return true;
    } else if (f.kind === 'moguls') {
      if (d > f.d - m && d < f.d + f.len + m && Math.abs(x - f.x) < f.w + m) return true;
    } else if (f.kind === 'roller') {
      if (d > f.d - m && d < f.d + f.len + m && Math.abs(x - laneXq(f.lane, d)) < f.w + 5 + m) return true;
    }
  }
  return false;
}
const laneXq = (i, d) => props(d).lx[i];
export const slopeColor = (d) => difficultyColor(props(d).slope);
export function difficultyColor(slope) {
  return slope < 0.27 ? 'blue' : slope < 0.37 ? 'red' : 'black';
}
export { jumpRel, cliffDrop, slopeTan };
