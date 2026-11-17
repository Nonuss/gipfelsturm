// Prozeduraler Freeride-Berg: Zonen-Grammatik, Routen (Pisten, Waldbahnen, Klippen-Linien), Gelände, Features.
//
// Aufbau (siehe PISTE_REFERENCE_RESEARCH.md):
//  1. Routenplanung    – Zonen (Wald, Pulverhang, Klippen, Rinne, Park, Big Air …) werden nach einer Grammatik gewürfelt.
//  2. Mittellinie      – „Hub“: aus Kurswinkel integriert (Sweeper, Esses), driftet nie weg.
//  3. Routen           – drei Spuren (A/B/C) spalten sich von der Mittellinie ab und laufen wieder zusammen (Abzweigungen).
//  4. Höhenprofil      – Gefälle je Zone, Steilstufen, Auslaufflächen; Features (Sprünge, Rollen, Steilkurven, Klippen) additiv.
//  5. Validierung      – Landungen werden mit der echten Flugbahn berechnet, Radien und Gefälle geprüft.
import { clamp, lerp, smoothstep, mulberry32, vnoise, fbm, snoise } from './mathutil.js';
import { designJump, designCliff, terminalSpeed, ramp01, jumpRel, cliffDrop, slopeTan, GR } from './jumps.js';

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
export function pisteInit(seed, style = 'freeride') {
  S = { seed, style, Z: [], hub: [0], H: [0], busy: false, types: [], slopes: [] };
  // Berg-Charakter: jeder Startwert bevorzugt andere Zonen und hat eigene Grundzüge (Waldberg, Pulverberg, Felsberg …)
  const Rc = mulberry32((Math.imul(seed, 2246822519) ^ 0x5bd1e995) >>> 0);
  const ch = { w: {}, wide: 0.85 + Rc() * 0.35, steep: 0.92 + Rc() * 0.16, forest: 0.7 + Rc() * 0.6, pow: 0.75 + Rc() * 0.5, curvy: 0.75 + Rc() * 0.6, mods: 0.6 + Rc() * 0.8 };
  for (const k of [...Object.keys(W), ...Object.keys(WF), ...Object.keys(WH)]) ch.w[k] = 0.45 + Rc() * 1.2;
  S.ch = ch;
  PR.d = NaN;
  report.seed = seed; report.zones = []; report.features = []; report.issues = []; report.skipped = 0;
  ensureZones(PCFG.lookahead);
}
const issue = (msg) => { if (report.issues.length < 400) report.issues.push(msg); };

