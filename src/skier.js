// Skifahrer: zusammenhängendes Modell aus Blender, das über 11 Knochen weich verformt wird (Skinning).
// Die Haltung wird prozedural berechnet: Becken/Oberkörper aus Fahrzustand, Beine und Arme per Zwei-Gelenk-IK.
import * as THREE from 'three';
import { clamp, lerp } from './course.js';
import { SKIS, BOARDS, makeSki, makeBoardGeo, makeHeadItem, makeBodyItems } from './gear.js';

const V = (x, y, z) => new THREE.Vector3(x, y, z);
const PIVOT_Y = 0.85;
const PEL = 0, CH = 1, HD = 2, TH = [3, 5], SH = [4, 6], UA = [7, 9], FA = [8, 10];
const L_TH = 0.45, L_SH = 0.42, L_UA = 0.31, L_FA = 0.28;

// Ruhehaltung (Körperkoordinaten: x rechts, y oben, -z vorne) – muss zu tools/blender_skier.py passen
const P0 = V(0, 1.0, 0), W0 = V(0, 1.07, 0), N0 = V(0, 1.63, 0);
const HIP0 = [V(-0.10, 0.96, 0), V(0.10, 0.96, 0)];
const KNEE0 = [V(-0.10, 0.51, 0), V(0.10, 0.51, 0)];
const SH0 = [V(-0.215, 1.51, 0), V(0.215, 1.51, 0)];
const ARMD = [V(-0.42, -0.9075, 0).normalize(), V(0.42, -0.9075, 0).normalize()];
const EL0 = [0, 1].map((i) => SH0[i].clone().addScaledVector(ARMD[i], L_UA));
const FWD = V(0, 0, -1);

const tA = V(0, 0, 0), tB = V(0, 0, 0), tC = V(0, 0, 0), tD = V(0, 0, 0), tE = V(0, 0, 0);
const bx = V(0, 0, 0), by = V(0, 0, 0), bz = V(0, 0, 0);
const mR = new THREE.Matrix4(), mT = new THREE.Matrix4();
const qA = new THREE.Quaternion(), qB = new THREE.Quaternion(), eA = new THREE.Euler(0, 0, 0, 'YXZ');
const DOWN = V(0, -1, 0);
const BO = { y: 0, z: 0 };

/** Drehmatrix, deren -Y entlang dir zeigt und deren -Z möglichst entlang hint. */
function basis(dir, hint, out) {
  by.copy(dir).negate();
  bz.copy(hint).addScaledVector(by, -hint.dot(by));
  if (bz.lengthSq() < 1e-6) bz.set(0, 0, -1).addScaledVector(by, by.z);
  bz.normalize().negate();
  bx.crossVectors(by, bz).normalize();
  return out.makeBasis(bx, by, bz);
}
const ARM_B0_INV = ARMD.map((d) => basis(d, FWD, new THREE.Matrix4()).clone().transpose());

function ik(A, T, l1, l2, pole, out) {
  tA.copy(T).sub(A);
  let L = tA.length();
  L = clamp(L, Math.abs(l1 - l2) + 0.03, (l1 + l2) * 0.998);
  tA.normalize();
  const a = (l1 * l1 - l2 * l2 + L * L) / (2 * L);
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  tB.copy(pole).addScaledVector(tA, -pole.dot(tA)).normalize();
  return out.copy(A).addScaledVector(tA, a).addScaledVector(tB, h);
}

