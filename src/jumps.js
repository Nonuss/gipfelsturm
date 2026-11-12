// Sprung-Konstrukteur: Absprungrampe, Tisch, Landefläche und Klippen-Abbrüche werden aus der Flugbahn berechnet.
// Grundlage (siehe PISTE_REFERENCE_RESEARCH.md): Die Landefläche wird so geformt, dass die Aufprallgeschwindigkeit
// senkrecht zur Fläche klein bleibt („äquivalente Fallhöhe“, Swedberg / skijumpdesign), und die Übergangsradien
// folgen r = v² / (1,5 g).
//
// Alle Profile sind relative Höhen über dem Hang (Meter). x = Abstand hangabwärts, 0 = Absprungkante.
import { clamp, smoothstep } from './mathutil.js';

export const GR = 9.81;
export const EFH = 0.9;                                  // Ziel-Fallhöhe der Landung (m)
export const VN_TARGET = Math.sqrt(2 * GR * EFH);        // ≈ 4,2 m/s Normalgeschwindigkeit beim Aufsetzen

/** Landefläche ab Knick: gerade Fläche mit Steigung D (zusätzlich zum Hang), runder Knick vorne, Übergang hinten. */
export function faceRel(xx, hk, D, Lk, Lt) {
  if (xx <= 0) return hk;
  if (xx < Lk) return hk - (D / (2 * Lk)) * xx * xx;
  const line = hk - D * (xx - Lk / 2);
  const q = (D * Lt) / 2;
  if (line > q) return line;
  const xx1 = Lk / 2 + (hk - q) / D;
  const u = xx - xx1;
  if (u >= Lt) return 0;
  return q - D * u + (D / (2 * Lt)) * u * u;
}
export const faceLength = (J) => J.Lk / 2 + (J.hk - (J.D * J.Lt) / 2) / J.D + J.Lt;

/** Relatives Höhenprofil eines Sprungs. */
export function jumpRel(x, J) {
  if (x < -J.Lr) return 0;
  if (x < 0) return J.h * Math.pow((x + J.Lr) / J.Lr, J.p);
  let r;
  if (J.T >= J.xk) r = J.h;
  else r = J.h + (J.hf - J.h) * smoothstep(J.T, J.T + 3, x);
  if (J.hk > J.hf && x > J.xk - J.Lu) r = J.hf + (J.hk - J.hf) * smoothstep(J.xk - J.Lu, J.xk, x);
  if (x >= J.xk) return faceRel(x - J.xk, J.hk, J.D, J.Lk, J.Lt);
  return r;
}

/** Hanglinie mit optionalem steilerem Abschnitt hinter der Kante (Break-over wie bei der Mausefalle). */
export function makeSlopeLine(t1, S) {
  if (!S) return (x) => -t1 * x;
  const N = 1100, step = 0.25, Y = new Float64Array(N + 1);
  for (let i = 1; i <= N; i++) {
    const x = (i - 0.5) * step;
    Y[i] = Y[i - 1] - slopeTan(x, t1, S) * step;
  }
  return (x) => {
    const f = clamp(x / step, 0, N - 1e-6), i = Math.floor(f);
    return Y[i] + (Y[i + 1] - Y[i]) * (f - i);
  };
}
/** Hangneigung (tan) an der Stelle x hinter der Kante: t1, ab xb steiler (t2) für die Länge len. */
export function slopeTan(x, t1, S) {
  if (!S) return t1;
  return t1 + (S.t2 - t1) * smoothstep(S.xb - 8, S.xb + 8, x) * (1 - smoothstep(S.xb + S.len, S.xb + S.len + 40, x));
}

/** Flugbahn gegen das Profil. Gibt Aufsetzpunkt, Normalgeschwindigkeit und Flugdaten zurück. */
export function touchdown(J, v, phi, slopeY) {
  const vx = v * Math.cos(phi), tp = Math.tan(phi), k = GR / (2 * vx * vx);
  let apex = 0;
  const ys = (x) => slopeY(x) + jumpRel(x, J);
  for (let x = 0.5; x < 270; x += 0.25) {
    const yt = J.h + tp * x - k * x * x;
    apex = Math.max(apex, yt - ys(x));
    if (yt <= ys(x)) {
      const sl = (ys(x + 0.1) - ys(x - 0.1)) / 0.2;
      const dy = tp - 2 * k * x;
      const vn = (vx * (sl - dy)) / Math.sqrt(1 + sl * sl);
      return { x, vn, t: x / vx, apex, speed: vx * Math.sqrt(1 + dy * dy) };
    }
  }
  return null;
}

/**
 * Entwirft einen Sprung.
 * spec: { kind, theta (Hangwinkel an der Kante, rad), steep: { t2, xb, len } (optional), vDes, phiDeg (Abflugwinkel über Horizont), Lr, hMax, su, sd, p }
 * Ergebnis enthält die Profilparameter J und die vorhergesagten Flugdaten.
 */