// ------------------------------------------------------------------ Zonen
const W = { cruise: 0.85, glade: 1.25, bowl: 1.0, park: 0.8, bigair: 0.6, couloir: 0.55, cliff: 0.85, steep: 1.15, flat: 0.25 };
// Freestyle-Berg: fast nur Sprungzonen, dazwischen gelegentlich Klippen und kurze Ausläufe
const WF = { jumpline: 2.4, megaair: 1.0, slopestyle: 1.6, railpark: 1.8, bigair: 0.8, cliff: 0.45, flat: 0.15 };
function pickFreestyle(idx, R) {
  if (idx === 0) return 'start';
  if (idx === 1) return 'jumpline';
  const hist = S.types, last = hist[hist.length - 1];
  const w = { ...WF };
  for (const k in w) w[k] *= S.ch ? S.ch.w[k] || 1 : 1;
  if (w[last] !== undefined) w[last] *= last === 'jumpline' ? 0.35 : 0;
  if (last === 'megaair') w.flat = 0.8;
  let sum = 0;
  for (const k in w) sum += w[k];
  let r = R() * sum;
  for (const k in w) { r -= w[k]; if (r <= 0) return k; }
  return 'jumpline';
}
// Heli-Berg: Gipfel, Gletscher, steile Pulverflanken, Felsgärten, Riesenklippen, Rinnen – alles Tiefschnee, keine Pisten
const WH = { glacier: 1.5, face: 1.8, rockgarden: 1.3, cliff: 1.0, couloir: 0.9, bowl: 0.9, spines: 1.4, dropzone: 1.6, icefall: 1.0 };
function pickHeli(idx, R) {
  if (idx === 0) return 'summit';
  if (idx === 1) return 'glacier';
  const hist = S.types, last = hist[hist.length - 1];
  const w = { ...WH };
  for (const k in w) w[k] *= S.ch ? S.ch.w[k] || 1 : 1;
  if (w[last] !== undefined) w[last] = 0;
  if (last === 'couloir' || last === 'cliff' || last === 'dropzone') { w.glacier *= 1.6; w.bowl *= 1.5; w.couloir = 0; w.cliff *= 0.3; w.dropzone *= 0.3; }
  if (last !== 'glacier') w.icefall *= 0.4;   // Eisbruch meist unterhalb eines Gletschers
  let sum = 0;
  for (const k in w) sum += w[k];
  let r = R() * sum;
  for (const k in w) { r -= w[k]; if (r <= 0) return k; }
  return 'face';
}
function pickType(idx, R) {
  if (S.style === 'heli') return pickHeli(idx, R);
  if (S.style === 'freestyle') return pickFreestyle(idx, R);
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
    head: { A: 0, lam: 600, ph: ph() }, lanes: Array.from({ length: NL }, noLane), feats: [], pitches: [], rails: [], cliff: null, sign: sg,
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
    // ---- Freestyle-Zonen: breite, präparierte Hänge mit gleichmäßigem Gefälle, damit man vor jedem Sprung Tempo aufbaut
    case 'jumpline':
      Object.assign(z, { len: rr(620, 820), slope: rr(0.25, 0.3), valley: rr(105, 135), wall: rr(0.05, 0.1), rock: 0.2, pow: 0.2, forest: rr(0.15, 0.35), rough: 0.4, hill: rr(4, 7) });
      z.head = { A: rr(0.08, 0.16), lam: rr(700, 950), ph: ph() };
      L[0] = lane(rr(13, 15), sg * rr(0, 10), { wob: 2, wl: 200, ph: ph() });
      L[1] = lane(rr(7, 8.5), -sg * rr(44, 56), { groom: 0.95, wob: 3, wl: 180, ph: ph() });
      if (R() < 0.7) L[2] = lane(rr(7, 8.5), sg * rr(46, 58), { groom: 0.95, wob: 3, wl: 180, ph: ph() });
      break;
    case 'megaair':
      Object.assign(z, { len: rr(640, 780), slope: rr(0.15, 0.17), valley: rr(110, 140), wall: rr(0.05, 0.1), rock: 0.3, pow: 0.2, forest: 0.2, rough: 0.35, hill: rr(4, 7) });
      z.head = { A: 0.04, lam: 900, ph: ph() };
      L[0] = lane(rr(14, 16));
      L[1] = lane(rr(6.5, 8), sg * rr(48, 60), { groom: 0.95 });
      break;
    // ---- Heli-Zonen: Hochgebirge über der Baumgrenze, überall Tiefschnee
    case 'summit':
      Object.assign(z, { len: 200, slope: 0.36, valley: 70, wall: 0.55, rock: 0.9, pow: 1, forest: 0, rough: 1.0, hill: 14, cap: 40 });
      z.head = { A: 0.05, lam: 600, ph: ph() };
      L[0] = lane(11, 0, { groom: 0 });
      break;
    case 'glacier':
      Object.assign(z, { len: rr(480, 680), slope: rr(0.28, 0.36), valley: rr(170, 215), wall: rr(0.05, 0.1), rock: 0.45, pow: 1, forest: 0, rough: 1.5, hill: rr(12, 18), cap: 26 });
      z.head = { A: rr(0.1, 0.22), lam: rr(700, 1000), ph: ph() };
      L[0] = lane(rr(9, 12), sg * rr(0, 30), { groom: 0, wob: 10, wl: 260, ph: ph() });
      L[1] = lane(rr(8, 10), -sg * rr(70, 110), { groom: 0, wob: 10, wl: 240, ph: ph() });
      z.mods = { waves: { lam: rr(110, 160), a: rr(1.6, 2.6), ph: ph(), sk: rr(-0.3, 0.3) } };
      break;
    case 'face':
      Object.assign(z, { len: rr(320, 460), slope: rr(0.5, 0.62), valley: rr(140, 185), wall: rr(0.06, 0.14), rock: 0.7, pow: 1, forest: 0, rough: 1.2, hill: rr(10, 16), cap: 24 });
      z.head = { A: rr(0.12, 0.24), lam: rr(420, 600), ph: ph() };
      L[0] = lane(rr(9, 12), sg * rr(10, 40), { groom: 0, wob: 8, wl: 180, ph: ph() });
      if (R() < 0.7) L[1] = lane(rr(8, 10), -sg * rr(60, 100), { groom: 0, wob: 8, wl: 180, ph: ph() });
      break;
    case 'spines':
      // Alaska-Spines: scharfe Grate in Falllinie, dazwischen Rinnen, in denen der Schnee abrutscht
      Object.assign(z, { len: rr(300, 420), slope: rr(0.55, 0.66), valley: rr(130, 170), wall: rr(0.08, 0.14), rock: 0.6, pow: 1, forest: 0, rough: 0.8, hill: rr(8, 12), cap: 26 });
      z.head = { A: rr(0.06, 0.12), lam: rr(600, 800), ph: ph() };
      L[0] = lane(rr(6, 8), sg * rr(0, 12), { groom: 0 });
      L[1] = lane(rr(6, 8), -sg * rr(40, 70), { groom: 0 });
      z.mods = { spines: { A: rr(3.2, 5.2), lam: rr(15, 22), sd: R() * 100 } };
      break;
    case 'dropzone':
      // Klippengelände: Bänder mit mehreren Drops verschiedener Höhe, dazwischen steile Pulverhänge
      Object.assign(z, { len: rr(520, 680), slope: rr(0.44, 0.52), valley: rr(140, 180), wall: rr(0.08, 0.14), rock: 1, pow: 1, forest: 0, rough: 1.1, hill: rr(10, 14), cap: 26 });
      z.head = { A: rr(0.06, 0.12), lam: rr(600, 800), ph: ph() };
      L[0] = lane(rr(8, 10), sg * rr(0, 20), { groom: 0 });
      L[1] = lane(rr(7, 9), -sg * rr(50, 80), { groom: 0 });
      break;
    case 'icefall':
      // Eisbruch: steile Gletscherstufe mit Séracs (Eistürmen) und einer Eishöhle
      Object.assign(z, { len: rr(380, 520), slope: rr(0.4, 0.5), valley: rr(150, 190), wall: rr(0.06, 0.12), rock: 0.4, pow: 1, forest: 0, rough: 1.3, hill: rr(12, 16), cap: 26 });
      z.head = { A: rr(0.08, 0.16), lam: rr(600, 800), ph: ph() };
      L[0] = lane(rr(8, 10), sg * rr(0, 20), { groom: 0 });
      L[1] = lane(rr(7, 9), -sg * rr(50, 90), { groom: 0 });
      z.mods = { waves: { lam: rr(90, 130), a: rr(1.2, 2.0), ph: ph(), sk: rr(-0.3, 0.3) } };
      break;
    case 'rockgarden':
      Object.assign(z, { len: rr(340, 460), slope: rr(0.42, 0.5), valley: rr(120, 160), wall: rr(0.08, 0.16), rock: 1, pow: 1, forest: 0, rough: 1.3, hill: rr(10, 14), cap: 26 });
      z.head = { A: rr(0.16, 0.28), lam: rr(380, 520), ph: ph() };
      L[0] = lane(rr(8, 10), sg * rr(0, 30), { groom: 0, wob: 9, wl: 150, ph: ph() });
      L[1] = lane(rr(7, 9), -sg * rr(55, 90), { groom: 0, wob: 9, wl: 150, ph: ph() });
      break;
    case 'railpark':
      Object.assign(z, { len: rr(560, 720), slope: rr(0.18, 0.22), valley: rr(95, 120), wall: rr(0.06, 0.12), rock: 0.2, pow: 0.15, forest: 0.2, rough: 0.3, hill: rr(4, 7) });
      z.head = { A: rr(0.06, 0.12), lam: rr(700, 900), ph: ph() };
      L[0] = lane(rr(13, 15));
      L[1] = lane(rr(6.5, 7.5), -sg * rr(40, 50), { groom: 0.95, wob: 1.5, wl: 200, ph: ph() });
      L[2] = lane(rr(6.5, 7.5), sg * rr(42, 52), { groom: 0.95, wob: 1.5, wl: 200, ph: ph() });
      break;
    case 'slopestyle':
      Object.assign(z, { len: rr(640, 800), slope: rr(0.22, 0.26), valley: rr(95, 120), wall: rr(0.06, 0.12), rock: 0.2, pow: 0.15, forest: 0.2, rough: 0.35, hill: rr(4, 7) });
      z.head = { A: rr(0.12, 0.2), lam: rr(600, 800), ph: ph() };
      L[0] = lane(rr(13, 15));
      L[1] = lane(rr(6.5, 7.5), -sg * rr(40, 50), { groom: 0.95, wob: 2, wl: 150, ph: ph() });
      if (R() < 0.6) L[2] = lane(rr(6.5, 7.5), sg * rr(42, 52), { groom: 0.95, wob: 2, wl: 150, ph: ph() });
      break;
    case 'flat':
      Object.assign(z, { len: rr(110, 170), slope: rr(0.09, 0.12), valley: rr(100, 125), wall: 0.06, rock: 0.2, pow: 0.25, forest: 0.4, rough: 0.6, hill: 4 });
      z.head = { A: rr(0.12, 0.2), lam: rr(380, 460), ph: ph() };
      L[0] = lane(rr(13, 15));
      break;
  }
  varyZone(z, R, rr, ph);
  if (S.style === 'heli') {
    // keine präparierten Pisten: Spuren sind nur noch Linien für Features, überall Tiefschnee
    for (const l of z.lanes) { l.groom = 0; if (l.kind !== KIND.jump && l.kind !== KIND.chute) l.kind = 0; }
    z.pow = 1;
    z.forest = idx < 7 ? 0 : Math.min(0.35, (idx - 6) * 0.06);   // weiter unten beginnt langsam der Wald
    if (z.forest === 0 && z.mods && z.mods.islands) { delete z.mods.islands; z.label = z.label.split(', ').filter((x) => x !== 'mit Baum-Inseln').join(', '); }
    if (z.type === 'rockgarden') z.mods = { ...(z.mods || {}), rocks: { amt: 2.4 } };
    if (z.type === 'glacier') z.label = z.label ? 'Gletscher, ' + z.label : '';
  }
  // Mindestlänge: zwei Übergänge (Anfang und Ende) dürfen sich nicht überlappen, sonst springen Spuren und Gelände
  z.len = Math.max(z.len, 2 * PCFG.transition + 20);
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
  z.mods = z.mods || {};
  z.label = '';
  if (z.type === 'start' || z.type === 'couloir' || z.type === 'summit') return;
  const fsZone = z.type === 'jumpline' || z.type === 'megaair' || z.type === 'slopestyle' || z.type === 'railpark';
  // Grundwerte leicht verschieben (Berg-Charakter + Zufall)
  z.len *= fsZone ? rr(0.95, 1.15) : rr(0.75, 1.3);
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
  if (fsZone) z.head.A = Math.min(z.head.A, 0.18);   // Freestyle: Kurven ruhig halten
  const pool = fsZone ? ['islands', 'rocks', 'wide'] : flatZone || z.type === 'cliff' ? ['islands', 'rocks', 'wide', 'gully'] : ['waves', 'gully', 'ridge', 'knolls', 'islands', 'rocks', 'wide', 'narrow', 'waves'];
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
  if (m.spines) { const sp = m.spines, sv = u / sp.lam + 0.35 * snoise(d / 90, sp.sd, S.seed); y += sp.A * (1 - Math.abs(Math.sin(Math.PI * sv))) * (1 - run); }   // scharfe Grate, runde Rinnen
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
    planVillage(z, mulberry32((Math.imul(S.seed, 7477) + Math.imul(idx + 3, 92821)) >>> 0));
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
  let s = 0;
  const f = z.cliffF;
  if (f) { const t = (d - f.dc + 55) / GENTLE, h = 0.02; s += (f.hs * (ramp01(t + h, 0.3) - ramp01(t - h, 0.3))) / (2 * h * GENTLE); }
  // Klippen-Drops: neben dem Drop wird dieselbe Höhe auf einer langen, sanften Rampe abgebaut
  if (z.drops) for (const g of z.drops) { const t = (d - g.dc + 55) / g.GL, h = 0.02; s += (g.hs * (ramp01(t + h, 0.3) - ramp01(t - h, 0.3))) / (2 * h * g.GL); }
  return s;
}
/** Anlauf vor Sprüngen: 1 = völlig glatt und gerade (ca. 90 m vor dem Absprung), blendet davor und seitlich weich aus. */
let RW_U = 0, RW_SA = 0, RW_SAU = 0, RW_N = 0;
const RW_A = new Float64Array(8), RW_UU = new Float64Array(8);   // einzelne Anläufe (Stärke, Sprungachse) für heightP
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
    if (x !== undefined) a *= 1 - smoothstep(f.wT + 5, f.wT + 32, Math.abs(x - f.x));   // breit auslaufen: die Bezugslinie biegt das Gelände sonst seitlich zu scharf
    if (a > m) m = a;
    // Bezugslinie gewichtet mischen: harte Auswahl des stärksten Anlaufs sprang, wo sich zwei Anläufe überlappen
    if (a > 1e-4) { const w = a * a; RW_SA += w; RW_SAU += w * (f.x - hubX(f.d)); if (RW_N < 8) { RW_A[RW_N] = a; RW_UU[RW_N++] = f.x - hubX(f.d); } }
  }
  return m;
}
/** Anlauf aus der eigenen und den Nachbarzonen: Sprünge nahe einer Zonengrenze reichen über sie hinaus. */
function runwayNear(zi, d, x) {
  RW_SA = 0; RW_SAU = 0; RW_N = 0;
  let m = runwayAt(S.Z[zi], d, x);
  if (zi > 0) m = Math.max(m, runwayAt(S.Z[zi - 1], d, x));
  if (S.Z[zi + 1]) m = Math.max(m, runwayAt(S.Z[zi + 1], d, x));
  RW_U = RW_SA > 0 ? RW_SAU / RW_SA : 0;
  return m;
}
function slopeAt(d) {
  blendZones(d);
  // Klippen-Rampen beider Zonen addieren (jede ist örtlich begrenzt); vorher wurde in der Übergangsmitte hart umgeschaltet
  const s = lerp(zoneSlopeAt(bz_a, d), zoneSlopeAt(bz_b, d), bz_t) + cliffSlope(bz_a, d) + (bz_b !== bz_a ? cliffSlope(bz_b, d) : 0);
  const base = d < 3 ? 0 : d < 45 ? lerp(0.02, 0.42, smoothstep(2, 24, d)) : lerp(0.42, s, smoothstep(45, 140, d));
  const run = runwayNear(bz_i, d);
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
      if (lat <= 0) return 0;
      let r = jumpRel(xx, J);
      if (f.gap) { const g = f.gap, m = smoothstep(g.a, g.a + 1.2, xx) * (1 - smoothstep(g.b - 1.2, g.b, xx)); r = r + (-g.dep - r) * m; }
      return r * lat;
    }
    case 'onramp': {
      // Auffahrt auf Box/Rail: steigt gleichmäßig bis zur Oberkante, endet genau am Anfang des Elements
      const xx = d - (f.d - f.len);
      if (xx < 0 || xx > f.len + 0.05) return 0;
      const lat = 1 - smoothstep(f.w, f.w + 0.9, Math.abs(x - f.x));
      return lat > 0 ? f.h * (xx / f.len) * lat : 0;
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

/** Klippen-Drop: Wand + Geröllhang nur in einer Breite um f.x; daneben die sanfte Rampe (steckt im Grundgefälle). */
function dropDelta(f, d, x) {
  const ax = Math.abs(x - f.x);
  const m = 1 - smoothstep(f.w, f.w + 11, ax + 3 * snoise(d / 9, f.x * 0.1, S.seed));
  if (m <= 0) return 0;
  const jag = 2.5 * snoise(x / 7, f.dc * 0.02, S.seed);
  const dd = d - f.dc - jag;
  const C = f.C;
  let sharp = C.wall * smoothstep(0, 2.6, dd);
  if (dd > C.a) sharp += (f.hs - C.wall) * ramp01((dd - C.a) / C.L2, 0.3);
  const gentle = f.hs * ramp01((d - f.dc + 55) / f.GL, 0.3);
  return m * (sharp - gentle);
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
  const runM = runwayNear(c.zi, dc, x), ruU = RW_U;
  // Im Anlauf eines Sprungs schwenken die seitlichen Anteile des Geländes (Mulde, Querneigung) nicht mit der Mittellinie
  // mit: dort gilt ihr Wert auf der Sprungachse. Gemischt werden die Werte, nicht die Koordinate (das ergab Böschungen).
  // Talflanken: im Normalfall sanfte Hügel mit Panorama, nur in Rinnen steile Felswände
  const e = au - c.valley;
  let lat = 0;
  if (e > 0) {
    const steepRock = c.rock > 0.8 && c.wall > 1.2;
    const rockN = (fbm(x / 13 + 3, dc / 13) - 0.5) * 3.2 * c.rock * smoothstep(0, 10, e) + (vnoise(x / 4.3, dc / 4.3) - 0.5) * 0.8 * c.rock * smoothstep(0, 14, e);
    lat += c.wall * e * (steepRock ? 1 + 0.012 * e : 1) + rockN;
    if (steepRock) lat += (fbm(x / 28 + 9, dc / 28) - 0.5) * 9 * smoothstep(4, 24, e);
  }
  // Spuren: Pflege-Grad glättet das Gelände, Waldbahnen liegen in einer flachen Rinne
  // Zwei weiche Masken statt der schmalen Pflege-Maske (3,7 m): Querneigung gleicht über 14 m aus, Rauigkeit und
  // Pulverwellen über 8 m. Der schmale Übergang machte an Pistenrändern und Kreuzungen spürbare Kanten.
  let groom = 0, chan = 0, bestM = 0, sumM = 0, sumMU = 0;
  for (let i = 0; i < NL; i++) {
    const w = c.lw[i];
    if (w < 0.3) continue;
    const e2 = Math.abs(x - c.lx[i]) - w;
    const mR = (1 - smoothstep(-1, 7, e2)) * c.lg[i];
    const m = (1 - smoothstep(-0.5, 14, e2)) * c.lg[i];
    if (mR > groom) groom = mR;
    if (m > bestM) bestM = m;
    sumM += m; sumMU += m * (c.lx[i] - hub);   // gewichteter Mittelwert statt harter Auswahl: keine Stufe, wenn die stärkste Spur wechselt
    if (c.lkw[i] > 0.001) chan = Math.max(chan, (1 - smoothstep(0, w * 1.2, Math.abs(x - c.lx[i]))) * c.lg[i] * c.lkw[i]);
  }
  const Za = S.Z[c.zi], mean = sumM > 1e-6 ? sumMU / sumM : 0;
  const latY = (ue) => {
    let r = 0.0007 * Math.min(ue * ue, c.valley * c.valley);
    // Querneigung: Hangpisten sind quer ausgeglichen, die Talseite bleibt offen
    const l2 = lat + (c.cross !== 0 ? c.cross * (ue + bestM * ((sumM > 1e-6 ? mean : ue) - ue)) : 0);
    // seitlicher Anstieg wird weich begrenzt: offene Panoramen statt Schlucht (nur die Rinne darf hoch aufragen)
    r += c.cap * Math.tanh(l2 / c.cap);
    // Zonen-Formen (Wellen, Mulde, Rücken, Kuppen) – im Übergang beide Zonen gewichtet
    r += modHeight(Za, x, dc, ue, runM);
    if (Za.idx > 0 && dc < Za.d0 + 70) r += modHeight(S.Z[Za.idx - 1], x, dc, ue, runM);
    else if (dc > Za.d1 - 70 && S.Z[Za.idx + 1]) r += modHeight(S.Z[Za.idx + 1], x, dc, ue, runM);
    return r;
  };
  // Mehrere Anläufe überlappen: jeder bekommt das Gewicht a²/Σa (Summe höchstens max a), alles stetig
  if (runM > 1e-4 && RW_N > 0) {
    const n = RW_N, A = RW_A.slice(0, n), U = RW_UU.slice(0, n);
    let sa = 0, sw = 0, acc = 0;
    for (let k = 0; k < n; k++) sa += A[k];
    for (let k = 0; k < n; k++) { const w = (A[k] * A[k]) / sa; sw += w; acc += w * latY(U[k]); }
    y += acc + (1 - sw) * latY(u);
  } else y += latY(u);
  void ruU;
  // Hügel und Rücken außerhalb des Tals
  if (e > 0) y += c.hill * (fbm(x / 70 + S.seed * 0.9, dc / 85) - 0.45) * 2 * smoothstep(0, 40, e);
  y -= 0.3 * chan;
  const rough = c.rough * (1 - 0.9 * groom) * (1 - runM);
  y += rough * ((vnoise(x / 40, z / 40) - 0.5) * 1.0 + (vnoise(x / 16 + 7, z / 16) - 0.5) * 0.07);
  const powM = c.pow * (1 - groom) * (1 - runM);
  if (powM > 0.02) y += powM * ((vnoise(x / 15 + 31, dc / 15) - 0.5) * 0.22 + (vnoise(x / 34, dc / 34 + 8) - 0.5) * 0.55);
  // Features der aktuellen Zone und der Nachbarzonen (ein Feature nahe der Zonengrenze reicht über sie hinaus;
  // nur die eigene Zone zu rechnen, schnitt es an der Grenze ab: Stufe im Gelände)
  for (let zj = Math.max(0, c.zi - 1); zj <= c.zi + 1 && zj < S.Z.length; zj++) {
    const feats = S.Z[zj].feats;
    for (let k = 0; k < feats.length; k++) {
      const f = feats[k];
      if (dc < f.s0 || dc > f.s1) continue;
      if (f.kind === 'cliff') y -= cliffDelta(f, dc, x);
      else if (f.kind === 'drop') y -= dropDelta(f, dc, x);
      else if (f.kind === 'icecave') continue;
      else if (f.kind === 'roller' || f.kind === 'pillow' || f.kind === 'moguls' || f.kind === 'berm') y += featRel(f, dc, x, c) * (1 - runM);   // kein Kleinkram im Anlauf
      else y += featRel(f, dc, x, c);
    }
  }
  // Nach einem Klippenband bleibt die Absenkung bestehen (die Zone danach beginnt auf tieferem Niveau)
  const ec = Math.abs(x) - 1e9;
  void ec;
  // Schneebett unter Rails und Boxen: das Gelände folgt dort genau der geraden Linie der Rail (gleiche Höhe überall)
  if (!BED_OFF) for (let zj = Math.max(0, c.zi - 1); zj <= c.zi + 1 && zj < S.Z.length; zj++) {
    const rl = S.Z[zj].rails;
    for (let k = 0; k < rl.length; k++) { const r = rl[k]; if (dc > r.d0 && dc < r.d0 + r.len + 4) y = railBed(r, x, dc, y); }
  }
  // Dörfer: jedes Haus steht auf einer ebenen Terrasse, die weich in den Hang übergeht
  if (!PAD_OFF) y = villagePads(x, dc, c.zi, y);
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
/** Tempo nach `dist` Metern Anlauf auf einem Hang (gleiche Konstanten wie physics.js: Reibung 0,04, Luftwiderstand). */
export function speedAfter(v0, slopeT, dist, tuck = 1) {
  const th = Math.atan(slopeT), a0 = GR * (Math.sin(th) - 0.04 * Math.cos(th)), k = tuck ? 0.0019 : 0.0036;
  let v2 = v0 * v0;
  for (let s = 0; s < dist; s += 2) v2 = Math.max(9, v2 + 2 * (a0 - k * v2) * Math.min(2, dist - s));
  return Math.sqrt(v2);
}

// Park-Hütte (tools/blender_village.py, ParkHut): Traufe 2,6 m, First 1,5 m höher, 8 m tief, 9 m breit
export const PARK_HUT = { E: 2.6, rise: 1.5, hd: 4.0, hw: 4.5 };
function addJump(z, R, o) {
  const d = o.exactD !== undefined ? o.exactD : snapStraight(z, o.d, 40);
  // Hüttendach als Schanze: die bergseitige Dachhälfte liegt unter dem Schnee der Rampe, der First ist die Absprungkante.
  // Rampe so ausgelegt, dass ihre Neigung an der Kante genau der Dachneigung entspricht (Abflugwinkel = Dachneigung).
  if (o.hut === 'roof') {
    const tp = PARK_HUT.rise / PARK_HUT.hd, h = PARK_HUT.E + PARK_HUT.rise, sH = zoneSlopeAt(z, d);
    // hinter der Hütte ein niedriger Tisch (2,2 m, Step-down), dann die Landung: wer langsam ist, landet auf dem Tisch
    o = { ...o, phi: (Math.atan(tp) * 180) / Math.PI, hMax: h, Lr: (1.7 * h) / (tp + sH), wT: Math.max(o.wT || 0, 5.6), gap: true, sd: h - 2.2 };
  }
  const x = laneX(z, o.lane, d) + (o.dx || 0);
  // Keine Steilstufe im Anlauf, über dem Sprung oder in der Landung: sonst stimmt weder der gerade Anlauf noch die Landung
  const w0 = d - (o.Lr || 14) - 165, w1 = d + 140;
  z.pitches = z.pitches.filter((p) => p.own || p.d + p.len + p.e < w0 || p.d - p.e > w1);
  const sRun = zoneSlopeAt(z, d - 70) * 0.5 + zoneSlopeAt(z, d - 20) * 0.5;
  const sHere = zoneSlopeAt(z, d);
  const vu = terminalSpeed(sRun, 0), vt = terminalSpeed(sRun, 1);
  let v = o.vBias !== undefined ? Math.pow(vu, 1 - o.vBias) * Math.pow(vt, o.vBias) : Math.sqrt(vu * vt);   // vBias > 0.5: für Hocke ausgelegt (Freestyle)
  let vRange = [vu * 0.95, vt * 1.03];
  // Freestyle: Sprung genau auf das Tempo auslegen, das man nach dem tatsächlichen Anlauf hat (nicht auf Endgeschwindigkeit)
  if (o.vDes) { v = o.vDes; vRange = [o.vDes * (o.gap ? 0.9 : 0.84), o.vDes * 1.05]; }
  const steep = o.steep ? { t2: o.steep, xb: 4, len: 160 } : null;
  const des = designJump({
    kind: o.kind === 'stepup' ? 'stepup' : 'table', theta: Math.atan(sHere), steep, vDes: v, vRange,
    phiDeg: o.phi, Lr: o.Lr, hMax: o.hMax, su: o.su || 0, sd: o.sd || 0,
  });
  const rec = { zone: z.idx, kind: o.name || o.kind, d: Math.round(d), lane: o.lane };
  if (!des || !des.ok) { issue(`Zone ${z.idx}: ${o.name || o.kind} bei ${Math.round(d)} m verworfen (keine sichere Landung)`); return null; }
  if (d + des.ext1 > z.d1 - PCFG.transition - 8) { report.skipped = (report.skipped || 0) + 1; return null; }
  // Gap: statt Tisch ein Graben zwischen Absprung und Landung. Nur, wenn auch das langsame Ende des Tempobereichs
  // sicher hinter dem Knick landet – wer zu langsam ist, fällt hinein.
  let gap = null, hut = null;
  if (o.gap) {
    // Graben endet 2,4 m vor dem Knick (fester Rand zum Aufsetzen); beim Hüttendach dort, wo der niedrige Tisch beginnt
    // Hüttensprung: Lücke nur so lang wie die Hütte (plus Rand), danach geht der Tisch weiter
    const gb = o.hut === 'roof' ? Math.min(des.J.xk - 2.4, des.J.T + 3) : o.hut === 'over' ? Math.min(des.J.xk - 2.4, 2.2 + 2 * (PARK_HUT.hd + 1.4)) : des.J.xk - 2.4;
    const ga = o.hut === 'roof' ? 0.3 : 2.2;
    if (des.xLow < gb + 0.6 || gb < 6) {
      if (o.hut === 'roof') { issue(`Zone ${z.idx}: Hüttendach bei ${Math.round(d)} m verworfen`); return null; }
      return addJump(z, R, { ...o, gap: false, hut: null, name: (o.name || '').replace('Gap', 'Tisch').replace('Hüttensprung', 'Großer Tisch') });
    }
    gap = { a: ga, b: gb, dep: o.hut ? 0 : 2.2 + R() * 0.8 };   // mit Hütte: Grabenboden = natürlicher Hang, darauf steht sie
    if (o.hut === 'roof') hut = { kind: 'roof', xx: 0 };
    else if (o.hut === 'over') {
      // Hütte mitten in der Lücke; die langsamste Flugbahn muss mindestens 0,9 m über dem First bleiben
      const xc = (ga + gb) / 2, tS = Math.tan(Math.atan(sHere)), ph = (o.phi * Math.PI) / 180;
      const vx = vRange[0] * Math.cos(ph), k = 9.81 / (2 * vx * vx), top = PARK_HUT.E + PARK_HUT.rise + 0.15;
      let ok = gb - ga >= 2 * (PARK_HUT.hd + 1.2);
      for (let s = -PARK_HUT.hd - 0.9; s <= PARK_HUT.hd + 0.9 && ok; s += 0.5) {
        const xr = xc + s, yT = des.J.h + (Math.tan(ph) + tS) * xr - k * xr * xr;
        const roofRel = top - (PARK_HUT.rise / PARK_HUT.hd) * Math.min(PARK_HUT.hd, Math.abs(s)) + tS * s;
        if (yT < roofRel + 0.9) ok = false;
      }
      if (ok) hut = { kind: 'over', xx: xc };
      else { issue(`Zone ${z.idx}: Hüttensprung bei ${Math.round(d)} m zu flach (h ${des.J.h.toFixed(1)}, Lücke ${(gb - ga).toFixed(0)} m)`); return addJump(z, R, { ...o, hut: null, name: 'Gap XL' }); }
    }
  }
  const wT = o.wT, wL = wT * 1.7;
  z.feats.push({ kind: 'jump', d, x, J: des.J, wT, wL: o.wL || wT * 1.7, ext0: des.ext0, ext1: des.ext1, s0: d - des.J.Lr - 10, s1: d + des.ext1 + 10, lane: o.lane, name: o.name || o.kind, gap, vDes: v, hut });
  if (steep) z.pitches.push({ d: d + 4, amt: o.steep - sHere, len: des.ext1 + 40, e: 14, own: true });
  Object.assign(rec, {
    flight: +des.flight.toFixed(1), airT: +des.airT.toFixed(2), height: +des.J.h.toFixed(1), vn: +des.vn.toFixed(1),
    vnLow: +des.vnLow.toFixed(1), vnHigh: +des.vnHigh.toFixed(1), speed: `${vu.toFixed(0)}-${vt.toFixed(0)}`,
  });
  report.features.push(rec);
  if (des.vnHigh > 17) issue(`Zone ${z.idx}: ${rec.kind} bei ${rec.d} m landet bei Höchsttempo hart (${rec.vnHigh} m/s)`);
  return { end: d + Math.max(des.ext1, des.xHigh + 10) + 14, d, des, v };
}

/** Rail oder Box auf Spur `lane` ab Position d. kind: 'rail' (rund, schmal) | 'box' (breit). Mit Auffahrrampe. */
function addRail(z, R, o) {
  // Rails und Boxen gut doppelt so lang wie früher (echte Park-Rails 10 bis 30 m); darunter ein ebenes Schneebett
  const d = snapStraight(z, o.d, 20), len = o.len * 2.1;
  if (d + len > z.d1 - PCFG.transition - 8 || d - 6 < z.d0 + PCFG.transition) return null;
  const x0 = laneX(z, o.lane, d) + (o.dx || 0), x1 = laneX(z, o.lane, d + len) + (o.dx || 0);
  const h = o.h, w = o.kind === 'box' ? 0.42 : 0.08;
  const rail = { kind: o.kind, d0: d, len, x0, x1, h, w, lane: o.lane, name: o.name };
  z.rails.push(rail);
  z.feats.push({ kind: 'onramp', d, len: o.kind === 'box' ? 3.2 : 4, x: x0, w: Math.max(w, 0.5) + 0.3, h, s0: d - 6, s1: d + 1, lane: o.lane });
  report.features.push({ zone: z.idx, kind: o.name, d: Math.round(d), lane: o.lane, len });
  return d + len + 8;
}
/** Rails und Boxen im Bereich [d0, d1). */
export function railsIn(d0, d1) {
  ensureZones(d1 + PCFG.lookahead);
  const out = [];
  for (const z of S.Z) {
    if (z.d1 < d0 - 300 || z.d0 > d1 + 300) continue;
    for (const r of z.rails) if (r.d0 + r.len >= d0 && r.d0 < d1) out.push(r);
  }
  return out;
}

/** Klippenband mit mehreren Drops nebeneinander (verschiedene Höhen) und sanften Umgehungen dazwischen. */
function addDropBand(z, R, dc, n) {
  const rr = (a, b) => a + (b - a) * R();
  const sShelf = 0.24;
  z.pitches.push({ d: dc - 95, amt: sShelf - z.slope, len: 92, e: 14 });   // kurzer Absatz vor der Kante: Tempo kontrollierbar
  const vDes = Math.min(21, terminalSpeed(sShelf, 0) * 0.92);
  const hub = hubX(dc), span = Math.min(z.valley * 0.75, 120);
  const hs = [rr(7, 11), rr(13, 19), rr(20, 30)].sort(() => R() - 0.5).slice(0, n);
  z.drops = z.drops || [];
  for (let k = 0; k < n; k++) {
    const x = hub + (n === 1 ? 0 : (k / (n - 1) - 0.5) * 2 * span) + rr(-8, 8);
    const des = designCliff({ theta: Math.atan(sShelf), vDes, drop: hs[k], maxWall: Math.min(22, hs[k] * 0.75) });
    if (!des) { issue(`Zone ${z.idx}: Drop ${hs[k].toFixed(0)} m nicht konstruierbar`); continue; }
    const GL = Math.max(130, hs[k] * 8), C = des.C;
    const f = { kind: 'drop', dc, x, w: rr(9, 15), hs: hs[k], C, GL, s0: dc - 60, s1: Math.max(dc + C.a + C.L2 + 15, dc - 55 + GL + 5) };
    z.feats.push(f);
    z.drops.push(f);
    report.features.push({ zone: z.idx, kind: `Drop ${hs[k].toFixed(0)} m`, d: Math.round(dc), x: Math.round(x), drop: +hs[k].toFixed(1), wall: +C.wall.toFixed(1), vn: +des.vn.toFixed(1), flight: +des.flight.toFixed(1) });
  }
}
/** Eishöhle: ein Tunnel durch das Gletschereis entlang der Hauptlinie. */
function addIceCave(z, R, d) {
  const len = 55 + R() * 45;
  if (d + len > z.d1 - PCFG.transition - 10 || d < z.d0 + PCFG.transition) return;
  z.feats.push({ kind: 'icecave', d, len, lane: 0, W: 5.5 + R() * 1.5, H: 5 + R() * 1.5, s0: d - 4, s1: d + len + 4 });
  report.features.push({ zone: z.idx, kind: 'Eishöhle', d: Math.round(d), len: Math.round(len) });
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
      } else if (it.t === 'rail') {
        end = addRail(z, R, { d: cur + 10, lane: it.lane || 0, ...it });
      }
      cur = (end === null ? cur + 20 : end) + (it.big !== undefined ? it.big : it.gap === undefined ? (it.t === 'jump' ? rr(8, 18) : rr(26, 44)) : Math.min(it.gap, it.t === 'jump' ? 18 : 99));
    }
  };
  const sideLine = (li, start, items) => { if (z.lanes[li].w > 0) { cur = a + start; chain(items.map((x) => ({ lane: li, ...x }))); } };
  // Sprünge in vier Größen (Freeride): klein, mittel, groß, riesig. Jeder wird mit der Flugbahn auf eine sichere Landung geprüft.
  const J = (sz, extra = {}) => {
    const spec = sz === 'S' ? { name: 'Kicker', phi: rr(4, 5.5), Lr: rr(9, 10.5), hMax: rr(2, 2.8), wT: rr(3, 3.6) }
      : sz === 'M' ? { name: 'Tisch', phi: rr(7, 10), Lr: rr(12, 15), hMax: rr(3.6, 5.2), wT: rr(4, 4.8) }
        : sz === 'L' ? { name: 'Großer Tisch', phi: rr(11, 13), Lr: rr(17, 21), hMax: rr(6.5, 8.5), wT: rr(5, 6) }
          : { name: 'Riesen-Kicker', phi: rr(14, 16), Lr: rr(22, 25), hMax: rr(9.5, 11), wT: 6.5 };
    return { t: 'jump', kind: 'table', ...spec, ...extra };
  };
  switch (z.type) {
    case 'cruise': {
      addPitches(z, R, 1);
      chain([
        J(R() < 0.6 ? 'L' : 'M', { gap: 10 }), { t: 'berm' }, J('S', { gap: 10 }), J('M'), { t: 'roller', n: 2 },
      ]);
      sideLine(1, 25, [J('M', { gap: 12 }), J('S', { gap: 12 }), { t: 'roller', n: 2, w: 5 }]);
      sideLine(2, 45, [J(R() < 0.4 ? 'L' : 'S', { gap: 12 }), J('S'), { t: 'roller', n: 3, w: 4.5, sp: 10 }]);
      break;
    }
    case 'glade': {
      addPitches(z, R, 1);
      chain([J('M', { lane: 0, gap: 10 }), { t: 'berm', lane: 0 }, J('S', { lane: 0 }), { t: 'roller', n: 2, lane: 0 }]);
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
      // statt Buckelpisten: Pulver-Kicker in allen Größen (Freeride soll glatt sein, Höhepunkte sind Sprünge)
      chain([J(R() < 0.5 ? 'L' : 'XL', { lane: 0, gap: 12 }), J('M', { lane: 0, gap: 12 }), J('S', { lane: 0 })]);
      sideLine(1, 30, [J('M', { gap: 12 }), J('S')]);
      break;
    }
    case 'steep': {
      // Steilhang: Roll-over, dann Mogelpiste und Pulverrinnen
      z.pitches.push({ d: z.d0 + T + 20, amt: 0.1, len: 50, e: 20 });
      for (let k = 0; k < 7; k++) {
        const dd = rr(a + 10, b - 10), sd = R() < 0.5 ? -1 : 1;
        addPillow(z, R, dd, hubX(dd) + sd * rr(20, z.valley * 0.85), k % 2 === 0);
      }
      chain([J('M', { lane: 0, gap: 10 }), { t: 'berm', lane: 0, h: 1.6, len: 40 }, J('S', { lane: 0 })]);
      sideLine(1, 30, [J('S', { gap: 12 }), J('S')]);
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
      sideLine(2, 60, [{ t: 'rail', kind: 'box', len: rr(7, 10), h: 0.5, name: 'Box', big: rr(45, 60) }, { t: 'rail', kind: 'rail', len: rr(9, 13), h: rr(0.65, 0.85), name: 'Rail', big: rr(45, 60) }, { t: 'rail', kind: 'box', len: rr(7, 10), h: 0.5, name: 'Box', big: 50 }]);
      break;
    }
    case 'jumpline': {
      // Sprunglinie: große Tische, Gaps und Step-downs. Jeder Sprung wird auf das Tempo ausgelegt, das man nach dem
      // tatsächlichen Anlauf seit der letzten Landung hat (Tempo-Modell) – kurzer Anlauf = kürzerer Sprung.
      const big = [
        { name: 'Großer Tisch', phi: 12, Lr: 20, hMax: 8, wT: 6 },
        { name: 'Riesen-Tisch', phi: 14, Lr: 24, hMax: 10, wT: 6.5 },
        { name: 'Kicker XL', phi: 15, Lr: 18, hMax: 7, wT: 5.5 },
        { sd: 3, name: 'Step-down XL', phi: 12, Lr: 20, hMax: 8, wT: 6 },
      ];
      const vMax = terminalSpeed(z.slope, 1) * 0.97;
      let v = Math.min(vMax, 17), dPrev = z.d0 - 40, dd = a + rr(60, 100);
      for (let k = 0; k < 8 && dd < b - 60; k++) {
        const vTake = Math.min(vMax, speedAfter(v, z.slope, dd - dPrev));
        const spec = big[Math.floor(R() * big.length)];
        const isGap = !spec.sd && R() < 0.38, rh = R();
        // Hütten im Park: übers Dach fahren (der First ist die Kante) oder über die ganze Hütte springen
        const hut = !spec.sd && rh < 0.3 && vTake < 19.5 ? 'roof' : !spec.sd && spec.hMax >= 8 && rh < 0.55 ? 'over' : null;
        const nm = hut === 'roof' ? 'Hüttendach' : hut === 'over' ? 'Hüttensprung' : isGap ? 'Gap ' + (spec.hMax >= 9 ? 'XL' : '') : spec.name;
        const j = addJump(z, R, { d: dd, lane: 0, kind: 'table', ...spec, name: nm, gap: isGap || !!hut, hut, vDes: hut === 'roof' ? Math.min(vTake * 0.97, 18) : vTake * 0.97 });
        if (!j) { dd += 35; continue; }
        v = j.v * 0.85;                                   // Tempo nach der Landung
        dPrev = j.d + j.des.flight;
        dd = j.end + rr(95, 150);
      }
      for (const li of [1, 2]) sideLine(li, rr(40, 70), [
        { t: 'rail', kind: 'box', len: rr(7, 11), h: 0.5, name: 'Box', big: rr(55, 75) },
        { t: 'jump', kind: 'table', name: 'Kicker (Seitenlinie)', phi: rr(7, 10), Lr: 12, hMax: rr(3.4, 4.4), wT: 3.4, big: rr(60, 80) },
        { t: 'rail', kind: 'rail', len: rr(9, 14), h: rr(0.65, 0.9), name: 'Rail', big: rr(55, 75) },
        { t: 'jump', kind: 'table', name: 'Kicker (Seitenlinie)', phi: rr(7, 10), Lr: 12, hMax: rr(3.4, 4.4), wT: 3.4, big: rr(60, 80) },
        { t: 'rail', kind: R() < 0.5 ? 'box' : 'rail', len: rr(8, 13), h: rr(0.5, 0.8), name: 'Rail', big: 60 },
      ].map((it) => (it.kind === 'box' ? { ...it, name: 'Box', h: 0.5 } : it)));
      break;
    }
    case 'summit': break;
    case 'spines': break;
    case 'dropzone': {
      addDropBand(z, R, z.d0 + z.len * 0.32, 3);
      addDropBand(z, R, z.d0 + z.len * 0.72, 2 + (R() < 0.5 ? 1 : 0));
      break;
    }
    case 'icefall': {
      addIceCave(z, R, a + rr(40, 120));
      for (let k = 0; k < 5; k++) { const dd = rr(a + 10, b - 10), sd = R() < 0.5 ? -1 : 1; addPillow(z, R, dd, hubX(dd) + sd * rr(40, z.valley * 0.85), true); }
      break;
    }
    case 'glacier': {
      if (R() < 0.55) addIceCave(z, R, a + rr(60, Math.max(70, z.len - 260)));
      for (let k = 0; k < 6; k++) { const dd = rr(a + 20, b - 20), sd = R() < 0.5 ? -1 : 1; addPillow(z, R, dd, hubX(dd) + sd * rr(25, z.valley * 0.85), k % 2 === 0); }
      break;
    }
    case 'face': {
      if (R() < 0.6) addDropBand(z, R, z.d0 + z.len * rr(0.4, 0.62), 2);
      // Pillow-Linien: Kissen in Reihen hintereinander, dazwischen freie Pulverhänge
      for (let k = 0; k < 12; k++) { const dd = rr(a + 10, b - 10), sd = R() < 0.5 ? -1 : 1; addPillow(z, R, dd, hubX(dd) + sd * rr(18, z.valley * 0.9), k % 3 !== 0); }
      break;
    }
    case 'rockgarden': {
      for (let k = 0; k < 8; k++) { const dd = rr(a + 10, b - 10), sd = R() < 0.5 ? -1 : 1; addPillow(z, R, dd, hubX(dd) + sd * rr(20, z.valley * 0.8), true); }
      break;
    }
    case 'railpark': {
      // Rail-Park: Boxen, Rails und kleine Gaps im Wechsel, mit ruhigem Gefälle dazwischen
      cur = a + 30;
      const items = [];
      for (let k = 0; k < 9; k++) {
        const r = R();
        if (r < 0.32) items.push({ t: 'rail', kind: 'box', len: rr(7, 12), h: 0.5, name: 'Box', big: rr(38, 55) });
        else if (r < 0.68) items.push({ t: 'rail', kind: 'rail', len: rr(9, 16), h: rr(0.65, 1.0), name: 'Rail', big: rr(38, 55) });
        else if (r < 0.82) items.push({ t: 'jump', kind: 'table', name: 'Gap', gap: true, phi: 10, Lr: 13, hMax: 4.2, wT: 4.5, vDes: speedAfter(14, z.slope, 45) * 0.95, big: rr(45, 60) });
        else items.push({ t: 'jump', kind: 'table', name: 'Hüttendach', hut: 'roof', wT: 5.6, vDes: Math.min(17.5, speedAfter(14, z.slope, 50) * 0.95), big: rr(60, 80) });
      }
      chain(items);
      for (const li of [1, 2]) sideLine(li, rr(30, 60), [0, 1, 2, 3, 4, 5].map((k) => (k % 2 ? { t: 'rail', kind: 'rail', len: rr(8, 12), h: rr(0.6, 0.8), name: 'Rail', big: rr(45, 60) } : { t: 'rail', kind: 'box', len: rr(6, 10), h: 0.5, name: 'Box', big: rr(45, 60) })));
      break;
    }
    case 'megaair': {
      // Ein Riesensprung mit sehr langem Anlauf (≈ 60 % der Zone), Landung in einen steileren Hang
      cur = z.d0 + z.len * 0.6;
      let j = null;
      for (const [phi, Lr, hMax] of [[18, 28, 14], [17, 26, 12.5], [16, 24, 11.5], [16, 23, 11]]) {
        j = addJump(z, R, { d: cur, exactD: snapStraight(z, cur, 40), lane: 0, kind: 'table', name: hMax >= 12 ? 'Mega Air' : 'Big Air', phi, Lr, hMax, wT: 7, steep: 0.55, vBias: 0.6 });
        if (j) break;
      }
      sideLine(1, 70, [0, 1, 2, 3].map(() => ({ t: 'jump', kind: 'table', name: 'Kicker (Seitenlinie)', phi: 8, Lr: 12, hMax: 4, wT: 3.2, big: rr(80, 110) })));
      break;
    }
    case 'slopestyle': {
      // Slopestyle-Linie: Tisch, Spine, Step-up, großer Tisch, Step-down – mit Platz zum Anfahren dazwischen
      cur = a + 20;
      chain([
        { t: 'rail', kind: 'box', len: rr(8, 11), h: 0.5, name: 'Box', big: rr(45, 60) },
        { t: 'rail', kind: 'rail', len: rr(10, 15), h: rr(0.7, 0.95), name: 'Rail', big: rr(60, 80) },
        { t: 'jump', kind: 'table', name: 'Gap', gap: true, phi: 10, Lr: 16, hMax: 6, wT: 5.5, big: rr(80, 110) },
        { t: 'spine', gap: 60 },
        { t: 'jump', kind: 'table', name: 'Hüttendach', hut: 'roof', wT: 5.6, vDes: Math.min(17, speedAfter(13, z.slope, 70) * 0.95), big: rr(90, 120) },
        { t: 'jump', kind: 'stepup', su: 2, name: 'Step-up', phi: 12, Lr: 18, hMax: 7, wT: 5.5, big: rr(90, 120) },
        { t: 'jump', kind: 'table', name: 'Hüttensprung', gap: true, hut: 'over', phi: 14, Lr: 22, hMax: 10, wT: 6, big: rr(100, 130) },
        { t: 'jump', kind: 'table', sd: 3, name: 'Step-down XL', phi: 12, Lr: 20, hMax: 8, wT: 6, big: rr(90, 120) },
      ]);
      for (const li of [1, 2]) sideLine(li, 60, [0, 1, 2, 3].map(() => ({ t: 'jump', kind: 'table', name: 'Kicker (Seitenlinie)', phi: 8, Lr: 12, hMax: 4, wT: 3.2, big: rr(70, 100) })));
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
      // Freeride: die Rinne bleibt frei (keine Felsen-Engstellen mitten in der Spur)
      if (S.style !== 'heli') break;
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
      const heli = S.style === 'heli';
      const hs = heli ? rr(18, 30) : rr(9, 19);   // Heli-Berg: Riesenklippen
      const des = designCliff({ theta: Math.atan(sShelf), vDes: 17.5, drop: hs, maxWall: heli ? 17 : 11 });
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
      chain([{ t: 'roller', n: 2, h: 0.6 }, J('S')]);
      break;
    }
    default:
      break;
  }
  z.feats.sort((p, q) => p.s0 - q.s0);
}

