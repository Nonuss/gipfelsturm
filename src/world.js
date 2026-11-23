// Welt: Gelände-Mesh, Wald, Felsen, Tore, Lift, Hütten, Himmel, Berge, Licht.
// Rennen: alles wird einmal gebaut. Endlos-Berg: 100-m-Stücke werden vor dem Fahrer erzeugt und hinter ihm entfernt.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as C from './course.js';
import { makeSnowMaterial, snowUniforms } from './snow.js';
import { Q } from './quality.js';
import { ultraTrees } from './ultratrees.js';
import { CRAG_GLSL } from './ultraglsl.js';
import { HeliWorld } from './heliworld.js';

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
const SUN_DEFAULT = SUN_DIR.clone();
const HAZE = new THREE.Color().setRGB(0.62, 0.77, 0.95);
const TREE_NAMES = ['TreeA', 'TreeB', 'TreeC'];
const LOD_R1 = 110, LOD_R2 = 380;   // Ultra: bis hier feinste, bis hier mittlere Fassung der Fichte, dahinter grobe

const ROCK_NAMES = ['RockA', 'RockB', 'RockC', 'RockD', 'RockE', 'RockF'];

export class World {
  constructor(scene, models) {
    this.scene = scene;
    this.models = models;
    this.propMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0 });
    this.glossMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.45, metalness: 0.1 });
    this.snowMat = makeSnowMaterial();
    this.snowMatH = makeSnowMaterial();          // Heli-Kacheln: mit Gelände-Schatten und Kreis-Ausschnitt
    this.snowMatH.defines = { HELISUN: 1 };
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
    this.mountains.scale.set(1, 1, 1);
    this.cables = [];
    this.chairs = null;
    this.course = new THREE.Group();
    this.scene.add(this.course);
    this.grp = this.course;
    if (this.heliW) { this.heliW.dispose(); this.heliW = null; }
    snowUniforms.uClip.value.set(0, 0, 1e9);
    const heli = C.cfg.heli;
    // Heli-Gebirge: eigene Sonne (tiefer, seitlich), Dunst mit Tiefe statt fester Sichtgrenze, echte Nachbarberge
    this.setSun(heli ? new THREE.Vector3(...C.HB.SUN) : SUN_DEFAULT);
    if (heli !== this.fogExp) {
      this.scene.fog = heli ? new THREE.FogExp2(new THREE.Color().setRGB(0.6, 0.71, 0.88), 0.000088) : new THREE.Fog(HAZE, 220, 2300);
      this.fogExp = heli;
    }
    this.mountains.visible = !heli;
    if (heli) {
      this.heliW = new HeliWorld(this);
      this.heliW.build();
      const dp = C.HB.dropPoint();
      this.heliW.updateTiles(dp.x, -dp.d, false);   // Kacheln bauen sich über die nächsten Bilder auf; bis dahin zeigt die Fernsicht
    } else if (C.cfg.endless) {
      this.scene.fog.near = 230;   // weiter vorne klar sehen, Nebel erst in der Ferne
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
    sun.shadow.normalBias = 0.035;   // kleiner: Schatten löst sich weniger von Brett und Ski (wirkte sonst schwebend)
    sun.shadow.radius = 2.5;
    s.add(sun, sun.target);
    this.sun = sun;
    snowUniforms.uSunDir.value.copy(SUN_DIR);
    this._lx = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
    this._ly = new THREE.Vector3().crossVectors(SUN_DIR, this._lx).normalize();
  }

  setSun(v) {
    SUN_DIR.copy(v).normalize();
    snowUniforms.uSunDir.value.copy(SUN_DIR);
    this.updateSkyEnv();
    this._lx.crossVectors(new THREE.Vector3(0, 1, 0), SUN_DIR).normalize();
    this._ly.crossVectors(SUN_DIR, this._lx).normalize();
  }

  /** Stimmung der Rennserie (cup.js MOODS) setzen; null = klarer Wintertag. keepSunFog: Sonnenrichtung und Nebel nicht
   * anfassen (Heli und Freeride haben eigene). */
  setMood(m, keepSunFog) {
    m = m || {};
    const u = this.sky.material.uniforms, c = (o, v, d) => o.setRGB(...(v || d));
    c(u.uZen.value, m.zen, [0.07, 0.24, 0.66]); c(u.uMid.value, m.mid, [0.26, 0.52, 0.92]); c(u.uHor.value, m.hor, [0.62, 0.77, 0.95]);
    c(u.uHalo.value, m.halo, [1.0, 0.86, 0.62]); c(u.uCloud.value, m.cloud, [1, 1, 1]);
    u.uCloudK.value = m.cloudK ?? 1; u.uStars.value = m.stars || 0; u.uMoon.value = m.moon || 0;
    c(this.sun.color, m.sunCol, [1.0, 0.94, 0.84]); this.sun.intensity = m.sunI ?? 2.7;
    c(this.hemi.color, m.hemiSky, [0.5, 0.68, 1.0]); c(this.hemi.groundColor, m.hemiGround, [0.72, 0.8, 1.0]);
    this.moodHemi = m.hemiI ?? 1.05;
    this.hemi.intensity = this.moodHemi * (this.skyLightOn ? this.hemiK ?? 0.5 : 1);
    this.mood = m;
    // ferne Berge sind unbeleuchtet (eingebrannte Farben): je Stimmung einfärben, im Nebel und Sturm ausblenden
    if (this.mountainMat) this.mountainMat.color.setRGB(...(m.mtn || [1, 1, 1]));
    if (this.mountains && !keepSunFog) this.mountains.visible = !m.hideMtn;
    if (!keepSunFog) {
      if (this.scene.fog && this.scene.fog.isFog) {
        this.scene.fog.color.setRGB(...(m.fog || [HAZE.r, HAZE.g, HAZE.b]));
        if (m.fogNear !== undefined) { this.scene.fog.near = m.fogNear; this.scene.fog.far = m.fogFar; }
      }
      this.setSun(m.sun ? new THREE.Vector3(...m.sun) : SUN_DEFAULT);
    } else this.updateSkyEnv();
  }

  /** Lichter entlang der Rennstrecke: Flutlichtmasten oder Fackeln (Rennserie, Nacht). Lichtinseln auf dem Schnee rechnet
   * der Schnee-Shader (die 24 nächsten Lampen), Fahrer und Tore beleuchten zwei Punktlichter an den nächsten Lampen. */
  buildLamps(kind, d0, d1) {
    if (this.lampGrp) { this.scene.remove(this.lampGrp); this.lampGrp.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); this.lampGrp = null; }
    for (const L of this.lampLights || []) this.scene.remove(L);
    this.lampLights = [];
    this.lamps = [];
    this.lampKind = kind || null;
    snowUniforms.uLampN.value = 0;
    if (!kind) return;
    const flood = kind === 'flood', g = new THREE.Group();
    const pts = [];
    if (flood) {
      let s = 1;
      for (let d = d0 - 10; d < d1 + 30; d += 34) {
        const w = C.halfWidth(d), cx = C.centerX(d), x = cx + s * (w + 3.2), z = -d, y = C.height(x, z);
        pts.push({ x, y, z, s, d, px: cx + s * w * 0.3, pz: z, r: 20, I: 0.5, hy: y + 11 });
        s = -s;
      }
    } else {
      for (let d = d0 - 6; d < d1 + 20; d += 10.5) for (const s of [-1, 1]) {
        const w = C.halfWidth(d), x = C.centerX(d) + s * (w + 0.9), z = -d, y = C.height(x, z);
        pts.push({ x, y, z, s, d, px: x - s * 1.2, pz: z, r: 5.2, I: 0.6, hy: y + 1.45 });
      }
    }
    const n = pts.length, M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(1, 1, 1), P = new THREE.Vector3();
    const poleMat = new THREE.MeshStandardMaterial({ color: flood ? 0x3a3f47 : 0x2a1d14, roughness: 0.7, metalness: flood ? 0.5 : 0 });
    const headMat = new THREE.MeshBasicMaterial({ color: flood ? new THREE.Color().setRGB(4.0, 3.7, 3.2) : new THREE.Color().setRGB(4.5, 1.9, 0.45), fog: true });
    const poleGeo = flood ? new THREE.CylinderGeometry(0.14, 0.22, 11, 8).translate(0, 5.5, 0) : new THREE.CylinderGeometry(0.04, 0.05, 1.3, 6).translate(0, 0.65, 0);
    const headGeo = flood ? new THREE.BoxGeometry(1.5, 0.5, 0.9) : new THREE.ConeGeometry(0.11, 0.34, 7).translate(0, 0.17, 0);
    const poles = new THREE.InstancedMesh(poleGeo, poleMat, n), heads = new THREE.InstancedMesh(headGeo, headMat, n);
    pts.forEach((p, i) => {
      M.compose(P.set(p.x, p.y - 0.2, p.z), Q.identity(), S); poles.setMatrixAt(i, M);
      if (flood) Q.setFromEuler(new THREE.Euler(0, 0, 0.5 * p.s));   // Scheinwerfer zur Piste geneigt
      M.compose(P.set(p.x - (flood ? p.s * 0.5 : 0), p.hy - (flood ? 0 : 0.1), p.z), Q, S); heads.setMatrixAt(i, M);
    });
    poles.castShadow = flood; g.add(poles, heads);
    this.lampHeads = heads;
    this.scene.add(g);
    this.lampGrp = g;
    this.lamps = pts;
    snowUniforms.uLampCol.value.setRGB(...(flood ? [1.0, 0.93, 0.8] : [1.0, 0.55, 0.22]));
    for (let i = 0; i < 2; i++) {
      const L = new THREE.PointLight(flood ? 0xfff0d8 : 0xff9a45, 0, flood ? 60 : 14, flood ? 1.4 : 2);
      this.scene.add(L); this.lampLights.push(L);
    }
  }
  /** Lampen fürs Bild: die 24 nächsten an der Kamera in den Schnee-Shader, zwei Punktlichter an die nächsten am Fahrer. */
  updateLamps(cam, pos, time) {
    if (!this.lamps || !this.lamps.length) return;
    const flood = this.lampKind === 'flood', L = this.lamps, U = snowUniforms.uLamps.value;
    const near = L.map((p, i) => [(p.px - cam.x) ** 2 + (p.pz - cam.z) ** 2, i]).sort((a, b) => a[0] - b[0]);
    const k = Math.min(24, near.length);
    for (let j = 0; j < k; j++) {
      const p = L[near[j][1]], fl = flood ? 1 : 0.85 + 0.15 * Math.sin(time * 13 + p.d) * Math.sin(time * 7.3 + p.d * 1.7);
      U[j].set(p.px, p.pz, p.r, p.I * fl);
    }
    snowUniforms.uLampN.value = k;
    const nr = L.map((p, i) => [(p.x - pos.x) ** 2 + (p.z - pos.z) ** 2, i]).sort((a, b) => a[0] - b[0]);
    this.lampLights.forEach((Lt, j) => {
      const p = L[nr[j][1]], fl = flood ? 1 : 0.8 + 0.2 * Math.sin(time * 11 + p.d * 2);
      Lt.position.set(flood ? p.px : p.x, p.hy + (flood ? -1 : 0.2), p.z);
      Lt.intensity = (flood ? 70 : 4) * fl;
    });
  }

  setLowQuality(low) {
    const mh = this.snowMatH;
    if (mh && !!mh.defines.LOWQ !== low) { if (low) mh.defines.LOWQ = 1; else delete mh.defines.LOWQ; mh.needsUpdate = true; }
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

  /** Halbe Kantenlänge des Schattenbereichs um den Fahrer (Ultra: größer, dank der feineren Karte trotzdem schärfer). */
  setShadowArea(S) {
    if (this.shadowSize === S) return;
    this.shadowSize = S;
    Object.assign(this.sun.shadow.camera, { left: -S, right: S, top: S, bottom: -S });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  /** Ultra: Licht aus der Himmelskuppel. Der Himmel (ohne Sonnenscheibe, die ist schon direktes Licht) wird vorgefiltert
   * und beleuchtet alle Oberflächen: Schatten werden bläulich wie unter freiem Himmel, glatte Flächen spiegeln den Himmel.
   * Das Halbkugel-Licht wird dafür zurückgenommen. Aus: alles wie vorher (keine Umgebung, volles Halbkugel-Licht). */
  setSkyLight(on, renderer) {
    this.skyLightOn = on;
    if (renderer) this.renderer = renderer;
    if (!on) {
      if (this.skyEnv && this.scene.environment === this.skyEnv.texture) this.scene.environment = null;
      this.hemi.intensity = this.moodHemi ?? 1.05;
      return;
    }
    this.updateSkyEnv();
  }
  updateSkyEnv() {
    if (!this.skyLightOn || !this.renderer) return;
    if (!this.envScene) {
      const m = this.sky.material.clone();
      m.fragmentShader = m.fragmentShader.replace('col += uHalo * mix(', 'col += 0.0 * uHalo * mix(');   // Sonne und Sonnenhof sind schon direktes Licht
      m.uniforms = this.sky.material.uniforms;   // gleiche Werte wie der sichtbare Himmel (auch bei Stimmungswechsel)
      this.envScene = new THREE.Scene();
      this.envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 48, 24), m));
      this.pmrem = new THREE.PMREMGenerator(this.renderer);
    }
    if (this.skyEnv) this.skyEnv.dispose();
    this.skyEnv = this.pmrem.fromScene(this.envScene, 0.03, 0.1, 100);
    this.scene.environment = this.skyEnv.texture;
    this.scene.environmentIntensity = this.envI ?? 0.75;
    this.hemi.intensity = (this.moodHemi ?? 1.05) * (this.hemiK ?? 0.5);
  }

  // ------------------------------------------------------------ Ultra: alle Bäume als fein modellierte Fichten
  // Jede Baumgruppe bekommt zwei weitere Instanz-Modelle. Bäume im Umkreis LOD_R1 stehen in der feinsten Fassung, bis LOD_R2
  // in der mittleren, dahinter in der groben Fassung derselben Fichte (die das einfache Vorlage-Modell ersetzt). So sieht auf
  // Ultra jeder Baum gleich aus. Gleiche Größe und Stellung, also gleiche Kollisionen. Neu verteilt wird nach 5 m Kamerafahrt.
  attachLod(im) {
    if (im.userData.lod) return;
    const v = im.userData.treeVariant, n = im.count;
    const mk = (lod) => {
      const m = new THREE.InstancedMesh(ultraTrees(this.models, lod)[v], this.propMat, n);
      m.count = 0; m.castShadow = true; m.receiveShadow = true;
      if (im.instanceColor) m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
      im.parent.add(m);
      return m;
    };
    if (!im.boundingSphere) im.computeBoundingSphere();
    const e = { im, lv: [mk(0), mk(1), im], n, mats: im.instanceMatrix.array.slice(0, n * 16), cols: im.instanceColor ? im.instanceColor.array.slice(0, n * 3) : null, sphere: im.boundingSphere.clone(), allFar: false, geo0: im.geometry };
    im.geometry = ultraTrees(this.models, 2)[v];   // grobe Fassung der neuen Fichte statt des Vorlage-Modells
    im.userData.lod = e;
    im.addEventListener('dispose', () => { e.dead = true; });   // Abschnitt bzw. Heli-Kachel abgebaut
    (this.lods || (this.lods = [])).push(e);
    this.lodDirty = true;
  }
  detachLod(e) {
    const { im, n, mats, cols } = e;
    im.geometry = e.geo0;
    im.instanceMatrix.array.set(mats); im.instanceMatrix.needsUpdate = true;
    if (cols) { im.instanceColor.array.set(cols); im.instanceColor.needsUpdate = true; }
    im.count = n; im.boundingSphere = e.sphere;
    for (const m of [e.lv[0], e.lv[1]]) { if (m.parent) m.parent.remove(m); m.dispose(); }
    delete im.userData.lod;
  }
  /** Beim Stufenwechsel: Ultra-Fichten an alle stehenden Gruppen anhängen bzw. wieder entfernen. */
  setTreeDetail(on) {
    if (!on) { if (this.lods) { for (const e of this.lods) if (!e.dead && e.im.parent) this.detachLod(e); this.lods = []; } return; }
    const todo = [];
    this.scene.traverse((o) => { if (o.isInstancedMesh && o.userData.treeVariant !== undefined && !o.userData.lod) todo.push(o); });
    for (const im of todo) this.attachLod(im);
  }
  updateTreeLod(cam) {
    if (!this.lods || !this.lods.length) return;
    if (!this.lodPos) this.lodPos = new THREE.Vector3(1e9, 0, 0);
    if (!this.lodDirty && cam.distanceToSquared(this.lodPos) < 25) return;   // erst nach 5 m Kamerafahrt neu verteilen
    this.lodPos.copy(cam); this.lodDirty = false;
    const R1 = LOD_R1 * LOD_R1, R2 = LOD_R2 * LOD_R2, cx = cam.x, cz = cam.z;
    const live = (o) => { while (o.parent) o = o.parent; return o === this.scene; };
    this.lods = this.lods.filter((e) => !e.dead && live(e.im));   // Gruppen abgebauter Abschnitte und alter Welten vergessen
    const cnt = [0, 0, 0];
    for (const e of this.lods) {
      const c = e.sphere.center, far = Math.hypot(c.x - cx, c.z - cz) - e.sphere.radius > LOD_R2;
      if (far && e.allFar) continue;                    // ganz in der groben Stufe und schon so verteilt
      const { n, mats, cols, lv } = e;
      cnt[0] = cnt[1] = cnt[2] = 0;
      for (let i = 0; i < n; i++) {
        const k = i * 16, dx = mats[k + 12] - cx, dz = mats[k + 14] - cz, d2 = dx * dx + dz * dz;
        const l = far ? 2 : d2 < R1 ? 0 : d2 < R2 ? 1 : 2, j = cnt[l]++;
        lv[l].instanceMatrix.array.set(mats.subarray(k, k + 16), j * 16);
        if (cols) lv[l].instanceColor.array.set(cols.subarray(i * 3, i * 3 + 3), j * 3);
      }
      e.allFar = cnt[2] === n;
      for (let l = 0; l < 3; l++) {
        const m = lv[l];
        m.count = cnt[l];
        m.instanceMatrix.needsUpdate = true;
        if (cols) m.instanceColor.needsUpdate = true;
        m.computeBoundingSphere();
      }
    }
  }

  /** Ultra: zusätzliche Schneestruktur (Windgangeln im Pulver, feinere Körnung). Andere Stufen bleiben unverändert. */
  setUltra(on, extra = []) {
    const far = this.heliW ? [this.heliW.farI, this.heliW.farO, this.heliW.farH].filter(Boolean).map((o) => o.material) : [];
    for (const m of [this.snowMat, this.snowMatH, this.mountainMat, this.sky && this.sky.material, ...far, ...extra]) {
      if (m && !m.defines) m.defines = {};
      if (!m || !!m.defines.ULTRA === on) continue;
      if (on) m.defines.ULTRA = 1; else delete m.defines.ULTRA;
      m.needsUpdate = true;
    }
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
      uniforms: { uSun: { value: SUN_DIR }, uTime: { value: 0 }, uZen: { value: new THREE.Color().setRGB(0.07, 0.24, 0.66) }, uMid: { value: new THREE.Color().setRGB(0.26, 0.52, 0.92) },
        uHor: { value: new THREE.Color().setRGB(0.62, 0.77, 0.95) }, uHalo: { value: new THREE.Color().setRGB(1.0, 0.86, 0.62) }, uCloud: { value: new THREE.Color(1, 1, 1) },
        uCloudK: { value: 1 }, uStars: { value: 0 }, uMoon: { value: 0 } },
      vertexShader: 'varying vec3 vDir; void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: /* glsl */ `
        varying vec3 vDir; uniform vec3 uSun; uniform float uTime; uniform vec3 uZen; uniform vec3 uMid; uniform vec3 uHor; uniform vec3 uHalo; uniform vec3 uCloud; uniform float uCloudK; uniform float uStars; uniform float uMoon;
        float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
        float n2(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.-2.*f); return mix(mix(h12(i),h12(i+vec2(1,0)),f.x), mix(h12(i+vec2(0,1)),h12(i+vec2(1,1)),f.x), f.y); }
        float fbm(vec2 p){ float a=0.5, s=0.; for(int i=0;i<5;i++){ s+=a*n2(p); p=p*2.03+7.1; a*=0.5; } return s; }
        void main(){
          vec3 d = normalize(vDir);
          float h = d.y;
          vec3 zen = uZen, mid = uMid, hor = uHor;   // Stimmung (Rennserie): Farben je Tageszeit
          float t = clamp(h, 0., 1.);
          vec3 col = mix(hor, mid, smoothstep(0.0, 0.28, t));
          col = mix(col, zen, smoothstep(0.2, 0.95, t));
          float s = max(dot(d, uSun), 0.);
          // Nacht: Sterne (hinter den Wolken) und statt der Sonne ein kleiner, kühler Mond mit schwachem Hof
          if (uStars > 0.) {
            vec2 sp = d.xz / (d.y + 0.18) * 150.; vec2 sc = floor(sp);
            float st = step(0.984, h12(sc)) * smoothstep(0.45, 0.05, length(fract(sp) - 0.5)) * smoothstep(0.03, 0.25, h);
            col += vec3(0.85, 0.9, 1.0) * st * uStars * (0.35 + 0.65 * h12(sc + 3.7)) * (0.8 + 0.2 * sin(uTime * 3. + h12(sc) * 50.));
          }
          col += uHalo * mix(pow(s, 1400.) * 40. + pow(s, 90.) * 0.55 + pow(s, 9.) * 0.16, pow(s, 3000.) * 9. + pow(s, 160.) * 0.18 + pow(s, 12.) * 0.05, uMoon);
#ifdef ULTRA
          // Ultra: Haufenwolken aus zwei Ebenen, Eigenschatten aus der Dichte Richtung Sonne, helle Ränder im Gegenlicht,
          // feine Schleier hoch oben und Dunst über dem Horizont
          vec2 cuv = d.xz / (abs(d.y) + 0.16);
          vec2 wind = vec2(uTime * 0.005, uTime * 0.0015);
          vec2 sd = normalize(uSun.xz + 1e-4) * 0.09;
          float c = fbm(cuv * 1.1 + wind) * 0.72 + fbm(cuv * 3.9 + wind * 1.6 + 4.0) * 0.38;
          float cs = fbm(cuv * 1.1 + wind + sd) * 0.72 + fbm(cuv * 3.9 + wind * 1.6 + 4.0 + sd * 3.5) * 0.38;
          float cover = smoothstep(0.6, 0.9, c) * smoothstep(0.02, 0.2, h);
          float lit = clamp(0.62 + (c - cs) * 3.2, 0.25, 1.15);
          vec3 ccol = mix(vec3(0.58, 0.66, 0.8), vec3(1.2, 1.14, 1.05), lit) * uCloud;
          ccol += uHalo * pow(s, 7.) * (1.0 - smoothstep(0.6, 1.0, cover)) * 0.9;   // Silberrand
          col = mix(col, ccol, cover * 0.92 * uCloudK);
          float cirr = smoothstep(0.55, 0.85, fbm(vec2(cuv.x * 0.35, cuv.y * 2.4) + wind * 0.4 + 9.0)) * smoothstep(0.1, 0.5, h);
          col = mix(col, vec3(1.0, 0.99, 0.98), cirr * 0.22);
          col = mix(col, hor * 1.06, exp(-max(h, 0.0) * 16.0) * 0.35);
#else
          vec2 cuv = d.xz / (abs(d.y) + 0.22);
          float c = fbm(cuv * 1.3 + vec2(uTime*0.004, 0.));
          float cl = smoothstep(0.6, 0.86, c) * smoothstep(0.03, 0.25, h) * 0.6;
          vec3 ccol = mix(vec3(0.82, 0.88, 0.97), vec3(1.25, 1.18, 1.08), smoothstep(0.55, 0.9, c) * (0.4 + 0.6*pow(s, 3.))) * uCloud;
          col = mix(col, ccol, cl * uCloudK);
#endif
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
    if (data.caves && data.caves.length) this.buildCaves(data.caves, grp);
    if (data.walls && data.walls.length) this.buildWalls(data.walls, grp);
    if (data.rails && data.rails.length) this.buildRails(data.rails, grp);
    this.course.add(grp);
    this.chunks.set(job.i, grp);
  }

  updateChunks(d, all = false, x = 0) {
    if (this.heliW) { this.heliW.updateTiles(x, -d, all); return; }
    const i0 = Math.floor((d - 170) / C.CHUNK), i1 = Math.min(Math.floor((d + Q.view + 40) / C.CHUNK), isFinite(C.MESH_D1) ? Math.floor((C.MESH_D1 + 250) / C.CHUNK) : 1e9);
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

  // ------------------------------------------------------------ Eishöhlen
  /** Tunnel aus Gletschereis: innen tiefblau bis türkis (leuchtet leicht), außen dicke Eisschale mit Schneekappe. */
  buildCaves(caves, parent) {
    if (!this.caveMat) {
      this.caveMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.05, emissive: new THREE.Color(0.03, 0.12, 0.2), side: THREE.DoubleSide });
    }
    const SEG = 16;
    for (const cv of caves) {
      const P = cv.pts, n = P.length, rings = 2 * (SEG + 1);   // innere + äußere Schale
      const pos = new Float32Array(n * rings * 3), col = new Float32Array(n * rings * 3);
      const hash = (a, b) => { const t = Math.sin(a * 12.9898 + b * 78.233 + cv.seed) * 43758.5453; return t - Math.floor(t); };
      for (let i = 0; i < n; i++) {
        const p = P[i], end = Math.min(i, n - 1 - i);
        const portal = 1 + 0.35 * Math.max(0, 1 - end / 3);          // Eingang etwas größer und unregelmäßiger
        for (let shell = 0; shell < 2; shell++) {
          const th = shell ? 1.9 : 0;                                 // Eisdicke
          for (let j = 0; j <= SEG; j++) {
            const a = (j / SEG) * Math.PI, ca = Math.cos(a), sa = Math.sin(a);
            const nz = (hash(i, j + shell * 50) - 0.5) * (shell ? 0.9 : 0.55);
            const W = (cv.W + th) * portal + nz, H = (cv.H + th * 1.1) * portal + nz;
            const gy = ca > 0 ? p.gc + (p.gr - p.gc) * ca : p.gc + (p.gl - p.gc) * -ca;   // Boden folgt dem Gelände
            const k = (i * rings + shell * (SEG + 1) + j) * 3;
            pos[k] = p.x - ca * W; pos[k + 1] = gy - 0.25 + sa * H; pos[k + 2] = -p.d;
            const v = hash(j, i * 3 + 7);
            if (shell === 0) {               // innen: unten tiefblau, oben hell türkis
              const t = sa;
              col[k] = 0.08 + 0.35 * t + v * 0.05; col[k + 1] = 0.32 + 0.5 * t + v * 0.06; col[k + 2] = 0.62 + 0.36 * t;
            } else {                          // außen: Schnee oben, Eis an den Flanken
              const snow = Math.max(0, sa - 0.55) / 0.45;
              col[k] = 0.55 + 0.4 * snow; col[k + 1] = 0.75 + 0.22 * snow; col[k + 2] = 0.9 + 0.08 * snow;
            }
          }
        }
      }
      const idx = [];
      for (let i = 0; i < n - 1; i++) for (let shell = 0; shell < 2; shell++) for (let j = 0; j < SEG; j++) {
        const a = i * rings + shell * (SEG + 1) + j, b = a + 1, c = a + rings, d = c + 1;
        idx.push(a, c, b, b, c, d);
      }
      // Stirnflächen (Eisrand am Eingang und Ausgang)
      for (const i of [0, n - 1]) for (let j = 0; j < SEG; j++) {
        const a = i * rings + j, b = a + 1, c = a + SEG + 1, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, this.caveMat);
      m.castShadow = true; m.receiveShadow = true;
      parent.add(m);
    }
  }

  // ------------------------------------------------------------ Rails und Boxen (Freestyle)
  /**
   * Eigenes Modell für jede Länge: Rail = Stahlrohr auf Stützen über einem Bodenträger, Box = breite Gleitfläche mit
   * Seitenwänden in Parkfarben. Oberkante liegt genau auf der Linie der Physik (course.railGeom).
   */
  buildRails(list, parent) {
    if (!this.railMat) this.railMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.35 });
    const pos = [], col = [], idx = [];
    const RAILC = [[0.95, 0.72, 0.08], [0.82, 0.84, 0.88], [0.9, 0.16, 0.12], [0.1, 0.55, 0.95]];
    const BOXC = [[0.95, 0.42, 0.06], [0.12, 0.42, 0.9], [0.13, 0.14, 0.17], [0.15, 0.7, 0.45]];
    for (const g of list) {
      const hn = Math.hypot(g.dx, g.dz) || 1, sx = g.dz / hn, sz = -g.dx / hn;   // seitliche Richtung
      const P = (s, u, v) => [g.ax + g.dx * s + sx * u, g.ay + g.dy * s + v, g.az + g.dz * s + sz * u];
      // Profil (u, v relativ zur Oberkante) entlang [s0, s1] ziehen; geschlossene Querschnitte mit Deckeln
      const sweep = (s0, s1, sec, c) => {
        const o = pos.length / 3, n = sec.length;
        for (const s of [s0, s1]) for (const [u, v] of sec) { pos.push(...P(s, u, v)); col.push(...c); }
        for (let i = 0; i < n; i++) { const j = (i + 1) % n; idx.push(o + i, o + j, o + n + j, o + i, o + n + j, o + n + i); }
        for (let i = 1; i < n - 1; i++) { idx.push(o, o + i + 1, o + i); idx.push(o + n, o + n + i, o + n + i + 1); }
      };
      // senkrechter Quader (Stütze) an der Stelle s
      const post = (s, u, hw, v0, v1, c) => {
        const o = pos.length / 3;
        for (const v of [v0, v1]) for (const [du, ds] of [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]]) { pos.push(...P(s + ds, u + du, v + g.dy * -ds)); col.push(...c); }
        for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; idx.push(o + i, o + 4 + i, o + 4 + j, o + i, o + 4 + j, o + j); }
        idx.push(o + 4, o + 5, o + 6, o + 4, o + 6, o + 7);
      };
      const h = g.h, L = g.L, k = g.seed >>> 0;
      if (g.kind === 'rail') {
        const c = RAILC[k % RAILC.length], dark = [0.16, 0.17, 0.2];
        const ring = []; for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2; ring.push([Math.cos(a) * 0.05, -0.05 + Math.sin(a) * 0.05]); }
        sweep(0, L, ring, c);
        sweep(0.2, L - 0.2, [[-0.16, -h], [0.16, -h], [0.16, -h + 0.1], [-0.16, -h + 0.1]], dark);       // Bodenträger
        const n = Math.max(2, Math.round(L / 2.6));
        for (let i = 0; i <= n; i++) post(0.3 + (i / n) * (L - 0.6), 0, 0.035, -h + 0.08, -0.08, dark);
      } else {
        const c = BOXC[k % BOXC.length], w = g.w;
        sweep(0, L, [[-w, -0.07], [w, -0.07], [w, 0], [-w, 0]], [0.93, 0.94, 0.96]);                     // Gleitfläche (Kunststoff)
        sweep(0.05, L - 0.05, [[-w + 0.03, -h], [w - 0.03, -h], [w - 0.03, -0.07], [-w + 0.03, -0.07]], c);
        sweep(0.05, L - 0.05, [[-w + 0.025, -h * 0.55], [w - 0.025, -h * 0.55], [w - 0.025, -h * 0.45], [-w + 0.025, -h * 0.45]], [0.95, 0.95, 0.95]);   // Zierstreifen
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    const flat = geo.toNonIndexed();   // kantige Boxen: Flächennormalen statt gemittelter Ecken
    flat.computeVertexNormals();
    const m = new THREE.Mesh(flat, this.railMat);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
  }

  // ------------------------------------------------------------ Heli-Berg: Felswände
  /**
   * Felswand vor einer Klippe. Das Höhenfeld kann nur eine steile Rampe; davor steht dieses Mesh:
   * kantiger, geschichteter Fels mit Pfeilern, Bändern (auf denen Schnee liegt), leicht überhängender Oberkante
   * und einer Schneewechte. Seitenwände laufen bergauf aus, bis die Bank im Hang verschwindet.
   */
  buildWalls(walls, parent) {
    if (!this.rockMat) {
      this.rockMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, flatShading: true, side: THREE.DoubleSide });
      this.iceMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.25, metalness: 0.05, flatShading: true, side: THREE.DoubleSide, emissive: new THREE.Color(0.02, 0.07, 0.12) });
    }
    const HB = C.HB;
    const hash = (a, b, c) => { const t = Math.sin(a * 12.9898 + b * 78.233 + c * 37.719) * 43758.5453; return t - Math.floor(t); };
    for (const w of walls) {
      // Heli: Abschnitt einer Klippe { c, ua, ub, id, ice } (v35); sonst eine ganze Klippe
      const c = w.c ? w : w, pts = w.c ? HB.wallLine(w.c, w.ua, w.ub) : HB.wallLine(w), n = pts.length;
      // Wandhöhe je Stützpunkt
      let hMax = 0;
      for (const p of pts) {
        p.yT = C.height(p.x - p.nx * 3.0, p.z - p.nz * 3.0) + 0.3;
        p.yB = C.height(p.x + p.nx * 3.3, p.z + p.nz * 3.3) - 1.3;
        p.h = p.yT - p.yB;
        hMax = Math.max(hMax, p.h);
      }
      const M = Math.max(7, Math.min(24, Math.round(hMax / 1.9) + 4));
      const rows = M + 1, pos = new Float32Array(n * rows * 3), col = new Float32Array(n * rows * 3);
      const sd = c.id * 7.3 + 1, R = M - 3;       // R = oberste Felsreihe; darüber Wechte (2 Reihen) und Schneekappe
      for (let i = 0; i < n; i++) {
        const p = pts[i], low = p.h < 1.8;
        const ov = Math.min(2.6, 0.3 + p.h * 0.075);
        // Pfeiler und Verschneidungen: zusammenhängende Formen statt Knitterfalten
        const pil = (C.vnoise(i * 0.19 + sd, 3.1) - 0.5) * 3.4 + (C.vnoise(i * 0.6 + sd, 8.7) - 0.5) * 1.3;
        const lip = 1.5 + ov * 0.55 + pil * 0.2;
        for (let j = 0; j <= M; j++) {
          const k = (i * rows + j) * 3;
          let off, y, r, g, b;
          if (low || j === M) {                       // Schneekappe, liegt auf dem Gelände
            off = -3.0; y = p.yT;
            r = 0.94; g = 0.96; b = 1.0;
          } else if (j === M - 1) {                   // Oberkante der Wechte
            off = lip; y = p.yT - 0.12 - 0.2 * C.vnoise(i * 0.4, sd);
            r = 0.92; g = 0.95; b = 1.0;
          } else if (j === M - 2) {                   // Unterseite der Wechte (im Schatten, bläulich)
            off = lip - 0.15; y = p.yT - 0.75 - 0.5 * C.vnoise(i * 0.5, sd + 4);
            r = 0.7; g = 0.78; b = 0.93;
          } else {
            const t = j / R;                          // 0 = Wandfuß, 1 = direkt unter der Wechte
            const strat = hash(j, 9, sd);
            const band = C.vnoise(i * 0.11 + sd, j * 0.55);                      // Bänder ziehen schräg durch die Wand
            const ledge = j > 0 && j < R && band > 0.66 && hash(j, Math.floor(i / 5), sd) > 0.35;
            off = 3.3 + (lip - 0.7 - 3.3) * t * t
              - 1.1 * Math.sin(Math.PI * t) * (0.3 + 0.7 * C.vnoise(i * 0.13 + sd, j * 0.2))
              + pil * (0.25 + 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.15)))
              + (C.vnoise(i * 0.8 + sd, j * 0.9) - 0.5) * 1.5 + (hash(i, j, sd) - 0.5) * 0.45;
            off = Math.max(2.0, off + (ledge ? 0.9 : 0));
            y = p.yB + (p.yT - 1.3 - p.yB) * t + (hash(i, j + 20, sd) - 0.5) * 0.5;
            if (c.ice) {
              const v = 0.75 + 0.5 * C.vnoise(i * 0.5 + sd, j * 0.7);
              r = 0.4 * v + 0.32 * t; g = 0.66 * v + 0.22 * t; b = 0.9 * v + 0.1 * t;
              if (ledge) { r = 0.9; g = 0.94; b = 1.0; }
            } else {
              // Gestein: Schichtung, senkrechte Wasserstreifen, warme und kühle Partien
              const streak = 0.78 + 0.3 * C.vnoise(i * 1.3 + sd, j * 0.08), warm = (C.vnoise(i * 0.07 + sd, j * 0.12 + 9) - 0.5) * 0.09;
              const v = (0.66 + 0.42 * strat) * streak * (0.82 + 0.36 * hash(i, j + 40, sd));
              r = (0.33 + warm) * v; g = (0.31 + warm * 0.5) * v; b = (0.31 - warm * 0.4) * v;
              if (ledge) { r = 0.9; g = 0.93; b = 1.0; }                        // Schnee auf Bändern
              else if (t < 0.12) { r = r * 0.5 + 0.45; g = g * 0.5 + 0.47; b = b * 0.5 + 0.5; }   // angewehter Schnee am Wandfuß
            }
          }
          pos[k] = p.x + p.nx * off; pos[k + 1] = y; pos[k + 2] = p.z + p.nz * off;
          col[k] = r; col[k + 1] = g; col[k + 2] = b;
        }
      }
      const idx = [];
      for (let i = 0; i < n - 1; i++) for (let j = 0; j < M; j++) {
        const a = i * rows + j, b2 = a + 1, c2 = a + rows, d2 = c2 + 1;
        if ((i + j) & 1) idx.push(a, c2, b2, b2, c2, d2); else idx.push(a, c2, d2, a, d2, b2);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, c.ice ? this.iceMat : this.rockMat);
      m.castShadow = true; m.receiveShadow = true;
      parent.add(m);
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
      im.userData.treeVariant = variant;
      parent.add(im);
      if (Q.ultra) this.attachLod(im);
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
    // Rennen: Start je nach Disziplin weiter unten am Hang; Starthaus steht dann am Pistenrand
    const S = C.cfg.endless ? 0 : C.START_D, cx = C.centerX(S);
    const hut = this.mesh('StartHut');
    if (S > 0) { const hx = cx - C.halfWidth(S) - 1.5; hut.position.set(hx, C.height(hx, -S + 5) - 0.2, -S + 5); hut.rotation.y = -0.35; }
    else { hut.position.set(-6.2, C.height(-6.2, 4) - 0.2, 4); hut.rotation.y = -0.55; }
    const sz = -S - 1.2, sy = C.height(cx, sz), hd = Math.atan2(C.centerX(S + 6) - cx, 6), ca = Math.cos(hd), sa = Math.sin(hd);
    const postMat = new THREE.MeshStandardMaterial({ color: 0xff6a13, roughness: 0.5 });
    for (const sx of [-2.5, 2.5]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 3.6, 10), postMat);
      const px = cx + sx * ca, pz = sz + sx * sa;
      post.position.set(px, C.height(px, pz) + 1.6, pz);
      post.castShadow = true;
      this.grp.add(post);
    }
    if (!this.startTex) this.startTex = this.bannerTexture('START', '#ff6a13', '#ffffff');
    const sb = new THREE.Mesh(new THREE.PlaneGeometry(5.0, 0.94), new THREE.MeshStandardMaterial({ map: this.startTex, roughness: 0.7, side: THREE.DoubleSide }));
    sb.position.set(cx, sy + 2.9, sz);
    sb.rotation.y = Math.PI - hd;   // Schrift zur Talseite (Kamera, Zuschauer)
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
          q.y = Math.max(q.y, C.height(q.x, q.z) + 6.5);   // über Kuppen zwischen zwei Stützen nicht durch den Schnee
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
    // Slalom: Kippstangen (rot oder blau, 1,8 m über dem Schnee, schwarzes Gelenk am Fuß); sonst Torflaggen
    if (!this.poleGeo) {
      const pole = new THREE.CylinderGeometry(0.02, 0.02, 1.8, 8, 1);
      pole.translate(0, 0.9 + 0.12, 0);
      const hinge = new THREE.CylinderGeometry(0.03, 0.035, 0.28, 8, 1);
      hinge.translate(0, 0.0, 0);
      const cap = new THREE.SphereGeometry(0.024, 8, 6);
      cap.translate(0, 1.82 + 0.12, 0);
      const parts = [[pole, 1], [hinge, 0], [cap, 1]];
      const pos = [], col = [], idx = [];
      for (const [g, colored] of parts) {
        const o = pos.length / 3, p = g.attributes.position;
        for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); const c = colored ? 1 : 0.06; col.push(c, c, c); }
        const ix = g.index; for (let i = 0; i < ix.count; i++) idx.push(ix.getX(i) + o);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      geo.userData.shared = true;
      this.poleGeo = geo;
      this.poleMats = { red: new THREE.MeshStandardMaterial({ vertexColors: true, color: 0xd8202a, roughness: 0.35, metalness: 0.05 }), blue: new THREE.MeshStandardMaterial({ vertexColors: true, color: 0x1f4fd6, roughness: 0.35, metalness: 0.05 }) };
    }
    for (const g of C.gates) {
      g.flags = [];
      for (const s of [-1, 1]) {
        const x = g.x + s * g.half;
        let m;
        if (g.pole) {
          m = new THREE.Mesh(this.poleGeo, this.poleMats[g.color]);
          m.castShadow = true;
          this.grp.add(m);
          m.position.set(x, C.height(x, g.z) - 0.12, g.z);
        } else {
          m = this.mesh(g.color === 'red' ? 'GateRed' : 'GateBlue', this.glossMat);
          m.position.set(x, C.height(x, g.z), g.z);
          m.scale.setScalar(1.35);
        }
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
    this.mountainMat = mat;
    // Ultra: Relief je Bildpunkt (Grate, Rinnen, Felsköpfe) als Höhenfeld in der Beleuchtung, Fels kommt an steilen
    // Stellen unter dem Schnee hervor. Ohne ULTRA wird nichts davon übersetzt: Bild wie bisher.
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uSunM = { value: SUN_DIR };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n#ifdef ULTRA\nvarying vec3 vCP;\nvarying vec3 vCN;\nvarying vec3 vCW;\n#endif')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n#ifdef ULTRA\nvCP = transformed;\nvCN = normal;\nvCW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#endif');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n#ifdef ULTRA\nuniform vec3 uSunM;\nvarying vec3 vCP;\nvarying vec3 vCN;\nvarying vec3 vCW;\n' + CRAG_GLSL + '\n#endif')
        .replace('#include <color_fragment>', `#include <color_fragment>
#ifdef ULTRA
{
  // Wie echte Alpenwände: Rinnen und Rippen entlang der Falllinie, quer liegende Felsbänder, Schnee in den Rinnen und auf
  // Absätzen, schneefreie Rippenkämme. Alles in Koordinaten der Berge selbst, das Muster wandert also nie über die Hänge.
  vec3 nn = normalize(vCN);
  float pw = length(fwidth(vCP));
  float steep = smoothstep(0.9, 0.5, nn.y);
  // senkrecht gestrecktes Rauschen: in steilen Wänden laufen Rinnen und Rippen damit die Falllinie hinab, ohne Wirbel
  float r1 = 1.0 - abs(2.0 * n3(vec3(vCP.x / 65.0, vCP.y / 340.0, vCP.z / 65.0)) - 1.0);
  float r2 = 1.0 - abs(2.0 * n3(vec3(vCP.x / 21.0, vCP.y / 120.0, vCP.z / 21.0) + 5.0) - 1.0);
  // Felsbänder: breit, unregelmäßig und leicht geneigt (Schichtung), nicht als gleichmäßige Linien
  float band = smoothstep(0.55, 0.8, n3(vec3(vCP.x / 260.0, (vCP.y + vCP.x * 0.12 + n3(vCP / 90.0) * 40.0) / 48.0, vCP.z / 260.0)));
  float f1 = 1.0 - smoothstep(10.0, 30.0, pw), f2 = 1.0 - smoothstep(6.0, 18.0, pw);
  float h = n3(vCP / 240.0) * 26.0 + r1 * 34.0 * steep + r2 * 8.0 * steep * f1 + band * 7.0 * steep * f2;
  vec3 nb = bumpN(vCP, nn, h);
  float lo = max(dot(nn, uSunM), 0.0), ln = max(dot(nb, uSunM), 0.0);
  diffuseColor.rgb *= clamp((0.55 + 1.05 * ln) / (0.55 + 1.05 * lo), 0.6, 1.5);
  float haze = clamp(0.1 + length(vCW - cameraPosition) / 11000.0, 0.1, 0.62);
  vec3 hz = vec3(0.62, 0.77, 0.95);
  // Schnee in den Rinnen der Felswände (nicht in senkrechten Stellen)
  float face = smoothstep(0.62, 0.48, nn.y);
  float gully = smoothstep(0.5, 0.12, r1) * face * smoothstep(0.18, 0.4, nb.y);
  vec3 snowC = mix(mix(vec3(0.56, 0.66, 0.86), vec3(0.96, 0.975, 1.0), clamp(ln * 1.4, 0.0, 1.0)), hz, haze);
  diffuseColor.rgb = mix(diffuseColor.rgb, snowC, gully * 0.8);
  // Fels an steilen Stellen und auf Rippenkämmen im Schnee; Felsbänder etwas dunkler
  float rockA = smoothstep(0.62, 0.44, nb.y) * smoothstep(0.3, 0.55, nn.y) * (0.45 + 0.55 * r1);
  diffuseColor.rgb *= 1.0 - 0.16 * face * (1.0 - gully) * (1.0 - haze);   // Felswände kräftiger
  vec3 rockC = vec3(0.27, 0.28, 0.32) * (0.85 - 0.2 * band) * (0.55 + 1.05 * ln) * (0.85 + 0.3 * n3(vCP / 9.0));
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(rockC, hz, haze), rockA * 0.8);
}
#endif`);
    };
    mat.customProgramCacheKey = () => 'mount' + (mat.defines && mat.defines.ULTRA ? 'U' : '');
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
      g.translate(x, baseY, z);   // gleiche Lage wie vorher über m.position; so liegen alle Gipfel in einem Koordinatenraum
      const m = new THREE.Mesh(g, mat);
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
    if (Q.ultra) this.updateTreeLod(camPos);
    this.sky.material.uniforms.uTime.value = time;
    this.updateSun(playerPos);
    if (this.heliW) this.heliW.update(playerPos);
    else if (C.cfg.endless) {
      this.updateChunks(-playerPos.z);
      // Das Panorama wandert mit, sonst wäre es nach ein paar Kilometern weg
      this.mountains.position.set(0, playerPos.y + 330, playerPos.z + 1200);
    }
    this.updateLift(time);
    this.updateGates(dt, time, nextGate);
    if (this.flag && this.flag.visible) this.flagCloth.rotation.y = Math.sin(time * 5) * 0.25;
  }
}
