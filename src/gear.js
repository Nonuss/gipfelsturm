// Ausrüstung für den Shop: Ski, Snowboards und Kopfteile, prozedural als Geometrie mit Farben je Fläche.
// Ski: Taillierung (Schaufel breit, Mitte schmal, Ende breit), Vorspannung unter der Bindung, Rocker an Schaufel und Ende,
// Stahlkanten, dunkler Belag, Seitenwange, Grafik auf der Oberseite, Bindung mit Platte, Vorder- und Fersenteil, Stopper.
// Achsen wie das alte Ski-Modell: x quer, y oben (Belag bei y = 0 unter dem Schuh), Spitze bei -z, Schuh bei z = 0.
import * as THREE from 'three';

const C3 = (h) => { const c = new THREE.Color(h); return [c.r, c.g, c.b]; };   // sRGB-Hex nach Linear (wie Materialfarben)
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

class Builder {
  constructor() { this.p = []; this.c = []; }
  tri(a, b, c, col) { this.p.push(...a, ...b, ...c); this.c.push(...col, ...col, ...col); }
  quad(a, b, c, d, col) { this.tri(a, b, c, col); this.tri(a, c, d, col); }
  box(cx, cy, cz, sx, sy, sz, col, top) {
    const x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    const t = top || col;
    this.quad([x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0], t);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col);
    this.quad([x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], col);
    this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0], col);
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], col);
  }
  geo() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

// ------------------------------------------------------------------ Ski
// d: { len, tip, waist, tail, twin, rockT, rockL, top: [Farben], pat: Muster, base, edgeC, bind: Farbe }
export const SKIS = {
  allround: { name: 'Allround', len: 1.72, tip: 0.122, waist: 0.078, tail: 0.106, rockT: 0.045, rockL: 0.012, top: ['#23262d', '#ff6a13', '#f2f2f0'], pat: 'stripe', base: '#14161a', bind: '#ff6a13' },
  slalom: { name: 'Slalom-Racer', len: 1.65, tip: 0.124, waist: 0.066, tail: 0.104, rockT: 0.03, rockL: 0.006, top: ['#e3202b', '#f6f6f4', '#14161a'], pat: 'race', base: '#101216', bind: '#e3202b', plate: true },
  giant: { name: 'Riesentorlauf GS', len: 1.85, tip: 0.112, waist: 0.068, tail: 0.098, rockT: 0.03, rockL: 0.006, top: ['#1d4fd8', '#f6f6f4', '#ffd23f'], pat: 'race', base: '#101216', bind: '#1d4fd8', plate: true },
  powder: { name: 'Powder 118', len: 1.86, tip: 0.142, waist: 0.118, tail: 0.13, rockT: 0.085, rockL: 0.05, top: ['#ff8a1e', '#14161a', '#fff1d6'], pat: 'mountain', base: '#1a1c22', bind: '#14161a' },
  park: { name: 'Park Twin', len: 1.74, tip: 0.124, waist: 0.092, tail: 0.124, rockT: 0.06, rockL: 0.055, twin: true, top: ['#b6ff3a', '#7a2bd9', '#ff3d7f', '#14161a'], pat: 'blocks', base: '#2a1446', bind: '#14161a' },
  wood: { name: 'Holz Classic', len: 1.78, tip: 0.128, waist: 0.084, tail: 0.112, rockT: 0.05, rockL: 0.015, top: ['#a8743f', '#7d5128', '#e8d8b8'], pat: 'wood', base: '#1a1712', bind: '#2b2b2b' },
  carbon: { name: 'Carbon Pro', len: 1.8, tip: 0.13, waist: 0.096, tail: 0.116, rockT: 0.06, rockL: 0.02, top: ['#17191d', '#2a2e36', '#27c3ff'], pat: 'carbon', base: '#0d0e10', bind: '#27c3ff' },
  gold: { name: 'Gipfel Gold', len: 1.8, tip: 0.128, waist: 0.088, tail: 0.112, rockT: 0.055, rockL: 0.018, top: ['#d4a62a', '#14161a', '#fff3c4'], pat: 'gold', base: '#15130d', bind: '#d4a62a' },
};

