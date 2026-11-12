// Pulverschicht: Im Tiefschnee liegt um den Fahrer eine feine Schneeschicht (bis ca. 30 cm) über dem festen Gelände.
// Die Skier und der Körper schneiden eine echte Rinne hinein (Höhenverschiebung im Vertex-Shader aus der Spurtextur),
// der unberührte Schnee steht als Wall daneben und davor. So steht der Fahrer in einer Spur, statt im Boden zu verschwinden.
import * as THREE from 'three';
import * as C from './course.js';
import { makeSnowMaterial } from './snow.js';

const LAYER_MAX = 0.3;     // Schichtdicke bei vollem Pulver (m)

export class PowderPatch {
  constructor(scene, cell = 0.5, n = 37) {
    this.cell = cell;
    this.n = n;
    this.cx = NaN; this.cz = NaN;
    const cnt = n * n;
    this.H = new Float32Array(cnt);
    this.pos = new Float32Array(cnt * 3);
    this.nor = new Float32Array(cnt * 3);
    this.aP = new Float32Array(cnt);
    this.aU = new Float32Array(cnt);
    this.aW = new Float32Array(cnt);
    this.aA = new Float32Array(cnt).fill(1);
    this.aL = new Float32Array(cnt);
    const idx = new Uint16Array((n - 1) * (n - 1) * 6);
    let k = 0;
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
        idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('normal', new THREE.BufferAttribute(this.nor, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aPiste', new THREE.BufferAttribute(this.aP, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aU', new THREE.BufferAttribute(this.aU, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aPow', new THREE.BufferAttribute(this.aW, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aAO', new THREE.BufferAttribute(this.aA, 1));
    g.setAttribute('aLayer', new THREE.BufferAttribute(this.aL, 1).setUsage(THREE.DynamicDrawUsage));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geo = g;
    this.mesh = new THREE.Mesh(g, makeSnowMaterial({ patch: true }));
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /** Nach einem Moduswechsel oder neuem Berg: Höhen neu rechnen. */
  reset() { this.cx = NaN; this.mesh.visible = false; }

  update(px, pz, active) {
    const m = this.mesh;
    if (!active) { m.visible = false; return; }
    const cell = this.cell, n = this.n, half = (n - 1) / 2;
    const cx = Math.round(px / cell) * cell, cz = Math.round(pz / cell) * cell;
    if (cx === this.cx && cz === this.cz && m.visible) return;
    this.cx = cx; this.cz = cz;
    m.visible = true;
    const H = this.H, pos = this.pos;
    for (let j = 0; j < n; j++) {
      const z = cz + (j - half) * cell;
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = cx + (i - half) * cell;
        const h = C.height(x, z);
        H[k] = h;
        pos[k * 3] = x; pos[k * 3 + 1] = h + 0.012; pos[k * 3 + 2] = z;
      }
    }
    // Pulveranteil an den vier Ecken, dazwischen bilinear (spart Rechenzeit)
    const x0 = cx - half * cell, x1 = cx + half * cell, z0 = cz - half * cell, z1 = cz + half * cell;
    const p00 = C.surfaceAt(x0, z0).pow, p10 = C.surfaceAt(x1, z0).pow, p01 = C.surfaceAt(x0, z1).pow, p11 = C.surfaceAt(x1, z1).pow;
    const nor = this.nor;
    for (let j = 0; j < n; j++) {
      const v = j / (n - 1);
      for (let i = 0; i < n; i++) {
        const k = j * n + i, u = i / (n - 1);
        const pw = (p00 * (1 - u) + p10 * u) * (1 - v) + (p01 * (1 - u) + p11 * u) * v;
        // Rand blendet auf 0: die Schicht geht nahtlos ins Gelände über
        const e = Math.min(i, j, n - 1 - i, n - 1 - j) / 5;
        const edge = e >= 1 ? 1 : e * e * (3 - 2 * e);
        const wob = 0.85 + 0.15 * Math.sin(pos[k * 3] * 0.9 + pos[k * 3 + 2] * 0.7);
        this.aW[k] = pw;
        // erst ab deutlichem Pulveranteil eine Schicht, sonst sieht man die Patch-Kante im präparierten Schnee
        const pk = Math.min(1, Math.max(0, (pw - 0.18) / 0.4));
        this.aL[k] = LAYER_MAX * (pk * pk * (3 - 2 * pk)) * edge * wob;
        const il = Math.max(0, i - 1), ir = Math.min(n - 1, i + 1), jl = Math.max(0, j - 1), jr = Math.min(n - 1, j + 1);
        const hx = (H[j * n + ir] - H[j * n + il]) / ((ir - il) * cell), hz = (H[jr * n + i] - H[jl * n + i]) / ((jr - jl) * cell);
        const inv = 1 / Math.sqrt(hx * hx + 1 + hz * hz);
        nor[k * 3] = -hx * inv; nor[k * 3 + 1] = inv; nor[k * 3 + 2] = -hz * inv;
      }
    }
    const a = this.geo.attributes;
    a.position.needsUpdate = true; a.normal.needsUpdate = true; a.aPow.needsUpdate = true; a.aLayer.needsUpdate = true;
  }
}
