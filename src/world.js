// Welt: Gelände-Mesh, Wald, Felsen, Tore, Lift, Hütten, Himmel, Berge, Licht.
// Rennen: alles wird einmal gebaut. Endlos-Berg: 100-m-Stücke werden vor dem Fahrer erzeugt und hinter ihm entfernt.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as C from './course.js';
import { makeSnowMaterial, snowUniforms } from './snow.js';
import { Q } from './quality.js';

export async function loadModels() {
  const gltf = await new GLTFLoader().loadAsync('models/models.glb');
  const m = {};
  gltf.scene.traverse((o) => {
    if (o.isMesh) { o.geometry.userData.shared = true; m[o.name] = o.geometry; }
  });
  // gespiegelter Wegweiser (Pfeil nach links): Geometrie und Dreiecksreihenfolge spiegeln
  if (m.SignArrow) {
    const g = m.SignArrow.clone();
    g.scale(-1, 1, 1);
    const idx = g.index;
    if (idx) for (let i = 0; i < idx.count; i += 3) { const t = idx.getX(i + 1); idx.setX(i + 1, idx.getX(i + 2)); idx.setX(i + 2, t); }
    g.userData.shared = true;
    m.SignArrowL = g;
  }
  return m;
}

export const SUN_DIR = new THREE.Vector3(-0.52, 0.56, -0.64).normalize(); // Richtung ZUR Sonne
const HAZE = new THREE.Color().setRGB(0.62, 0.77, 0.95);
const TREE_NAMES = ['TreeA', 'TreeB', 'TreeC'];
const ROCK_NAMES = ['RockA', 'RockB', 'RockC', 'RockD', 'RockE', 'RockF'];

