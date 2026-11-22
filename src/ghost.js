// Geist der Bestzeit in den vier Rennen: die beste Fahrt wird 15-mal pro Sekunde aufgezeichnet (Lage, Drehung, Haltung)
// und beim nächsten Lauf als durchscheinender Fahrer abgespielt. Gespeichert pro Disziplin im Browser (rund 100 bis
// 150 KB je Abfahrt). Kosten: ein zweiter Fahrer ohne Schatten mit einem einzigen Material.
import * as THREE from 'three';
import { Skier } from './skier.js';

const HZ = 15, F = 20;   // Werte je Probe: Position 3, Lage 4, Körperdrehung 3, Körperhöhe 1, Haltung 9
const KEY = 'gipfelsturm_ghost_';
const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();

function enc(arr) {
  const b = new Uint8Array(arr.buffer); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function dec(str) {
  const s = atob(str), b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return new Float32Array(b.buffer);
}

export class Ghost {
  constructor(models, scene) {
    this.models = models; this.scene = scene;
    this.sk = null; this.data = null; this.meta = null; this.rec = null; this.recT = 0; this.cur = null;
  }
  /** Fahrer erst bei Bedarf bauen, in der Ausrüstung der aufgezeichneten Fahrt, ganz in einem durchscheinenden Material. */
  build(meta) {
    if (this.sk) this.scene.remove(this.sk.root);   // alter Geist (andere Ausrüstung) raus; Geometrien teilt er mit den Vorlagen
    const sk = new Skier(this.models);
    sk.setSkiDesign(meta.ski || 'allround');
    sk.setBoardDesign(meta.board || 'classic');
    sk.setGear(meta.gear === 'board' ? 'board' : 'ski');
    if (!this.mat) this.mat = new THREE.MeshStandardMaterial({ color: 0x3d8bff, emissive: 0x2a6bff, emissiveIntensity: 0.9, roughness: 0.5, transparent: true, opacity: 0.55, depthWrite: false })   // kräftiges Blau: auf weißem Schnee auch von weitem zu sehen;
    sk.root.traverse((o) => { if (o.isMesh) { o.material = this.mat; o.castShadow = false; o.receiveShadow = false; o.renderOrder = 4; } });
    sk.root.visible = false;
    this.scene.add(sk.root);
    this.sk = sk;
  }
  /** Gespeicherte Bestfahrt einer Disziplin laden; sig muss zur Strecke passen. */
  load(disc, sig) {
    this.data = null; this.meta = null; this.cur = disc;
    try {
      const raw = localStorage.getItem(KEY + disc);
      if (!raw) return false;
      const o = JSON.parse(raw);
      if (o.v !== 1 || o.sig !== sig) return false;
      this.data = dec(o.d); this.meta = o;
      if (!this.sk || this.sk._gear !== o.gear || this.sk._ski !== o.ski || this.sk._board !== o.board) { this.build(o); this.sk._gear = o.gear; this.sk._ski = o.ski; this.sk._board = o.board; }
      return true;
    } catch { return false; }
  }
  startRec(meta) { this.rec = []; this.recT = 0; this.recMeta = meta; }
  /** Eine Probe, wenn ihre Zeit erreicht ist (t = Laufzeit). */
  record(t, skier, pose) {
    if (!this.rec || t < this.recT) return;
    this.recT += 1 / HZ;
    const r = skier.root, pv = skier.pivot;
    this.rec.push(r.position.x, r.position.y, r.position.z, r.quaternion.x, r.quaternion.y, r.quaternion.z, r.quaternion.w,
      pv.rotation.x, pv.rotation.y, pv.rotation.z, pv.position.y,
      pose.lean, pose.crouch, pose.plow, pose.air, pose.compress, pose.tuck, pose.spin, pose.extend, pose.grab);
  }
  /** Neue Bestzeit: Aufzeichnung speichern. */
  save(disc, sig) {
    if (!this.rec || this.rec.length < F * 10) return false;
    const o = { v: 1, sig, hz: HZ, n: this.rec.length / F, ...this.recMeta, d: enc(new Float32Array(this.rec)) };
    try { localStorage.setItem(KEY + disc, JSON.stringify(o)); } catch { return false; }
    this.rec = null;
    return true;
  }
  stopRec() { this.rec = null; }
  /** Abspielen zur Laufzeit t; show = false blendet aus. */
  play(t, show, dt) {
    const sk = this.sk;
    if (!sk) return;
    const d = this.data;
    if (!show || !d) { sk.root.visible = false; return; }
    const n = d.length / F, u = Math.min(n - 1, Math.max(0, t * HZ)), i = Math.min(n - 2, Math.floor(u)), f = u - i;
    if (i < 0) { sk.root.visible = false; return; }
    const a = i * F, b = a + F, L = (k) => d[a + k] + (d[b + k] - d[a + k]) * f;
    sk.root.visible = true;
    sk.root.position.set(L(0), L(1), L(2));
    qa.set(d[a + 3], d[a + 4], d[a + 5], d[a + 6]); qb.set(d[b + 3], d[b + 4], d[b + 5], d[b + 6]);
    sk.root.quaternion.slerpQuaternions(qa, qb, f);
    // Körperdrehung: Winkel ohne Sprung über ±π interpolieren
    const ang = (k) => { const x = d[a + k], y = d[b + k]; let dd = y - x; dd = Math.atan2(Math.sin(dd), Math.cos(dd)); return x + dd * f; };
    sk.pivot.rotation.set(ang(7), ang(8), ang(9));
    sk.pivot.position.set(0, L(10), 0);
    sk.update({ lean: L(11), crouch: L(12), steer: 0, plow: L(13), air: L(14), compress: L(15), speed: 10, tuck: L(16), spin: L(17), extend: L(18), grab: L(19), crash: 0 }, dt);
  }
  /** Zeitabstand zum Geist an der Stelle z (Meter talwärts = -z): positiv = langsamer als die Bestfahrt. */
  gapAt(t, z) {
    const d = this.data;
    if (!d) return null;
    const n = d.length / F;
    if (z < d[(n - 1) * F + 2]) return null;   // schon weiter als der Geist im Ziel
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (d[m * F + 2] > z) lo = m; else hi = m; }
    const za = d[lo * F + 2], zb = d[hi * F + 2], f = za === zb ? 0 : (za - z) / (za - zb);
    return t - (lo + f) / HZ;
  }
}