// Ski biegen (Nose Butter): Der Fuß kippt mit der Schaufel nach unten (Winkel theta) und hebt sich. Wie bei einem echten
// Ski ist die Biegung nicht gleichmäßig: unter der Bindung bleibt er steif (gerade bis uBendS0), im Vorderteil biegt er
// sich, am stärksten in der Mitte, und läuft am Auflagepunkt (uBendS1, Beginn des Schaufel-Rockers) wieder gerade aus.
// Krümmung = theta mal sin² über die Biegestrecke: kein Knick am Anfang und am Ende. Jeder Punkt wird senkrecht zur
// Biegelinie umgelegt; die Schaufel liegt in der Welt genau flach auf dem Schnee, Bogen und Ende liegen darüber.
// Bei uBendT = 0 bleibt alles wie vorher. Gleiche Rechnung in JS: bendPoint (Bodenprüfung, Spuren).
function patchBend(mat, uni) {
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uni);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uBendT;\nuniform float uBendS0;\nuniform float uBendS1;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      if (uBendT > 1e-4) {
        float s = -transformed.z;
        if (s > uBendS0) {
          float L = uBendS1 - uBendS0, t = min(1.0, (s - uBendS0) / L), e = max(0.0, s - uBendS1), w = 6.2831853 * t;
          float ph = uBendT * (t - sin(w) / 6.2831853);
          float u = L * uBendT * (0.5 * t * t + (cos(w) - 1.0) / 39.4784176) + e * sin(uBendT);
          float f = uBendS0 + L * t + e * cos(uBendT);
          transformed.z = -(f - transformed.y * sin(ph));
          transformed.y = u + transformed.y * cos(ph);
        }
      }`);
  };
  mat.customProgramCacheKey = () => 'skiBend3';
}
/** JS-Fassung des Shaders: Punkt (y, z) im Fuß-Rahmen gebogen. */
export function bendPoint(y, z, th, s0, s1, out) {
  const s = -z;
  if (th <= 1e-4 || s <= s0) { out.y = y; out.z = z; return out; }
  const L = s1 - s0, t = Math.min(1, (s - s0) / L), e = Math.max(0, s - s1), w = 2 * Math.PI * t;
  const ph = th * (t - Math.sin(w) / (2 * Math.PI));
  const u = L * th * (0.5 * t * t + (Math.cos(w) - 1) / (4 * Math.PI * Math.PI)) + e * Math.sin(th);
  const f = s0 + L * t + e * Math.cos(th);
  out.z = -(f - y * Math.sin(ph));
  out.y = u + y * Math.cos(ph);
  return out;
}
/** Hub des Fußes, damit der gerade Schaufelteil nach dem Kippen um theta genau auf dem Schnee liegt. */
export function bendLift(th, s0, s1) {
  if (th <= 1e-4) return 0;
  return s1 * Math.sin(th) - 0.5 * (s1 - s0) * th * Math.cos(th);
}
export const BUTTER_TH = 0.2;   // mittlere Biegung: Schaufel 11 bis 12 Grad gekippt, Enden gut 20 cm über dem Schnee

function makeSkinned(geo, mat) {
  const n = geo.attributes.position.count;
  const b0 = geo.attributes._b0, b1 = geo.attributes._b1, w = geo.attributes._w0;
  const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) {
    si[i * 4] = Math.round(b0.getX(i));
    si[i * 4 + 1] = Math.round(b1.getX(i));
    sw[i * 4] = w.getX(i);
    sw[i * 4 + 1] = 1 - w.getX(i);
  }
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  const m = new THREE.SkinnedMesh(geo, mat);
  m.frustumCulled = false;
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export class Skier {
  constructor(models) {
    this.root = new THREE.Group();
    this.pivot = new THREE.Group();       // dreht den ganzen Körper um die Körpermitte (Flips, Spins, Sturz)
    this.pivot.rotation.order = 'YXZ';
    this.pivot.position.y = PIVOT_Y;
    this.body = new THREE.Group();
    this.body.position.y = -PIVOT_Y;
    this.body.scale.setScalar(0.94);
    this.root.add(this.pivot);
    this.pivot.add(this.body);

    this.jacketMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    this.accentMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 });
    this.pantsMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88 });
    const fixedMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 });
    const lensMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.18, metalness: 0.2 });
    const skiMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.15 });
    this.bendU = { uBendT: { value: 0 }, uBendS0: { value: 0.16 }, uBendS1: { value: 0.55 } };
    this.butterTh = 0;
    this.bendS0 = 0.16; this.bendS1 = 0.55; this.skiHalfW = 0.065;
    patchBend(skiMat, this.bendU);

    this.bones = [];
    for (let i = 0; i < 11; i++) {
      const b = new THREE.Bone();
      b.matrixAutoUpdate = false;
      this.body.add(b);
      this.bones.push(b);
    }
    this.skeleton = new THREE.Skeleton(this.bones);
    this.fpvMats = [this.jacketMat, this.accentMat, this.pantsMat, fixedMat, lensMat];   // in der Ego-Sicht unsichtbar (Schatten bleibt)
    this.skinned = {};
    for (const [name, mat] of [['Sk_Jacket', this.jacketMat], ['Sk_JacketAcc', this.accentMat], ['Sk_Pants', this.pantsMat], ['Sk_Fixed', fixedMat], ['Sk_Lens', lensMat]]) {
      const m = makeSkinned(models[name], mat);
      this.body.add(m);
      m.bind(this.skeleton, new THREE.Matrix4());
      this.skinned[name] = m;
    }

    const rigid = (name, mat, parent) => {
      const o = new THREE.Mesh(models[name], mat);
      o.castShadow = true;
      o.receiveShadow = true;
      parent.add(o);
      return o;
    };
    const bootMat = fixedMat.clone(), poleMat = skiMat.clone();
    this.sides = [-1, 1].map((side) => {
      const foot = new THREE.Object3D();
      foot.rotation.order = 'YXZ';
      this.body.add(foot);
      const boot = rigid('Sk_Boot', bootMat, foot);
      boot.position.set(0, 0.036, 0);
      const ski = rigid('Sk_Ski', skiMat, this.body);
      return {
        side, foot, ski, pole: rigid('Sk_Pole', poleMat, this.body), loose: null,
        hip: V(0, 0, 0), knee: V(0, 0, 0), ankle: V(0, 0, 0), shoulder: V(0, 0, 0), elbow: V(0, 0, 0), hand: V(0, 0, 0),
      };
    });
    // Der Fahrer wird nach den Schneepartikeln gezeichnet (Tiefentest bleibt), damit Wolken ihn nie verdecken
    this.root.traverse((o) => {
      if (o.isMesh) { o.renderOrder = 10; o.material.transparent = true; }
    });
    this.mPel = new THREE.Matrix4();
    this.mCh = new THREE.Matrix4();
    this.t = 0;
    // Snowboard: Brett entlang der Körper-Querachse (die Füße stehen nebeneinander auf dem Brett), Fahrer seitlich
    this.board = makeBoard();
    this.board.visible = false;
    this.board.renderOrder = 10;
    this.body.add(this.board);
    this.gear = 'ski';
    this.skiMat = skiMat;
    this.head = null;
  }

  /** Umgebungs-Spiegelung (nur für Metall: Gold-Ski, Krone, Schnallen); die übrige Szene bleibt ohne. */
  setEnv(tex) {
    this.env = tex;
    this.root.traverse((o) => { if (o.isMesh && o.material.userData && o.material.userData.metal) { o.material.envMap = tex; o.material.needsUpdate = true; } });
  }
  metalize(grp) { if (this.env) grp.traverse((o) => { if (o.isMesh && o.material.userData && o.material.userData.metal) o.material.envMap = this.env; }); }
  /** Material für Teile aus echtem Metall (Gold): spiegelt die Umgebung, Farbe aus den Ecken. */
  goldMat() {
    if (!this._gold) {
      this._gold = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 0.24, side: THREE.DoubleSide, transparent: true });
      this._gold.userData.metal = true;
      patchBend(this._gold, this.bendU);
    }
    if (this.env) this._gold.envMap = this.env;
    return this._gold;
  }
  /** Ski-Modell aus dem Shop (gear.js); beide Ski teilen sich eine Geometrie. Metall-Ski (Gold) mit eigenem Material. */
  setSkiDesign(id) {
    const d = SKIS[id] || SKIS.allround;
    if (this.skiId === id) return;
    this.skiId = id;
    const g = makeSki(d);
    // Biegung: gerade bis vor die Schuhspitze, Auflagepunkt dort, wo der Schaufel-Rocker beginnt; halbe Breite für die Kante
    this.skiDef = d;
    this.bendS0 = 0.18;
    this.bendS1 = Math.max(0.4, d.len * 0.53 - d.len * (d.twin ? 0.2 : 0.22) - 0.02);
    this.skiHalfW = Math.max(d.tip, d.tail) / 2;
    this.bendU.uBendS0.value = this.bendS0; this.bendU.uBendS1.value = this.bendS1;
    this.skiMat.side = THREE.DoubleSide;
    this.skiMat.roughness = 0.32;
    for (const k of this.sides) {
      const old = k.ski.geometry; k.ski.geometry = g; k.ski.material = d.metal ? this.goldMat() : this.skiMat;
      if (old && !old.userData.shared && old !== g && !this.sides.some((q) => q.ski.geometry === old)) old.dispose();
    }
  }
  /** Wo liegt Ski i gerade auf dem Schnee? Tastet die Unterseite (mit Rocker und Butter-Biegung) an 18 Stellen ab und
   * gibt Anfang und Ende des tiefsten zusammenhängenden Stücks in Koordinaten des Fahrers (root) zurück: x rechts,
   * y oben, z hinten. Für die Spuren bei Ski-Tricks. */
  contactSpan(i, out) {
    const d = this.skiDef || SKIS.allround, k = this.sides[i], L = d.len, z0 = -L * 0.53, z1 = L * 0.47;
    const zTipR = z0 + L * (d.twin ? 0.2 : 0.22), zTailR = z1 - L * (d.twin ? 0.18 : 0.12), N = 18;
    this.pivot.updateMatrix(); this.body.updateMatrix(); k.ski.updateMatrix();
    mT.multiplyMatrices(this.pivot.matrix, this.body.matrix).multiply(k.ski.matrix);
    const th = this.butterTh, pts = this._cs || (this._cs = Array.from({ length: N + 1 }, () => V(0, 0, 0)));
    let minY = 1e9;
    for (let j = 0; j <= N; j++) {
      const z = z0 + (z1 - z0) * (j / N);
      let y = 0;
      if (z < zTipR) { const u = (zTipR - z) / (zTipR - z0); y = d.rockT * u * u * (1.25 - 0.25 * u); }
      if (z > zTailR) { const u = (z - zTailR) / (z1 - zTailR); y = d.rockL * u * u; }
      bendPoint(y, z, th, this.bendS0, this.bendS1, BO);
      pts[j].set(0, BO.y, BO.z).applyMatrix4(mT);
      if (pts[j].y < minY) minY = pts[j].y;
    }
    let a = -1, b = -1;
    for (let j = 0; j <= N; j++) if (pts[j].y < minY + 0.012) { if (a < 0) a = j; b = j; }
    out.hx = pts[a].x; out.hz = pts[a].z; out.tx = pts[b].x; out.tz = pts[b].z; out.n = b - a;
    return out;
  }
  setBoardDesign(id) {
    const d = BOARDS[id] || BOARDS.classic;
    if (this.boardId === id) return;
    this.boardId = id;
    const g = makeBoardGeo(d);
    g.translate(0, -0.006, 0);   // Belag wie beim alten Brett knapp unter der Brettmitte
    this.board.geometry.dispose();
    this.board.geometry = g;
    if (!this.boardMat) this.boardMat = this.board.material;
    this.board.material = d.metal ? this.goldMat() : this.boardMat;
    this.board.material.side = THREE.DoubleSide;
  }
  /** Ausrüstung am Körper zum Outfit (Gürtel, Startnummer, Rucksack, Schal, Medaille). */
  setBody(kind) {
    if (this.bodyKind === kind) return;
    this.bodyKind = kind;
    if (this.bodyItems) {
      for (const [i, g] of [[PEL, this.bodyItems.pel], [CH, this.bodyItems.ch]]) { this.bones[i].remove(g); g.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); if (o.material.map) o.material.map.dispose(); o.material.dispose(); } }); }
      this.bodyItems = null;
    }
    if (!kind) return;
    this.bodyItems = makeBodyItems(kind);
    this.metalize(this.bodyItems.pel); this.metalize(this.bodyItems.ch);
    this.bones[PEL].add(this.bodyItems.pel);
    this.bones[CH].add(this.bodyItems.ch);
    this.bodyItems.pel.visible = this.bodyItems.ch.visible = !this.fpv;
  }
  /** Kopfteil zum Outfit (Weihnachtsmütze mit Bart, Zylinder, Stirnband, Krone) am Kopfknochen. */
  setHead(kind) {
    if (this.headKind === kind) return;
    this.headKind = kind;
    if (this.head) { this.bones[HD].remove(this.head); this.head.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } }); this.head = null; }
    if (!kind) return;
    this.head = makeHeadItem(kind);
    this.metalize(this.head);
    this.head.visible = !this.fpv;
    this.bones[HD].add(this.head);
  }

  /** 'ski' oder 'board' */
  setGear(g) {
    this.gear = g;
    const b = g === 'board';
    this.board.visible = b;
    for (const k of this.sides) { k.ski.visible = !b; k.pole.visible = !b; }
    this.body.rotation.y = b ? -Math.PI / 2 : 0;   // Regular: linker Fuß vorne, Blick zur rechten Seite der Fahrtrichtung
  }

  /** Ego-Sicht: Körper, Helm und Stöcke nicht zeichnen (sie würden die Kamera verdecken), ihr Schatten bleibt sichtbar. */
  setFirstPerson(on) {
    if (this.fpv === on) return;
    this.fpv = on;
    for (const m of this.fpvMats) { m.colorWrite = !on; m.depthWrite = !on; }
    if (this.head) this.head.visible = !on;
    if (this.bodyItems) this.bodyItems.pel.visible = this.bodyItems.ch.visible = !on;
  }

  setColors(jacket, accent, pants) {
    this.jacketMat.color.set(jacket);
    this.accentMat.color.set(accent);
    this.pantsMat.color.set(pants);
  }

  /** Setzt Knochen i so, dass der Ruhepunkt p0 nach p1 wandert und um ihn mit R gedreht wird. */
  setBone(i, p1, R, p0) {
    const m = this.bones[i].matrix;
    m.copy(R);
    tE.copy(p0).applyMatrix4(R);          // R hat hier noch keine Verschiebung
    m.setPosition(p1.x - tE.x, p1.y - tE.y, p1.z - tE.z);
    this.bones[i].matrixWorldNeedsUpdate = true;
    return m;
  }

  // ------------------------------------------------------------ lose Ski beim Sturz
  detachSkis(parent, vel) {
    for (const k of this.sides) {
      if (k.loose) continue;
      parent.attach(k.ski);
      k.loose = {
        vel: vel.clone().multiplyScalar(0.55 + Math.random() * 0.35).add(V((Math.random() - 0.5) * 6, 3 + Math.random() * 4, (Math.random() - 0.5) * 6)),
        ang: V((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 9, (Math.random() - 0.5) * 14),
      };
    }
  }
  attachSkis() {
    for (const k of this.sides) {
      if (!k.loose) continue;
      k.loose = null;
      this.body.add(k.ski);
      k.ski.scale.setScalar(1);
    }
  }
  updateLoose(dt, heightFn) {
    for (const k of this.sides) {
      const l = k.loose;
      if (!l) continue;
      const s = k.ski;
      l.vel.y -= 9.81 * dt;
      s.position.addScaledVector(l.vel, dt);
      s.rotateX(l.ang.x * dt); s.rotateY(l.ang.y * dt); s.rotateZ(l.ang.z * dt);
      const h = heightFn(s.position.x, s.position.z) + 0.06;
      if (s.position.y < h) {
        s.position.y = h;
        if (l.vel.y < 0) l.vel.y *= -0.3;
        const f = Math.exp(-dt * 2.2);
        l.vel.x *= f; l.vel.z *= f;
        l.ang.multiplyScalar(Math.exp(-dt * 4));
      }
    }
  }

  /** s: { lean, crouch, steer, plow, air, compress, speed, grab, tuck, spin, extend, crash, crashA } */
  update(s, dt) {
    this.t += dt;
    const lean = clamp(s.lean, -0.9, 0.9);
    const air = s.air, grab = s.grab || 0, tuck = s.tuck || 0, spin = s.spin || 0, ext = (s.extend || 0) * air;
    const crash = s.crash || 0, ca = s.crashA || 0;
    const sup = s.sup || 0, cross = s.cross || 0;   // Spezialtricks: Superman (gestreckt), Iron Cross (Ski gekreuzt)
    const daffy = s.daffy || 0;                     // Daffy: linkes Bein weit nach vorn (Spitze hoch), rechtes nach hinten
    const tweak = s.tweak || 0;                     // Japan Air: Ski hinter dem Körper hochgezogen, Spitzen nach unten
    // Nose Butter (Taste E): Gewicht über den Schaufeln, Ski gebogen, Enden in der Luft
    const butter = this.gear === 'board' ? 0 : clamp(s.butter || 0, 0, 1);
    // Biegung: s.butterTh (Radiant) aus dem Trick, sonst Standard; schwankt beim echten Butter mit dem Druck
    const bTh = this.gear === 'board' ? 0 : s.butterTh !== undefined ? s.butterTh : BUTTER_TH * butter;
    const bLift = bendLift(bTh, this.bendS0, this.bendS1);
    this.bendU.uBendT.value = bTh; this.butterTh = bTh;
    let c = clamp(Math.max(s.crouch + s.compress * 0.7 + air * 0.25, tuck * 0.9, grab * 0.75, cross * 0.7), 0, 1);
    c = lerp(c, 0.08, Math.max(ext, sup, daffy * 0.7));
    if (crash) c = 0.35;
    const plow = s.plow * (1 - butter);
    const idle = 1 - clamp(s.speed / 3, 0, 1);
    const bob = Math.sin(this.t * 2.2) * 0.012 * idle + Math.sin(this.t * 31) * 0.004 * clamp(s.speed / 30, 0, 1);
    const hipH = lerp(1.0, 0.70, c) - 0.09 * Math.abs(lean) + 0.13 * butter;   // beim Butter stehen die Füße höher
    const edge = clamp(lean * 1.2, -1.05, 1.05);
    const spinAbs = Math.abs(spin) * (1 - grab) * (1 - tuck);

    // Becken
    tC.set(Math.sin(lean) * hipH * 0.88, Math.cos(lean) * hipH + bob, 0.05 + 0.10 * c - 0.2 * butter);   // Butter: Hüfte nach vorn über die Schuhspitzen
    eA.set(-(0.10 + 0.30 * c), s.steer * 0.10 + spin * 0.15, -lean * 0.55);
    mR.makeRotationFromEuler(eA);
    this.mPel.copy(this.setBone(PEL, tC, mR, P0));

    // Oberkörper
    const bend = 0.34 + 0.70 * c - air * 0.12 * (1 - grab) * (1 - tuck) + 0.22 * butter;
    tC.copy(W0).applyMatrix4(this.mPel);
    const look = s.look || 0;   // rückwärts fahren: Oberkörper dreht mit, Kopf schaut über die Schulter in Fahrtrichtung
    eA.set(-bend, s.steer * 0.18 + spin * 0.45 + grab * 0.2 + look * 0.55 + (crash ? Math.sin(ca * 1.3) * 0.5 : 0), -lean * 0.18);
    qA.setFromEuler(eA);
    mR.makeRotationFromQuaternion(qA);
    this.mCh.copy(this.setBone(CH, tC, mR, W0));

    // Kopf: blickt nach vorne, leicht in die Kurve bzw. Drehrichtung
    tC.copy(N0).applyMatrix4(this.mCh);
    eA.set(bend * 0.8 - tuck * 0.35, s.steer * 0.25 + spin * 0.5 + look * 1.15, 0);
    qB.setFromEuler(eA).premultiply(qA);
    mR.makeRotationFromQuaternion(qB).scale(tD.set(1.08, 1.08, 1.08));
    this.setBone(HD, tC, mR, N0);

    for (let i = 0; i < 2; i++) {
      const k = this.sides[i], side = k.side;
      // Fuß/Ski
      const f = k.foot;
      if (crash) {
        f.position.set(side * (0.24 + 0.08 * Math.sin(ca * 1.3 + side)), 0.28 + 0.2 * Math.sin(ca * 1.9 + side * 1.7), -0.05 + 0.32 * Math.sin(ca * 1.1 + side * 2.3));
        f.rotation.set(0.6 * Math.sin(ca * 1.5 + side), side * 0.5, 0.4 * Math.sin(ca * 2 + side));
      } else if (this.gear === 'board') {
        // Bindungen: Füße 52 cm auseinander, Duck-Stellung (vorne +15, hinten -15 Grad), Brett hebt sich beim Grab
        f.position.set(side * 0.26, 0.032 + grab * 0.22 + tuck * 0.14, 0);
        // Kantenwinkel des Bretts über den Körper hinaus (Angulation): Füße und Brett kippen um die Brett-Längsachse
        f.rotation.set(grab * 0.25 + tuck * 0.1 + (s.edge || 0), side * 0.26, 0);
      } else {
        const stance = 0.17 + 0.07 * Math.abs(lean) + 0.13 * plow + air * 0.03 + grab * 0.03;
        // Kante: der Ski kippt um seine Mitte; um die halbe Breite mal Kantenwinkel anheben, damit die untere Kante genau
        // auf dem Schnee liegt statt einzutauchen (auch beim Pflug, wo die Ski nach innen kanten)
        const rollZ = -(edge - side * plow * 0.28) - side * cross * 0.35;
        f.position.set(side * stance * (1 - 0.25 * cross) * (1 - 0.35 * daffy), Math.abs(Math.sin(rollZ)) * this.skiHalfW + grab * 0.2 + tuck * 0.16 + cross * 0.22 + sup * 0.1 + daffy * (side < 0 ? 0.2 : 0.06) + tweak * 0.3, -0.09 * lean * side - grab * 0.06 + cross * 0.12 + sup * 0.32 + daffy * (side < 0 ? -0.46 : 0.42) + tweak * 0.42);
        // Pflug: vorwärts Spitzen zusammen, rückwärts Enden zusammen (plowDir = -1) – der Keil öffnet sich immer in Fahrtrichtung
        f.rotation.set(air * 0.1 * (1 - ext) + grab * 0.32 + tuck * 0.12 - sup * 0.35 + daffy * (side < 0 ? 0.6 : -0.55) - tweak * 0.85, side * (plow * 0.33 * (s.plowDir || 1) + grab * 0.22 + cross * 0.75), rollZ);
      }
      // Nose Butter: Schaufel nach unten gekippt, Fuß so weit angehoben, dass die Schaufel genau auf dem Schnee liegt
      if (bTh > 1e-4 && !crash) { f.rotation.x -= bTh; f.position.y += bLift + 0.003; }
      f.updateMatrix();
      const boot = f.children[0];
      if (!k.loose) {
        k.ski.position.copy(f.position);
        k.ski.quaternion.copy(f.quaternion);
      }
      if (boot && boot.rotation.x !== 0) { boot.updateMatrix(); k.ankle.set(0, 0.309, -0.02).applyMatrix4(boot.matrix).applyMatrix4(f.matrix); }
      else k.ankle.set(0, 0.345, -0.02).applyMatrix4(f.matrix);
      k.hip.copy(HIP0[i]).applyMatrix4(this.mPel);
      tD.set(side * (0.12 + grab * 0.35 + tuck * 0.3), 0.25, -1);
      ik(k.hip, k.ankle, L_TH, L_SH, tD, k.knee);
      tC.copy(k.knee).sub(k.hip).normalize();
      this.setBone(TH[i], k.hip, basis(tC, tD, mR), HIP0[i]);
      tC.copy(k.ankle).sub(k.knee).normalize();
      this.setBone(SH[i], k.knee, basis(tC, tD, mR), KNEE0[i]);

      // Arm
      k.shoulder.copy(SH0[i]).applyMatrix4(this.mCh);
      if (crash) {
        k.hand.copy(k.shoulder);
        k.hand.x += side * (0.38 + 0.12 * Math.sin(ca * 1.7 + side * 2));
        k.hand.y += 0.15 + 0.3 * Math.sin(ca * 2.3 + side);
        k.hand.z += -0.1 + 0.3 * Math.cos(ca * 1.3 + side);
      } else {
        tC.copy(k.shoulder);
        tC.x += side * (0.24 + air * 0.16);
        tC.y += -0.36 - side * lean * 0.10 + air * 0.14;
        tC.z += -0.30;
        tD.set(side * 0.36, 1.30, -0.36).applyMatrix4(this.mCh);
        k.hand.copy(tC).lerp(tD, clamp(s.crouch, 0, 1) * (1 - air));
        if (spinAbs > 0.01) k.hand.lerp(tD.set(side * 0.34, 1.28, -0.22).applyMatrix4(this.mCh), Math.min(1, spinAbs) * 0.85);
        if (tuck > 0.01) k.hand.lerp(tD.copy(k.knee).add(tC.set(side * 0.17, 0.03, -0.12)), tuck * (1 - grab));
        if (grab > 0.01) {
          // Grab-Arten: 0 Safety (rechte Hand an rechten Ski), -1 Mute (linke Hand an linken Ski), 1 Tail (rechte Hand ans Skiende)
          const gs = s.grabSide || 0, gHand = gs < 0 ? -1 : 1;
          if (side === gHand) tD.set(side * 0.13, 0.11, gs > 0 ? 0.5 : -0.22).applyMatrix4(f.matrix);
          else tD.copy(k.shoulder).add(tC.set(side * 0.42, 0.26, 0.05));
          k.hand.lerp(tD, grab);
        }
        // Superman: Arme gestreckt nach vorne oben; Iron Cross: Arme weit zur Seite
        if (sup > 0.01) k.hand.lerp(tD.set(side * 0.2, 1.62, -0.62).applyMatrix4(this.mCh), sup);
        if (cross > 0.01) k.hand.lerp(tD.copy(k.shoulder).add(tC.set(side * 0.62, 0.12, -0.12)), cross);
        if (daffy > 0.01) k.hand.lerp(tD.copy(k.shoulder).add(tC.set(side * 0.5, 0.18, side * 0.25)), daffy);   // Arme seitlich zum Ausgleich
        // Nose Butter: Arme seitlich vorn, Stöcke zum Ausbalancieren abgespreizt
        if (butter > 0.01) k.hand.lerp(tD.copy(k.shoulder).add(tC.set(side * 0.46, -0.2, -0.34)), butter * 0.85);
      }
      if (this.gear === 'board' && !crash && grab < 0.01) {
        // ohne Stöcke: Arme locker seitlich, leicht vor dem Körper, zum Ausbalancieren
        tD.set(side * 0.62, 0.95 - c * 0.18 + air * 0.25, -0.18 - side * 0.12).applyMatrix4(this.mPel);
        k.hand.lerp(tD, 0.85);
      }
      tD.set(side * 0.8, -0.45, 0.5);
      ik(k.shoulder, k.hand, L_UA, L_FA, tD, k.elbow);
      tD.negate();
      tC.copy(k.elbow).sub(k.shoulder).normalize();
      this.setBone(UA[i], k.shoulder, basis(tC, tD, mR).multiply(ARM_B0_INV[i]), SH0[i]);
      tC.copy(k.hand).sub(k.elbow).normalize();
      this.setBone(FA[i], k.elbow, basis(tC, tD, mR).multiply(ARM_B0_INV[i]), EL0[i]);

      if (i === 1 && this.gear === 'board') {
        const a = this.sides[0].foot, b2 = this.sides[1].foot;
        this.board.position.set(0, (a.position.y + b2.position.y) / 2 - 0.03, 0);   // Stiefel stehen auf dem Brett
        this.board.rotation.set(0, 0, (a.rotation.x + b2.rotation.x) / 2 * 0);
        this.board.rotation.x = (a.rotation.x + b2.rotation.x) / 2;
      }
      // Stock in der Hand
      k.pole.position.copy(k.hand).addScaledVector(tC, 0.09);
      tB.set(side * 0.10, -0.66, 0.74);
      tD.set(side * 0.34, 0.12, 0.93);
      tB.lerp(tD, clamp(s.crouch * 1.4 + air * 0.5 + grab + tuck + crash, 0, 1)).normalize();
      k.pole.quaternion.setFromUnitVectors(DOWN, tB);
    }
  }
}

/** Snowboard: Taillierung, aufgebogene Nose und Tail, Belag dunkel, Oberseite mit Streifen. Länge entlang X. */
function makeBoard() {
  const L = 1.56, W = 0.27, geo = new THREE.BoxGeometry(L, 0.018, W, 32, 1, 4);
  const p = geo.attributes.position, col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), t = Math.abs(x) / (L / 2);
    const side = 1 - 0.07 * Math.cos(Math.min(1, t / 0.8) * Math.PI / 2) - (t > 0.82 ? (1 - Math.sqrt(Math.max(0, 1 - ((t - 0.82) / 0.18) ** 2))) * 0.75 : 0);
    p.setZ(i, z * side);
    p.setY(i, y + (t > 0.88 ? 0.028 * ((t - 0.88) / 0.12) ** 2 : 0));   // Nose und Tail nur ganz leicht aufgebogen: von hinten liegt das Ende sichtbar auf
    const top = y > 0, stripe = Math.abs(Math.sin(x * 7.5)) > 0.85;
    const c = top ? (stripe ? [1.0, 0.42, 0.08] : [0.12, 0.14, 0.18]) : [0.05, 0.05, 0.06];
    col.set(c, i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.1, transparent: true }));
  m.castShadow = true;
  return m;
}
