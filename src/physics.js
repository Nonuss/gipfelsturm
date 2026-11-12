// Fahrphysik: Schwerkraft am Hang, Gleitreibung, Luftwiderstand, Kantengriff (Carven) und Rutschen (Driften).
// Kurvenradius ergibt sich aus der maximalen Querbeschleunigung, die die Kante hält – wer zu hart einlenkt, rutscht.
import * as THREE from 'three';
import { G, height, terrainNormal, surfaceAt, centerX, bounds, cfg, nearColliders, clamp, lerp, smoothstep, MESH_D1 } from './course.js';

const N = new THREE.Vector3(), N2 = new THREE.Vector3();
const F = new THREE.Vector3(), Rv = new THREE.Vector3(), FH = new THREE.Vector3();

export class SkiPhysics {
  constructor() {
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.normal = new THREE.Vector3(0, 1, 0);
    this.fwd = new THREE.Vector3(0, 0, -1);
    this.right = new THREE.Vector3(1, 0, 0);
    this.events = [];
    this.reset(-1);
  }

  reset(d, x0) {
    const x = x0 === undefined ? centerX(d) : x0, z = -d;
    this.pos.set(x, height(x, z), z);
    this.vel.set(0, 0, 0);
    this.heading = Math.atan2(centerX(d + 6) - centerX(d), 6);
    this.grounded = true;
    this.crashed = 0;
    this.speed = 0;
    this.aLat = 0;       // Querbeschleunigung (m/s², + = nach rechts)
    this.skid = 0;       // Rutschgeschwindigkeit quer zum Ski
    this.slip = 0;
    this.off = 0;        // 0 = Piste, 1 = neben der Piste
    this.pow = 0;        // 0 = fester Schnee, 1 = tiefer Pulverschnee (bremst, federt Landungen ab)
    this.sink = 0;       // Einsinktiefe (m) für die Darstellung
    this.airTime = 0;
    this.airStart = new THREE.Vector3();
    this.gap = 0;
    this.yawRate = 0;
    this.pressure = 1;
    terrainNormal(x, z, this.normal);
  }

