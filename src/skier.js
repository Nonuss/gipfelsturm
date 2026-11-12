// Skifahrer: zusammenhängendes Modell aus Blender, das über 11 Knochen weich verformt wird (Skinning).
// Die Haltung wird prozedural berechnet: Becken/Oberkörper aus Fahrzustand, Beine und Arme per Zwei-Gelenk-IK.
import * as THREE from 'three';
import { clamp, lerp } from './course.js';

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

    this.bones = [];
    for (let i = 0; i < 11; i++) {
      const b = new THREE.Bone();
      b.matrixAutoUpdate = false;
      this.body.add(b);
      this.bones.push(b);
    }
    this.skeleton = new THREE.Skeleton(this.bones);
    for (const [name, mat] of [['Sk_Jacket', this.jacketMat], ['Sk_JacketAcc', this.accentMat], ['Sk_Pants', this.pantsMat], ['Sk_Fixed', fixedMat], ['Sk_Lens', lensMat]]) {
      const m = makeSkinned(models[name], mat);
      this.body.add(m);
      m.bind(this.skeleton, new THREE.Matrix4());
    }

    const rigid = (name, mat, parent) => {
      const o = new THREE.Mesh(models[name], mat);
      o.castShadow = true;
      o.receiveShadow = true;
      parent.add(o);
      return o;
    };
    this.sides = [-1, 1].map((side) => {
      const foot = new THREE.Object3D();
      foot.rotation.order = 'YXZ';
      this.body.add(foot);
      const boot = rigid('Sk_Boot', fixedMat, foot);
      boot.position.set(0, 0.036, 0);
      const ski = rigid('Sk_Ski', skiMat, this.body);
      return {
        side, foot, ski, pole: rigid('Sk_Pole', skiMat, this.body), loose: null,
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
    let c = clamp(Math.max(s.crouch + s.compress * 0.7 + air * 0.25, tuck * 0.9, grab * 0.75), 0, 1);
    c = lerp(c, 0.08, ext);
    if (crash) c = 0.35;
    const plow = s.plow;
    const idle = 1 - clamp(s.speed / 3, 0, 1);
    const bob = Math.sin(this.t * 2.2) * 0.012 * idle + Math.sin(this.t * 31) * 0.004 * clamp(s.speed / 30, 0, 1);
    const hipH = lerp(1.0, 0.70, c) - 0.09 * Math.abs(lean);
    const edge = clamp(lean * 1.2, -1.05, 1.05);
    const spinAbs = Math.abs(spin) * (1 - grab) * (1 - tuck);

    // Becken
    tC.set(Math.sin(lean) * hipH * 0.88, Math.cos(lean) * hipH + bob, 0.05 + 0.10 * c);
    eA.set(-(0.10 + 0.30 * c), s.steer * 0.10 + spin * 0.15, -lean * 0.55);
    mR.makeRotationFromEuler(eA);
    this.mPel.copy(this.setBone(PEL, tC, mR, P0));

    // Oberkörper
    const bend = 0.34 + 0.70 * c - air * 0.12 * (1 - grab) * (1 - tuck);
    tC.copy(W0).applyMatrix4(this.mPel);
    eA.set(-bend, s.steer * 0.18 + spin * 0.45 + grab * 0.2 + (crash ? Math.sin(ca * 1.3) * 0.5 : 0), -lean * 0.18);
    qA.setFromEuler(eA);
    mR.makeRotationFromQuaternion(qA);
    this.mCh.copy(this.setBone(CH, tC, mR, W0));

    // Kopf: blickt nach vorne, leicht in die Kurve bzw. Drehrichtung
    tC.copy(N0).applyMatrix4(this.mCh);
    eA.set(bend * 0.8 - tuck * 0.35, s.steer * 0.25 + spin * 0.5, 0);
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
      } else {
        const stance = 0.17 + 0.07 * Math.abs(lean) + 0.13 * plow + air * 0.03 + grab * 0.03;
        f.position.set(side * stance, Math.abs(Math.sin(edge)) * 0.03 + grab * 0.2 + tuck * 0.16, -0.09 * lean * side - grab * 0.06);
        f.rotation.set(air * 0.1 * (1 - ext) + grab * 0.32 + tuck * 0.12, side * (plow * 0.33 + grab * 0.22), -(edge - side * plow * 0.28));
      }
      f.updateMatrix();
      if (!k.loose) {
        k.ski.position.copy(f.position);
        k.ski.quaternion.copy(f.quaternion);
      }
      k.ankle.set(0, 0.345, -0.02).applyMatrix4(f.matrix);
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
          if (side > 0) tD.set(0.13, 0.11, -0.22).applyMatrix4(f.matrix);
          else tD.copy(k.shoulder).add(tC.set(-0.42, 0.26, 0.05));
          k.hand.lerp(tD, grab);
        }
      }
      tD.set(side * 0.8, -0.45, 0.5);
      ik(k.shoulder, k.hand, L_UA, L_FA, tD, k.elbow);
      tD.negate();
      tC.copy(k.elbow).sub(k.shoulder).normalize();
      this.setBone(UA[i], k.shoulder, basis(tC, tD, mR).multiply(ARM_B0_INV[i]), SH0[i]);
      tC.copy(k.hand).sub(k.elbow).normalize();
      this.setBone(FA[i], k.elbow, basis(tC, tD, mR).multiply(ARM_B0_INV[i]), EL0[i]);

      // Stock in der Hand
      k.pole.position.copy(k.hand).addScaledVector(tC, 0.09);
      tB.set(side * 0.10, -0.66, 0.74);
      tD.set(side * 0.34, 0.12, 0.93);
      tB.lerp(tD, clamp(s.crouch * 1.4 + air * 0.5 + grab + tuck + crash, 0, 1)).normalize();
      k.pole.quaternion.setFromUnitVectors(DOWN, tB);
    }
  }
}
