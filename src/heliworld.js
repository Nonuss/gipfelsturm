// Darstellung des Heli-Gebirges (Daten aus heliberg.js):
//   Nahbereich  – 100-m-Kacheln in alle Richtungen um den Fahrer (Schnee-Shader, Bäume, Felsen, Felswände).
//   Fernsicht   – ein Mesh über das Massiv (aus dem feinen Raster) und eines über das ganze Gebirge (grobes Raster).
//                 Farbe je Bildpunkt: Schnee, Fels in Rippen entlang der Falllinie, Wald als Baumgruppen, Gletschereis;
//                 dazu der vorab berechnete Gelände-Schatten. Wo Kacheln liegen, wird die Fernsicht ausgespart.
//   Wald fern   – viele einfache Fichten als Instanzen (im Nahbereich ausgeblendet, dort stehen die echten Bäume).
//   Tal         – Fluss (teils zugefroren), Dörfer mit Häusern, Zielbogen.
import * as THREE from 'three';
import * as C from './course.js';
import { Q } from './quality.js';
import { snowUniforms } from './snow.js';
import { farArrays } from './helifar.js';

const T = 100;
const GLSL_NOISE = /* glsl */ `
float hN(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float vN(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
  return mix(mix(hN(i), hN(i+vec2(1,0)), f.x), mix(hN(i+vec2(0,1)), hN(i+vec2(1,1)), f.x), f.y); }
float fN(vec2 p){ return vN(p)*0.55 + vN(p*2.03+7.1)*0.28 + vN(p*4.1+3.3)*0.17; }`;

export class HeliWorld {
  constructor(world) {
    this.w = world;
    this.scene = world.scene;
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.tiles = new Map();
    this.queue = [];
    this.hole = new THREE.Vector3(0, 0, 0);
    this.uniforms = { uHole: { value: this.hole } };
    this.tileMat = world.snowMatH;
  }

  get radius() { return Q.tier === 'minimal' ? 170 : Q.tier === 'low' ? 200 : Q.tier === 'mid' ? 240 : Q.ultra ? 330 : 280; }

  build() {
    const s = C.HB.info();
    this.s = s;
    this.buildFar();
    this.buildForest();
    this.buildValley();
  }