export class World {
  constructor(scene, models) {
    this.scene = scene;
    this.models = models;
    this.propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    this.glossMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 });
    this.snowMat = makeSnowMaterial();
    this._o = new THREE.Object3D();
    this._col = new THREE.Color();
    this._shear = new THREE.Matrix4();
    this.course = null;
    this.chunks = new Map();
    this.cables = [];
    this.grp = scene;
    this.buildLights();
    this.buildSky();
    this.buildMountains();
    const geo = new THREE.ConeGeometry(0.7, 1.3, 4);
    geo.rotateX(Math.PI);
    this.arrow = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(3.2, 2.2, 0.25), fog: false }));
    this.arrow.visible = false;
    scene.add(this.arrow);
    this.buildColumns();
  }

  /** Baut die Strecke für den aktuellen Modus neu (C.setMode muss vorher aufgerufen sein). */
  setMode() {
    if (this.course) {
      this.course.traverse((o) => {
        if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
        if (o.isInstancedMesh) o.dispose();
      });
      this.scene.remove(this.course);
    }
    this.chunks.clear();
    this.cables = [];
    this.chairs = null;
    this.course = new THREE.Group();
    this.scene.add(this.course);
    this.grp = this.course;
    if (C.cfg.endless) {
      this.scene.fog.near = 140;
      this.scene.fog.far = Q.view - 30;
      this.job = null;
      this.buildColumnsE(Q.grid);
      this.buildStart();
      this.updateChunks(0, true);
    } else {
      this.scene.fog.near = 220;
      this.scene.fog.far = 2300;
      this.mountains.position.set(0, 0, 0);
      this.buildTerrainRace();
      this.addInstances(C.trees, C.rocks, C.markers, this.grp, 90);
      this.buildStart();
      this.buildProps();
      this.buildLift();
      this.buildGates();
    }
    this.grp = this.scene;
  }

  // ------------------------------------------------------------ Licht
  buildLights() {
    const s = this.scene;
    s.fog = new THREE.Fog(HAZE, 220, 2300);
    this.hemi = new THREE.HemisphereLight(new THREE.Color().setRGB(0.5, 0.68, 1.0), new THREE.Color().setRGB(0.72, 0.8, 1.0), 1.05);
    s.add(this.hemi);
    const sun = new THREE.DirectionalLight(new THREE.Color().setRGB(1.0, 0.94, 0.84), 2.7);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const S = 95;
    this.shadowSize = S;
    Object.assign(sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S, near: 10, far: 700 });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.06;
    sun.shadow.radius = 2.5;
    s.add(sun, sun.target);
    this.sun = sun;
    snowUniforms.uSunDir.value.copy(SUN_DIR);
    this._lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
    this._ly = new THREE.Vector3().crossVectors(SUN_DIR, this._lx).normalize();
  }

  setLowQuality(low) {
    const m = this.snowMat;
    if (!!m.defines.LOWQ === low) return;
    if (low) m.defines.LOWQ = 1; else delete m.defines.LOWQ;
    m.needsUpdate = true;
  }

  setShadowSize(n) {
    const sh = this.sun.shadow;
    if (sh.mapSize.x === n) return;
    sh.mapSize.set(n, n);
    if (sh.map) { sh.map.dispose(); sh.map = null; }
  }

  updateSun(p) {
    const texel = (2 * this.shadowSize) / this.sun.shadow.mapSize.x;
    const lx = this._lx, ly = this._ly;
    const a = Math.round(p.dot(lx) / texel) * texel, b = Math.round(p.dot(ly) / texel) * texel, c = p.dot(SUN_DIR);
    const t = this.sun.target.position;
    t.set(0, 0, 0).addScaledVector(lx, a).addScaledVector(ly, b).addScaledVector(SUN_DIR, c);
    this.sun.position.copy(t).addScaledVector(SUN_DIR, 350);
    this.sun.target.updateMatrixWorld();
  }

  // ------------------------------------------------------------ Himmel
  buildSky() {
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSun: { value: SUN_DIR }, uTime: { value: 0 } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec3 vDir; uniform vec3 uSun; uniform float uTime;
        float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
        float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h12(i),h12(i+vec2(1,0)),f.x), mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),f.x), f.y); }
        float fbm(vec2 p){ float a=0.5, s=0.; for(int i=0;i<5;i++){ s+=a*n2(p); p=p*2.03+7.1; a*=0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 zen = vec3(0.07, 0.24, 0.66), mid = vec3(0.26, 0.52, 0.92), hor = vec3(0.62, 0.77, 0.95);
          float t = clamp(h, 0., 1.);
          vec3 col = mix(hor, mid, smoothstep(0.0, 0.28, t));
          col = mix(col, zen, smoothstep(0.2, 0.95, t));
          float s = max(dot(d, uSun), 0.);
          col += vec3(1.0, 0.86, 0.62) * (pow(s, 1400.) * 40. + pow(s, 90.) * 0.55 + pow(s, 9.) * 0.16);
          vec2 cuv = d.xz / (abs(d.y) + 0.22);
          float c = fbm(cuv * 1.3 + vec2(uTime*0.004, 0.));
          float cl = smoothstep(0.6, 0.86, c) * smoothstep(0.03, 0.25, h) * 0.6;
          vec3 ccol = mix(vec3(0.82, 0.88, 0.97), vec3(1.25, 1.18, 1.08), smoothstep(0.55, 0.9, c) * (0.4 + 0.6*pow(s, 3.)));
          col = mix(col, ccol, cl);
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, fog: false,
    });
    this.sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), mat);
    this.sky.frustumCulled = false;
    this.sky.renderOrder = -10;
    this.scene.add(this.sky);
  }

  // ------------------------------------------------------------ Gelände
  buildColumns() {
    const half = [0];
    let u = 0, step = 1.25;
    while (u < C.EDGE_U) {
      if (u > 32) step = Math.min(step * 1.16, 14);
      u = Math.min(C.EDGE_U, u + step);
      half.push(u);
    }
    this.us = [...half.slice(1).reverse().map((v) => -v), ...half];
    this._nrm = new THREE.Vector3();
  }

  makeStrip(ds) {
    const us = this.us, cols = us.length, rows = ds.length, nrm = this._nrm;
    const pos = new Float32Array(rows * cols * 3), nor = new Float32Array(rows * cols * 3);
    const aP = new Float32Array(rows * cols), aU = new Float32Array(rows * cols), aW = new Float32Array(rows * cols), aA = new Float32Array(rows * cols).fill(1);
    let k = 0;
    for (let r = 0; r < rows; r++) {
      const d = ds[r], cx = C.centerX(d), w = C.halfWidth(d);
      for (let c = 0; c < cols; c++, k++) {
        const x = cx + us[c], z = -d;
        pos[k * 3] = x; pos[k * 3 + 1] = C.height(x, z); pos[k * 3 + 2] = z;
        C.terrainNormal(x, z, nrm);
        nor[k * 3] = nrm.x; nor[k * 3 + 1] = nrm.y; nor[k * 3 + 2] = nrm.z;
        aP[k] = 1 - C.smoothstep(-1.5, 2.5, Math.abs(us[c]) - w);
        aU[k] = us[c];
      }
    }
    const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
    let i = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c, b = a + 1, c2 = a + cols, d2 = c2 + 1;
        idx[i++] = a; idx[i++] = b; idx[i++] = c2; idx[i++] = b; idx[i++] = d2; idx[i++] = c2;
      }
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
    const m = new THREE.Mesh(g, this.snowMat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    return m;
  }

  buildTerrainRace() {
    const dStep = 1.5, segRows = 60;
    const total = Math.round((C.MESH_D1 - C.MESH_D0) / dStep);
    for (let r0 = 0; r0 < total; r0 += segRows) {
      const ds = [];
      for (let r = r0; r <= Math.min(total, r0 + segRows); r++) ds.push(C.MESH_D0 + r * dStep);
      this.grp.add(this.makeStrip(ds));
    }
    this.grp.add(this.makeStrip([C.MESH_D1, 2800, 2860, 2960, 3100, 3300, 3650]));
    this.grp.add(this.makeStrip([-380, -260, -170, -110, -80, C.MESH_D0]));
  }

  // ------------------------------------------------------------ Endlos: Stücke nachladen
  /** Spalten relativ zur Mittellinie: dicht im Kern (dort liegen die Spuren), außen gröber. */
  buildColumnsE(step) {
    const half = [0];
    let u = 0, st = step;
    while (u < 275) {
      if (u > 125) st = Math.min(st * 1.2, 16);
      u = Math.min(275, u + st);
      half.push(u);
    }
    this.usE = Float32Array.from([...half.slice(1).reverse().map((v) => -v), ...half]);
    this.rowsE = Math.round(C.CHUNK / step);
  }

  startJob(i) {
    const cols = this.usE.length, rows = this.rowsE, n = (rows + 3) * cols;
    return {
      i, r: 0, n: rows + 3, H: new Float32Array(n), aP: new Float32Array(n), aU: new Float32Array(n), aW: new Float32Array(n), aF: new Float32Array(n),
      X: new Float32Array(n),
    };
  }

  /** Rechnet Höhen zeilenweise, bis das Zeitbudget (ms) verbraucht ist. Gibt true zurück, wenn fertig. */
  stepJob(job, budget) {
    const us = this.usE, cols = us.length, dstep = C.CHUNK / this.rowsE;
    const t0 = performance.now();
    while (job.r < job.n) {
      const d = job.i * C.CHUNK + (job.r - 1) * dstep;
      const hub = C.centerX(d);
      let k = job.r * cols;
      for (let c = 0; c < cols; c++, k++) {
        const x = hub + us[c];
        job.X[k] = x;
        job.H[k] = C.height(x, -d);
        const sf = C.surfaceAt(x, -d);
        job.aP[k] = sf.groom;
        job.aU[k] = sf.u;
        job.aW[k] = sf.pow;
        job.aF[k] = sf.forest;
      }
      job.r++;
      if (performance.now() - t0 > budget) return job.r >= job.n;
    }
    return true;
  }

  finishJob(job) {
    const us = this.usE, cols = us.length, rows = this.rowsE, dstep = C.CHUNK / rows;
    const n = (rows + 1) * cols;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    const aP = new Float32Array(n), aU = new Float32Array(n), aW = new Float32Array(n), aA = new Float32Array(n);
    let k = 0;
    for (let r = 0; r <= rows; r++) {
      const jr = (r + 1) * cols, d = job.i * C.CHUNK + r * dstep;
      for (let c = 0; c < cols; c++, k++) {
        const j = jr + c;
        const c0 = Math.max(0, c - 1), c1 = Math.min(cols - 1, c + 1);
        const dx = job.X[jr + c1] - job.X[jr + c0];
        const hx = (job.H[jr + c1] - job.H[jr + c0]) / dx;
        const hd = (job.H[j + cols] - job.H[j - cols]) / (2 * dstep);
        const inv = 1 / Math.sqrt(hx * hx + 1 + hd * hd);
        pos[k * 3] = job.X[j]; pos[k * 3 + 1] = job.H[j]; pos[k * 3 + 2] = -d;
        nor[k * 3] = -hx * inv; nor[k * 3 + 1] = inv; nor[k * 3 + 2] = hd * inv;
        aP[k] = job.aP[j]; aU[k] = job.aU[j]; aW[k] = job.aW[j];
        // Geländeform als Schattierung (Hohlraum dunkler, Kuppe heller) + Waldboden: macht Features auch ohne Schatten lesbar
        const du = Math.max(0.5, Math.abs(us[c1] - us[c0]) / 2);
        const lx = (job.H[jr + c1] + job.H[jr + c0] - 2 * job.H[j]) / (du * du * (c1 === c0 ? 1 : 1));
        const lz = (job.H[j + cols] + job.H[j - cols] - 2 * job.H[j]) / (dstep * dstep);
        const cav = C.clamp(1 - 5.5 * (lx * (du > 3 ? 0.35 : 1) + lz), 0.58, 1.14);
        aA[k] = cav * (1 - 0.2 * job.aF[j]);
      }
    }
    if (!this.idxE || this.idxE.length !== rows * (cols - 1) * 6) {
      const idx = new Uint32Array(rows * (cols - 1) * 6);
      let i = 0;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols - 1; c++) {
          const a = r * cols + c, b = a + 1, c2 = a + cols, d2 = c2 + 1;
          idx[i++] = a; idx[i++] = b; idx[i++] = c2; idx[i++] = b; idx[i++] = d2; idx[i++] = c2;
        }
      }
      this.idxE = idx;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('aPiste', new THREE.BufferAttribute(aP, 1));
    g.setAttribute('aU', new THREE.BufferAttribute(aU, 1));
    g.setAttribute('aPow', new THREE.BufferAttribute(aW, 1));
    g.setAttribute('aAO', new THREE.BufferAttribute(aA, 1));
    g.setIndex(new THREE.BufferAttribute(this.idxE, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, this.snowMat);
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    const grp = new THREE.Group();
    grp.add(m);
    const data = C.genChunk(job.i);
    this.addInstances(data.trees, data.rocks, data.markers, grp, 0, data.decor);
    this.course.add(grp);
    this.chunks.set(job.i, grp);
  }

  updateChunks(d, all = false) {
    const i0 = Math.floor((d - 170) / C.CHUNK), i1 = Math.floor((d + Q.view + 40) / C.CHUNK);
    for (const [i, g] of this.chunks) {
      if (i < i0 || i > i1) {
        g.traverse((o) => {
          if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
          if (o.isInstancedMesh) o.dispose();
        });
        this.course.remove(g);
        this.chunks.delete(i);
        C.dropChunk(i);
      }
    }
    if (this.job && (this.job.i < i0 || this.job.i > i1)) this.job = null;
    const here = Math.floor(d / C.CHUNK);
    for (;;) {
      if (!this.job) {
        let next = null;
        for (let i = Math.max(-1, i0); i <= i1; i++) if (!this.chunks.has(i)) { if (next === null || Math.abs(i - here) < Math.abs(next - here)) next = i; }
        if (next === null) return;
        this.job = this.startJob(next);
      }
      // Stücke direkt beim Fahrer müssen sofort da sein (z. B. nach einem Sprung oder Respawn)
      const urgent = all || Math.abs(this.job.i - here) <= 1;
      if (!this.stepJob(this.job, urgent ? 1e9 : Q.budget)) return;
      this.finishJob(this.job);
      this.job = null;
      if (!urgent) return;
    }
  }

  // ------------------------------------------------------------ Respawn-Fahne
  setFlag(p) {
    if (!this.flag) {
      const g = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 2.6, 8), new THREE.MeshStandardMaterial({ color: 0x23262d, roughness: 0.6 }));
      pole.position.y = 1.3;
      const shape = new THREE.Shape();
      shape.moveTo(0, 0); shape.lineTo(0.95, -0.28); shape.lineTo(0, -0.56); shape.closePath();
      const cloth = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.1, 1.6, 0.5), side: THREE.DoubleSide, fog: false }));
      cloth.position.set(0.03, 2.58, 0);
      const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.05, 32), new THREE.MeshBasicMaterial({ color: new THREE.Color().setRGB(0.1, 1.6, 0.5), side: THREE.DoubleSide, transparent: true, opacity: 0.8 }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.y = 0.12;
      pole.castShadow = true;
      g.add(pole, cloth, ring);
      this.flag = g;
      this.flagCloth = cloth;
      this.scene.add(g);
    }
    this.flag.visible = !!p;
    if (p) this.flag.position.set(p.x + 1.4, C.height(p.x + 1.4, p.z), p.z);
  }

  // ------------------------------------------------------------ Wald, Felsen, Stangen
  addInstances(trees, rocks, markers, parent, segLen, decor = []) {
    const o = this._o, col = this._col;
    const groups = new Map();
    for (const t of trees) {
      const key = (segLen ? Math.floor((-t.z - C.MESH_D0) / segLen) : 0) + '_' + t.variant;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    for (const [key, list] of groups) {
      const variant = +key.split('_')[1];
      const im = new THREE.InstancedMesh(this.models[TREE_NAMES[variant]], this.propMat, list.length);
      list.forEach((t, i) => {
        o.position.set(t.x, t.y, t.z);
        o.rotation.set(0, t.rot, 0);
        o.scale.set(t.scale, t.scale * (0.92 + (t.tint - 0.82) * 0.45), t.scale);
        o.updateMatrix();
        im.setMatrixAt(i, o.matrix);
        im.setColorAt(i, col.setRGB(t.tint * 0.98, t.tint, t.tint * 1.02));
      });
      im.computeBoundingSphere();
      im.castShadow = true;
      im.receiveShadow = true;
      parent.add(im);
    }
    for (let v = 0; v < ROCK_NAMES.length; v++) {
      const list = rocks.filter((r) => r.variant === v);
      if (!list.length) continue;
      const im = new THREE.InstancedMesh(this.models[ROCK_NAMES[v]], this.propMat, list.length);
      list.forEach((t, i) => {
        o.position.set(t.x, t.y, t.z);
        o.rotation.set(0, t.rot, 0);
        o.scale.setScalar(t.scale);
        o.updateMatrix();
        im.setMatrixAt(i, o.matrix);
      });
      im.frustumCulled = false;
      im.castShadow = true;
      im.receiveShadow = true;
      parent.add(im);
    }
    if (decor.length) {
      const byName = new Map();
      for (const d of decor) { if (!this.models[d.m]) continue; if (!byName.has(d.m)) byName.set(d.m, []); byName.get(d.m).push(d); }
      for (const [name, list] of byName) {
        const im = new THREE.InstancedMesh(this.models[name], this.propMat, list.length);
        list.forEach((t, i) => {
          o.position.set(t.x, t.y, t.z);
          o.rotation.set(0, t.rot, 0);
          o.scale.set(t.scale * (t.sx || 1), t.scale * (t.sy || 1), t.scale);
          o.updateMatrix();
          if (t.sl) o.matrix.multiply(this._shear.set(1, 0, 0, 0, t.sl, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1));
          im.setMatrixAt(i, o.matrix);
          if (name === 'SnowFence') { const b = 0.78 + 0.4 * Math.abs(Math.sin(t.x * 12.9898 + t.z * 78.233)); im.setColorAt(i, col.setRGB(b, b * 0.97, b * 0.95)); } else im.setColorAt(i, t.col ? col.setRGB(t.col[0], t.col[1], t.col[2]) : col.setRGB(1, 1, 1));
        });
        im.computeBoundingSphere();
        im.castShadow = name !== 'Bush' && name !== 'IceCluster';
        im.receiveShadow = true;
        parent.add(im);
      }
    }
    if (markers.length) {
      const im = new THREE.InstancedMesh(this.models.PisteMarker, this.propMat, markers.length);
      markers.forEach((t, i) => {
        o.position.set(t.x, t.y, t.z);
        o.rotation.set(0, 0, 0);
        o.scale.setScalar(t.big ? 2.3 : t.kicker || t.cliff ? 1.5 : 1);
        o.updateMatrix();
        im.setMatrixAt(i, o.matrix);
        im.setColorAt(i, t.col ? col.setRGB(t.col[0], t.col[1], t.col[2]) : t.big ? col.setRGB(2.6, 1.6, 0.2) : t.kicker ? col.setRGB(0.25, 0.6, 2.2) : t.cliff ? col.setRGB(2.4, 0.25, 0.3) : col.setRGB(1, 1, 1));
      });
      im.frustumCulled = false;
      im.castShadow = true;
      parent.add(im);
    }
  }

  // ------------------------------------------------------------ Gebäude, Start, Ziel
  mesh(name, mat = this.propMat) {
    const m = new THREE.Mesh(this.models[name], mat);
    m.castShadow = true;
    m.receiveShadow = true;
    this.grp.add(m);
    return m;
  }

  bannerTexture(text, bg, fg) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 192;
    const g = c.getContext('2d');
    g.fillStyle = bg; g.fillRect(0, 0, 1024, 192);
    g.fillStyle = fg;
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2 === 0) { g.fillRect(i * 16, j * 16 + 160, 16, 16); g.fillRect(768 + i * 16, j * 16, 16, 16); g.fillRect(i * 16, j * 16, 16, 16); g.fillRect(768 + i * 16, j * 16 + 160, 16, 16); }
    g.font = 'italic 900 132px "Avenir Next Condensed", "Arial Narrow", Arial, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(text, 512, 104);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }

  buildStart() {
    const hut = this.mesh('StartHut');
    hut.position.set(-6.2, C.height(-6.2, 4) - 0.2, 4);
    hut.rotation.y = -0.55;
    const sy = C.height(0, -1.2);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xff6a13, roughness: 0.5 });
    for (const sx of [-2.5, 2.5]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.6, 10), postMat);
      post.position.set(sx, sy + 1.6, -1.2);
      post.castShadow = true;
      this.grp.add(post);
    }
    if (!this.startTex) this.startTex = this.bannerTexture('START', '#ff6a13', '#ffffff');
    const sb = new THREE.Mesh(new THREE.PlaneGeometry(5.0, 0.94), new THREE.MeshStandardMaterial({ map: this.startTex, roughness: 0.7, side: THREE.DoubleSide }));
    sb.position.set(0, sy + 2.9, -1.2);
    sb.castShadow = true;
    this.grp.add(sb);
  }

  buildProps() {
    for (const c of C.chalets) {
      const m = this.mesh('Chalet');
      m.position.set(c.x, c.y + 0.4, c.z);
      m.rotation.y = c.rot;
    }
    // Ziel
    const fd = C.FINISH_D, fx = C.centerX(fd), fz = -fd;
    const arch = this.mesh('FinishArch', this.glossMat);
    arch.position.set(fx, C.height(fx, fz) - 0.3, fz);
    if (!this.finTex) this.finTex = this.bannerTexture('ZIEL', '#ffffff', '#14171d');
    const zb = new THREE.Mesh(new THREE.PlaneGeometry(9.6, 1.8), new THREE.MeshStandardMaterial({ map: this.finTex, roughness: 0.7, side: THREE.DoubleSide }));
    zb.position.set(fx, C.height(fx, fz) + 5.2, fz);
    zb.castShadow = true;
    this.grp.add(zb);

    // Ziellinie (Schachbrett) auf dem Schnee
    const n = 40, wl = 8.2;
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= n; i++) {
      const x = fx - wl + (2 * wl * i) / n;
      for (const dz of [0.7, -0.7]) {
        pos.push(x, C.height(x, fz + dz) + 0.06, fz + dz);
        uv.push((i / n) * 12, dz > 0 ? 0 : 1);
      }
      if (i < n) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    lg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    lg.setIndex(idx);
    lg.computeVertexNormals();
    const cc = document.createElement('canvas');
    cc.width = 64; cc.height = 64;
    const cg = cc.getContext('2d');
    cg.fillStyle = '#f4f6fa'; cg.fillRect(0, 0, 64, 64);
    cg.fillStyle = '#d6202a'; cg.fillRect(0, 0, 32, 32); cg.fillRect(32, 32, 32, 32);
    const ct = new THREE.CanvasTexture(cc);
    ct.wrapS = ct.wrapT = THREE.RepeatWrapping;
    ct.magFilter = THREE.NearestFilter;
    ct.colorSpace = THREE.SRGBColorSpace;
    const line = new THREE.Mesh(lg, new THREE.MeshStandardMaterial({ map: ct, roughness: 0.9, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    line.receiveShadow = true;
    this.grp.add(line);

    // Fangnetze, die zum Zielbogen führen
    const nc = document.createElement('canvas');
    nc.width = 64; nc.height = 64;
    const ng = nc.getContext('2d');
    ng.strokeStyle = '#ff5a10'; ng.lineWidth = 5;
    ng.beginPath(); ng.moveTo(0, 0); ng.lineTo(64, 64); ng.moveTo(64, 0); ng.lineTo(0, 64); ng.stroke();
    ng.fillStyle = '#ff5a10'; ng.fillRect(0, 0, 64, 6); ng.fillRect(0, 58, 64, 6);
    const nt = new THREE.CanvasTexture(nc);
    nt.wrapS = THREE.RepeatWrapping; nt.colorSpace = THREE.SRGBColorSpace; nt.anisotropy = 8;
    const netMat = new THREE.MeshStandardMaterial({ map: nt, transparent: true, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.8 });
    const postList = [];
    for (const s of [-1, 1]) {
      const p = [], u2 = [], ix = [];
      const m = 26;
      for (let i = 0; i <= m; i++) {
        const t = i / m;
        const d = C.lerp(fd - 70, fd, t);
        const x = C.centerX(d) + s * C.lerp(C.halfWidth(d) - 1, 9.6, t * t);
        const y = C.height(x, -d);
        p.push(x, y - 0.1, -d, x, y + 1.35, -d);
        u2.push(t * 60, 0, t * 60, 1);
        if (i < m) { const a = i * 2; ix.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
        if (i % 2 === 0) postList.push([x, y, -d]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(u2, 2));
      g.setIndex(ix);
      g.computeVertexNormals();
      const net = new THREE.Mesh(g, netMat);
      net.castShadow = true;
      this.grp.add(net);
    }
    const posts = new THREE.InstancedMesh(this.models.FencePost, this.propMat, postList.length);
    const o = this._o;
    o.rotation.set(0, 0, 0);
    o.scale.setScalar(1);
    postList.forEach((q, i) => { o.position.set(q[0], q[1], q[2]); o.updateMatrix(); posts.setMatrixAt(i, o.matrix); });
    posts.frustumCulled = false;
    posts.castShadow = true;
    this.grp.add(posts);
  }

  // ------------------------------------------------------------ Sessellift
  buildLift() {
    const L = C.lift;
    const dir = new THREE.Vector3(L.a.x - L.b.x, 0, -(L.a.d - L.b.d)).normalize();
    const yaw = Math.atan2(dir.x, dir.z);
    const perp = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    this.liftYaw = yaw;
    for (const p of L.pylons) {
      const m = this.mesh('LiftPylon');
      m.position.set(p.x, p.y, p.z);
      m.rotation.y = yaw;
    }
    const cableMat = new THREE.LineBasicMaterial({ color: 0x1a1d22 });
    for (const s of [-1, 1]) {
      const pts = [];
      for (let i = 0; i < L.pylons.length; i++) {
        const a = L.pylons[i];
        const A = new THREE.Vector3(a.x, a.y + 10.45, a.z).addScaledVector(perp, s * 2.6);
        if (i === L.pylons.length - 1) { pts.push(A); break; }
        const b = L.pylons[i + 1];
        const B = new THREE.Vector3(b.x, b.y + 10.45, b.z).addScaledVector(perp, s * 2.6);
        const span = A.distanceTo(B);
        for (let k = 0; k < 10; k++) {
          const t = k / 10;
          const q = A.clone().lerp(B, t);
          q.y -= span * 0.018 * 4 * t * (1 - t);
          pts.push(q);
        }
      }
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + pts[i].distanceTo(pts[i - 1]));
      this.cables.push({ pts, cum, total: cum[cum.length - 1], s });
      this.grp.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), cableMat));
    }
    this.chairsPer = Math.floor(this.cables[0].total / 26);
    this.chairSpacing = this.cables[0].total / this.chairsPer;
    this.chairs = new THREE.InstancedMesh(this.models.LiftChair, this.propMat, this.chairsPer * 2);
    this.chairs.frustumCulled = false;
    this.chairs.castShadow = true;
    this.grp.add(this.chairs);
  }

  updateLift(time) {
    if (!this.chairs) return;
    const o = this._o;
    o.scale.setScalar(1);
    let n = 0;
    for (const cab of this.cables) {
      const dirSign = cab.s > 0 ? 1 : -1;
      for (let i = 0; i < this.chairsPer; i++, n++) {
        let dist = (i * this.chairSpacing + dirSign * time * 2.6) % cab.total;
        if (dist < 0) dist += cab.total;
        let lo = 0, hi = cab.cum.length - 1;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cab.cum[mid] <= dist) lo = mid; else hi = mid; }
        const t = (dist - cab.cum[lo]) / (cab.cum[hi] - cab.cum[lo] || 1);
        o.position.copy(cab.pts[lo]).lerp(cab.pts[hi], t);
        o.rotation.set(Math.sin(time * 0.9 + i) * 0.03, this.liftYaw + (dirSign > 0 ? 0 : Math.PI), 0);
        o.updateMatrix();
        this.chairs.setMatrixAt(n, o.matrix);
      }
    }
    this.chairs.instanceMatrix.needsUpdate = true;
  }

  // ------------------------------------------------------------ Tore
  buildGates() {
    for (const g of C.gates) {
      g.flags = [];
      for (const s of [-1, 1]) {
        const m = this.mesh(g.color === 'red' ? 'GateRed' : 'GateBlue', this.glossMat);
        const x = g.x + s * g.half;
        m.position.set(x, C.height(x, g.z), g.z);
        m.scale.setScalar(1.35);
        m.userData = { knock: 0, vel: 0, x, z: g.z };
        g.flags.push(m);
      }
    }
  }

  resetGates() {
    for (const g of C.gates) {
      g.state = 0;
      for (const f of g.flags) { f.userData.knock = 0; f.userData.vel = 0; f.rotation.x = 0; }
    }
  }

  updateGates(dt, time, nextGate) {
    for (const g of C.gates) {
      for (const f of g.flags) {
        const u = f.userData;
        if (u.knock !== 0 || u.vel !== 0) {
          u.vel += (-u.knock * 60 - u.vel * 5) * dt;
          u.knock += u.vel * dt;
          if (Math.abs(u.knock) < 0.002 && Math.abs(u.vel) < 0.02) { u.knock = 0; u.vel = 0; }
          f.rotation.x = -Math.max(-0.3, Math.min(1.45, u.knock));
        }
      }
    }
    if (nextGate) {
      this.arrow.visible = true;
      this.arrow.position.set(nextGate.x, C.height(nextGate.x, nextGate.z) + 4.3 + Math.sin(time * 4) * 0.3, nextGate.z);
      this.arrow.rotation.y = time * 2;
    } else this.arrow.visible = false;
  }

  // ------------------------------------------------------------ Berge im Hintergrund
  buildMountains() {
    this.mountains = new THREE.Group();
    this.scene.add(this.mountains);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    const light = SUN_DIR;
    const peak = (x, z, baseY, R, H, seed, haze) => {
      const g = new THREE.PlaneGeometry(2 * R, 2 * R, 90, 90);
      g.rotateX(-Math.PI / 2);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        const px = p.getX(i), pz = p.getZ(i);
        const r = Math.hypot(px, pz) / R;
        const base = Math.pow(Math.max(0, 1 - r), 1.2);
        const ridge = 1 - Math.abs(2 * C.vnoise((px / R) * 2.6 + seed, (pz / R) * 2.6 + seed * 1.7) - 1);
        const n = C.fbm((px / R) * 6 + seed * 3, (pz / R) * 6);
        const er = 1 - Math.abs(2 * C.vnoise((px / R) * 17 + seed * 2.3, (pz / R) * 17 + seed) - 1);   // feine Grate und Rinnen gegen glatte Riesenflächen
        p.setY(i, H * base * (0.45 + 0.5 * ridge + 0.35 * n + 0.07 * er * Math.min(1, base * 3)));
      }
      g.computeVertexNormals();
      const nrm = g.attributes.normal;
      const col = new Float32Array(p.count * 3);
      const c = new THREE.Color(), tmp = new THREE.Color();
      const snow = new THREE.Color().setRGB(0.95, 0.97, 1.0), snowSh = new THREE.Color().setRGB(0.5, 0.62, 0.86);
      const rock = new THREE.Color().setRGB(0.3, 0.33, 0.4), wood = new THREE.Color().setRGB(0.09, 0.17, 0.16);
      for (let i = 0; i < p.count; i++) {
        const y = p.getY(i) / H, ny = nrm.getY(i);
        const lit = Math.max(0, nrm.getX(i) * light.x + ny * light.y + nrm.getZ(i) * light.z);
        const px = p.getX(i), pz = p.getZ(i);
        const nz = C.vnoise(px / 60 + seed, pz / 60);
        const n2 = C.fbm(px / 140 + seed * 1.3, pz / 140 + y * 5);
        const n3 = C.vnoise(px / 22 + seed, pz / 22);
        if (y < 0.16 + nz * 0.1) c.copy(wood).multiplyScalar(0.6 + lit * 0.9);
        else if (ny < 0.58 + nz * 0.12) {
          // Fels: Schichtung, wechselnde Grautöne, Schnee in Rinnen und auf Bändern statt einer grauen Fläche
          const strata = 0.5 + 0.5 * Math.sin(y * 85 + n2 * 9 + n3 * 2);
          c.setRGB(0.27 + 0.1 * n2, 0.285 + 0.08 * n2, 0.33 + 0.05 * n2);
          c.multiplyScalar((0.62 + 0.34 * strata) * (0.55 + lit * 1.05) * (0.85 + 0.3 * n3));
          const dust = Math.min(1, Math.max(0, (ny - 0.2 + (n2 - 0.5) * 0.6 + (strata > 0.8 ? 0.18 : 0)) * 2.4));
          c.lerp(tmp.copy(snowSh).lerp(snow, Math.min(1, lit * 1.4)), dust * 0.8);
        }
        else c.copy(snowSh).lerp(snow, Math.min(1, lit * 1.5));
        c.lerp(HAZE, haze);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const m = new THREE.Mesh(g, mat);
      m.position.set(x, baseY, z);
      m.frustumCulled = false;
      this.mountains.add(m);
    };
    const R = C.mulberry32(99);
    const defs = [
      [-1500, 600, 1300, 2100], [1700, 300, 1500, 2400], [0, 1700, 1700, 2300],
      [-1900, -900, 1400, 2000], [1500, -1100, 1200, 1700], [-1700, -2400, 1500, 2200], [2000, -2600, 1600, 2500],
      [-1200, -4200, 1500, 1900], [900, -4700, 1700, 2300], [2600, -4300, 1500, 2000], [-2900, -3900, 1700, 2500],
      [0, -6200, 2200, 2700], [-3300, -1600, 1700, 2400], [3300, -1200, 1700, 2300], [3600, -5600, 2000, 2600], [-3400, -6000, 2000, 2500],
    ];
    for (const [x, z, Rr, H] of defs) {
      const dist = Math.hypot(x, z + 1200);
      peak(x, z, -900, Rr, H, R() * 50, C.clamp(0.1 + dist / 11000, 0.1, 0.62));
    }
  }

  update(dt, time, camPos, playerPos, nextGate) {
    this.sky.position.copy(camPos);
    this.sky.material.uniforms.uTime.value = time;
    this.updateSun(playerPos);
    if (C.cfg.endless) {
      this.updateChunks(-playerPos.z);
      // Das Panorama wandert mit, sonst wäre es nach ein paar Kilometern weg
      this.mountains.position.set(0, playerPos.y + 330, playerPos.z + 1200);
    }
    this.updateLift(time);
    this.updateGates(dt, time, nextGate);
    if (this.flag && this.flag.visible) this.flagCloth.rotation.y = Math.sin(time * 5) * 0.25;
  }
}
