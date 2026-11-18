// 3D-Shop (v34): ein kleiner Ski-Laden statt eines Fensters mit Karten. Vorbild sind echte Ski-Shops (Wandregal mit
// allen Ski, Holzwand, Podest mit Puppe) und Spiele-Shops (großes Vorschaumodell in der Mitte, Liste links, Details
// rechts, anprobieren vor dem Kauf). Eigene Szene und Kamera; gerendert wird nur, solange der Shop offen ist.
import * as THREE from 'three';
import { Skier } from './skier.js';
import { SKIS, BOARDS, makeSki, makeBoardGeo, STAT_NAMES } from './gear.js';
import { shop, CATALOG, OUTFITS } from './shop.js';

const num = (n) => Math.round(n).toLocaleString('de-DE');
// Podest mit Puppe (rechts vorn) und Ständer mit dem Ausstellungsstück (links dahinter): beide in der Bildmitte zwischen den Leisten
const PX = 0.5, PZ = 0.35, SX = -0.85, SZ = -0.1;
const TAB_NAMES = { ski: 'Ski', board: 'Snowboards', outfit: 'Outfits' };
const KICKER = { ski: 'Ski', board: 'Snowboard', outfit: 'Outfit' };
// Achsen der Ausstellungsstücke: Ski (Länge entlang z, Spitze -z) und Brett (Länge entlang x) aufrecht, Oberseite zur Kamera
const SKI_UP = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, -1, 0)));
const BOARD_UP = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));