function skiPattern(d, t, x, cols) {
  // t: 0 = Spitze, 1 = Ende; x: -1 .. 1 quer
  const [a, b, c, e] = cols;
  switch (d.pat) {
    case 'stripe': return Math.abs(t - 0.32) < 0.035 || Math.abs(t - 0.4) < 0.012 ? b : t > 0.62 && t < 0.66 ? c : a;
    case 'race': { const k = t * 9 + x * 0.6; return t < 0.42 ? (Math.floor(k) % 2 ? a : b) : t > 0.7 ? a : Math.abs(x) < 0.35 ? c : b; }
    case 'mountain': { const peak = 0.5 - 0.35 * Math.abs(Math.sin((x + 1) * 2.3)) * 0.55; return t > 0.18 && t < 0.62 ? (t > peak + 0.14 ? b : t > peak ? c : a) : a; }
    case 'blocks': { const i = Math.floor(t * 7 + (x > 0 ? 0.5 : 0)); return [a, b, c, e][i % 4]; }
    case 'wood': { const g = 0.5 + 0.5 * Math.sin(t * 160 + Math.sin(x * 3 + t * 20) * 2.2); return t > 0.08 && t < 0.92 && Math.abs(x) > 0.86 ? c : mix(a, b, g * 0.7); }
    case 'carbon': { const w = (Math.floor(t * 120) + Math.floor((x + 1) * 6)) % 2; return Math.abs(x) < 0.12 && t > 0.15 && t < 0.85 ? c : w ? a : b; }
    case 'gold': return Math.abs(x) < 0.18 ? c : t > 0.45 && t < 0.55 ? b : a;
    default: return a;
  }
}
/** Ein Ski als Geometrie. Länge entlang z (Spitze -z), Schuh-Mitte bei z = 0 (Montagepunkt knapp hinter der Mitte). */
export function makeSki(d) {
  const B = new Builder();
  const L = d.len, z0 = -L * 0.53, z1 = L * 0.47, N = 48;
  const top = d.top.map(C3), base = C3(d.base), steel = C3('#8c9097'), side = C3('#1c1e22');
  const zTipR = z0 + L * (d.twin ? 0.2 : 0.22), zTailR = z1 - L * (d.twin ? 0.18 : 0.12);
  const width = (z) => {
    // Taillierung: breiteste Stelle 12 cm vor der Spitze bzw. 8 cm vor dem Ende, schmalste unter dem Schuh
    const zt = z0 + 0.12, zl = z1 - 0.08;
    let w;
    if (z < 0) { const t = (z - zt) / (0 - zt); w = d.tip + (d.waist - d.tip) * (1 - Math.cos(Math.PI * Math.min(1, Math.max(0, t)))) / 2; }
    else { const t = z / zl; w = d.waist + (d.tail - d.waist) * (1 - Math.cos(Math.PI * Math.min(1, t))) / 2; }
    // runde Spitze und (bei Twin) rundes Ende
    if (z < zt) { const u = (zt - z) / (zt - z0); w *= Math.sqrt(Math.max(0, 1 - u * u * 0.92)); }
    if (z > zl) { const u = (z - zl) / (z1 - zl); w *= d.twin ? Math.sqrt(Math.max(0, 1 - u * u * 0.92)) : 1 - 0.18 * u * u; }
    return Math.max(0.012, w) / 2;
  };
  const baseY = (z) => {
    // Rocker: Spitze und Ende biegen sich auf; dazwischen Vorspannung (Mitte 4 mm höher, liegt beim Fahren flach)
    let y = 0;
    if (z < zTipR) { const u = (zTipR - z) / (zTipR - z0); y += d.rockT * u * u * (1.25 - 0.25 * u); }
    if (z > zTailR) { const u = (z - zTailR) / (z1 - zTailR); y += d.rockL * u * u; }
    return y;
  };
  const thick = (z) => { const t = (z - z0) / L; return 0.0055 + 0.0105 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.04) / 0.92))); };
  const sec = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N, z = z0 + (z1 - z0) * (0.5 - 0.5 * Math.cos(Math.PI * t)) * 0 + (z1 - z0) * t, w = width(z), y = baseY(z), h = thick(z);
    sec.push({ z, t, w, y, h });
  }
  for (let i = 0; i < N; i++) {
    const A = sec[i], Bq = sec[i + 1];
    const P = (s, xf, yo) => [xf * s.w, s.y + yo, s.z];
    // Belag
    B.quad(P(A, -0.94, 0), P(A, 0.94, 0), P(Bq, 0.94, 0), P(Bq, -0.94, 0), base);
    for (const sg of [-1, 1]) {
      // Stahlkante (unten außen) und Seitenwange
      const e0 = P(A, sg * 0.94, 0), e1 = P(Bq, sg * 0.94, 0), e2 = P(Bq, sg, 0.0022), e3 = P(A, sg, 0.0022);
      if (sg > 0) B.quad(e0, e3, e2, e1, steel); else B.quad(e0, e1, e2, e3, steel);
      const s0 = P(A, sg, 0.0022), s1 = P(Bq, sg, 0.0022), s2 = [sg * Bq.w * 0.9, Bq.y + Bq.h, Bq.z], s3 = [sg * A.w * 0.9, A.y + A.h, A.z];
      if (sg > 0) B.quad(s0, s3, s2, s1, side); else B.quad(s0, s1, s2, s3, side);
    }
    // Oberseite: 6 Streifen quer, Farbe aus dem Muster (Grafik), leicht gewölbt
    const M = 6;
    for (let k = 0; k < M; k++) {
      const xa = -0.9 + (1.8 * k) / M, xb = -0.9 + (1.8 * (k + 1)) / M, xm = (xa + xb) / 2;
      const col = skiPattern(d, (A.t + Bq.t) / 2, xm / 0.9, top);
      const Y = (s, xf) => s.y + s.h + 0.0015 * (1 - xf * xf);
      B.quad([xa * A.w, Y(A, xa), A.z], [xa * Bq.w, Y(Bq, xa), Bq.z], [xb * Bq.w, Y(Bq, xb), Bq.z], [xb * A.w, Y(A, xb), A.z], col);
    }
  }
  // Spitzen-Abschluss (Deckel)
  // Bindung: Platte, Vorderbacken, Fersenautomat mit Stopper-Armen
  const bc = C3(d.bind), dark = C3('#202227'), metal = C3('#b9bec6'), yT = thick(0) + 0.0015;
  if (d.plate) B.box(0, yT + 0.007, -0.01, 0.072, 0.014, 0.62, dark, bc);
  const yb = yT + (d.plate ? 0.014 : 0);
  B.box(0, yb + 0.006, -0.01, 0.064, 0.012, 0.5, dark);
  B.box(0, yb + 0.03, -0.205, 0.07, 0.04, 0.085, bc, metal);           // Vorderbacken
  B.box(0, yb + 0.05, -0.17, 0.05, 0.02, 0.03, dark);
  B.box(0, yb + 0.034, 0.19, 0.072, 0.05, 0.11, bc);                     // Fersenautomat
  B.box(0, yb + 0.066, 0.215, 0.05, 0.022, 0.06, dark, metal);
  for (const sg of [-1, 1]) B.box(sg * 0.042, yb + 0.012, 0.2, 0.006, 0.006, 0.12, metal);   // Stopper
  return B.geo();
}

