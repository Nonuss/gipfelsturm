// Lawine (Heli-Berg): Ein Schneebrett reißt oberhalb des Fahrers ab, die Front rollt hangabwärts und wird
// auf steilem Gelände schneller (bis ~110 km/h), auf flachem Gelände langsamer, bis sie liegen bleibt.
// Sichtbar als riesige, quellende Staubwolke aus vielen weichen Ballen (ein InstancedMesh, ein Draw-Call).
import * as THREE from 'three';

const N = 520;
const AX = new THREE.Vector3(0.3, 1, 0.2).normalize();
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3();

export class Avalanche {
  constructor(scene) {
    const geo = new THREE.IcosahedronGeometry(1, 2);
    const mat = new THREE.MeshLambertMaterial({ color: 0xf2f6fc, transparent: true, opacity: 0.88, depthWrite: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, N);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    this.mesh.count = 0;
    scene.add(this.mesh);
    this.b = Array.from({ length: N }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 0, s1: 0, t: 0, life: 0 }));
    this.next = 0;
    this.active = false;
    this.cool = 0;
    this.acc = 0;
  }

  /** Abriss: Front startet `d` Meter (Hangabstand), quer bei x (relativ zur Mittellinie xRel), Breite w. */
  start(d, xRel, w) {
    Object.assign(this, { active: true, front: d, xRel, w, speed: 7, t: 0, stopped: 0, travelled: 0 });
  }

  stop() { this.active = false; this.mesh.count = 0; for (const b of this.b) b.life = 0; }

  /** Ein Ballen Staub an der Front. */
  puff(x, y, z, vDown, big) {
    const b = this.b[this.next];
    this.next = (this.next + 1) % N;
    const s = big ? 2.5 + Math.random() * 3 : 1.2 + Math.random() * 2;
    Object.assign(b, {
      x, y, z, s, s1: s * (big ? 2.6 + Math.random() * 2 : 2 + Math.random()), t: 0, life: 3.2 + Math.random() * 2.6,
      vx: (Math.random() - 0.5) * 4, vy: 2 + Math.random() * (big ? 9 : 5), vz: -vDown * (0.75 + Math.random() * 0.3),
    });
  }

  /**
   * dt: Zeitschritt; C: course (height, centerX); player: Position; returns { caught, ended, near }.
   */
  update(dt, C, player) {
    const res = { caught: false, ended: false, near: 0 };
    if (this.active) {
      this.t += dt;
      const hub = C.centerX(this.front), x = hub + this.xRel;
      const y0 = C.height(x, -this.front), y1 = C.height(x, -(this.front + 8));
      const slope = (y0 - y1) / 8;
      const vmax = 6 + 28 * Math.min(1, Math.max(0, (slope - 0.15) / 0.45));
      this.speed += Math.max(-6, Math.min(5, (vmax - this.speed) * 0.8)) * dt;
      this.front += this.speed * dt;
      this.travelled += this.speed * dt;
      // Staub über die ganze Breite der Front, unregelmäßige Kante
      this.acc += dt * (60 + this.w * 1.6) * Math.min(1, 0.4 + this.speed / 18);
      while (this.acc >= 1) {
        this.acc -= 1;
        const u = (Math.random() - 0.5) * this.w, ox = x + u + Math.sin(this.t * 1.7 + u * 0.13) * 3;
        const dz = this.front + Math.random() * 5 - 2 * Math.cos(u * 0.09 + this.t);
        this.puff(ox, C.height(ox, -dz) + Math.random() * 1.5, -dz, this.speed, Math.random() < 0.45);
      }
      // erfasst? Front ist am Fahrer vorbei und er steckt in der Breite
      const pd = -player.z, pu = player.x - hub;
      if (this.front > pd - 1.5 && this.front < pd + 25 && Math.abs(pu - this.xRel) < this.w / 2 + 2) res.caught = true;
      const dist = Math.hypot(pd - this.front, (pu - this.xRel) * 0.6);
      res.near = Math.max(0, 1 - dist / 90);
      if (this.speed < 2.5 && this.t > 4) this.stopped += dt;
      if (this.stopped > 1.5 || this.travelled > 900 || this.front > pd + 260) { this.active = false; res.ended = true; this.cool = 22; }
    } else this.cool = Math.max(0, this.cool - dt);
    // Ballen bewegen: anfangs mit der Lawine, dann bremsen, aufquellen und absinken
    let n = 0;
    for (let i = 0; i < N; i++) {
      const b = this.b[i];
      if (b.life <= 0) continue;
      b.t += dt;
      if (b.t >= b.life) { b.life = 0; continue; }
      const k = Math.exp(-dt * 0.9);
      b.vx *= k; b.vz *= k; b.vy = b.vy * Math.exp(-dt * 1.4) - 0.6 * dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      const f = b.t / b.life;
      const s = b.s + (b.s1 - b.s) * Math.min(1, f * 1.6);
      const sc = s * (f > 0.8 ? 1 - (f - 0.8) * 3.5 : 1);
      tmpP.set(b.x, b.y, b.z);
      tmpS.setScalar(Math.max(0.01, sc));
      tmpQ.setFromAxisAngle(AX, i * 1.7 + b.t * 0.4);
      tmpM.compose(tmpP, tmpQ, tmpS);
      this.mesh.setMatrixAt(n++, tmpM);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    return res;
  }
}