function woodTexture(w, h, base, planks, seed = 1) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d');
  let s = seed; const R = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const pw = w / planks;
  for (let i = 0; i < planks; i++) {
    const l = 0.82 + R() * 0.3;
    g.fillStyle = `rgb(${base[0] * l | 0},${base[1] * l | 0},${base[2] * l | 0})`;
    g.fillRect(i * pw, 0, pw, h);
    g.strokeStyle = 'rgba(0,0,0,0.12)';
    for (let k = 0; k < 9; k++) {   // Maserung
      const x0 = i * pw + R() * pw; g.lineWidth = 1 + R() * 1.5; g.beginPath(); g.moveTo(x0, 0);
      for (let y = 0; y <= h; y += h / 12) g.lineTo(x0 + Math.sin(y / h * 6 + R() * 2) * pw * 0.08, y);
      g.stroke();
    }
    g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillRect(i * pw, 0, 2, h);   // Fuge
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
function signTexture() {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 160;
  const g = c.getContext('2d');
  g.fillStyle = '#16191f'; g.fillRect(0, 0, 1024, 160);
  g.font = 'italic 800 92px "Avenir Next", "Helvetica Neue", Arial, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#ff6a13'; g.fillText('GIPFELSTURM', 512, 70);
  g.font = '600 30px "Avenir Next", "Helvetica Neue", Arial, sans-serif'; g.fillStyle = '#f2f2f0';
  g.fillText('S K I   ·   B O A R D   ·   O U T F I T', 512, 130);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class Shop3D {
  /** hooks: { onEquip(), setGear(g), getGear(), customColors(), isRot(), onClose() } */
  constructor(renderer, models, env, hooks) {
    this.r = renderer; this.hooks = hooks; this.env = env;
    this.isOpen = false; this.tab = 'ski'; this.sel = { ski: shop.equip.ski, board: shop.equip.board, outfit: shop.equip.outfit };
    this.spin = Math.PI - 0.5; this.spinV = 0; this.dragging = false; this.idleT = 0; this.zoom = 0; this.t = 0;
    const sc = this.scene = new THREE.Scene();
    sc.background = new THREE.Color('#151a22');
    sc.fog = new THREE.Fog('#151a22', 9, 18);
    this.cam = new THREE.PerspectiveCamera(36, 1, 0.1, 50);
    this.camPos = new THREE.Vector3(0.3, 1.5, 5); this.camLook = new THREE.Vector3(0.3, 1, 0);
    // Licht: warmes Grundlicht, Hauptlicht von vorn links, Spot auf das Podest, kühles Streiflicht von hinten
    sc.add(new THREE.HemisphereLight('#ffe9cf', '#2a2018', 0.9));
    const key = new THREE.DirectionalLight('#fff3e2', 2.0); key.position.set(-3, 5, 5); sc.add(key);
    const rim = new THREE.DirectionalLight('#9cc8ff', 1.2); rim.position.set(3, 3, -4); sc.add(rim);
    const spot = new THREE.SpotLight('#ffffff', 26, 9, 0.5, 0.6, 1.4); spot.position.set(0.1, 4.6, 1.8); spot.target.position.set(0.1, 0.6, 0); sc.add(spot, spot.target);
    // Raum: Holzboden, Holzwand mit Regal, Schild
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(14, 10), new THREE.MeshStandardMaterial({ map: woodTexture(1024, 512, [118, 84, 58], 10, 7), roughness: 0.75 }));
    floor.material.map.wrapS = floor.material.map.wrapT = THREE.RepeatWrapping; floor.material.map.repeat.set(2, 1);
    floor.rotation.x = -Math.PI / 2; floor.position.z = 1; sc.add(floor);
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(14, 5), new THREE.MeshStandardMaterial({ map: woodTexture(1024, 512, [150, 108, 72], 22, 3), roughness: 0.85 }));
    wall.position.set(0, 2.5, -2.4); sc.add(wall);
    for (const sx of [-1, 1]) { const side = wall.clone(); side.position.set(sx * 6.5, 2.5, 1); side.rotation.y = -sx * Math.PI / 2; sc.add(side); }
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.66), new THREE.MeshBasicMaterial({ map: signTexture() }));
    sign.position.set(0, 3.2, -2.38); sc.add(sign);
    const rail = new THREE.Mesh(new THREE.BoxGeometry(8.4, 0.06, 0.12), new THREE.MeshStandardMaterial({ color: '#2b2f36', metalness: 0.8, roughness: 0.35 }));
    rail.position.set(0, 2.62, -2.28); sc.add(rail);
    const rail2 = rail.clone(); rail2.position.y = 0.42; sc.add(rail2);
    // Podest mit Leuchtring
    const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 1.02, 0.14, 48), new THREE.MeshStandardMaterial({ color: '#23272e', roughness: 0.4, metalness: 0.3 }));
    pod.position.set(PX, 0.07, PZ); sc.add(pod);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.98, 0.012, 8, 64), new THREE.MeshBasicMaterial({ color: '#ff8a3c' }));
    ring.rotation.x = Math.PI / 2; ring.position.set(PX, 0.142, PZ); sc.add(ring);
    // Kontaktschatten unter der Puppe und dem Ständer
    const blobTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
    const blob = (x, y, z, s) => { const m = new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false })); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); sc.add(m); return m; };
    blob(PX, 0.145, PZ, 1.3);
    // Puppe: ein eigener Fahrer, der anprobiert
    this.turn = new THREE.Group(); this.turn.position.set(PX, 0.14, PZ); sc.add(this.turn);
    this.sk = new Skier(models);
    this.sk.root.scale.setScalar(1);
    this.turn.add(this.sk.root);
    if (env) this.sk.setEnv(env);
    // Ständer für das Ausstellungsstück (Ski oder Brett im Großformat)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.06, 40), new THREE.MeshStandardMaterial({ color: '#2b2f36', metalness: 0.7, roughness: 0.3 }));
    base.position.set(SX, 0.03, SZ); sc.add(base); this.base = base;
    this.baseBlob = blob(SX, 0.065, SZ, 0.9);
    this.stand = new THREE.Group(); this.stand.position.set(SX, 0.06, SZ); sc.add(this.stand);
    this.feature = null;
    // Wandregal: alle Ski bzw. Bretter
    this.rack = new THREE.Group(); sc.add(this.rack);
    this.rackItems = [];
    this.goldMat = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 1, roughness: 0.24, envMap: env || null, side: THREE.DoubleSide });
    this.paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32, metalness: 0.15, side: THREE.DoubleSide });
    this.boardMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.1, side: THREE.DoubleSide });
    this.markMat = new THREE.MeshBasicMaterial({ color: '#ff8a3c' });
    this.buildUI();
  }

  // ------------------------------------------------------------ Szene
  itemMesh(cat, id) {
    if (cat === 'ski') { const d = SKIS[id]; const m = new THREE.Mesh(makeSki(d), d.metal ? this.goldMat : this.paintMat); m.quaternion.copy(SKI_UP); return m; }
    const d = BOARDS[id]; const m = new THREE.Mesh(makeBoardGeo(d), d.metal ? this.goldMat : this.boardMat); m.quaternion.copy(BOARD_UP); return m;
  }
  buildRack() {
    for (const it of this.rackItems) { this.rack.remove(it.g); it.g.traverse((o) => { if (o.isMesh && o.geometry !== this._markGeo) o.geometry.dispose(); }); }
    this.rackItems = [];
    if (this.tab === 'outfit') return;
    const list = CATALOG[this.tab], n = list.length, gap = this.tab === 'ski' ? 0.62 : 0.72;
    list.forEach((it, i) => {
      const g = new THREE.Group();
      const x = (i - (n - 1) / 2) * gap;
      if (this.tab === 'ski') {   // Ski immer als Paar
        for (const sx of [-1, 1]) { const m = this.itemMesh('ski', it.id); m.position.x = sx * 0.075; g.add(m); }
        g.position.set(x, 0.55 + 0.92, -2.2);
      } else { const m = this.itemMesh('board', it.id); g.add(m); g.position.set(x, 0.55 + 0.8, -2.2); }
      g.rotation.y = 0.08 * Math.sign(-x);
      if (!this._markGeo) this._markGeo = new THREE.BoxGeometry(0.36, 0.035, 0.02);
      const mark = new THREE.Mesh(this._markGeo, this.markMat); mark.position.set(0, -1.02, 0.06); mark.visible = false; g.add(mark);
      this.rack.add(g);
      this.rackItems.push({ id: it.id, g, mark, x });
    });
  }
  showFeature() {
    if (this.feature) { this.stand.remove(this.feature); this.feature.traverse((o) => { if (o.isMesh) o.geometry.dispose(); }); this.feature = null; }
    const id = this.sel[this.tab];
    this.base.visible = this.baseBlob.visible = this.tab !== 'outfit';
    if (this.tab === 'outfit') return;
    const g = new THREE.Group();
    if (this.tab === 'ski') { for (const sx of [-1, 1]) { const m = this.itemMesh('ski', id); m.position.set(sx * 0.08, 0, 0); g.add(m); } g.position.y = 0.92; }
    else { const m = this.itemMesh('board', id); g.add(m); g.position.y = 0.82; }
    this.feature = g; this.stand.add(g);
  }
  dress() {
    // Puppe: anprobieren, was gerade gewählt ist (ohne zu kaufen); sonst das Angelegte
    const sk = this.sk, tab = this.tab;
    const gear = tab === 'board' ? 'board' : tab === 'ski' ? 'ski' : this.hooks.getGear();
    sk.setGear(gear);
    sk.setSkiDesign(tab === 'ski' ? this.sel.ski : shop.equip.ski);
    sk.setBoardDesign(tab === 'board' ? this.sel.board : shop.equip.board);
    const oid = tab === 'outfit' ? this.sel.outfit : shop.equip.outfit, o = OUTFITS[oid];
    if (o && o.jacket) { sk.setColors(o.jacket, o.accent, o.pants); sk.setHead(o.head || null); sk.setBody(oid); }
    else { const c = this.hooks.customColors(); sk.setColors(c.jacket, c.accent, c.pants); sk.setHead(null); sk.setBody(null); }
    for (const it of this.rackItems) { const on = it.id === this.sel[tab]; it.mark.visible = on; it.g.position.z = on ? -2.05 : -2.2; }
  }

  // ------------------------------------------------------------ Oberfläche
  buildUI() {
    const root = this.ui = document.createElement('div');
    root.id = 'shop3d'; root.className = 'hidden'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-label', 'Shop');
    root.innerHTML = `
      <header class="s3-top"><b>Gipfel-Shop</b><span class="s3-wallet">Guthaben <b></b></span><button class="s3-x" aria-label="Shop schließen">×</button></header>
      <nav class="s3-left">
        <div class="s3-tabs" role="tablist">${Object.keys(TAB_NAMES).map((t) => `<button role="tab" data-t="${t}">${TAB_NAMES[t]}</button>`).join('')}</div>
        <ul class="s3-list"></ul>
      </nav>
      <div class="s3-stage" aria-hidden="true"></div>
      <aside class="s3-detail" aria-live="polite"></aside>
      <p class="s3-hint">Ziehen zum Drehen · ↑ ↓ wählen · Enter kaufen oder anlegen · Esc zurück</p>`;
    (document.getElementById('app') || document.body).appendChild(root);
    root.querySelector('.s3-x').addEventListener('click', () => this.close());
    for (const b of root.querySelectorAll('.s3-tabs button')) b.addEventListener('click', () => this.setTab(b.dataset.t));
    // Drehen per Ziehen (Maus und Finger), Abstand per Mausrad
    const st = root.querySelector('.s3-stage');
    let lx = 0;
    const px = (e) => (this.hooks.isRot() ? e.clientY : e.clientX);
    st.addEventListener('pointerdown', (e) => { this.dragging = true; lx = px(e); try { st.setPointerCapture(e.pointerId); } catch {} });
    st.addEventListener('pointermove', (e) => { if (!this.dragging) return; const x = px(e), dx = x - lx; lx = x; this.spin += dx * 0.012; this.spinV = dx * 0.012 * 60; this.idleT = 0; });
    const up = () => { this.dragging = false; };
    st.addEventListener('pointerup', up); st.addEventListener('pointercancel', up);
    st.addEventListener('wheel', (e) => { e.preventDefault(); this.zoom = Math.max(-0.35, Math.min(0.5, this.zoom + e.deltaY * 0.0012)); }, { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e), true);
  }
  onKey(e) {
    if (!this.isOpen) return;
    const k = e.code;
    if (e.target instanceof HTMLInputElement) return;
    const list = CATALOG[this.tab], i = list.findIndex((q) => q.id === this.sel[this.tab]);
    if (k === 'Escape') this.close();
    else if (k === 'ArrowDown' || k === 'KeyS') this.select(list[(i + 1) % list.length].id, true);
    else if (k === 'ArrowUp' || k === 'KeyW') this.select(list[(i - 1 + list.length) % list.length].id, true);
    else if (k === 'ArrowRight' || k === 'KeyD' || k === 'ArrowLeft' || k === 'KeyA') { const tabs = Object.keys(TAB_NAMES), j = tabs.indexOf(this.tab); this.setTab(tabs[(j + (k === 'ArrowRight' || k === 'KeyD' ? 1 : -1) + tabs.length) % tabs.length]); }
    else if ((k === 'Enter' || k === 'Space') && !(e.target instanceof HTMLButtonElement)) this.act();
    else return;   // andere Tasten (M, V) wie gewohnt
    e.preventDefault(); e.stopImmediatePropagation();
  }
  setTab(t) {
    this.tab = t;
    this.sel[t] = this.sel[t] || shop.equip[t];
    for (const b of this.ui.querySelectorAll('.s3-tabs button')) { const on = b.dataset.t === t; b.classList.toggle('sel', on); b.setAttribute('aria-selected', String(on)); }
    this.buildRack(); this.showFeature(); this.dress(); this.renderUI();
  }
  select(id, focus) {
    this.sel[this.tab] = id;
    this.showFeature(); this.dress(); this.renderUI();
    if (focus) { const b = this.ui.querySelector(`.s3-list button[data-id="${id}"]`); if (b) { b.focus({ preventScroll: true }); b.scrollIntoView({ block: 'nearest' }); } }
  }
  act() {
    const cat = this.tab, id = this.sel[cat], it = CATALOG[cat].find((q) => q.id === id);
    if (!it || shop.equip[cat] === id) return;
    const ok = shop.has(cat, id) ? shop.wear(cat, id) : shop.buy(cat, id);
    if (!ok) return;
    if (cat === 'ski' || cat === 'board') this.hooks.setGear(cat);   // wer ein Brett anlegt, will Brett fahren
    this.hooks.onEquip();
    this.flash = 1;
    this.dress(); this.renderUI();
  }
  renderUI() {
    const cat = this.tab, list = CATALOG[cat];
    this.ui.querySelector('.s3-wallet b').textContent = `${num(shop.wallet)} Punkte`;
    const ul = this.ui.querySelector('.s3-list');
    ul.innerHTML = list.map((it) => {
      const own = shop.has(cat, it.id), on = shop.equip[cat] === it.id, sel = this.sel[cat] === it.id;
      const sw = it.colors.slice(0, 3).map((c) => `<i style="background:${c}"></i>`).join('');
      const state = on ? '<em class="on">Angelegt</em>' : own ? '<em>Gekauft</em>' : `<em class="price">${num(it.price)}</em>`;
      return `<li><button data-id="${it.id}" class="${sel ? 'sel' : ''}" aria-current="${sel}"><span class="s3-sw">${sw}</span><span class="s3-name">${it.name}</span>${state}</button></li>`;
    }).join('');
    for (const b of ul.querySelectorAll('button')) b.addEventListener('click', () => this.select(b.dataset.id));
    const id = this.sel[cat], it = list.find((q) => q.id === id);
    const own = shop.has(cat, id), on = shop.equip[cat] === id, afford = shop.wallet >= it.price;
    const cur = list.find((q) => q.id === shop.equip[cat]);
    const stats = it.st ? `<ul class="gstats">${STAT_NAMES.map(([k, nm]) => {
      const v = it.st[k], dv = cur && cur.st && !on ? v - cur.st[k] : 0;
      return `<li><span>${nm}</span><i style="--v:${v * 10}%" role="img" aria-label="${nm} ${v} von 10"></i><em class="${dv > 0 ? 'up' : dv < 0 ? 'dn' : ''}">${dv > 0 ? '+' + dv : dv < 0 ? String(dv).replace('-', '−') : ''}</em></li>`;
    }).join('')}</ul>` : '';
    const label = on ? 'Angelegt' : own ? 'Anlegen' : `Kaufen · ${num(it.price)} Punkte`;
    const note = !own && !afford ? `<small>Dir fehlen noch ${num(it.price - shop.wallet)} Punkte. Punkte gibt es für jeden Lauf.</small>`
      : !own ? '<small>Nur Spielpunkte, kein echtes Geld.</small>'
      : cat === 'outfit' && id === 'custom' ? '<small>Die Farben stellst du im Menü unter „Outfit“ ein.</small>' : '';
    this.ui.querySelector('.s3-detail').innerHTML = `<span class="s3-kicker">${KICKER[cat]}${on ? ' · angelegt' : !own ? ' · Vorschau' : ''}</span><h2>${it.name}</h2><p>${it.text}</p>${stats}
      <button class="cta s3-buy" ${on || (!own && !afford) ? 'disabled' : ''}>${label}</button>${note}`;
    this.ui.querySelector('.s3-buy').addEventListener('click', () => this.act());
  }

  // ------------------------------------------------------------ Öffnen, Schließen, Zeichnen
  open(tab) {
    this.isOpen = true; this.idleT = 0; this.zoom = 0;
    this.sel = { ski: shop.equip.ski, board: shop.equip.board, outfit: shop.equip.outfit };
    this.ui.classList.remove('hidden'); document.body.classList.add('shopopen');
    this.setTab(tab || (this.hooks.getGear() === 'board' ? 'board' : 'ski'));
    this.camSnap = true;
    const b = this.ui.querySelector('.s3-list button.sel'); if (b) b.focus({ preventScroll: true });
  }
  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.ui.classList.add('hidden'); document.body.classList.remove('shopopen');
    if (this.hooks.onClose) this.hooks.onClose();
  }
  refresh() { if (this.isOpen) this.renderUI(); }
  render(dt) {
    this.t += dt;
    this.idleT += dt;
    if (!this.dragging) { this.spinV *= Math.exp(-dt * 3); this.spin += this.spinV * dt + (this.idleT > 2.5 ? dt * 0.35 : 0); }
    this.turn.rotation.y = this.spin;
    if (this.feature) this.feature.rotation.y = Math.sin(this.t * 0.6) * 0.9;
    this.sk.update({ lean: 0, crouch: 0.1, edge: 0, steer: 0, plow: 0, plowDir: 1, air: 0, compress: 0, speed: 0, grab: 0, grabSide: 0, sup: 0, cross: 0, daffy: 0, look: this.sk.gear === 'board' ? 0.72 : 0, tuck: 0, spin: 0, extend: 0, crash: 0, crashA: 0 }, dt);
    // Kamera je Reiter: Ski und Bretter mit Ausstellungsstück und Regal, Outfits näher an der Puppe
    const w = this.r.domElement.width, h = this.r.domElement.height, asp = w / Math.max(1, h);
    const narrow = asp < 1.5 ? 1 + (1.5 - asp) * 0.6 : 1;
    const look = this.tab === 'outfit' ? [PX, 1.12, PZ] : [0.0, 1.15, 0];
    const dist = (this.tab === 'outfit' ? 3.9 : 5.2) * narrow * (1 + this.zoom);
    const tp = new THREE.Vector3(look[0] + 0.1, look[1] + 0.3 + dist * 0.06, look[2] + dist);
    const k = this.camSnap ? 1 : 1 - Math.exp(-dt * 5);
    this.camPos.lerp(tp, k); this.camLook.lerp(new THREE.Vector3(...look), k); this.camSnap = false;
    this.cam.position.copy(this.camPos); this.cam.lookAt(this.camLook);
    if (Math.abs(this.cam.aspect - asp) > 1e-3) { this.cam.aspect = asp; this.cam.updateProjectionMatrix(); }
    this.markMat.color.setHSL(0.07, 1, 0.55 + 0.1 * Math.sin(this.t * 4));
    this.r.setRenderTarget(null);
    this.r.render(this.scene, this.cam);
  }
}
