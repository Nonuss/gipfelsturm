// Fernsicht des Heli-Gebirges als reine Zahlenfelder (ohne three.js), damit sie im Web Worker entstehen kann:
// zwei Gitter (Massiv fein, Umgebung grob) mit Position, Normale und Material (Fels, Wald, Sonne, Gletscher)
// sowie die Fichten der Ferne (Position, Drehung, Größe, Helligkeit).
import * as HB from './heliberg.js';
import { clamp, lerp, smoothstep, fbm, mulberry32 } from './mathutil.js';

function grid(nx, nd, P, H, matFn, skip) {
  const n = nx * nd, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), am = new Float32Array(n * 4), ao = new Float32Array(n);
  const Y = new Float32Array(n), X = new Float32Array(n), D = new Float32Array(n);
  for (let j = 0; j < nd; j++) for (let i = 0; i < nx; i++) { const k = j * nx + i, [x, d] = P(i, j); X[k] = x; D[k] = d; Y[k] = H(x, d); }
  for (let j = 0; j < nd; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i;
    const i0 = Math.max(0, i - 1), i1 = Math.min(nx - 1, i + 1), j0 = Math.max(0, j - 1), j1 = Math.min(nd - 1, j + 1);
    const hx = (Y[j * nx + i1] - Y[j * nx + i0]) / (X[j * nx + i1] - X[j * nx + i0]);
    const hd = (Y[j1 * nx + i] - Y[j0 * nx + i]) / (D[j1 * nx + i] - D[j0 * nx + i]);
    const inv = 1 / Math.sqrt(hx * hx + 1 + hd * hd);
    pos[k * 3] = X[k]; pos[k * 3 + 1] = Y[k]; pos[k * 3 + 2] = -D[k];
    nor[k * 3] = -hx * inv; nor[k * 3 + 1] = inv; nor[k * 3 + 2] = hd * inv;
    am.set(matFn(X[k], D[k], Y[k], Math.hypot(hx, hd)), k * 4);
    // Mulden dunkler, Rücken heller: Geländeform bleibt auch im flachen Licht lesbar
    const dx = Math.max(1e-3, (X[j * nx + i1] - X[j * nx + i0]) / Math.max(1, i1 - i0)), dz = Math.max(1e-3, (D[j1 * nx + i] - D[j0 * nx + i]) / Math.max(1, j1 - j0));
    const lap = (Y[j * nx + i1] + Y[j * nx + i0] - 2 * Y[k]) / (dx * dx) + (Y[j1 * nx + i] + Y[j0 * nx + i] - 2 * Y[k]) / (dz * dz);
    ao[k] = clamp(1 - lap * 9 * Math.sqrt(dx), 0.62, 1.08);
  }
  const idx = [];
  for (let j = 0; j < nd - 1; j++) for (let i = 0; i < nx - 1; i++) {
    if (skip && skip(X[j * nx + i], D[j * nx + i], X[(j + 1) * nx + i + 1], D[(j + 1) * nx + i + 1])) continue;
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    idx.push(a, b, c, b, d, c);   // Vorderseite nach oben (z = -d): von oben sichtbar
  }
  return { pos, nor, am, ao, idx: Uint32Array.from(idx) };
}