  step(dt, inp) {
    const p = this.pos, v = this.vel;
    terrainNormal(p.x, p.z, N);
    // Tiefschnee: im Rennen bremst das Gelände neben der Piste, im Freeride-Berg gibt es echten Pulverschnee mit Tiefe
    const sf = surfaceAt(p.x, p.z);
    this.off = smoothstep(-0.5, 4, sf.edge);
    this.pow = cfg.endless ? sf.pow : 0;
    const pw = cfg.endless ? this.pow : this.off;
    let speed = v.length();
    this.sink += ((this.grounded ? this.pow * clamp(0.5 + speed / 25, 0.5, 1.2) * 0.34 : 0) - this.sink) * Math.min(1, dt * 6);

    if (this.crashed > 0) {
      this.crashed -= dt;
      v.y -= G * dt;
      if (this.grounded && speed > 0.01) v.multiplyScalar(Math.max(0, speed - (6.5 + 0.38 * speed) * dt) / speed);   // Überschlag: bei hohem Tempo bremst der Schnee stark
      this.aLat = 0; this.skid = 0;
      if (this.crashed <= 0) this.events.push({ type: 'respawn' });
    } else if (this.grounded) {
      const gripG = lerp(1.5, 0.72, inp.brake) * lerp(1, cfg.endless ? 0.7 : 0.62, pw);
      const maxLat = gripG * G;
      const wCarve = (maxLat * 0.9) / Math.max(speed, 2.5);
      const wPivot = 2.6 * (1 - smoothstep(3, 15, speed));
      let wMax = Math.max(wCarve, wPivot);
      if (inp.brake > 0) wMax = Math.max(wMax, 2.1 * inp.brake);
      wMax = Math.min(wMax, 2.3) * lerp(1, 0.55, inp.tuck);
      this.yawRate = inp.steer * wMax;
      this.heading += this.yawRate * dt;

      FH.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
      F.copy(FH).addScaledVector(N, -FH.dot(N)).normalize();
      Rv.crossVectors(F, N).normalize();
      let vf = v.dot(F), vl = v.dot(Rv);

      // Ski richten sich ohne Lenkeingabe in Fahrtrichtung aus
      if (speed > 2 && vf > 0) {
        this.heading += Math.atan2(vl, vf) * (1 - Math.abs(inp.steer)) * (1 - inp.brake) * 3.0 * dt;
      }

      // Reibung + Luftwiderstand
      const mu = lerp(0.04, cfg.endless ? 0.072 : 0.11, pw);
      const k = lerp(0.0036, 0.0019, inp.tuck);
      const dec = mu * G * N.y + k * speed * speed + (cfg.endless ? pw * (0.26 + 0.03 * speed) : pw * 0.05 * speed) + inp.brake * 4.6;
      if (speed > 1e-4) v.multiplyScalar(Math.max(0, speed - dec * dt) / speed);
      v.y -= G * dt;

      // Kantengriff
      vl = v.dot(Rv);
      const dv = clamp(-vl, -maxLat * dt, maxLat * dt);
      v.addScaledVector(Rv, dv);
      const a = dv / dt;
      this.aLat += (a - this.aLat) * Math.min(1, dt * 10);
      this.skid = Math.abs(vl + dv);
      this.slip = Math.atan2(vl + dv, Math.max(0.5, Math.abs(vf)));
      this.pressure = clamp(0.6 + Math.abs(a) / (1.2 * G), 0.5, 1.6);

      if (inp.jump) {
        v.addScaledVector(N, 4.3);
        this.grounded = false;
        this.airTime = 0;
        this.airStart.copy(p);
        this.events.push({ type: 'jump' });
      }
    } else {
      // Luft
      const k = lerp(0.003, 0.0018, inp.tuck);
      if (speed > 1e-4) v.multiplyScalar(Math.max(0, speed - k * speed * speed * dt) / speed);
      v.y -= G * dt;
      if (v.y < 0 && this.gap < 3) {
        const target = Math.atan2(v.x, -v.z);
        let diff = target - this.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        this.heading += diff * Math.min(1, 5 * dt);
      }
      this.airTime += dt;
      this.aLat += (0 - this.aLat) * Math.min(1, dt * 6);
      this.skid = 0;
    }

    p.addScaledVector(v, dt);

    // Geländerand
    const d = -p.z;
    const bd = bounds(d);
    if (Math.abs(p.x - bd.c) > bd.u) {
      p.x = bd.c + Math.sign(p.x - bd.c) * bd.u;
      v.x *= 0.5;
    }
    if (d > MESH_D1 - 20) { p.z = -(MESH_D1 - 20); v.z = 0; }
    if (d < -40) { p.z = 40; v.z = Math.min(v.z, 0); }

    const hgt = height(p.x, p.z);
    terrainNormal(p.x, p.z, N2);
    const gap = p.y - hgt;
    const vn = v.dot(N2);
    this.gap = gap;
    if (this.grounded) {
      // Pulver und Unterholz fangen kleine Kanten ab: neben der Piste hebt man nicht bei jeder Welle ab
      if (vn > 1.5 + 0.012 * this.speed + 2.4 * this.pow + 0.8 * this.off && gap > 0) {
        this.grounded = false;
        this.airTime = 0;
        this.airStart.copy(p);
      } else {
        p.y = hgt;
        if (vn < 0) v.addScaledVector(N2, -vn);
      }
    } else if (gap <= 0) {
      p.y = hgt;
      // Pulverschnee fängt Landungen ab
      const impact = Math.max(0, -vn) * (1 - 0.42 * this.pow);
      if (vn < 0) v.addScaledVector(N2, -vn);
      this.grounded = true;
      this.gap = 0;
      const dist = Math.hypot(p.x - this.airStart.x, p.z - this.airStart.z);
      this.events.push({ type: 'land', impact, airTime: this.airTime, dist });
      if (impact > 23 && this.crashed <= 0) this.crash();
    }
    this.normal.copy(N2);
    this.speed = v.length();

    // Hindernisse: Streifkontakte werden abgelenkt, nur ein frontaler Aufprall lässt stürzen
    if (gap < 2.5) {
      nearColliders(p.z, (c) => {
        const dx = p.x - c.x, dz = p.z - c.z;
        const rr = c.r + 0.2;
        const d2 = dx * dx + dz * dz;
        if (d2 < rr * rr) {
          const dl = Math.sqrt(d2) || 1e-3;
          const nx = dx / dl, nz = dz / dl;
          p.x = c.x + nx * rr;
          p.z = c.z + nz * rr;
          const into = -(v.x * nx + v.z * nz);
          if (c.type === 'zaun') {
            // Netzzaun: kein Abstoßen. Wer hineinfährt, stürzt; nur ganz flaches Streifen bremst etwas.
            // Aufprall senkrecht zur Zaunlinie (nicht zum Kreis), sonst würde schon flaches Entlangstreifen als Aufprall zählen
            const lnx = -c.lz, lnz = c.lx, intoL = Math.abs(v.x * lnx + v.z * lnz);
            if (intoL > 2.2 && this.crashed <= 0) { this.events.push({ type: 'hit', what: 'zaun' }); this.crash(); v.multiplyScalar(0.35); }
            else if (into > 0) { v.x += nx * into; v.z += nz * into; v.multiplyScalar(0.97); }
          } else if (c.type === 'weich') {
            if (into > 0) { v.x += nx * into * 1.3; v.z += nz * into * 1.3; }
            v.multiplyScalar(0.8);
          } else if (this.crashed > 0) {
            v.multiplyScalar(0.3);
          } else if (into > (c.type === 'fels' ? 2.2 : c.type === 'baum' ? 5.5 : 7)) {   // Felsen sind hart: schon bei Schritttempo-Aufprall Sturz
            this.events.push({ type: 'hit', what: c.type });
            this.crash();
            v.multiplyScalar(0.4);
          } else if (into > 0) {
            // Streifkontakt: abprallen und etwas Tempo verlieren
            v.x += nx * into * 1.25; v.z += nz * into * 1.25;
            v.multiplyScalar(1 - Math.min(0.25, into * 0.03));
          }
        }
      });
    }

    FH.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
    this.fwd.copy(FH).addScaledVector(this.normal, -FH.dot(this.normal)).normalize();
    this.right.crossVectors(this.fwd, this.normal).normalize();
  }

  crash() {
    if (this.crashed > 0) return;
    this.crashed = clamp(2.0 + this.speed * 0.045, 2.2, 3.3);
    this.events.push({ type: 'crash' });
  }
}