export function designJump(spec) {
  const theta = spec.theta, v = spec.vDes, phi = (spec.phiDeg * Math.PI) / 180;
  const slopeY = makeSlopeLine(Math.tan(theta), spec.steep);
  const p = spec.p || 1.7, Lr = spec.Lr;
  let h = (Math.tan(phi + theta) * Lr) / p;
  h = clamp(h, 0.7, spec.hMax || 8);
  const su = spec.su || 0, sd = spec.sd || 0;
  const hf = Math.max(0.5, h - sd);
  const hk = spec.kind === 'stepup' ? h + su : hf;
  const Lk = 3, Lu = su > 0 ? 6 : 0.1;
  let best = null;
  for (const D of [0.2, 0.24, 0.28, 0.33, 0.38, 0.44, 0.5]) {
    const Lt = clamp(((v * v) / (1.5 * GR)) * (D / (1 + 2 * D)) * 1.6, 5, 16);
    if (hk < (D * Lt) / 2 + 0.3) continue;
    for (let xk = 8; xk < 130; xk += 0.5) {
      const T = sd > 0 ? Math.max(4, xk * 0.4) : xk;
      const J = { h, Lr, p, T, hf, hk, Lu, xk, D, Lk, Lt };
      const td = touchdown(J, v, phi, slopeY);
      if (!td) continue;
      const lf = faceLength(J);
      const frac = (td.x - xk) / lf;
      if (frac < 0.18 || frac > 0.7) continue;
      const score = Math.abs(frac - 0.4) + Math.max(0, td.vn - VN_TARGET) * 0.15;
      if (!best || score < best.score) best = { J, td, score, frac };
    }
    if (best && best.td.vn <= VN_TARGET * 1.2) break;
  }
  if (!best) return null;
  const J = best.J;
  const vr = spec.vRange || [v * 0.8, v * 1.2];
  const lo = touchdown(J, vr[0], phi, slopeY), hi = touchdown(J, vr[1], phi, slopeY);
  const ok = best.td.vn <= VN_TARGET * 1.6;
  return {
    J, ok, vn: best.td.vn, flight: best.td.x, airT: best.td.t, apex: best.td.apex, frac: best.frac,
    vnLow: lo ? lo.vn : 0, vnHigh: hi ? hi.vn : 0, xLow: lo ? lo.x : 0, xHigh: hi ? hi.x : 0,
    ext0: -Lr, ext1: J.xk + faceLength(J) + 2,
  };
}

/** Endgeschwindigkeit auf einem Hang (gleiche Konstanten wie physics.js: Reibung 0,04, Luftwiderstand 0,0036 / 0,0019 in der Hocke). */
export function terminalSpeed(slopeTan, tuck) {
  const th = Math.atan(slopeTan);
  const a = GR * (Math.sin(th) - 0.04 * Math.cos(th));
  return a <= 0 ? 3 : Math.sqrt(a / (tuck ? 0.0019 : 0.0036));
}

// ------------------------------------------------------------------ Klippen
/** Sanft ansteigende Rampe 0→1 mit linearem Mittelteil (e = Anteil der gerundeten Enden). */
export function ramp01(t, e = 0.25) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const n = 1 - e;
  if (t < e) return t * t / (2 * e * n);
  if (t > 1 - e) return 1 - (1 - t) * (1 - t) / (2 * e * n);
  return (t - e / 2) / n;
}

/** Abbruch: senkrechte Wand + Geröllhang (Talus), der den Aufprall abfängt. Werte sind Absenkungen (positiv = tiefer). */
export function cliffDrop(dd, C) {
  let r = C.wall * smoothstep(0, 3.2, dd);
  if (dd > C.a) r += C.talus * ramp01((dd - C.a) / C.L2, 0.3);
  return r;
}
export const cliffTotal = (C) => C.wall + C.talus;

/** Flugbahn über die Kante: gibt Normalgeschwindigkeit beim Aufsetzen auf dem Geröllhang zurück. */
export function cliffLanding(C, v, theta, phiDeg = 3) {
  const phi = (phiDeg * Math.PI) / 180, tanT = Math.tan(theta), vx = v * Math.cos(phi), tp = Math.tan(phi), k = GR / (2 * vx * vx);
  for (let x = 0.5; x < 200; x += 0.25) {
    const yt = tp * x - k * x * x;
    const ys = -tanT * x - cliffDrop(x, C);
    if (yt <= ys) {
      const s1 = -tanT * (x + 0.1) - cliffDrop(x + 0.1, C), s0 = -tanT * (x - 0.1) - cliffDrop(x - 0.1, C);
      const sl = (s1 - s0) / 0.2, dy = tp - 2 * k * x;
      return { x, vn: (vx * (sl - dy)) / Math.sqrt(1 + sl * sl), t: x / vx };
    }
  }
  return null;
}

/** Entwirft einen Klippen-Sprung: Wand-Höhe und Geröllhang werden so gewählt, dass der Aufprall tragbar bleibt. */
export function designCliff(spec) {
  const { theta, vDes, drop } = spec;
  let best = null;
  for (let wall = Math.min(spec.maxWall, drop * 0.7); wall >= 2.2; wall -= 0.4) {
    const talus = drop - wall;
    for (const L2 of [16, 20, 24, 30, 36, 44]) {
      if (talus / L2 > 0.62) continue;
      for (let a = 5; a <= 40; a += 2) {
        const C = { wall, talus, L2, a };
        const ld = cliffLanding(C, vDes, theta);
        if (!ld || ld.x < a + L2 * 0.1 || ld.x > a + L2 * 0.9) continue;
        const sc = ld.vn + Math.abs(ld.x - (a + L2 * 0.4)) * 0.05;
        if (!best || sc < best.sc) best = { C, ld, sc };
      }
    }
    if (best && best.ld.vn < 7.5) break;
  }
  if (!best) return null;
  const lo = cliffLanding(best.C, vDes * 0.75, theta), hi = cliffLanding(best.C, vDes * 1.25, theta);
  return { C: best.C, vn: best.ld.vn, flight: best.ld.x, airT: best.ld.t, vnLow: lo ? lo.vn : 0, vnHigh: hi ? hi.vn : 0, ok: best.ld.vn < 10 };
}
