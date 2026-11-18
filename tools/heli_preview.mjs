// Vorschau des Heli-Gebirges ohne Browser: Reliefbild von oben (Sonne, Schatten, Fels, Wald, Gletscher, Klippen).
// Aufruf: node tools/heli_preview.mjs [seed] [feld|alles] [ausgabe.png] -> sonst docs/img/heli_<seed>_<feld|alles>.png
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as HB from '../src/heliberg.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const seed = +(process.argv[2] || 77), mode = process.argv[3] || 'feld';
const t0 = Date.now();
const s = HB.init(seed);
console.log(`seed ${seed}: Makro ${s.tMacro} ms, Erosion ${s.tErode} ms, gesamt ${s.tAll} ms, Klippen ${s.cliffs.length}, Höhe ${Math.round(-s.valleyY)} m, Baumgrenze ${Math.round(s.treeY - s.valleyY)} m über Tal`);

function png(w, h, rgb) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const big = mode === 'alles';
const X0 = big ? -16000 : -3300, X1 = big ? 16000 : 3300, D0 = big ? -9000 : -700, D1 = big ? 15000 : s.DV + 1500;
const W = 900, Hh = Math.round(W * (D1 - D0) / (X1 - X0));
const buf = Buffer.alloc(W * Hh * 3);
const L = [HB.SUN[0], HB.SUN[1], -HB.SUN[2]];   // (x, y, d)
const H = big ? HB.heightCoarse : (x, d) => HB.heightDU(d, x);
for (let py = 0; py < Hh; py++) for (let px = 0; px < W; px++) {
  const x = X0 + (px / W) * (X1 - X0), d = D0 + (py / Hh) * (D1 - D0), e = (X1 - X0) / W;
  const y = H(x, d), hx = (H(x + e, d) - H(x - e, d)) / (2 * e), hd = (H(x, d + e) - H(x, d - e)) / (2 * e);
  const n = [-hx, 1, -hd], nl = Math.hypot(...n); n[0] /= nl; n[1] /= nl; n[2] /= nl;
  const ndl = Math.max(0, n[0] * L[0] + n[1] * L[1] + n[2] * L[2]);
  const sun = HB.sunAt(x, d), slope = Math.hypot(hx, hd);
  let r = 0.93, g = 0.95, b = 1.0;
  const rock = Math.min(1, Math.max(0, (slope - 1.0) / 0.35));
  r += (0.33 - r) * rock; g += (0.32 - g) * rock; b += (0.33 - b) * rock;
  const f = HB.forestAt(x, d), gl = HB.glacierAt(x, d);
  r += (0.1 - r) * f * 0.8; g += (0.18 - g) * f * 0.8; b += (0.16 - b) * f * 0.8;
  r += (0.72 - r) * gl * 0.5; g += (0.86 - g) * gl * 0.5;
  const lit = 0.32 + 0.85 * ndl * sun;
  const amb = [0.55, 0.65, 0.85];
  let R = r * (lit + amb[0] * 0.35), Gc = g * (lit + amb[1] * 0.35), B = b * (lit + amb[2] * 0.35);
  if (Math.abs(d - HB.riverD(x)) < 9 && y < HB.floorY(x, d) + 3) { R = 0.25; Gc = 0.32; B = 0.38; }
  // Höhenlinien alle 100 m (dünn)
  const cl = Math.abs(((y % 100) + 100) % 100 - 50) > 48.5 ? 0.85 : 1;
  const k = (py * W + px) * 3;
  buf[k] = Math.min(255, R * 200 * cl); buf[k + 1] = Math.min(255, Gc * 200 * cl); buf[k + 2] = Math.min(255, B * 200 * cl);
}
// Klippen rot einzeichnen
if (!big) for (const c of s.cliffs) for (let u = c.u0; u <= c.u1; u += 2) {
  const p = HB.cliffPoint(c, 0, u), px = Math.round((p.x - X0) / (X1 - X0) * W), py = Math.round((p.d - D0) / (D1 - D0) * Hh);
  if (px >= 0 && py >= 0 && px < W && py < Hh) { const k = (py * W + px) * 3; buf[k] = 230; buf[k + 1] = 40; buf[k + 2] = 30; }
}
const out = process.argv[4] ? path.resolve(process.argv[4]) : path.join(ROOT, 'docs', 'img', `heli_${seed}_${mode}.png`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png(W, Hh, buf));
console.log('gespeichert', out, (Date.now() - t0) + ' ms');