// ------------------------------------------------------------------ Snowboards
// Länge entlang x (wie das alte Brett), Breite z, Bindungen bei x = ±0.26
export const BOARDS = {
  classic: { name: 'Classic', len: 1.56, w: 0.27, shape: 'twin', top: ['#1e2127', '#ff6a13'], pat: 'stripes', bind: '#14161a' },
  freestyle: { name: 'Park Twin', len: 1.52, w: 0.262, shape: 'twin', top: ['#ffd23f', '#14161a', '#ff3d7f'], pat: 'checker', bind: '#ff3d7f' },
  powder: { name: 'Powder Swallowtail', len: 1.6, w: 0.29, shape: 'swallow', top: ['#2f6fd0', '#e9e6df', '#14161a'], pat: 'mountain', bind: '#2f6fd0' },
  freeride: { name: 'Freeride Directional', len: 1.62, w: 0.274, shape: 'directional', top: ['#0f6b5a', '#f2f2f0', '#d99a1c'], pat: 'wave', bind: '#14161a' },
  aurora: { name: 'Polarlicht', len: 1.56, w: 0.27, shape: 'twin', top: ['#0b1230', '#35e0a1', '#7a2bd9'], pat: 'aurora', bind: '#35e0a1' },
  gold: { name: 'Gipfel Gold', len: 1.58, w: 0.272, shape: 'directional', top: ['#d4a62a', '#14161a'], pat: 'stripes', bind: '#d4a62a' },
};
function boardPattern(d, t, z, cols) {
  const [a, b, c] = cols;
  switch (d.pat) {
    case 'stripes': return Math.abs(Math.sin(t * 22)) > 0.86 ? b : a;
    case 'checker': return (Math.floor(t * 14) + Math.floor((z + 1) * 3)) % 2 ? a : b;
    case 'mountain': { const ridge = 0.15 + 0.55 * Math.abs(Math.sin(t * 9.4)) * Math.abs(Math.cos(t * 3.1)); return (z + 1) / 2 < ridge ? b : (z + 1) / 2 < ridge + 0.08 ? c : a; }
    case 'wave': return Math.sin(t * 18 + z * 2.4) > 0.55 ? b : Math.sin(t * 18 + z * 2.4) < -0.85 ? c : a;
    case 'aurora': { const s = 0.5 + 0.5 * Math.sin(t * 7 + z * 1.6 + Math.sin(t * 3) * 2); return s > 0.66 ? b : s > 0.45 ? mix(b, c, 0.6) : a; }
    default: return a;
  }
}
export function makeBoardGeo(d) {
  const B = new Builder();
  const L = d.len, W = d.w, N = 44, M = 8;
  const top = d.top.map(C3), base = C3('#121418'), steel = C3('#8c9097');
  const nose = d.shape === 'twin' ? 0.12 : 0.15, tail = d.shape === 'twin' ? 0.12 : 0.09;
  const half = (t) => {
    // t: 0 = Ende (-x), 1 = Nase (+x); Taillierung, runde Nase, beim Swallowtail ein Einschnitt hinten (unten)
    const tt = t * 2 - 1, side = 1 - 0.075 * Math.cos(Math.min(1, Math.abs(tt) / 0.8) * Math.PI / 2);
    let w = side;
    const tn = 1 - nose, tl = tail;
    if (t > tn) { const u = (t - tn) / nose; w *= Math.sqrt(Math.max(0, 1 - u * u * (d.shape === 'swallow' ? 0.96 : 0.82))); }
    if (t < tl) { const u = (tl - t) / tl; w *= Math.sqrt(Math.max(0, 1 - u * u * (d.shape === 'directional' ? 0.6 : 0.82))); }
    return (W / 2) * Math.max(0.05, w);
  };
  const rise = (t) => {
    const n = d.shape === 'twin' ? 0.12 : 0.16, l = d.shape === 'twin' ? 0.12 : 0.08;
    let y = 0;
    if (t > 1 - n) { const u = (t - (1 - n)) / n; y += (d.shape === 'swallow' ? 0.06 : 0.035) * u * u; }
    if (t < l) { const u = (l - t) / l; y += (d.shape === 'twin' ? 0.035 : 0.022) * u * u; }
    return y;
  };
  const th = 0.015;
  const S = [];
  for (let i = 0; i <= N; i++) { const t = i / N; S.push({ x: -L / 2 + L * t, t, w: half(t), y: rise(t) }); }
  const swallow = d.shape === 'swallow';
  for (let i = 0; i < N; i++) {
    const A = S[i], Bq = S[i + 1];
    for (let k = 0; k < M; k++) {
      const za = -1 + (2 * k) / M, zb = -1 + (2 * (k + 1)) / M;
      if (swallow && A.t < 0.07 && Math.abs((za + zb) / 2) < 0.3) continue;   // Schwalbenschwanz-Kerbe
      const col = boardPattern(d, (A.t + Bq.t) / 2, (za + zb) / 2, top);
      B.quad([A.x, A.y + th, za * A.w], [A.x, A.y + th, zb * A.w], [Bq.x, Bq.y + th, zb * Bq.w], [Bq.x, Bq.y + th, za * Bq.w], col);
      B.quad([A.x, A.y, za * A.w], [Bq.x, Bq.y, za * Bq.w], [Bq.x, Bq.y, zb * Bq.w], [A.x, A.y, zb * A.w], base);
    }
    for (const sg of [-1, 1]) {
      const a0 = [A.x, A.y, sg * A.w], b0 = [Bq.x, Bq.y, sg * Bq.w], b1 = [Bq.x, Bq.y + th, sg * Bq.w], a1 = [A.x, A.y + th, sg * A.w];
      if (sg > 0) B.quad(a0, b0, b1, a1, steel); else B.quad(a0, a1, b1, b0, steel);
    }
  }
  // Bindungen: Grundplatte, Highback auf der Fersenseite (+z), zwei Riemen
  const bc = C3(d.bind), dark = C3('#1a1c20');
  for (const sx of [-0.26, 0.26]) {
    B.box(sx, th + 0.008, 0, 0.13, 0.016, 0.24, dark, bc);
    B.box(sx, th + 0.13, 0.115, 0.12, 0.22, 0.022, bc);
    B.box(sx - 0.03, th + 0.07, 0, 0.03, 0.02, 0.21, dark);
    B.box(sx + 0.045, th + 0.06, 0, 0.03, 0.02, 0.2, dark);
  }
  return B.geo();
}