/** tier: 'low' | 'mid' | 'high' */
export function farArrays(s, tier) {
  const fg = s.fg, cg = s.cg, low = tier === 'low';
  // Fels: steil (über ca. 32 Grad) oder scharfe Grate; in der Ferne nach Gefälle des groben Rasters
  const rockOf = (slope, curv) => smoothstep(0.62, 1.0, slope) + clamp(-curv * 120, 0, 0.45) * smoothstep(0.4, 0.75, slope);
  const coarseForest = (x, d, y, slope) => {
    const fl = HB.floorY(x, d), tl = s.treeY + (fl - s.valleyY) + 160 * (fbm(x / 900, d / 900) - 0.5);
    const up = smoothstep(tl + 40, tl - 200, y) * smoothstep(1.3, 0.85, slope) * (0.55 + 0.45 * smoothstep(0.3, 0.6, fbm(x / 260 + 4, d / 260)));
    // wie im Massiv: Talboden mit Waldflecken, dazu Almen und Lichtungen (v29)
    return lerp(HB.floorWood(x, d), up, smoothstep(fl + 12, fl + 45, y)) * HB.openLand(x, d);
  };
  const floorMask = (x, d, y) => smoothstep(s.valleyY + 60, s.valleyY + 15, y + (s.valleyY - HB.floorY(x, HB.valleyD(x))));
  // Massiv (feines Raster)
  const st = low ? 3 : 2, nx = Math.floor((fg.nx - 1) / st) + 1, nd = Math.floor((fg.nd - 1) / st) + 1;
  const I = grid(nx, nd, (i, j) => [fg.x0 + i * st * fg.cell, fg.d0 + j * st * fg.cell], HB.heightCoarse,
    (x, d, y) => [rockOf(HB.slopeAt(x, d), HB.curvAt(x, d)), HB.forestAt(x, d), HB.sunAt(x, d), HB.glacierAt(x, d) - floorMask(x, d, y)]);
  // Gebirge rundherum (grobes Raster), das Massiv ausgespart
  const cs = low ? 2 : 1, cx = Math.floor((cg.nx - 1) / cs) + 1, cd = Math.floor((cg.nd - 1) / cs) + 1;
  const fx0 = fg.x0 + 60, fx1 = fg.x0 + (fg.nx - 1) * fg.cell - 60, fd0 = fg.d0 + 60, fd1 = fg.d0 + (fg.nd - 1) * fg.cell - 60;
  const O = grid(cx, cd, (i, j) => [cg.x0 + i * cs * cg.cell, cg.d0 + j * cs * cg.cell], HB.heightCoarse,
    (x, d, y, slope) => [rockOf(slope * 2.0, 0) * smoothstep(s.valleyY + 450, s.valleyY + 1000, y) + 0.35 * smoothstep(s.treeY + 300, s.treeY + 1200, y) * smoothstep(0.3, 0.55, slope),
      coarseForest(x, d, y, slope), HB.sunAt(x, d), smoothstep(0.5, 0.25, slope) * smoothstep(s.treeY + 700, s.treeY + 1000, y) - floorMask(x, d, y)],
    (xa, da, xb, db) => xa >= fx0 && xb <= fx1 && da >= fd0 && db <= fd1);
  // Horizont: ein sehr grober Ring bis 70 km, damit man nirgends ins Leere schaut (Höhe aus der Makroform)
  const Hz = horizon(s);
  // Fichten in der Ferne, in Gruppen (Bestände mit Lücken)
  const N = low ? 34000 : tier === 'mid' ? 70000 : 120000;
  const tr = new Float32Array(N * 7);
  const R = mulberry32(s.seed * 31 + 5);
  let n = 0, tries = 0;
  const x0 = fg.x0, x1 = fg.x0 + (fg.nx - 1) * fg.cell, d0 = fg.d0, d1 = fg.d0 + (fg.nd - 1) * fg.cell;
  const nIn = Math.round(N * 0.55), nRiver = Math.round(N * 0.06);
  while (n < N && tries < N * 40) {
    tries++;
    let x, d, f;
    if (n < nIn) { x = x0 + R() * (x1 - x0); d = d0 + R() * (d1 - d0); f = HB.forestAt(x, d); }
    else {
      x = (R() * 2 - 1) * 11000; d = s.DV + (R() * 2 - 1) * 5000;
      if (x > x0 && x < x1 && d > d0 && d < d1) continue;
      const e = 30, y = HB.heightCoarse(x, d), sl = Math.hypot(HB.heightCoarse(x + e, d) - HB.heightCoarse(x - e, d), HB.heightCoarse(x, d + e) - HB.heightCoarse(x, d - e)) / (2 * e);
      f = coarseForest(x, d, y, sl);
    }
    if (n >= N - nRiver) {
      // Ufergehölz entlang des Flusses und kleine Feldgehölze im Talboden
      x = (R() * 2 - 1) * 15000; d = HB.riverD(x) + (R() < 0.5 ? -1 : 1) * (14 + R() * 22); f = 0.8;
      if (R() < 0.25) d = HB.valleyD(x) + (R() * 2 - 1) * s.Wv * 0.9;
    }
    if (f < 0.15 || R() > f) continue;
    const nG = 4 + Math.floor(R() * 9 * Math.min(1, f + 0.3));
    for (let q = 0; q < nG && n < N; q++) {
      const tx = x + (R() - 0.5) * 26, td = d + (R() - 0.5) * 26, hgt = 10 + R() * 14;
      tr.set([tx, HB.heightCoarse(tx, td) - 0.6, -td, R() * 6.28, hgt * (0.8 + R() * 0.3), hgt, 0.62 + R() * 0.3], n * 7);
      n++;
    }
  }
  return { I, O, Hz, trees: tr.subarray(0, n * 7), treeCount: n };
}

/** Ring um das grobe Raster bis rund 70 km: grobe Berge und Täler aus der Makroform, stark im Dunst. */
function horizon(s) {
  const cg = s.cg;
  const gx0 = cg.x0, gx1 = cg.x0 + (cg.nx - 1) * cg.cell, gd0 = cg.d0, gd1 = cg.d0 + (cg.nd - 1) * cg.cell;
  const cxm = (gx0 + gx1) / 2, cdm = (gd0 + gd1) / 2, R0 = 35000;
  const n = 140, X = [], step = (2 * R0) / n;
  for (let i = 0; i <= n; i++) X.push(cxm - R0 + i * step);
  const D = []; for (let j = 0; j <= n; j++) D.push(cdm - R0 + j * step);
  return grid(n + 1, n + 1, (i, j) => [X[i], D[j]], (x, d) => {
    const inside = x > gx0 + 200 && x < gx1 - 200 && d > gd0 + 200 && d < gd1 - 200;
    return inside ? HB.heightCoarse(x, d) - 60 : HB.macroAt(x, d);
  }, (x, d, y, slope) => [smoothstep(0.35, 0.7, slope), 0.2 * smoothstep(s.valleyY + 900, s.valleyY + 400, y), 1, 0],
  (xa, da, xb, db) => xa > gx0 + 600 && xb < gx1 - 600 && da > gd0 + 600 && db < gd1 - 600);
}
