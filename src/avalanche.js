// Lawine (Heli-Berg), in drei sichtbaren Phasen wie bei einem echten Schneebrett:
//  1. Riss      – oberhalb des Fahrers reißt eine gezackte Abrisskante auf und läuft in Sekundenbruchteilen nach
//                 beiden Seiten; von ihr aus schießen Risse hangabwärts durch die Schneedecke.
//  2. Bruch     – die Platte zerbricht in Schollen, die losrutschen, kippen und zerfallen.
//  3. Staub     – unterhalb quillt die Staubwolke auf; die Front wird im Steilen schneller (bis ~120 km/h) und
//                 läuft im Flachen aus.
// Die Abrisskante bleibt im Hang stehen, bis die Lawine zurückgesetzt wird (stop()).
import * as THREE from 'three';

const N = 520, NB = 440;
const CRACK_T = 0.85;          // so lange wächst der Riss, bevor die Platte losbricht (s)
const AX = new THREE.Vector3(0.3, 1, 0.2).normalize();
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(), tmpP = new THREE.Vector3(), tmpE = new THREE.Euler();

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
    // Schollen der Platte
    this.blocks = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.72, 0), new THREE.MeshLambertMaterial({ color: 0xf1f5fc, flatShading: true }), NB);   // kantige Schollen
    this.blocks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.blocks.frustumCulled = false;
    this.blocks.castShadow = true;
    this.blocks.count = 0;
    scene.add(this.blocks);
    this.bl = [];
    // Risse: dunkle Spalten (wachsen über drawRange) und die bläuliche Abrisswand darunter
    this.crackMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.07, 0.11, 0.2), polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -30, side: THREE.DoubleSide });
    this.wallMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.66, 0.9), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -20, side: THREE.DoubleSide, transparent: true, opacity: 0 });
    this.crack = new THREE.Mesh(new THREE.BufferGeometry(), this.crackMat);
    this.wall = new THREE.Mesh(new THREE.BufferGeometry(), this.wallMat);
    for (const m of [this.crack, this.wall]) { m.frustumCulled = false; m.visible = false; m.renderOrder = 3; scene.add(m); }
    this.scene = scene;
    this.active = false;
    this.cool = 0;
    this.acc = 0;
    this.phase = 'none';
  }

  /** Abriss quer zur örtlichen Falllinie: fr = { x, d, fx, fd } (Mitte der Abrisskante, Falllinie als Einheitsvektor), Breite w.
   *  Alle Längen der Lawine sind danach Koordinaten in diesem Rahmen: s entlang der Falllinie, u quer. */
  start(fr, w, C) {
    const l = Math.hypot(fr.fx, fr.fd) || 1, fx = fr.fx / l, fd = fr.fd / l;
    Object.assign(this, { active: true, crown: 0, front: 0, xRel: 0, w, speed: 7, t: 0, stopped: 0, travelled: 0, phase: 'crack', acc: 0,
      ox: fr.x, od: fr.d, fx, fd, ax: fd, ad: -fx });
    if (C) this.buildCracks(C);
  }

  /** Rahmen -> Welt: [x, d] */
  W(u, sv) { return [this.ox + this.fx * sv + this.ax * u, this.od + this.fd * sv + this.ad * u]; }
  /** Welt -> Rahmen: [s, u] */
  L(x, d) { const dx = x - this.ox, dd = d - this.od; return [dx * this.fx + dd * this.fd, dx * this.ax + dd * this.ad]; }

  /** Geometrie der Abrisskante und der Bruchlinien aus dem Gelände. */
  buildCracks(C) {
    const w = this.w;
    const quads = [], wallQ = [];
    // Bandstück von a nach b (Welt-xz) mit Breite, liegt auf dem Gelände
    const seg = (list, ax, az, bx, bz, wd, order, lift, drop = 0) => {
      const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1, nx = (-dz / l) * wd * 0.5, nz = (dx / l) * wd * 0.5;
      const P = (x, z, dy) => [x, C.height(x, z) + lift + dy, z];
      list.push({ order, v: [P(ax - nx, az - nz, 0), P(ax + nx, az + nz, -drop), P(bx + nx, bz + nz, -drop), P(bx - nx, bz - nz, 0)] });
    };
    // Abrisskante: gezackt, in der Mitte am höchsten, die Enden laufen hangabwärts aus
    const pts = [];
    for (let u = -w / 2; u <= w / 2 + 0.01; u += 1.4 + Math.random() * 1.8) {
      const f = (2 * u) / w, d = this.crown + f * f * w * 0.16 + (Math.random() - 0.5) * 2.4 + (pts.length % 2 ? 0.9 : -0.9);
      pts.push({ u, d });
    }
    this.pts = pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], ord = Math.abs((a.u + b.u) / 2) / (w / 2);
      const [ax, ad] = this.W(a.u, a.d), [bx, bd] = this.W(b.u, b.d), [ax2, ad2] = this.W(a.u, a.d + 0.5), [bx2, bd2] = this.W(b.u, b.d + 0.5);
      seg(quads, ax, -ad, bx, -bd, 0.55 + Math.random() * 0.5, ord, 0.1);
      seg(wallQ, ax2, -ad2, bx2, -bd2, 1.5, ord, 0.06, 0.55);
    }
    // Bruchlinien: von der Kante hangabwärts, verzweigt
    const nL = 5 + Math.floor(w / 22);
    for (let k = 0; k < nL; k++) {
      const p0 = pts[1 + Math.floor(Math.random() * (pts.length - 2))];
      let u = p0.u, d = p0.d, wd = 0.42;
      const len = 14 + Math.random() * 34, ord0 = 0.25 + (Math.abs(p0.u) / (w / 2)) * 0.75;
      for (let l = 0; l < len;) {
        const st = 1.6 + Math.random() * 2.2, u2 = u + (Math.random() - 0.5) * 2.6, d2 = d + st;
        const [qx, qd] = this.W(u, d), [rx, rd] = this.W(u2, d2);
        seg(quads, qx, -qd, rx, -rd, wd, ord0 + (l / len) * 0.9, 0.1);
        u = u2; d = d2; l += st; wd = Math.max(0.14, wd * 0.93);
      }
    }
    const build = (mesh, list) => {
      list.sort((a, b) => a.order - b.order);
      const pos = new Float32Array(list.length * 18);
      list.forEach((q, i) => { const [a, b, c, d] = q.v; pos.set([...a, ...b, ...c, ...a, ...c, ...d], i * 18); });
      mesh.geometry.dispose();
      mesh.geometry = new THREE.BufferGeometry();
      mesh.geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      mesh.userData.n = list.length * 6;
      mesh.userData.maxOrder = list.length ? list[list.length - 1].order : 1;
      mesh.userData.orders = list.map((q) => q.order);
      mesh.geometry.setDrawRange(0, 0);
      mesh.visible = true;
    };
    build(this.crack, quads);
    build(this.wall, wallQ);
    this.wallMat.opacity = 0;
    // Schollen: unregelmäßig über die Platte unterhalb der Kante verteilt, oben größer, unten schon zerbrochen
    const L = 46, nBl = Math.min(NB, Math.round((w * L) / 5));
    this.bl.length = 0;
    for (let k = 0; k < nBl; k++) {
      const f = Math.random() * 2 - 1, r = Math.random(), u = f * w * 0.5;
      const d = this.crown + f * f * w * 0.16 + 2 + r * L, big = 1.25 - 0.6 * r;
      this.bl.push({
        u, d, sx: (0.9 + Math.random() * 1.4) * big, sz: (0.9 + Math.random() * 1.4) * big, sy: 0.3 + Math.random() * 0.35, yaw: Math.random() * 6.28,
        rel: CRACK_T + (1 - r) * 0.5 + Math.random() * 0.15, k: 0.75 + Math.random() * 0.45, run: 0, rx: 0, rz: 0, wx: (Math.random() - 0.5) * 3.2, wz: (Math.random() - 0.5) * 2.4, life: 50 + Math.random() * 110,
      });
    }
  }

  stop() {
    this.active = false; this.phase = 'none';
    this.mesh.count = 0; this.blocks.count = 0; this.bl.length = 0;
    this.crack.visible = false; this.wall.visible = false;
    for (const b of this.b) b.life = 0;
  }

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

  /** dt: Zeitschritt; C: course (height, centerX); player: Position. Gibt { caught, ended, near, broke } zurück. */
  update(dt, C, player) {
    const res = { caught: false, ended: false, near: 0, broke: false };
    if (this.active) {
      this.t += dt;
      // Riss wächst von der Mitte nach außen
      if (this.crack.visible) {
        const g = Math.min(1, this.t / CRACK_T) * 1.9;
        for (const m of [this.crack, this.wall]) {
          const o = m.userData.orders;
          let n = 0;
          while (n < o.length && o[n] <= g) n++;
          m.geometry.setDrawRange(0, n * 6);
        }
      }
      if (this.phase === 'crack' && this.t >= CRACK_T) { this.phase = 'slide'; res.broke = true; }
      if (this.phase === 'slide') {
        this.wallMat.opacity = Math.min(0.9, this.wallMat.opacity + dt * 1.6);
        const [x, fdw] = this.W(0, this.front), [x8, fd8] = this.W(0, this.front + 8);
        const y0 = C.height(x, -fdw), y1 = C.height(x8, -fd8);
        const slope = (y0 - y1) / 8;
        const vmax = 6 + 28 * Math.min(1, Math.max(0, (slope - 0.15) / 0.45));
        this.speed += Math.max(-6, Math.min(5, (vmax - this.speed) * 0.8)) * dt;
        this.front += this.speed * dt;
        this.travelled += this.speed * dt;
        // Staub über die ganze Breite der Front, unregelmäßige Kante
        this.acc += dt * (60 + this.w * 1.6) * Math.min(1, 0.4 + this.speed / 18) * Math.min(1, this.travelled / 30 + 0.25);
        while (this.acc >= 1) {
          this.acc -= 1;
          const u = (Math.random() - 0.5) * this.w + Math.sin(this.t * 1.7) * 3;
          const sv = this.front + Math.random() * 5 - 2 * Math.cos(u * 0.09 + this.t);
          const [px, pdw] = this.W(u, sv);
          this.puff(px, C.height(px, -pdw) + Math.random() * 1.5, -pdw, this.speed, Math.random() < 0.45);
        }
        // erfasst? Front ist am Fahrer vorbei und er steckt in der Breite
        const [pd, pu] = this.L(player.x, -player.z);
        if (this.front > pd - 1.5 && this.front < pd + 25 && Math.abs(pu) < this.w / 2 + 2) res.caught = true;
        if (this.speed < 2.5 && this.t > 4) this.stopped += dt;
        if (this.stopped > 1.5 || this.travelled > 900 || this.front > pd + 260) { this.active = false; res.ended = true; this.cool = 22; }
      }
      const [pd, pu] = this.L(player.x, -player.z);
      res.near = Math.max(0, 1 - Math.hypot(pd - this.front, pu * 0.6) / 90);
    } else this.cool = Math.max(0, this.cool - dt);

    // Schollen: rutschen mit der Lawine, kippen, zerfallen
    let nb = 0;
    if (this.bl.length) {
      const tt = this.t;
      for (const b of this.bl) {
        if (b.life <= 0) continue;
        if (this.phase !== 'none' && tt > b.rel) {
          const v = Math.min(this.speed * b.k, 4 + (tt - b.rel) * 9);
          b.d += v * dt; b.run += v * dt;
          const tum = Math.min(1, b.run / 26);
          b.rx += b.wx * tum * dt; b.rz += b.wz * tum * dt;
          if (b.run > b.life) b.life = 0;
        }
        const [x, bd] = this.W(b.u, b.d), z = -bd, sh = Math.max(0.05, 1 - Math.max(0, b.run - b.life * 0.6) / (b.life * 0.4));
        const [x2, bd2] = this.W(b.u, b.d + 1.5), hy = C.height(x, z), hz = C.height(x2, -bd2);
        tmpP.set(x, hy + b.sy * 0.32 * sh + 0.05, z);
        tmpE.set(Math.atan2(hy - hz, 1.5) * -1 + b.rx, b.yaw, b.rz);
        tmpQ.setFromEuler(tmpE);
        tmpS.set(b.sx * sh, b.sy * sh, b.sz * sh);
        tmpM.compose(tmpP, tmpQ, tmpS);
        this.blocks.setMatrixAt(nb++, tmpM);
      }
      this.blocks.instanceMatrix.needsUpdate = true;
    }
    // Schollen erscheinen erst mit dem Bruch (vorher ist die Schneedecke noch ganz)
    this.blocks.count = this.phase === 'crack' ? 0 : nb;

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
