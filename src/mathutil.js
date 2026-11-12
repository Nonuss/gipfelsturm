// Kleine Mathe- und Rauschfunktionen, die Rennen und Zufallsberg gemeinsam nutzen.
export const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ihash(ix, iy) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y) {
  const ix = Math.floor(x), iy = Math.floor(y);
  let fx = x - ix, fy = y - iy;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = ihash(ix, iy), b = ihash(ix + 1, iy), c = ihash(ix, iy + 1), d = ihash(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
export function fbm(x, y) {
  return vnoise(x, y) * 0.55 + vnoise(x * 2.03 + 11.3, y * 2.03 + 4.7) * 0.28 + vnoise(x * 4.1 + 3.1, y * 4.1 + 9.2) * 0.17;
}
/** Rauschen in [-1, 1] mit Startwert (für zufällige, aber reproduzierbare Verläufe). */
export const snoise = (x, y, seed) => vnoise(x + seed * 17.13, y + seed * 5.71) * 2 - 1;