// ------------------------------------------------------------------ Dörfer (Freeride)
// Selten, abseits der Pisten (mindestens rund 30 m), nur in sanften Zonen: Bauernhäuser, Holzhäuser, Kapelle, Heustadel.
const VILLAGE_TYPES = { cruise: 1, glade: 0.8, flat: 1.2, park: 0.7, bowl: 0.6 };
const HOUSE = { VillageHouseA: { r: 7.5, col: [[0, -2.8, 4.6], [0, 2.8, 4.6]] }, VillageHouseB: { r: 5.6, col: [[0, 0, 4.6]] }, Chapel: { r: 7.2, col: [[0, -0.5, 4.6], [0, 5.6, 2.2]] }, Hayloft: { r: 4.6, col: [[0, 0, 3.6]] } };
export const HOUSES = HOUSE;
function planVillage(z, R) {
  if (S.style !== 'freeride' || !VILLAGE_TYPES[z.type] || z.slope > 0.31 || z.idx < 2) return;
  if (S.lastVillage !== undefined && z.idx - S.lastVillage < 3) return;
  if (R() > 0.42 * VILLAGE_TYPES[z.type]) return;
  const rr = (a, b) => a + (b - a) * R();
  // Seite mit dem meisten Platz neben den Spuren
  let best = null;
  for (const sg of [-1, 1]) {
    let ext = 0;
    for (const l of z.lanes) if (l.w > 0) ext = Math.max(ext, sg * l.off + l.w + l.wob);
    const room = z.valley + 22 - ext;
    if (!best || room > best.room) best = { sg, ext, room };
  }
  if (best.room < 52) return;
  const uc = best.sg * (best.ext + 34 + Math.min(18, (best.room - 52) * 0.5));
  const n = 4 + Math.floor(R() * 4), dc = z.d0 + z.len * rr(0.35, 0.65);
  const kinds = ['Chapel', 'VillageHouseA', 'VillageHouseB', 'VillageHouseA', 'Hayloft', 'VillageHouseB', 'Hayloft', 'VillageHouseA'];
  if (R() < 0.45) kinds.shift();
  const houses = [];
  for (let i = 0; i < n; i++) {
    const m = kinds[i % kinds.length], r = HOUSE[m].r;
    for (let tr = 0; tr < 8; tr++) {
      const d = dc + (i - (n - 1) / 2) * rr(14, 19) + rr(-4, 4);
      const u = uc + best.sg * rr(-6, 18) * (i % 2 ? 1 : 0.4);
      if (d < z.d0 + 20 || d > z.d1 - 20) continue;
      if (best.sg * u - r < best.ext + 26) continue;
      if (houses.some((h) => Math.hypot(h.u - u, h.d - d) < h.r + r + 3)) continue;
      houses.push({ m, u, d, r, rot: (best.sg > 0 ? -0.35 : 0.35) * R() + rr(-0.2, 0.2), y: NaN });
      break;
    }
  }
  if (houses.length < 3) return;
  z.village = { houses, sg: best.sg };
  S.lastVillage = z.idx;
  report.features.push({ zone: z.idx, kind: 'Dorf', d: Math.round(dc), u: Math.round(uc), houses: houses.length });
}
let PAD_OFF = false, BED_OFF = false;
function railBed(r, x, d, y) {
  if (!r.bed) {
    BED_OFF = true;
    r.bed = { ya: heightP(r.x0, -(r.d0 + 0.6)), yb: heightP(r.x1, -(r.d0 + r.len)) };
    BED_OFF = false;
  }
  const t = clamp((d - r.d0 - 0.6) / (r.len - 0.6), 0, 1), xr = r.x0 + (r.x1 - r.x0) * clamp((d - r.d0) / r.len, 0, 1);
  const m = (1 - smoothstep(r.w + 1.2, r.w + 6, Math.abs(x - xr))) * smoothstep(r.d0 + 0.1, r.d0 + 1.2, d) * (1 - smoothstep(r.d0 + r.len, r.d0 + r.len + 4, d));
  return m > 0 ? y + (r.bed.ya + (r.bed.yb - r.bed.ya) * t - y) * m : y;
}
function villagePads(x, d, zi, y) {
  for (let zj = Math.max(0, zi - 1); zj <= zi + 1 && zj < S.Z.length; zj++) {
    const v = S.Z[zj].village;
    if (!v) continue;
    for (const h of v.houses) {
      const dd = d - h.d;
      if (dd > h.r + 10 || dd < -h.r - 10) continue;
      const hx = hubX(h.d) + h.u, dist = Math.hypot(x - hx, dd);
      if (dist > h.r + 10) continue;
      if (Number.isNaN(h.y)) { PAD_OFF = true; h.y = heightP(hx, -h.d); PAD_OFF = false; }
      y += (h.y - y) * (1 - smoothstep(h.r, h.r + 10, dist));
    }
  }
  return y;
}
/** Steht bei (x, d) ein Dorfhaus (mit Abstand m)? Für Bäume, Felsen und Dekoration. */
function nearHouse(x, d, m) {
  const zi = zoneIndex(d);
  for (let zj = Math.max(0, zi - 1); zj <= zi + 1 && zj < S.Z.length; zj++) {
    const v = S.Z[zj].village;
    if (v) for (const h of v.houses) if (Math.abs(d - h.d) < h.r + m && Math.hypot(x - hubX(h.d) - h.u, d - h.d) < h.r + m) return true;
  }
  return false;
}
/** Dorfhäuser im Bereich [d0, d1): Modell, Lage, Höhe der Terrasse, Drehung. */
export function housesIn(d0, d1) {
  const out = [];
  for (const z of S.Z) {
    if (!z.village || z.d1 < d0 - 100 || z.d0 > d1 + 100) continue;
    for (const h of z.village.houses) if (h.d >= d0 && h.d < d1) {
      const x = hubX(h.d) + h.u;
      if (Number.isNaN(h.y)) { PAD_OFF = true; h.y = heightP(x, -h.d); PAD_OFF = false; }
      out.push({ m: h.m, x, d: h.d, y: h.y, rot: h.rot, r: h.r });
    }
  }
  return out;
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
  if (nearHouse(x, d, 4 + m)) return true;
  for (const f of z.feats) {
    if (f.kind === 'drop' && d > f.dc - 30 - m && d < f.dc + f.C.a + f.C.L2 + 20 + m && Math.abs(x - f.x) < f.w + 6 + m) return true;
    if (f.kind === 'icecave' && d > f.d - 12 - m && d < f.d + f.len + 12 + m && Math.abs(x - laneX(z, 0, d)) < f.W + 4 + m) return true;
  }
  for (const r of z.rails) if (d > r.d0 - 8 - m && d < r.d0 + r.len + 4 + m && Math.abs(x - (r.x0 + r.x1) / 2) < 3 + m) return true;
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