// ------------------------------------------------------------------ Kopfteile (am Kopfknochen, Ruhehaltung)
export function makeHeadItem(kind) {
  const grp = new THREE.Group();
  const mat = (c, r = 0.85) => new THREE.MeshStandardMaterial({ color: c, roughness: r });
  if (kind === 'santa') {
    // Weihnachtsmütze über dem Helm: rote, umknickende Spitze, weißer Plüschrand, Bommel; dazu ein weißer Vollbart
    const red = mat('#c8102e'), white = mat('#f4f2ee', 0.95);
    const brim = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.035, 10, 24), white);
    brim.rotation.x = Math.PI / 2; brim.position.set(0, 1.86, 0.01); grp.add(brim);
    const pts = [];
    for (let i = 0; i <= 10; i++) { const t = i / 10; pts.push(new THREE.Vector2(0.135 * (1 - t) + 0.012 * t, t * 0.26)); }
    const cone = new THREE.Mesh(new THREE.LatheGeometry(pts, 16), red);
    cone.position.set(0, 1.875, 0.01); cone.rotation.x = 0.55; grp.add(cone);
    const pom = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), white);
    pom.position.set(0, 1.875 + Math.cos(0.55) * 0.26, 0.01 + Math.sin(0.55) * 0.26); grp.add(pom);
    const beardG = new THREE.SphereGeometry(0.12, 16, 12, 0, Math.PI * 2, Math.PI * 0.45, Math.PI * 0.55);
    const beard = new THREE.Mesh(beardG, white);
    beard.scale.set(1.0, 1.25, 0.75); beard.position.set(0, 1.71, -0.065); grp.add(beard);
    const mous = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.09, 4, 8), white);
    mous.rotation.z = Math.PI / 2; mous.position.set(0, 1.705, -0.135); grp.add(mous);
  } else if (kind === 'tophat') {
    const blk = mat('#16171b', 0.5), band = mat('#e3202b', 0.6);
    const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.015, 24), blk); brim.position.set(0, 1.88, 0.0); grp.add(brim);
    const crown = new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.125, 0.2, 24), blk); crown.position.set(0, 1.985, 0.0); grp.add(crown);
    const b2 = new THREE.Mesh(new THREE.CylinderGeometry(0.127, 0.127, 0.04, 24), band); b2.position.set(0, 1.91, 0.0); grp.add(b2);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.025, 0.14, 10), mat('#ff7a1a', 0.6)); nose.rotation.x = -Math.PI / 2; nose.position.set(0, 1.72, -0.2); grp.add(nose);
  } else if (kind === 'headband') {
    const hb = new THREE.Mesh(new THREE.TorusGeometry(0.132, 0.022, 8, 24), mat('#ff3d7f', 0.8)); hb.rotation.x = Math.PI / 2; hb.position.set(0, 1.79, 0.0); hb.scale.set(1, 1.1, 1); grp.add(hb);
  } else if (kind === 'crown') {
    const g = mat('#d4a62a', 0.3); g.metalness = 0.8;
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.05, 20, 1, true), g); ring.position.set(0, 1.9, 0); grp.add(ring);
    for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI * 2; const sp = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.07, 6), g); sp.position.set(Math.cos(a) * 0.125, 1.955, Math.sin(a) * 0.125); grp.add(sp); }
  }
  grp.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.renderOrder = 10; } });
  return grp;
}
