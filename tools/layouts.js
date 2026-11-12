import * as C from '../src/course.js';
import * as P from '../src/piste.js';

const SEEDS = [3, 8, 15, 22, 29, 36, 43, 50];
const D1 = 4000, W = 170, H = 960, PAD = 28;
const cv = document.getElementById('c');
cv.width = SEEDS.length * W + 20;
cv.height = H + PAD + 16;
const g = cv.getContext('2d');
g.fillStyle = '#0f1722';
g.fillRect(0, 0, cv.width, cv.height);
const LAT = 190;                               // sichtbare Breite: ±190 m um x = 0
const sx = (W - 36) / (2 * LAT), sy = H / D1;
const ZC = { start: '#8892a6', cruise: '#58a7ff', glade: '#2f9e5d', bowl: '#d9e8ff', park: '#ff9f0a', bigair: '#ff453a', couloir: '#7d5fff', cliff: '#c44', flat: '#8892a6', steep: '#1a1d24' };
const ZL = { start: 'S', cruise: 'P', glade: 'W', bowl: 'H', park: 'K', bigair: 'B', couloir: 'R', cliff: 'L', flat: 'A', steep: 'T' };

SEEDS.forEach((seed, si) => {
  C.setMode(true, seed);
  const ox = si * W + 14;
  const X = (x) => ox + 22 + W / 2 - 18 + x * sx - 0;
  const Y = (d) => PAD + d * sy;
  const data = C.mapSlice(0, D1, 8);
  g.save();
  g.beginPath(); g.rect(ox, PAD, W - 4, H); g.clip();
  g.fillStyle = '#16263d'; g.fillRect(ox, PAD, W - 4, H);
  // Zonenband
  for (const z of data.zones) {
    g.fillStyle = ZC[z.type]; g.globalAlpha = 0.9;
    g.fillRect(ox, Y(z.d0), 12, Y(Math.min(z.d1, D1)) - Y(z.d0) - 1);
    g.globalAlpha = 1; g.fillStyle = '#0f1722'; g.font = 'bold 10px sans-serif';
    if (Y(z.d1) - Y(z.d0) > 14) g.fillText(ZL[z.type], ox + 3, Y(z.d0) + 11);
  }
  // Tal
  g.fillStyle = 'rgba(235,242,255,0.18)';
  g.beginPath();
  data.rows.forEach((r, i) => { const x = X(r.hub - r.valley), y = Y(r.d); if (i === 0) g.moveTo(x, y); else g.lineTo(x, y); });
  for (let i = data.rows.length - 1; i >= 0; i--) g.lineTo(X(data.rows[i].hub + data.rows[i].valley), Y(data.rows[i].d));
  g.closePath(); g.fill();
  // Spuren
  for (let li = data.rows[0].lanes.length - 1; li >= 0; li--) {
    for (let i = 0; i < data.rows.length - 1; i++) {
      const a = data.rows[i].lanes[li], b = data.rows[i + 1].lanes[li];
      if (a.w < 1 || b.w < 1) continue;
      const k = a.k;
      g.strokeStyle = k === 3 ? '#ff8a2e' : k === 1 ? '#ffd84a' : data.rows[i].slope < 0.27 ? '#58a7ff' : data.rows[i].slope < 0.37 ? '#ff5b4d' : '#2b2f3a';
      g.lineWidth = Math.max(1.5, a.w * 2 * sx * 0.9); g.lineCap = 'round';
      g.beginPath(); g.moveTo(X(a.x), Y(data.rows[i].d)); g.lineTo(X(b.x), Y(data.rows[i + 1].d)); g.stroke();
    }
  }
  for (const f of data.feats) {
    const x = X(f.x), y = Y(f.d);
    if (f.kind === 'cliff') { g.strokeStyle = '#ff3b30'; g.lineWidth = 2; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(ox + 14, y); g.lineTo(ox + W - 6, y); g.stroke(); g.setLineDash([]); }
    else if (f.kind === 'jump') { g.fillStyle = f.size > 5 ? '#ff9f0a' : '#ffe14a'; g.beginPath(); g.arc(x, y, f.size > 5 ? 3.5 : 2.2, 0, 6.3); g.fill(); }
  }
  g.restore();
  g.fillStyle = '#eaf2ff'; g.font = 'bold 12px sans-serif';
  g.fillText('Seed ' + seed, ox + 20, 18);
  const nz = {};
  data.zones.forEach((z) => { nz[z.type] = (nz[z.type] || 0) + 1; });
  g.font = '10px sans-serif'; g.fillStyle = 'rgba(234,242,255,0.65)';
  g.fillText(data.zones.length + ' Zonen · ' + Object.keys(nz).length + ' Typen', ox + 20, 28 + 0);
});
// Skala
g.fillStyle = 'rgba(234,242,255,0.5)'; g.font = '10px sans-serif';
for (let d = 0; d <= D1; d += 500) { g.fillText(d + ' m', cv.width - 46, PAD + d * sy + 3); }
window.__done = true;