  dispose() {
    this.group.traverse((o) => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
    for (const t of this.tiles.values()) this.disposeTile(t);
    this.scene.remove(this.group);
    this.tiles.clear();
  }

  // ------------------------------------------------------------ Fernsicht
  farMaterial(outer) {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.93, metalness: 0, vertexColors: false });
    if (outer) { m.polygonOffset = true; m.polygonOffsetFactor = 2; m.polygonOffsetUnits = 8; }
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aMat;\nattribute float aAo;\nvarying vec4 vMat;\nvarying float vAo;\nvarying vec3 vW;\nvarying vec3 vNW;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMat = aMat; vAo = aAo; vW = position; vNW = normal;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec4 vMat;\nvarying float vAo;\nvarying vec3 vW;\nvarying vec3 vNW;\nuniform vec3 uHole;\n' + GLSL_NOISE)
        .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>
          ${outer ? '' : 'if (distance(vW.xz, uHole.xy) < uHole.z - 2.0) discard;'}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec2 p = vW.xz;
          float pw = length(fwidth(p));                       // Meter pro Bildpunkt: feine Muster in der Ferne ausblenden
          vec3 nw = normalize(vNW);
          vec2 gd = normalize(nw.xz + 1e-4);                   // Falllinie
          float al = dot(p, gd), ac = dot(p, vec2(-gd.y, gd.x));
          // Fels: Rippen und Rinnen entlang der Falllinie (Schnee hält in den Rinnen, die Rippen sind frei)
          float rib = vN(vec2(ac * 0.045, al * 0.006)) * 0.65 + vN(vec2(ac * 0.15, al * 0.02)) * 0.35 * (1.0 - smoothstep(4.0, 14.0, pw));
          float sl = sqrt(max(0.0, 1.0 - nw.y * nw.y)) / max(nw.y, 0.2);
          // Felsköpfe und Felsbänder auch in mittelsteilen Flanken (nicht nur an Wänden): Gelände zeigt Struktur
          float outc = smoothstep(0.6, 0.7, fN(p * 0.011 + 3.0) + (rib - 0.5) * 0.25) * smoothstep(0.42, 0.75, sl) * (1.0 - vMat.y);
          float rockM = smoothstep(0.34, 0.56, vMat.x + outc + (rib - 0.5) * 0.85 + (fN(p * 0.01) - 0.5) * 0.25);
          float strata = vN(vec2(p.x * 0.02, vW.y * 0.25)) * 0.5 + 0.5 * vN(vec2(p.y * 0.03, vW.y * 0.6));
          vec3 rockC = vec3(0.30, 0.285, 0.28) * (0.65 + 0.55 * strata) * (0.85 + 0.3 * fN(p * 0.004));
          rockC = mix(rockC, vec3(0.82, 0.86, 0.94), 0.35 * smoothstep(0.45, 0.8, nw.y));   // Schneestaub auf flacheren Felsen
          vec3 snowC = vec3(0.95, 0.965, 1.0) * (0.96 + 0.04 * fN(p * 0.02));
          vec3 col = mix(snowC, rockC, rockM);
          // Gletscher: bläulich, mit Spalten quer zur Falllinie
          float glac = max(vMat.w, 0.0), floorM = max(-vMat.w, 0.0);
          float crev = smoothstep(0.88, 0.97, vN(vec2(al * 0.09, ac * 0.012))) * (1.0 - smoothstep(3.0, 8.0, pw));
          col = mix(col, mix(vec3(0.78, 0.88, 0.98), vec3(0.32, 0.5, 0.66), crev), glac * (1.0 - rockM));
          // Talboden: verschneite Felder mit leicht unterschiedlichem Ton, Hecken und Zäune an den Grenzen
          if (floorM > 0.01) {
            // unregelmäßige Flur: Streifen quer zum Tal mit wechselnder Breite, Grenzen leicht verzogen
            vec2 fp = p + vec2(30.0 * vN(p * 0.004 + 5.0), 18.0 * sin(p.x * 0.003));
            float colW = 140.0 + 60.0 * hN(vec2(floor(fp.y / 95.0), 1.7));
            float row = floor(fp.y / 95.0);
            vec2 cs = vec2(colW, 95.0);
            vec2 q = fp / cs + vec2(hN(vec2(row, 3.1)), 0.0);
            vec2 id = floor(q), fr = fract(q);
            float edge = min(min(fr.x, 1.0 - fr.x) * cs.x, min(fr.y, 1.0 - fr.y) * cs.y);
            float tone = hN(id);
            vec3 fieldC = mix(vec3(0.95, 0.965, 1.0), vec3(0.88, 0.9, 0.95), tone * 0.6);
            float near = 1.0 - smoothstep(5.0, 16.0, pw);
            // nur manche Grenzen tragen eine Hecke (unterbrochen), manche einen Zaun
            float hedge = (1.0 - smoothstep(1.5, 4.0 + pw * 0.5, edge)) * step(0.72, hN(id + 7.3)) * smoothstep(0.35, 0.6, vN(p * 0.03));
            float fence = (1.0 - smoothstep(0.12, 0.4 + pw * 0.3, edge)) * step(0.55, hN(id + 2.9)) * near;
            fieldC = mix(fieldC, vec3(0.22, 0.27, 0.24) * (0.8 + 0.4 * vN(p * 0.5)), hedge * 0.75);
            fieldC = mix(fieldC, vec3(0.4, 0.34, 0.28), fence * 0.35);
            col = mix(col, fieldC, floorM * (1.0 - rockM));
          }
          // Schnee: Windstrukturen und Mulden-Schattierung
          col *= (0.965 + 0.05 * fN(p * 0.025)) * vAo;
          // Luftperspektive wie auf Panoramafotos: ferne Hänge werden kühler und flauer, Schnee nie reinweiß
          float dist = length(vW - cameraPosition);
          float ap = smoothstep(1500.0, 14000.0, dist);
          col = mix(col, vec3(0.74, 0.8, 0.9) * (0.88 + 0.12 * nw.y), ap * 0.45);
          col *= mix(1.0, 0.9, ap);
          // Wald: Baumgruppen (dunkel, mit Schnee auf den Kronen), in der Ferne als ruhige Fläche
          float speck = mix(vN(p * 0.22), 0.5, smoothstep(3.0, 12.0, pw));
          float fm = smoothstep(0.12, 0.45, vMat.y + (speck - 0.5) * 0.55);
          vec3 forC = mix(vec3(0.045, 0.075, 0.07), vec3(0.3, 0.36, 0.38), 0.16 + 0.22 * vN(p * 0.6) * (1.0 - smoothstep(2.0, 6.0, pw)));
          col = mix(col, forC, fm);
          diffuseColor.rgb = col;
        }`)
        .replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\nreflectedLight.directDiffuse *= vMat.z;\nreflectedLight.directSpecular *= vMat.z;');
    };
    m.customProgramCacheKey = () => 'heliFar' + (outer ? 'O' : 'I');
    return m;
  }

  /** Fernsicht aus den (im Worker vorbereiteten) Zahlenfeldern. */
  farData() {
    const s = this.s, tier = Q.tier;
    if (!s.far || s.farTier !== tier) { s.far = farArrays(s, tier); s.farTier = tier; }
    return s.far;
  }
  geo(a) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(a.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(a.nor, 3));
    g.setAttribute('aMat', new THREE.BufferAttribute(a.am, 4));
    g.setAttribute('aAo', new THREE.BufferAttribute(a.ao, 1));
    g.setIndex(new THREE.BufferAttribute(a.idx, 1));
    g.computeBoundingSphere();
    return g;
  }
  buildFar() {
    const f = this.farData();
    this.farI = new THREE.Mesh(this.geo(f.I), this.farMaterial(false));
    this.farI.frustumCulled = false;
    this.farI.receiveShadow = true;
    this.farO = new THREE.Mesh(this.geo(f.O), this.farMaterial(true));
    this.farO.frustumCulled = false;
    this.farH = new THREE.Mesh(this.geo(f.Hz), this.farMaterial(true));
    this.farH.frustumCulled = false;
    this.group.add(this.farI, this.farO, this.farH);
  }

  // ------------------------------------------------------------ Wald in der Ferne
  buildForest() {
    const s = this.s, HB = C.HB, fg = s.fg;
    // Fichte aus drei Kegeln, Schnee auf den oberen Flächen (Farbe je Ecke)
    const parts = [];
    for (const [y0, h, r] of [[0.04, 0.6, 0.34], [0.42, 0.58, 0.22]]) {
      const c = new THREE.ConeGeometry(r, h, 6, 1, true);
      c.translate(0, y0 + h / 2, 0);
      parts.push(c);
    }
    const trunk = new THREE.CylinderGeometry(0.03, 0.04, 0.1, 4, 1, true); trunk.translate(0, 0.05, 0); parts.push(trunk);
    const geo = mergeGeos(parts);
    const col = new Float32Array(geo.attributes.position.count * 3);
    for (let i = 0; i < geo.attributes.position.count; i++) {
      const ny = geo.attributes.normal.getY(i), y = geo.attributes.position.getY(i);
      const snow = C.smoothstep(0.25, 0.75, ny) * 0.42;
      const dark = y < 0.13 ? 0.6 : 1;
      col[i * 3] = (0.07 + 0.78 * snow) * dark; col[i * 3 + 1] = (0.13 + 0.74 * snow) * dark; col[i * 3 + 2] = (0.11 + 0.82 * snow) * dark;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, this.uniforms);
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform vec3 uHole;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          { vec4 ip = instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0); if (distance(ip.xz, uHole.xy) < uHole.z - 10.0) transformed *= 0.0; }`);
    };
    mat.customProgramCacheKey = () => 'heliTree';
    const f = this.farData(), tr = f.trees, n = f.treeCount;
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    const o = new THREE.Object3D(), c3 = new THREE.Color();
    for (let i = 0; i < n; i++) {
      const k = i * 7;
      o.position.set(tr[k], tr[k + 1], tr[k + 2]);
      o.rotation.set(0, tr[k + 3], 0);
      o.scale.set(tr[k + 4], tr[k + 5], tr[k + 4]);
      o.updateMatrix();
      im.setMatrixAt(i, o.matrix);
      im.setColorAt(i, c3.setRGB(tr[k + 6], tr[k + 6], tr[k + 6]));
    }
    im.count = n;
    im.frustumCulled = false;
    im.castShadow = false;
    im.receiveShadow = false;
    this.forest = im;
    this.group.add(im);
  }

  // ------------------------------------------------------------ Tal: Fluss, Dörfer, Ziel
  buildValley() {
    const s = this.s, HB = C.HB, w = this.w;
    // Fluss: Band entlang der Talachse, teils zugefroren und verschneit
    const pos = [], col = [], idx = [];
    let k = 0;
    for (let x = -20500; x <= 20500; x += 20) {
      const d = HB.riverD(x), dd = (HB.riverD(x + 5) - HB.riverD(x - 5)) / 10, l = Math.hypot(1, dd);
      const nxv = -dd / l, ndv = 1 / l, wd = 6.5 + 2.5 * Math.sin(x / 310);
      const y = HB.floorY(x, d) - 1.25;
      const ice = C.smoothstep(0.45, 0.75, C.fbm(x / 140, 3.1));
      for (const sgn of [-1, 1]) {
        pos.push(x + nxv * wd * sgn, y, -(d + ndv * wd * sgn));
        const e = 0.35;
        col.push(0.16 + ice * 0.6 + e * 0.05, 0.24 + ice * 0.6, 0.28 + ice * 0.62);
      }
      if (k > 0) { const a = (k - 1) * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      k++;
    }
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    rg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    rg.setIndex(idx);
    rg.computeVertexNormals();
    const river = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.05, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    river.frustumCulled = false;
    river.receiveShadow = true;
    this.group.add(river);
    // Häuser
    const list = [];
    for (const v of s.villages) for (const h of v.houses) list.push(h);
    for (const name of ['Chalet', 'MountainHut']) {
      const sub = list.filter((h) => (name === 'MountainHut') === h.big);
      if (!sub.length || !w.models[name]) continue;
      const im = new THREE.InstancedMesh(w.models[name], w.propMat, sub.length);
      const o = new THREE.Object3D();
      sub.forEach((h, i) => {
        o.position.set(h.x, HB.heightDU(h.d, h.x) - 0.3, -h.d);
        o.rotation.set(0, h.rot, 0);
        o.scale.setScalar(h.sc);
        o.updateMatrix();
        im.setMatrixAt(i, o.matrix);
      });
      im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
      this.group.add(im);
    }
    // Heustadel auf den Wiesen
    if (s.villages.barns && w.models.MountainHut) {
      const b = s.villages.barns, im = new THREE.InstancedMesh(w.models.MountainHut, w.propMat, b.length), o = new THREE.Object3D();
      b.forEach((h, i) => { o.position.set(h.x, HB.heightCoarse(h.x, h.d) - 0.3, -h.d); o.rotation.set(0, h.rot, 0); o.scale.setScalar(h.sc); o.updateMatrix(); im.setMatrixAt(i, o.matrix); });
      im.castShadow = true; im.receiveShadow = true; im.frustumCulled = false;
      this.group.add(im);
    }
    // Straße im Talboden: geräumt, gräulich, mit Schneewällen
    {
      const pos = [], col = [], idx = [];
      let k = 0;
      for (let x = -20500; x <= 20500; x += 16) {
        const d = HB.roadD(x), dd = (HB.roadD(x + 4) - HB.roadD(x - 4)) / 8, l = Math.hypot(1, dd), nx = -dd / l, nd = 1 / l;
        for (const [o, c] of [[-4.6, 0.93], [-2.8, 0.56], [2.8, 0.56], [4.6, 0.93]]) {
          const px = x + nx * o, pd = d + nd * o;
          pos.push(px, HB.heightCoarse(px, pd) + (Math.abs(o) > 4 ? 0.25 : 0.06), -pd);
          col.push(c * 0.98, c * 0.97, c * (Math.abs(o) > 4 ? 1.02 : 0.95));
        }
        if (k > 0) { const a = (k - 1) * 4; for (let q = 0; q < 3; q++) idx.push(a + q, a + q + 4, a + q + 1, a + q + 1, a + q + 4, a + q + 5); }
        k++;
      }
      const rg = new THREE.BufferGeometry();
      rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      rg.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      rg.setIndex(idx);
      rg.computeVertexNormals();
      const road = new THREE.Mesh(rg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
      road.frustumCulled = false; road.receiveShadow = true;
      this.group.add(road);
    }
    // Zielbogen: dort, wo die Fallinie vom Gipfel den Talboden erreicht
    let fd = s.DV - 1500;
    while (fd < s.DV && HB.heightDU(fd, 0) > HB.floorY(0, fd) + 10) fd += 5;
    this.finishD = fd;
    if (w.models.FinishArch) {
      const arch = new THREE.Mesh(w.models.FinishArch, w.glossMat);
      arch.position.set(0, HB.heightDU(fd + 20, 0) - 0.3, -(fd + 20));
      arch.scale.setScalar(1.6);
      arch.castShadow = true;
      this.group.add(arch);
    }
  }

  // ------------------------------------------------------------ Nahbereich: Kacheln
  buildTile(ti, tj) {
    const HB = C.HB, step = Q.grid, n = Math.round(T / step) + 1, st = T / (n - 1);
    const x0 = ti * T, d0 = tj * T, N = n + 2;
    const H = new Float32Array(N * N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) H[j * N + i] = HB.heightDU(d0 + (j - 1) * st, x0 + (i - 1) * st);
    const cnt = n * n, pos = new Float32Array(cnt * 3), nor = new Float32Array(cnt * 3);
    const aP = new Float32Array(cnt), aU = new Float32Array(cnt), aW = new Float32Array(cnt), aA = new Float32Array(cnt);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, K = (j + 1) * N + i + 1, x = x0 + i * st, d = d0 + j * st;
      const hx = (H[K + 1] - H[K - 1]) / (2 * st), hd = (H[K + N] - H[K - N]) / (2 * st), inv = 1 / Math.sqrt(hx * hx + 1 + hd * hd);
      pos[k * 3] = x; pos[k * 3 + 1] = H[K]; pos[k * 3 + 2] = -d;
      nor[k * 3] = -hx * inv; nor[k * 3 + 1] = inv; nor[k * 3 + 2] = hd * inv;
      const sf = HB.surf(x, d);
      aP[k] = HB.sunAt(x, d);
      aU[k] = x;
      aW[k] = sf.pow;
      const cv = HB.curvAt(x, d);
      aA[k] = C.clamp(1 - cv * 70, 0.72, 1.1) * (1 - 0.42 * sf.forest);   // Waldboden im Schatten der Kronen: passt zur Fernsicht
    }
    const idx = new Uint16Array((n - 1) * (n - 1) * 6);
    let q = 0;
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[q++] = a; idx[q++] = b; idx[q++] = c; idx[q++] = b; idx[q++] = d; idx[q++] = c;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aPiste', new THREE.BufferAttribute(aP, 1));
    g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
    g.setAttribute('aPow', new THREE.BufferAttribute(aW, 1));
    g.setAttribute('aAO', new THREE.BufferAttribute(aA, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.tileMat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    const grp = new THREE.Group();
    grp.add(m);
    const cols = [];
    const add = (...a) => { cols.push(C.addCollider(...a)); };
    const data = HB.genTile(ti, tj, T, Q.trees, add, (x, z, y, sc, rot, v) => C.addRockCollider(add, x, z, y, sc, rot, v));
    this.w.addInstances(data.trees, data.rocks, [], grp, 0, data.decor);
    if (data.walls.length) this.w.buildWalls(data.walls, grp);
    this.group.add(grp);
    return { ti, tj, grp, cols };
  }

  disposeTile(t) {
    t.grp.traverse((o) => { if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose(); if (o.isInstancedMesh) o.dispose(); });
    this.group.remove(t.grp);
    C.removeColliders(t.cols);
  }

  /** Kacheln um (px, pz) laden und entfernen. all: alles sofort (Start, Respawn). */
  updateTiles(px, pz, all = false) {
    const R = this.radius, d = -pz;
    const i0 = Math.floor((px - R) / T), i1 = Math.floor((px + R) / T), j0 = Math.floor((d - R) / T), j1 = Math.floor((d + R) / T);
    const need = [];
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const cx = Math.max(i * T, Math.min(px, (i + 1) * T)), cd = Math.max(j * T, Math.min(d, (j + 1) * T));
      if (Math.hypot(cx - px, cd - d) < R + 10) need.push([i, j, Math.hypot((i + 0.5) * T - px, (j + 0.5) * T - d)]);
    }
    const keep = new Set(need.map(([i, j]) => i + ',' + j));
    for (const [key, t] of this.tiles) if (!keep.has(key) && Math.hypot((t.ti + 0.5) * T - px, (t.tj + 0.5) * T - d) > R + 120) { this.disposeTile(t); this.tiles.delete(key); }
    need.sort((a, b) => a[2] - b[2]);
    const t0 = performance.now();
    for (const [i, j] of need) {
      const key = i + ',' + j;
      if (this.tiles.has(key)) continue;
      this.tiles.set(key, this.buildTile(i, j));
      if (!all && performance.now() - t0 > Q.budget) break;
    }
    // Aussparung der Fernsicht: größter Kreis um den Fahrer, der vollständig geladen ist
    let r = R;
    for (const [i, j] of need) if (!this.tiles.has(i + ',' + j)) {
      const cx = Math.max(i * T, Math.min(px, (i + 1) * T)), cd = Math.max(j * T, Math.min(d, (j + 1) * T));
      r = Math.min(r, Math.hypot(cx - px, cd - d) - 2);
    }
    this.hole.set(px, pz, Math.max(0, r));
    snowUniforms.uClip.value.set(px, pz, Math.max(0, r) + 1);
  }

  update(playerPos) { this.updateTiles(playerPos.x, playerPos.z); }
}

function mergeGeos(list) {
  let nv = 0, ni = 0;
  for (const g of list) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint16Array(ni);
  let vo = 0, io = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3);
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    else for (let i = 0; i < g.attributes.position.count; i++) idx[io++] = i + vo;
    vo += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
