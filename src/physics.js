// Fahrphysik: Schwerkraft am Hang, Gleitreibung, Luftwiderstand, Kantengriff (Carven) und Rutschen (Driften).
// Kurvenradius ergibt sich aus der maximalen Querbeschleunigung, die die Kante hält – wer zu hart einlenkt, rutscht.
import * as THREE from 'three';
import { G, height, terrainNormal, groundAt, groundNormal, surfaceAt, centerX, bounds, cfg, nearColliders, nearRails, clamp, lerp, smoothstep, MESH_D1 } from './course.js';

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
    this.gs = { glide: 1, turn: 1, pow: 1, trick: 1, grip: 1 };   // Ausrüstung (gear.js statMul), 1 = neutral
    this.reset(-1);
  }
  /** Eigenschaften des angelegten Skis oder Bretts (Multiplikatoren aus gear.js statMul). */
  setGearStats(m) { this.gs = m || { glide: 1, turn: 1, pow: 1, trick: 1, grip: 1 }; }

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
    this.airStart = new THREE.Vector3(x, height(x, z), z);   // nach Teleport/Respawn keine Fantasie-Sprungweite
    this.gap = 0;
    this.yawRate = 0;
    this.pressure = 1;
    this.grind = null;   // auf Rail/Box: { g, s (gefahrene Meter), bal (Balance −1..1) }
    this.grindCool = 0;
    this.noRockCrash = false;   // Lawinen-Sicht: Felsen werfen nicht ab
    terrainNormal(x, z, this.normal);
  }

  step(dt, inp) {
    if (this.grind) { this.stepGrind(dt, inp); return; }
    this.grindCool = Math.max(0, this.grindCool - dt);
    const p = this.pos, v = this.vel;
    const ox = p.x, oy = p.y, oz = p.z;   // Stand vor dem Schritt (Heli: Wände)
    groundNormal(p.x, p.z, p.y, N);
    // Tiefschnee: im Rennen bremst das Gelände neben der Piste, im Freeride-Berg gibt es echten Pulverschnee mit Tiefe
    const sf = surfaceAt(p.x, p.z);
    this.off = smoothstep(-0.5, 4, sf.edge);
    this.pow = cfg.endless && !this.onDeck ? sf.pow : 0;   // auf einem Dach liegt fester Schnee
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
      // Heli-Pulver (v29): mehr Griff als im Freeride-Pulver, die breiten Ski stützen sich im tiefen Schnee ab
      const gs = this.gs, press = inp.press || 0;
      // Kantengriff: auf hartem Schnee nach dem Kantengriff-Wert, im Pulver nach dem Pulver-Wert; im Press (nur Enden
      // oder Spitzen auf dem Schnee) greift die Kante weniger
      const gripG = lerp(1.5, 0.72, inp.brake) * lerp(gs.grip, (cfg.heli ? 0.92 : cfg.endless ? 0.7 : 0.62) * Math.sqrt(gs.pow), pw) * (1 - 0.22 * press);
      const maxLat = gripG * G;
      const wCarve = (maxLat * 0.9) / Math.max(speed, 2.5) * gs.turn;
      const wPivot = 2.6 * (1 - smoothstep(3, 15, speed)) * gs.turn;
      let wMax = Math.max(wCarve, wPivot);
      if (inp.brake > 0) wMax = Math.max(wMax, 2.1 * inp.brake);
      wMax = Math.min(wMax, 2.3 * gs.turn) * lerp(1, 0.55, inp.tuck);
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
      // Pulver-Wert: der Tiefschnee-Anteil der Reibung und der Schneewiderstand sinken mit breiten, aufschwimmenden Ski
      const mu = (0.04 + ((cfg.heli ? 0.05 : cfg.endless ? 0.072 : 0.11) - 0.04) * pw / gs.pow) / gs.glide;
      // Heli-Berg: tiefer, leichter Pulver trägt – man schwebt darüber und wird kaum gebremst (wie echter Powder)
      const k = lerp(0.0036, 0.0019, inp.tuck) / (1 + (gs.glide - 1) * 0.6);
      const powDrag = (cfg.heli ? pw * (0.08 + 0.012 * speed) : cfg.endless ? pw * (0.26 + 0.03 * speed) : pw * 0.05 * speed) / gs.pow;
      // Butter-Drehung: quer zur Fahrt schiebt der Ski Schnee vor sich her (mit Freestyle-Ski weniger)
      const butterDrag = (inp.butter || 0) * (0.5 + 0.035 * speed) / gs.trick;
      const dec = mu * G * N.y + k * speed * speed + powDrag + butterDrag + inp.brake * 4.6;
      if (speed > 1e-4) v.multiplyScalar(Math.max(0, speed - dec * dt) / speed);
      v.y -= G * dt;

      // Kantengriff. Heli-Berg (v29): die Kante hält zusätzlich den Querhang-Abtrieb (Schwerkraft quer zum Ski). Vorher
      // ging dafür der ganze Griff drauf, der Hang drückte einen bei Tempo in seine Richtung, Lenken dagegen griff kaum.
      vl = v.dot(Rv);
      const lim = maxLat + (cfg.heli ? Math.abs(G * Rv.y) * 0.9 : 0);
      const dv = clamp(-vl, -lim * dt, lim * dt);
      v.addScaledVector(Rv, dv);
      const a = dv / dt;
      this.aLat += (a - this.aLat) * Math.min(1, dt * 10);
      this.skid = Math.abs(vl + dv);
      this.slip = Math.atan2(vl + dv, Math.max(0.5, Math.abs(vf)));
      this.pressure = clamp(0.6 + Math.abs(a) / (1.2 * G), 0.5, 1.6);

      if (inp.jump) {
        v.addScaledVector(N, 4.3 + (inp.pop || 0));   // aus dem Press (Ollie/Nollie) springt man höher
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
      // Heli-Berg, oberer Teil: die Flanken des Grats sind Absturzgelände. Wer sie bis zum Ende hinabrutscht, stürzt ab.
      if (bd.fall && this.crashed <= 0) { this.events.push({ type: 'hit', what: 'flanke' }); this.crash(); }
    }
    if (d > MESH_D1 - 20) { p.z = -(MESH_D1 - 20); v.z = 0; }
    if (d < -40) { p.z = 40; v.z = Math.min(v.z, 0); }

    // Rails und Boxen: aufspringen oder über die Rampe auffahren; seitlich dagegen = abprallen
    if (cfg.endless && this.crashed <= 0 && this.grindCool <= 0) {
      nearRails(p.z, (g) => {
        if (this.grind) return;
        const rx = p.x - g.ax, ry = p.y - g.ay, rz = p.z - g.az;
        const sAl = rx * g.dx + ry * g.dy + rz * g.dz;
        if (sAl < -0.4 || sAl > g.L - 0.6) return;
        const qx = g.ax + g.dx * sAl, qy = g.ay + g.dy * sAl, qz = g.az + g.dz * sAl;
        const hn = Math.hypot(g.dx, g.dz) || 1, lx = g.dz / hn, lz = -g.dx / hn;
        const lat = (p.x - qx) * lx + (p.z - qz) * lz, dyTop = p.y - qy;
        const va = v.x * g.dx + v.y * g.dy + v.z * g.dz;
        if (Math.abs(lat) < g.w + 0.34 && dyTop > -0.32 && dyTop < 0.6 && va > 2 && v.y - g.dy * va < 1.5 + 0.35 * va) {   // von der Auffahrrampe kommt man leicht steigend an
          this.grind = { g, s: Math.max(0, sAl), bal: clamp(lat / (g.w + 0.34), -1, 1) * 0.35, ph: Math.random() * 6.28, t: 0 };
          p.set(qx, qy, qz);
          v.set(g.dx * va, g.dy * va, g.dz * va);
          this.grounded = false;
          this.events.push({ type: 'grindStart', kind: g.kind, name: g.name });
        } else if (Math.abs(lat) < g.w + 0.28 && dyTop <= -0.32 && dyTop > -g.h - 0.3) {
          // gegen die Seite gefahren: wegdrücken, kein Sturz
          const out = (g.w + 0.28 - Math.abs(lat)) * Math.sign(lat || 1);
          p.x += lx * out; p.z += lz * out;
          const vl = v.x * lx + v.z * lz;
          if (vl * Math.sign(lat || 1) < 0) { v.x -= lx * vl * 1.2; v.z -= lz * vl * 1.2; }
        }
      });
      if (this.grind) { this.normal.set(0, 1, 0); this.speed = v.length(); return; }
    }

    let hgt = groundAt(p.x, p.z, p.y);
    groundNormal(p.x, p.z, p.y, N2);
    // Heli-Berg: Steiler als etwa 60 Grad ist eine Wand (Seiten der Klippen-Bänke, Stirn einer Windlippe, Rinnenwand).
    // Wer hineinfährt, fährt nicht mehr an ihr hinauf (vorher glitt man an der Felswand senkrecht nach oben, mitten
    // durch den Fels, und kam so auf die Bank), sondern prallt ab und gleitet an ihr entlang; frontal und schnell
    // gegen eine hohe Wand heißt Sturz.
    let onWall = false;
    if (cfg.heli && this.crashed <= 0 && p.y - hgt < 0.05 && N2.y < 0.5) {
      const hl = Math.hypot(N2.x, N2.z) || 1, wx = N2.x / hl, wz = N2.z / hl;
      const into = -(v.x * wx + v.z * wz);
      if (into > 0.02) {
        // hineingefahren: zurück auf den Stand vor dem Schritt, die Bewegung in die Wand fällt weg
        const tall = groundAt(p.x - wx * 1.5, p.z - wz * 1.5, p.y) - hgt > 1.5;
        // nur den Teil des Schritts zurücknehmen, der in die Wand ging; entlang und hinab geht es weiter
        const sIn = -((p.x - ox) * wx + (p.z - oz) * wz);
        if (sIn > 0) { p.x += wx * sIn; p.z += wz * sIn; }
        if (groundAt(p.x, p.z, p.y) > oy + 0.002) p.set(ox, oy, oz);   // dort ginge es bergauf, also immer noch in der Wand: ganz zurück
        v.x += wx * into; v.z += wz * into;
        // die Ski drehen sich mit an der Wand entlang (sonst führt die Kante das Tempo immer wieder in die Wand zurück)
        if (Math.hypot(v.x, v.z) > 1) { const hv = Math.atan2(v.x, -v.z); let dh = hv - this.heading; dh = Math.atan2(Math.sin(dh), Math.cos(dh)); if (Math.abs(dh) < Math.PI / 2) this.heading = hv; }
        if (tall && into > 12 && !this.noRockCrash) { this.events.push({ type: 'hit', what: 'wand' }); this.crash(); }
        else { const sp = v.length(); if (sp > 1e-3) v.multiplyScalar(Math.max(0, sp - into * 0.15) / sp); }   // Anprall kostet etwas Tempo, Streifen kaum
      } else {
        // an der Wand, aber nicht hinein: man hält sich dort nicht, sondern rutscht frei an ihr hinab
        const pen = Math.max(0, hgt - p.y);
        p.x += wx * (pen * N2.y / hl + 0.02); p.z += wz * (pen * N2.y / hl + 0.02);
        if (this.grounded) { this.grounded = false; this.airTime = 0; this.airStart.copy(p); }
        onWall = true;
      }
      if (v.y > 0) v.y *= 0.3;   // die Wand hebt nicht an
      hgt = groundAt(p.x, p.z, p.y);
      groundNormal(p.x, p.z, p.y, N2);
    }
    this.onDeck = hgt > height(p.x, p.z) + 0.05;
    const gap = p.y - hgt;
    const vn = v.dot(N2);
    this.gap = gap;
    if (onWall) { /* an der Wand: in diesem Schritt kein Bodenkontakt */ }
    else if (this.grounded) {
      // Pulver und Unterholz fangen kleine Kanten ab: neben der Piste hebt man nicht bei jeder Welle ab
      if (vn > 1.5 + 0.012 * this.speed + 2.4 * this.pow + 0.8 * this.off && gap > 0) {
        this.grounded = false;
        this.airTime = 0;
        this.airStart.copy(p);
      } else {
        p.y = hgt;
        // Heli-Berg: wer mit Tempo gegen eine Felswand fährt (Seitenwand einer Rinne, Wandfuß), stürzt
        if (cfg.heli && N2.y < 0.42 && vn < -8 && this.crashed <= 0 && !this.noRockCrash) { this.events.push({ type: 'hit', what: 'wand' }); this.crash(); }
        if (vn < 0) v.addScaledVector(N2, -vn);
        if (cfg.heli && N2.y < 0.5 && v.y > 0) v.y = 0;   // an einer Wand gewinnt man keine Höhe
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
    {
      nearColliders(p.z, (c) => {
        if (c.top !== undefined ? p.y > c.top + 0.2 : gap >= 2.5) return;   // über das Hindernis hinweg geflogen
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
          } else if (c.type === 'fels' && this.noRockCrash && into > 0) {
            // Lawinen-Sicht: am Felsen vorbeigleiten statt hängenzubleiben (Tempo bleibt weitgehend, Richtung seitlich vorbei)
            const sp0 = Math.hypot(v.x, v.z), tx = -nz, tz = nx, vt = v.x * tx + v.z * tz;
            const sg = Math.abs(vt) > 0.5 ? Math.sign(vt) : (dx * tx + dz * tz >= 0 ? 1 : -1);
            const keep = sp0 * (into > 3 ? 0.85 : 0.995);   // Tempoverlust nur beim ersten Anprall, nicht bei jedem Streifen
            // neue Richtung: seitlich am Felsen vorbei, aber weiter in die alte Fahrtrichtung (nicht zurück bergauf)
            const fx = v.x / (sp0 || 1), fz = v.z / (sp0 || 1);
            let ux = tx * sg * 0.7 + fx + nx * 0.25, uz = tz * sg * 0.7 + fz + nz * 0.25;
            const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
            v.x = ux * keep; v.z = uz * keep;
            this.heading = Math.atan2(v.x, -v.z);   // Ski drehen mit, sonst bremst die Kante das seitliche Tempo weg
          } else if (into > (c.type === 'fels' ? (this.noRockCrash ? 1e9 : 2.2) : c.type === 'baum' ? 5.5 : 7)) {   // Felsen sind hart: schon bei Schritttempo-Aufprall Sturz (nicht in der Lawinen-Sicht)
            this.events.push({ type: 'hit', what: c.type });
            this.crash();
            v.multiplyScalar(0.4);
          } else if (into > 0) {
            // Streifkontakt: abprallen und etwas Tempo verlieren
            v.x += nx * into * 1.25; v.z += nz * into * 1.25;
            v.multiplyScalar(1 - Math.min(0.25, into * 0.03));
          }
        }
      }, p.x);
    }

    FH.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
    this.fwd.copy(FH).addScaledVector(this.normal, -FH.dot(this.normal)).normalize();
    this.right.crossVectors(this.fwd, this.normal).normalize();
  }

  /** Rutschen auf Rail oder Box: Tempo entlang des Elements, Balance halten (Lenken gleicht aus), abspringen mit Sprung. */
  stepGrind(dt, inp) {
    const gr = this.grind, g = gr.g, p = this.pos, v = this.vel;
    let va = v.x * g.dx + v.y * g.dy + v.z * g.dz;
    const mu = g.kind === 'box' ? 0.07 : 0.045;
    va += (-G * g.dy - mu * G * Math.sqrt(Math.max(0, 1 - g.dy * g.dy)) - 0.0025 * va * va) * dt;
    gr.t += dt;
    // Balance ist instabil (kippt von selbst weg), Gegenlenken hält sie; auf Boxen deutlich gutmütiger
    const k = g.kind === 'box' ? 0.55 : 1;
    gr.bal += (gr.bal * 1.5 + Math.sin(gr.t * 2.1 + gr.ph) * 0.5 + Math.sin(gr.t * 5.3 + gr.ph * 2) * 0.25) * k * dt - inp.steer * 2.6 * dt;
    gr.s += va * dt;
    this.heading = Math.atan2(g.dx, -g.dz);
    this.speed = Math.abs(va);
    this.skid = 0; this.aLat = 0; this.slip = 0; this.airTime = 0; this.gap = 0;
    const hn = Math.hypot(g.dx, g.dz) || 1, lx = g.dz / hn, lz = -g.dx / hn;
    let leave = null;
    if (inp.jump) leave = { clean: true, pop: 4.6 };
    else if (gr.s >= g.L) leave = { clean: true, pop: 0.6 };
    else if (Math.abs(gr.bal) > 1) leave = { clean: false, side: Math.sign(gr.bal) };
    else if (va < 0.8) leave = { clean: gr.s > 2, pop: 0 };
    if (leave) {
      v.set(g.dx * va, g.dy * va + (leave.pop || 0), g.dz * va);
      if (leave.side) { v.x += lx * leave.side * 2.4; v.z += lz * leave.side * 2.4; p.x += lx * leave.side * (g.w + 0.4); p.z += lz * leave.side * (g.w + 0.4); }
      this.grind = null;
      this.grindCool = 0.35;
      this.grounded = false;
      this.airStart.copy(p);
      if (leave.pop > 1) this.events.push({ type: 'jump' });
      this.events.push({ type: 'grindEnd', dist: gr.s, kind: g.kind, name: g.name, clean: leave.clean, time: gr.t });
    } else {
      p.set(g.ax + g.dx * gr.s, g.ay + g.dy * gr.s, g.az + g.dz * gr.s);
      v.set(g.dx * va, g.dy * va, g.dz * va);
    }
    this.normal.set(0, 1, 0);
    FH.set(Math.sin(this.heading), 0, -Math.cos(this.heading));
    this.fwd.copy(FH);
    this.right.crossVectors(this.fwd, this.normal).normalize();
  }

  crash() {
    if (this.crashed > 0) return;
    this.crashed = clamp(2.0 + this.speed * 0.045, 2.2, 3.3);
    this.events.push({ type: 'crash' });
  }
}
