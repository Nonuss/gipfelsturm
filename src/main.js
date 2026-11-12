import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import * as C from './course.js';
import { World, loadModels } from './world.js';
import { SnowTracks } from './snow.js';
import { SkiPhysics } from './physics.js';
import { Skier } from './skier.js';
import { Spray, DiamondDust } from './particles.js';
import { GameAudio } from './audio.js';
import { Q, setTier, ORDER } from './quality.js';
import { PowderPatch } from './powder.js';
import { setupTouch, updateTouch, touch, isTouch, viewSize } from './touch.js';

const { clamp, lerp, smoothstep, G } = C;
const $ = (id) => document.getElementById(id);
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- Renderer
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, 1, 0.3, 20000);

const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 }));
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.55, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// Farblook: etwas mehr Kontrast und Sättigung, kühle Schatten, warme Lichter, leichte Vignette (sehr günstig)
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.22 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, 1.1);                                   // Sättigung
      c = c + (c - 0.5) * 0.06 * (1.0 - abs(c - 0.5) * 2.0);      // sanfte S-Kurve
      c *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.25, 0.85, l));   // Schatten kühl, Lichter warm
      vec2 q = vUv - 0.5;
      c *= 1.0 - uVig * smoothstep(0.35, 0.85, length(q * vec2(1.15, 1.0)));
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
});
composer.addPass(grade);
// Kantenglättung per Nachbearbeitung, wenn MSAA aus ist (niedrige Stufe, Handys)
const fxaa = new FXAAPass();
composer.addPass(fxaa);

let world, skier, tracks, spray, dust, patch;
const phys = new SkiPhysics();
const audio = new GameAudio();

// Dynamische Auflösung: startet scharf (bis zur vollen Pixeldichte der Stufe) und regelt nur so weit herunter,
// wie es für flüssige Bilder nötig ist. Danach wird langsam wieder hochgeregelt.
let renderScale = 0;
const maxScale = () => Math.min(window.devicePixelRatio || 1, Q.pr);
const minScale = () => Math.min(maxScale(), Q.minPR || 0.75);
function resize() {
  const { w, h } = viewSize();   // Handy hochkant: Spiel wird gedreht, Breite und Höhe tauschen
  if (!renderScale) renderScale = maxScale();
  renderScale = clamp(renderScale, minScale(), maxScale());
  const pr = renderScale;
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h, false);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  if (spray) spray.resize(h * pr, camera.fov);
  if (dust) dust.resize(h * pr, camera.fov);
}
window.addEventListener('resize', resize);

// ---------------------------------------------------------------- Leistungsstufen
const QUAL_KEY = 'gipfelsturm_quality', AUTO_KEY = 'gipfelsturm_auto_tier2';   // neuer Schlüssel: alte, zu niedrige Automatik-Wahl verwerfen
let qualSetting = localStorage.getItem(QUAL_KEY) || 'auto';
function applyQuality() {
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    if (rt.samples !== Q.msaa) { rt.samples = Q.msaa; rt.dispose(); }
  }
  bloom.enabled = Q.bloom;
  fxaa.enabled = Q.msaa === 0;
  renderScale = maxScale();
  C.cfg.treeMul = Q.trees;
  if (world) {
    world.setLowQuality(Q.tier === 'low');
    world.setShadowSize(Q.shadow);
    if (C.cfg.endless) scene.fog.far = Q.view - 30;
  }
  if (dust) dust.points.visible = Q.dust;
  if (patch && Q.patch > 0 && patch.cell !== Q.patch) { const old = patch; scene.remove(old.mesh); old.geo.dispose(); patch = new PowderPatch(scene, Q.patch, Math.round(18 / Q.patch) + 1); }
  resize();
  for (const b of $('quality').children) b.classList.toggle('sel', b.dataset.q === qualSetting);
}
function chooseQuality(q) {
  qualSetting = q;
  localStorage.setItem(QUAL_KEY, q);
  setTier(q === 'auto' ? localStorage.getItem(AUTO_KEY) || (isTouch ? 'mid' : 'high') : q);
  applyQuality();
}
// „Auto“: bleibt die Bildrate länger unter 40, wird eine Stufe heruntergeschaltet (und gemerkt)
let fpsEma = 60, slowT = 0;
let drsT = 0, drsN = 0, drsUpBlock = 0, drsStable = 0;
function dynamicResolution(rawDt) {
  if (game.mode !== 'run' || document.hidden || rawDt > 0.25) { drsT = 0; drsN = 0; return; }
  drsT += rawDt; drsN++;
  drsUpBlock = Math.max(0, drsUpBlock - rawDt);
  if (drsT < 0.8) return;
  const fps = drsN / drsT;
  drsT = 0; drsN = 0;
  const old = renderScale;
  if (fps < 50) { renderScale = Math.max(minScale(), renderScale * (fps < 38 ? 0.8 : 0.9)); drsStable = 0; drsUpBlock = 12; }
  else if (fps > 58) { drsStable += 0.8; if (drsStable > 4 && drsUpBlock <= 0) { renderScale = Math.min(maxScale(), renderScale * 1.07); drsStable = 0; } }
  if (Math.abs(renderScale - old) > 0.01) resize();
}
function watchPerformance(rawDt) {
  dynamicResolution(rawDt);
  if (qualSetting !== 'auto' || game.mode !== 'run' || document.hidden || rawDt > 0.25) return;
  fpsEma += (1 / Math.max(rawDt, 1e-3) - fpsEma) * 0.05;
  slowT = fpsEma < 40 && renderScale <= minScale() + 0.01 ? slowT + rawDt : 0;
  const idx = ORDER.indexOf(Q.tier);
  if (slowT > 2.5 && idx < ORDER.length - 1) {
    slowT = 0; fpsEma = 60;
    setTier(ORDER[idx + 1]);
    localStorage.setItem(AUTO_KEY, Q.tier);
    applyQuality();
    showMsg('Grafik angepasst – läuft jetzt flüssiger', 'good');
  }
}

// ---------------------------------------------------------------- Zustand
const BEST_KEY = 'gipfelsturm_best', BEST_E_KEY = 'gipfelsturm_best_points', BEST_D_KEY = 'gipfelsturm_best_dist', OUTFIT_KEY = 'gipfelsturm_outfit2';
const game = {
  mode: 'loading', kind: 'race', time: 0, penalty: 0, passed: 0, gateIdx: 0, topSpeed: 0, bestJump: 0, countdown: 0, lastCount: 0, finishT: 0,
  score: 0, maxD: 0, bestTrick: '', bestTrickPts: 0, tricks: 0, cp: null,
  best: parseFloat(localStorage.getItem(BEST_KEY) || '0') || 0,
  bestEndless: parseInt(localStorage.getItem(BEST_E_KEY) || '0', 10) || 0,
  bestDist: parseInt(localStorage.getItem(BEST_D_KEY) || '0', 10) || 0,
  // Endlos-Welt: Punkte sind ein Risiko-Konto. Trickpunkte sind erst „gesichert“, wenn man nach der Landung sauber
  // weiterfährt; ein Sturz löscht alle Punkte, die Meter bleiben. Saubere Tricks hintereinander erhöhen den Multiplikator.
  pend: 0, pendT: 0, combo: 1, comboT: 0,
};
const PEND_TIME = 1.6;      // so lange muss man nach einer Landung ohne Sturz weiterfahren
const COMBO_TIME = 14;      // ohne neuen Trick fällt der Multiplikator danach zurück
const keys = { left: false, right: false, up: false, down: false, space: false };
const airKey = { left: false, right: false, up: false, down: false, space: false };
const inp = { steer: 0, tuck: 0, brake: 0, jump: false };
const zeroInp = { steer: 0, tuck: 0, brake: 0, jump: false };
const vis = {
  lean: 0, crouch: 0, compress: 0, plow: 0, air: 0, up: new THREE.Vector3(0, 1, 0), crashAngle: 0, crashSpin: 0,
  tuck: 0, spin: 0, extend: 0, zoom: 0, shake: 0, crashCam: 0,
  camSide: 1, flipCam: 0, bigAir: 0, dip: 0,
};
const trick = { pitch: 0, yaw: 0, pv: 0, yv: 0, grab: 0, grabT: 0, wasAir: false };
let jumpQueued = false;
let quietCrash = false;
let hasPrevSki = false;
const prevSki = [{ tx: 0, tz: 0, hx: 0, hz: 0 }, { tx: 0, tz: 0, hx: 0, hz: 0 }];

const fmt = (t) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
};
const num = (n) => Math.round(n).toLocaleString('de-DE');

function showMsg(text, cls = 'good') {
  const el = $('msg');
  el.className = '';
  void el.offsetWidth;
  el.textContent = text;
  el.className = 'show ' + cls;
}

// ---------------------------------------------------------------- Outfit
const SW = {
  jacket: ['#1d2c52', '#23262d', '#0f6b5a', '#8a1f2b', '#5b3ea8', '#e9e6df', '#d99a1c', '#2f6fd0'],
  accent: ['#ff6a13', '#ffd23f', '#35e0a1', '#ff3d7f', '#27c3ff', '#f2f2f0', '#b6ff3a', '#23262d'],
  pants: ['#33363b', '#1b1d21', '#1d2c52', '#6b5a3c', '#3f5d3b', '#7a2a2a', '#cfc7b4', '#8a8f98'],
};
const outfit = { jacket: SW.jacket[0], accent: SW.accent[0], pants: SW.pants[0] };
try { Object.assign(outfit, JSON.parse(localStorage.getItem(OUTFIT_KEY) || '{}')); } catch { /* Standardfarben */ }
const SW_IDS = { jacket: ['swJacket', 'colJacket'], accent: ['swAccent', 'colAccent'], pants: ['swPants', 'colPants'] };

function applyOutfit() {
  if (skier) skier.setColors(outfit.jacket, outfit.accent, outfit.pants);
  localStorage.setItem(OUTFIT_KEY, JSON.stringify(outfit));
  for (const key in SW_IDS) {
    for (const b of $(SW_IDS[key][0]).children) b.classList.toggle('sel', b.dataset.c === outfit[key]);
    $(SW_IDS[key][1]).value = outfit[key];
  }
}
function buildMenuControls() {
  for (const key in SW_IDS) {
    for (const c of SW[key]) {
      const b = document.createElement('button');
      b.className = 'sw';
      b.style.background = c;
      b.dataset.c = c;
      b.setAttribute('aria-label', `Farbe ${c}`);
      b.addEventListener('click', () => { outfit[key] = c; applyOutfit(); b.blur(); });
      $(SW_IDS[key][0]).appendChild(b);
    }
    $(SW_IDS[key][1]).addEventListener('input', (e) => { outfit[key] = e.target.value; applyOutfit(); });
  }
  for (const b of $('quality').children) {
    b.addEventListener('click', () => {
      chooseQuality(b.dataset.q);
      if (game.mode === 'menu' && game.kind === 'endless') setKind('endless');
      b.blur();
    });
  }
}

// ---------------------------------------------------------------- Modus
function resetVisuals() {
  hasPrevSki = false;
  Object.assign(vis, { lean: 0, crouch: 0, compress: 0, plow: 0, air: 0, crashAngle: 0, crashSpin: 0, tuck: 0, spin: 0, extend: 0, zoom: 0, shake: 0, crashCam: 0, camSide: 1, flipCam: 0, bigAir: 0, dip: 0 });
  Object.assign(trick, { pitch: 0, yaw: 0, pv: 0, yv: 0, grab: 0, grabT: 0, wasAir: false });
  skier.attachSkis();
  skier.pivot.rotation.set(0, 0, 0);
  skier.pivot.position.y = 0.85;
  camSnap = true;
}
function resetRunState() {
  if (patch) patch.reset();
  phys.reset(-1);
  phys.events.length = 0;
  tracks.clear();
  game.cp = null;
  world.setFlag(null);
  resetVisuals();
}

function setKind(kind, seed) {
  game.kind = kind;
  C.cfg.treeMul = Q.trees;
  C.setMode(kind === 'endless', seed || 1 + Math.floor(Math.random() * 1e6));
  world.setMode();
  resetRunState();
  for (const b of document.querySelectorAll('.mode')) b.classList.toggle('sel', b.dataset.mode === kind);
  $('menuKicker').textContent = kind === 'endless' ? 'Freeride · jedes Mal ein neuer Berg' : 'Abfahrt · 2,4 km · 650 Höhenmeter';
  $('lblMain').textContent = kind === 'endless' ? 'Punkte' : 'Zeit';
  $('lblSide').textContent = kind === 'endless' ? 'Respawn' : 'Tore';
  $('progress').classList.toggle('off', kind === 'endless');
}

function startRun() {
  audio.start();
  saveEndlessBest();
  if (game.kind === 'endless') setKind('endless', game.forceSeed);   // jedes Mal ein neuer Berg (forceSeed nur für Tests)
  else { world.resetGates(); resetRunState(); }
  $('menu').classList.add('hidden');
  $('finish').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('hint').classList.remove('fade');
  setTimeout(() => $('hint').classList.add('fade'), 14000);
  Object.assign(game, {
    mode: 'countdown', time: 0, penalty: 0, passed: 0, gateIdx: 0, topSpeed: 0, bestJump: 0, countdown: 3.0, lastCount: 4, finishT: 0,
    score: 0, maxD: 0, bestTrick: '', bestTrickPts: 0, tricks: 0, pend: 0, pendT: 0, combo: 1, comboT: 0,
  });
  $('penalty').textContent = '';
}

function toMenu() {
  if (game.mode === 'loading') return;
  saveEndlessBest();
  game.mode = 'menu';
  resetRunState();
  $('menu').classList.remove('hidden');
  $('finish').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('count').innerHTML = '';
}

const totalScore = () => Math.round(game.score);
function saveEndlessBest() {
  if (game.kind !== 'endless' || game.mode === 'menu' || game.mode === 'loading') return;
  const t = totalScore();
  if (t > game.bestEndless) { game.bestEndless = t; localStorage.setItem(BEST_E_KEY, String(t)); }
  const m = Math.round(game.maxD);
  if (m > game.bestDist) { game.bestDist = m; localStorage.setItem(BEST_D_KEY, String(m)); }
}
/** Endlos-Welt: Punkte einer Landung vormerken; gesichert werden sie erst nach sauberem Weiterfahren. */
function addPending(pts, isTrick) {
  if (game.kind !== 'endless') { game.score += pts; return pts; }
  const mult = isTrick ? game.combo : 1;
  const p = Math.round(pts * mult);
  game.pend += p;
  game.pendT = PEND_TIME;
  if (isTrick) { game.combo = Math.min(5, game.combo + 0.5); game.comboT = COMBO_TIME; }
  return p;
}
function updatePoints(dt) {
  if (game.kind !== 'endless' || game.mode !== 'run') return;
  if (game.pend > 0 && phys.grounded && phys.crashed <= 0) {
    game.pendT -= dt;
    if (game.pendT <= 0) {
      game.score += game.pend;
      showMsg(`Gesichert  +${num(game.pend)}`, 'good');
      game.pend = 0;
      saveEndlessBest();
    }
  }
  if (game.combo > 1 && phys.crashed <= 0) {
    game.comboT -= dt;
    if (game.comboT <= 0) { game.combo = 1; }
  }
}

function finishRun() {
  game.mode = 'finished';
  game.finishT = 0;
  const total = game.time + game.penalty;
  const isBest = !game.best || total < game.best;
  if (isBest) { game.best = total; localStorage.setItem(BEST_KEY, String(total)); }
  audio.finish();
  $('finTitle').textContent = isBest ? 'Neue Bestzeit!' : 'Im Ziel';
  $('finTime').textContent = fmt(total);
  const rows = [['Tore', `${game.passed}/${C.gates.length}`], ['Strafzeit', `+${game.penalty.toFixed(0)} s`], ['Trickpunkte', num(game.score)],
    ['Höchsttempo', `${Math.round(game.topSpeed * 3.6)} km/h`], ['Weitester Sprung', `${game.bestJump.toFixed(1)} m`], ['Bestzeit', fmt(game.best)]];
  $('finStats').innerHTML = rows.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('');
}

// ---------------------------------------------------------------- Respawn-Punkte
function setCheckpoint() {
  if (game.mode !== 'run' || !phys.grounded || phys.crashed > 0) return;
  game.cp = { x: phys.pos.x, z: phys.pos.z, h: phys.heading };
  world.setFlag(game.cp);
  audio.gate();
  showMsg('Respawn-Punkt gesetzt', 'good');
}
function teleport(x, z, heading) {
  if (C.cfg.endless) world.updateChunks(-z, true);
  phys.reset(-z, x);
  if (patch) patch.reset();
  if (heading !== undefined) phys.heading = heading;
  phys.events.length = 0;
  tracks.clear();
  resetVisuals();
}
function toCheckpoint() {
  if (game.mode !== 'run' || phys.crashed > 0) return;
  if (game.cp) {
    teleport(game.cp.x, game.cp.z, game.cp.h);
    showMsg('Zurück am Respawn-Punkt', 'good');
    return;
  }
  // Kein Punkt gesetzt (oder festgefahren): auf die Mitte der nächsten Piste, etwas weiter hinten
  const d = clamp(-phys.pos.z - 8, 2, C.MESH_D1 - 40);
  const x = C.cfg.endless ? C.surfaceAt(phys.pos.x, -d).lx : C.centerX(d);
  teleport(x, -d);
  showMsg('Zurück auf die Piste', 'good');
}

// ---------------------------------------------------------------- Eingabe
const KEYMAP = { ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', Space: 'space' };
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.target instanceof HTMLInputElement) return;
  const k = e.code;
  const name = KEYMAP[k];
  if (name) {
    keys[name] = true;
    // Tricks zählen nur für Tasten, die erst in der Luft gedrückt werden
    if (game.mode === 'run' && !phys.grounded) airKey[name] = true;
  }
  if (k === 'Space' || k === 'Enter') {
    if (game.mode === 'menu' || (game.mode === 'finished' && game.finishT > 1.2)) startRun();
    else if (game.mode === 'run' && phys.grounded) jumpQueued = true;
  } else if (k === 'KeyR') { if (game.mode !== 'loading') startRun(); }
  else if (k === 'KeyF') setCheckpoint();
  else if (k === 'KeyT' || k === 'Backspace') toCheckpoint();
  else if (k === 'Escape') toMenu();
  else if (k === 'KeyM') audio.setMuted(!audio.muted);
  if (k.startsWith('Arrow') || k === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  const name = KEYMAP[e.code];
  if (name) { keys[name] = false; airKey[name] = false; }
});
window.addEventListener('blur', () => { for (const k in keys) { keys[k] = false; airKey[k] = false; } });
// Handy: Knöpfe, Neigungssteuerung (Erlaubnis wird beim Start-Tipp eingeholt)
const touchCtl = setupTouch({ isAir: () => game.mode === 'run' && !phys.grounded && phys.crashed <= 0, isRunning: () => game.mode === 'run', onResize: () => resize() });
$('startBtn').addEventListener('click', () => { if (touchCtl) touchCtl.onStart(); if (game.mode === 'menu') startRun(); });
$('againBtn').addEventListener('click', () => { if (touchCtl) touchCtl.onStart(); startRun(); });
$('menuBtn').addEventListener('click', () => toMenu());
for (const b of document.querySelectorAll('.mode')) {
  b.addEventListener('click', () => { if (game.mode === 'menu' && game.kind !== b.dataset.mode) setKind(b.dataset.mode); b.blur(); });
}

// ---------------------------------------------------------------- Tricks
function updateTricks(dt) {
  const inAir = !phys.grounded && phys.crashed <= 0 && game.mode === 'run';
  if (inAir && !trick.wasAir) { for (const k in airKey) airKey[k] = false; trick.grabT = 0; }
  trick.wasAir = inAir;
  if (inAir) {
    const flipIn = (airKey.down ? 1 : 0) - (airKey.up ? 1 : 0);
    const spinIn = (airKey.right ? 1 : 0) - (airKey.left ? 1 : 0);
    // Ohne Taste dreht die Figur zur nächsten vollen Umdrehung weiter und richtet sich aus
    const pT = flipIn !== 0 ? flipIn * 8.4 : clamp((Math.round(trick.pitch / TAU) * TAU - trick.pitch) * 9, -8.4, 8.4);
    const yT = spinIn !== 0 ? spinIn * 8.8 : clamp((Math.round(trick.yaw / TAU) * TAU - trick.yaw) * 9, -8.8, 8.8);
    // weiches An- und Ausdrehen wirkt natürlicher als ein starres Tempo
    trick.pv += clamp(pT - trick.pv, -38 * dt, 38 * dt);
    trick.yv += clamp(yT - trick.yv, -44 * dt, 44 * dt);
    trick.pitch += trick.pv * dt;
    trick.yaw += trick.yv * dt;
    const gT = airKey.space ? 1 : 0;
    trick.grab += clamp(gT - trick.grab, -6 * dt, 6 * dt);
    if (trick.grab > 0.7) trick.grabT += dt;
  } else {
    const k = 1 - Math.exp(-dt * 12);
    trick.pitch -= trick.pitch * k;
    trick.yaw -= trick.yaw * k;
    trick.pv = 0; trick.yv = 0;
    trick.grab += clamp(0 - trick.grab, -10 * dt, 10 * dt);
  }
  const k = (r) => 1 - Math.exp(-dt * r);
  const rotating = inAir && (Math.abs(trick.pv) > 1.2 || Math.abs(trick.yv) > 1.2 || trick.grab > 0.3);
  vis.zoom += ((rotating ? 1 : 0) - vis.zoom) * k(rotating ? 5 : 2.5);
  // Kameraseite folgt der Drehrichtung: bei einer Drehung nach rechts schwenkt die Kamera nach rechts und sieht das Gesicht
  // vorbeidrehen. Bei Flips bleibt sie auf ihrer Seite und geht in die Profilansicht, damit man den Überschlag sieht.
  if (inAir && Math.abs(trick.yv) > 1.2) vis.camSide += (Math.sign(trick.yv) - vis.camSide) * k(3.2);
  else if (!inAir) vis.camSide += ((vis.camSide >= 0 ? 1 : -1) - vis.camSide) * k(1.5);
  vis.flipCam += ((inAir ? clamp(Math.abs(trick.pv) / 5, 0, 1) : 0) - vis.flipCam) * k(inAir ? 4 : 2);
  // Großer Flug (hoch über dem Boden): Kamera geht auf Abstand und zeigt die Landung
  vis.bigAir += ((inAir && phys.gap > 4 ? 1 : 0) - vis.bigAir) * k(inAir ? 2.2 : 3);
  vis.dip *= Math.exp(-dt * 5);
  vis.tuck += ((inAir ? clamp(Math.abs(trick.pv) / 7, 0, 1) : 0) - vis.tuck) * k(9);
  vis.spin += ((inAir ? clamp(-trick.yv / 8.8, -1, 1) : 0) - vis.spin) * k(9);
  // Absprung: kurz strecken. Kurz vor dem Boden: Beine zur Landung ausfahren.
  const nearGround = inAir && phys.vel.y < 0 && phys.gap < 2.6 && Math.abs(trick.pv) < 2.5;
  const pop = inAir && phys.airTime < 0.16;
  vis.extend += ((nearGround || pop ? 1 : 0) - vis.extend) * k(11);
}

/** Wird bei der Landung aufgerufen: wertet Drehungen aus oder lässt den Fahrer stürzen. */
function scoreLanding(e) {
  const flips = Math.round(trick.pitch / TAU), spins = Math.round(trick.yaw / TAU);
  const pOff = trick.pitch - flips * TAU, yOff = trick.yaw - spins * TAU;
  const grabT = trick.grabT;
  trick.pitch = pOff; trick.yaw = yOff; trick.grabT = 0;
  if (phys.crashed > 0) return;
  if (Math.abs(pOff) > 0.85 || Math.abs(yOff) > 1.1) {
    showMsg('Nicht ausgedreht!', 'bad');
    quietCrash = true;
    phys.crash();
    return;
  }
  const parts = [];
  let pts = 0, cats = 0;
  if (flips !== 0) {
    const n = Math.abs(flips);
    parts.push((n === 2 ? 'Doppel-' : n >= 3 ? 'Dreifach-' : '') + (flips > 0 ? 'Backflip' : 'Frontflip'));
    pts += [0, 500, 1300, 2600][Math.min(3, n)];
    cats++;
  }
  if (spins !== 0) {
    const n = Math.abs(spins);
    parts.push(String(n * 360));
    pts += Math.round(250 * Math.pow(n, 1.5));
    cats++;
  }
  if (grabT > 0.25) {
    parts.push('Safety Grab');
    pts += 150 + Math.round(Math.min(grabT, 1.5) * 300);
    cats++;
  }
  const airPts = e.airTime > 0.55 ? Math.round(e.dist * 4) : 0;
  if (cats > 0) {
    if (cats > 1) pts = Math.round(pts * 1.5);
    pts += airPts;
    const name = parts.join(' + ');
    const comboNow = game.combo;
    pts = addPending(pts, true);
    game.tricks++;
    if (pts > game.bestTrickPts) { game.bestTrickPts = pts; game.bestTrick = name; }
    showMsg(`${name}  +${num(pts)}${game.kind === 'endless' && comboNow > 1 ? `  (×${comboNow.toFixed(1).replace('.0', '')})` : ''}`, 'gold');
    audio.gate();
  } else if (e.airTime > 0.55) {
    const p = addPending(airPts, false);
    showMsg(`${e.dist.toFixed(1)} m Sprung${game.kind === 'endless' ? `  +${p}` : ''}`, 'gold');
  }
}

// ---------------------------------------------------------------- Kamera
const camPos = new THREE.Vector3(0, 5, 12), camDir = new THREE.Vector3(0, 0, -1), lookSm = new THREE.Vector3();
const tV = new THREE.Vector3(), tV2 = new THREE.Vector3(), tV3 = new THREE.Vector3();
let camSnap = true;

function updateCamera(dt, time) {
  const p = phys.pos, sp = phys.speed;
  if (game.mode === 'menu') {
    const a = Math.sin(time * 0.16) * 0.9 + 0.5;
    tV.set(p.x + Math.sin(a) * 2.1, 0, p.z - 3.3 - Math.cos(a) * 0.6);
    tV.y = Math.max(C.height(tV.x, tV.z) + 1.3, p.y + 1.2 + Math.sin(time * 0.23) * 0.3);
    camPos.lerp(tV, camSnap ? 1 : 1 - Math.exp(-dt * 2));
    lookSm.set(p.x - (camera.aspect > 1.2 ? 0.9 : 0), p.y + 1.0, p.z);
    camera.position.copy(camPos);
    camera.lookAt(lookSm);
    camera.fov = 42;
    camera.updateProjectionMatrix();
    camSnap = false;
    return;
  }
  const z = vis.zoom, cc = vis.crashCam;
  if (sp > 2) tV.set(phys.vel.x, 0, phys.vel.z).normalize();
  else tV.set(Math.sin(phys.heading), 0, -Math.cos(phys.heading));
  camDir.lerp(tV, camSnap ? 1 : 1 - Math.exp(-dt * 3.2)).normalize();
  // Bei Tricks rückt die Kamera heran und schwenkt leicht zur Seite, beim Sturz geht sie auf Abstand
  const fc = vis.flipCam * z, ba = vis.bigAir * (1 - z * 0.6);
  const dist = (lerp(6.4 + sp * 0.07 - inp.tuck * 0.5 + vis.air * 1.2, 4.6 + fc * 0.8, z) + ba * 3.2) * (1 - 0.35 * cc) + cc * 2.6;
  tV2.copy(p).addScaledVector(camDir, -dist);
  const side = (2.6 * z + 1.6 * fc) * vis.camSide;
  tV2.x += -camDir.z * side;
  tV2.z += camDir.x * side;
  const groundY = C.height(tV2.x, tV2.z);
  tV2.y = Math.max(groundY + 1.9 + sp * 0.012, p.y + 1.55);
  tV2.y = Math.max(groundY + 1.2, lerp(tV2.y, p.y + 1.3 - fc * 0.35, z * 0.75)) + cc * 1.9 + ba * 1.6 - vis.dip * 0.45;
  camPos.lerp(tV2, camSnap ? 1 : 1 - Math.exp(-dt * (7.5 + cc * 9)));
  const gh = C.height(camPos.x, camPos.z) + 0.9;
  if (camPos.y < gh) camPos.y = gh;
  tV3.copy(p).addScaledVector(camDir, (6 + ba * 5) * (1 - z) * (1 - cc));
  tV3.y = lerp(lerp(C.height(tV3.x, tV3.z) + 1.0, p.y + 1.0, 0.5 + vis.air * 0.3 - ba * 0.35), p.y + 0.9, Math.max(z, cc));
  lookSm.lerp(tV3, camSnap ? 1 : 1 - Math.exp(-dt * (11 + z * 8)));
  camSnap = false;
  const sh = Math.pow(clamp(sp / 42, 0, 1), 2) * 0.035 + vis.shake * 0.4;
  camera.position.set(
    camPos.x + (C.vnoise(time * 23, 1.3) - 0.5) * sh,
    camPos.y + (C.vnoise(time * 27, 7.7) - 0.5) * sh,
    camPos.z + (C.vnoise(time * 19, 4.1) - 0.5) * sh);
  camera.lookAt(lookSm);
  camera.rotateZ(-vis.lean * 0.09 + (C.vnoise(time * 17, 9.2) - 0.5) * vis.shake * 0.12);
  const fov = 60 + 22 * smoothstep(8, 44, sp) + inp.tuck * 2 - 15 * z - 20 * cc + 6 * ba;
  if (Math.abs(fov - camera.fov) > 0.01) {
    camera.fov = lerp(camera.fov, fov, 1 - Math.exp(-dt * 4));
    camera.updateProjectionMatrix();
  }
}

// ---------------------------------------------------------------- Spuren & Gischt
function stampTracks() {
  if (!phys.grounded) { hasPrevSki = false; return; }
  const p = phys.pos, f = phys.fwd, r = phys.right;
  if (phys.crashed > 0) {
    tracks.blob(p.x, p.z, 0.9, 0.8, 0.95);
    hasPrevSki = false;
    return;
  }
  if (phys.speed < 0.15 && hasPrevSki) return;
  const stance = 0.17 + 0.07 * Math.abs(vis.lean) + 0.13 * vis.plow;
  const depth = clamp(0.5 + 0.3 * phys.pressure + phys.off * 0.3 + phys.pow * 0.35, 0, 1);
  const skidG = clamp(phys.skid / 2.2 + inp.brake * 0.4, 0, 1);
  const hw = 0.062 + phys.off * 0.05 + phys.pow * 0.07;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    const yaw = side * vis.plow * 0.33;
    const fx = f.x - r.x * yaw, fz = f.z - r.z * yaw;
    const cx = p.x + r.x * side * stance, cz = p.z + r.z * side * stance;
    const hx = cx + fx * 0.86, hz = cz + fz * 0.86, tx = cx - fx * 0.8, tz = cz - fz * 0.8;
    const wx = r.x * hw, wz = r.z * hw;
    tracks.quad(tx - wx, tz - wz, -1, tx + wx, tz + wz, 1, hx + wx, hz + wz, 1, hx - wx, hz - wz, -1, depth, skidG * 0.5);
    const q = prevSki[i];
    if (hasPrevSki && (skidG > 0.12 || phys.off > 0.3)) {
      tracks.quad(q.tx, q.tz, 0, q.hx, q.hz, 0, hx, hz, 0, tx, tz, 0, 0.22 + skidG * 0.3 + phys.off * 0.3, Math.max(skidG, phys.off * 0.6));
    }
    q.tx = tx; q.tz = tz; q.hx = hx; q.hz = hz;
  }
  if (phys.off > 0.2 || phys.pow > 0.2) {
    const w = 0.42 + phys.pow * 0.25;
    tracks.quad(p.x - r.x * w - f.x * 0.9, p.z - r.z * w - f.z * 0.9, -1, p.x + r.x * w - f.x * 0.9, p.z + r.z * w - f.z * 0.9, 1,
      p.x + r.x * w + f.x * 0.9, p.z + r.z * w + f.z * 0.9, 1, p.x - r.x * w + f.x * 0.9, p.z - r.z * w + f.z * 0.9, -1, 0.7 * Math.max(phys.off, phys.pow), 0.8 * phys.off);
  }
  hasPrevSki = true;
}

let sprayAcc = 0, powAcc = 0;
/** Tiefschnee: die Skier ziehen eine große, träge Pulverfahne hinter sich her. */
function emitPowder(dt) {
  if (!phys.grounded || phys.crashed > 0 || phys.pow < 0.12 || phys.speed < 3) return;
  const p = phys.pos, v = phys.vel, f = phys.fwd, r = phys.right, n = phys.normal;
  const carvePlume = clamp(Math.abs(phys.aLat) / 9, 0, 1.4);
  powAcc += dt * phys.pow * (10 + phys.speed * 2.4 + carvePlume * (30 + phys.speed * 5)) * Q.trees;
  let count = Math.min(26, Math.floor(powAcc));
  powAcc -= count;
  if (powAcc > 40) powAcc = 0;
  while (count-- > 0) {
    const outer = phys.aLat === 0 ? 0 : -Math.sign(phys.aLat);
    const side = carvePlume > 0.3 && Math.random() < 0.75 ? outer || 1 : Math.random() < 0.5 ? -1 : 1, along = -0.2 - Math.random() * 0.9;
    const x = p.x + r.x * side * 0.3 + f.x * along, y = p.y + 0.15 + Math.random() * 0.3, z = p.z + r.z * side * 0.3 + f.z * along;
    const up = 1.4 + Math.random() * (1.5 + phys.speed * 0.12) + carvePlume * 1.6;
    spray.emit(x, y, z, v.x * (0.3 + Math.random() * 0.25) + r.x * side * (0.8 + Math.random() * 1.8 + carvePlume * 3.2) + n.x * up, v.y * 0.3 + n.y * up, v.z * (0.3 + Math.random() * 0.25) + r.z * side * (0.8 + Math.random() * 1.8 + carvePlume * 3.2) + n.z * up,
      0.55 + Math.random() * 0.9, 1.0 + Math.random() * 1.3, 1.4, 0.45 * (0.5 + phys.pow * 0.6), 2.4);
  }
}
function emitSpray(dt) {
  emitPowder(dt);
  if (!phys.grounded || phys.speed < 2.5 || phys.crashed > 0) return;
  const p = phys.pos, v = phys.vel, f = phys.fwd, r = phys.right, n = phys.normal;
  const sp = phys.speed;
  const carve = clamp((Math.abs(phys.aLat) - 3.5) / 11, 0, 1);
  const skid = clamp(phys.skid / 3, 0, 1.6);
  const inten = skid * 1.2 + carve * 0.55 + inp.brake * 0.9 + (C.cfg.endless ? phys.pow * 0.4 : phys.off * 0.5) + 0.03;
  sprayAcc += inten * Math.min(sp, 30) * 26 * dt;
  let count = Math.min(70, Math.floor(sprayAcc));
  sprayAcc -= count;
  if (sprayAcc > 100) sprayAcc = 0;
  const dirSign = phys.skid > 0.5 ? Math.sign(phys.slip) || 1 : -Math.sign(phys.aLat) || 1;
  const plow = vis.plow;
  while (count-- > 0) {
    let side = dirSign;
    let out = dirSign;
    if (plow > 0.4 || (phys.off > 0.5 && skid < 0.3 && carve < 0.2)) { side = Math.random() < 0.5 ? -1 : 1; out = side; }
    const along = Math.random() * 1.5 - 0.8;
    const lat = side * (0.2 + Math.random() * 0.1);
    const x = p.x + r.x * lat + f.x * along, y = p.y + r.y * lat + f.y * along + 0.05, z = p.z + r.z * lat + f.z * along;
    const push = (1.2 + Math.random() * 4.5) * (0.35 + Math.min(1.4, inten)) * (0.5 + sp / 30);
    const upv = 0.6 + Math.random() * 3.2 * (0.4 + Math.min(1.2, inten));
    const keep = 0.25 + Math.random() * 0.35;
    spray.emit(x, y, z,
      v.x * keep + r.x * out * push + n.x * upv + (Math.random() - 0.5) * 1.2,
      v.y * keep + r.y * out * push + n.y * upv + Math.random() * 0.8,
      v.z * keep + r.z * out * push + n.z * upv + (Math.random() - 0.5) * 1.2,
      0.16 + Math.random() * 0.3 + inten * 0.12, 0.45 + Math.random() * 0.75);
  }
}

function burst(n, power) {
  const p = phys.pos, v = phys.vel;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, s = Math.random() * power;
    spray.emit(p.x + Math.cos(a) * 0.4, p.y + 0.1 + Math.random() * 0.4, p.z + Math.sin(a) * 0.4,
      v.x * 0.4 + Math.cos(a) * s, 1 + Math.random() * power * 0.9, v.z * 0.4 + Math.sin(a) * s, 0.3 + Math.random() * 0.5, 0.6 + Math.random() * 0.9);
  }
}

/** Große, träge Schneewolke: quillt auf und bleibt in der Luft stehen. */
function cloud(n, radius, power) {
  const p = phys.pos, v = phys.vel;
  for (let i = 0; i < n; i++) {
    const a = Math.random() * 6.283, s = Math.random() * power, rr = Math.random() * radius;
    spray.emit(p.x + Math.cos(a) * rr, p.y + 0.2 + Math.random() * 1.2, p.z + Math.sin(a) * rr,
      v.x * (0.25 + Math.random() * 0.4) + Math.cos(a) * s, 0.8 + Math.random() * power * 0.7, v.z * (0.25 + Math.random() * 0.4) + Math.sin(a) * s,
      1.0 + Math.random() * 1.6, 1.6 + Math.random() * 2.0, 0.9, 0.6, 2.6);
  }
}
let cloudAcc = 0, puffAcc = 0;
/** Beim Überschlag stiebt der Schnee dort hoch, wo der Körper aufschlägt: Spritzer vom Boden bis Körperhöhe, dazu Wolken und eine lange Schneefahne. */
function emitCrash(dt) {
  if (phys.crashed <= 0) return;
  const p = phys.pos, v = phys.vel, n = phys.normal, r = phys.right;
  const sp = phys.speed;
  const bodyH = skier.pivot.position.y * 0.94;
  cloudAcc += dt * (90 + sp * 40);
  let c = Math.min(120, Math.floor(cloudAcc));
  cloudAcc -= c;
  while (c-- > 0) {
    const side = (Math.random() - 0.5) * 2;
    const up = 0.8 + Math.random() * (2 + sp * 0.1);
    const k = 0.15 + Math.random() * 0.5;
    const hgt = Math.random() * (0.2 + bodyH * 0.9);
    spray.emit(p.x + r.x * side * 0.8 + (Math.random() - 0.5) * 0.7, p.y + 0.05 + hgt, p.z + r.z * side * 0.8 + (Math.random() - 0.5) * 0.7,
      v.x * k + r.x * side * (1 + Math.random() * 3) + n.x * up, v.y * k + n.y * up, v.z * k + r.z * side * (1 + Math.random() * 3) + n.z * up,
      0.7 + Math.random() * 1.4, 1.2 + Math.random() * 1.6, 2.2, 1.5, 2.2);
  }
  puffAcc += dt * (5 + sp * 0.7);
  let q = Math.floor(puffAcc);
  puffAcc -= q;
  while (q-- > 0) cloud(8, 1.2, 2 + sp * 0.08);
}

// ---------------------------------------------------------------- Spielregeln
function handleEvents() {
  for (let i = 0; i < phys.events.length; i++) {
    const e = phys.events[i];
    if (e.type === 'land') {
      vis.compress = Math.max(vis.compress, clamp(e.impact / 9, 0.15, 1));
      vis.shake = Math.max(vis.shake, clamp(e.impact / 30, 0, 0.5));
      vis.dip = Math.max(vis.dip, clamp((e.impact - 2) / 14, 0, 0.6));   // Kamera federt bei der Landung kurz mit
      audio.land(e.impact);
      burst(Math.min(110, 12 + e.impact * 9), 2 + e.impact * 0.35);
      if (e.impact > 8) cloud(Math.min(40, e.impact * 2), 0.8, 2.5);
      tracks.blob(phys.pos.x, phys.pos.z, 0.55 + e.impact * 0.04, 0.8, 0.7);
      if (game.mode === 'run') {
        if (e.airTime > 0.55) game.bestJump = Math.max(game.bestJump, e.dist);
        scoreLanding(e);
      }
    } else if (e.type === 'crash') {
      vis.crashSpin = 8 + phys.speed * 0.35;
      vis.shake = 1;
      audio.crash();
      cloud(90, 1.9, 4 + phys.speed * 0.16);
      burst(170, 7 + phys.speed * 0.22);
      tV.copy(phys.vel);
      skier.detachSkis(scene, tV);
      if (game.mode === 'run') {
        let lostMsg = 'Sturz!';
        if (game.kind === 'endless') {
          saveEndlessBest();
          const lost = game.score + game.pend;
          lostMsg = lost > 0 ? `Sturz!  ${num(lost)} Punkte verloren` : 'Sturz!';
          game.score = 0; game.pend = 0; game.pendT = 0; game.combo = 1; game.comboT = 0;
        }
        if (!quietCrash) showMsg(lostMsg, 'bad');
        else if (game.kind === 'endless' && lostMsg !== 'Sturz!') setTimeout(() => showMsg(lostMsg, 'bad'), 900);
        quietCrash = false;
      }
    } else if (e.type === 'respawn') {
      if (game.cp && game.mode === 'run') teleport(game.cp.x, game.cp.z, game.cp.h);
      else {
        const d = clamp(-phys.pos.z, 0, C.MESH_D1 - 40);
        let x;
        if (C.cfg.endless) { x = C.surfaceAt(phys.pos.x, -d).lx; }
        phys.reset(d, x);
        resetVisuals();
        camSnap = false;
      }
    }
  }
  phys.events.length = 0;
}

function checkGates() {
  const p = phys.pos, d = -p.z;
  while (game.gateIdx < C.gates.length && d >= C.gates[game.gateIdx].d) {
    const g = C.gates[game.gateIdx];
    if (Math.abs(p.x - g.x) < g.half + 0.25) {
      g.state = 1; game.passed++;
      audio.gate();
      showMsg(game.passed % 5 === 0 ? `${game.passed} Tore!` : 'Tor ✓', 'good');
    } else {
      g.state = -1; game.penalty += 2;
      audio.miss();
      showMsg('Tor verpasst  +2 s', 'bad');
      $('penalty').textContent = `Strafe +${game.penalty.toFixed(0)} s`;
    }
    game.gateIdx++;
  }
  for (let i = Math.max(0, game.gateIdx - 1); i < Math.min(C.gates.length, game.gateIdx + 2); i++) {
    for (const fl of C.gates[i].flags) {
      const u = fl.userData;
      if (u.knock === 0 && u.vel === 0 && Math.abs(p.x - u.x) < 0.75 && Math.abs(p.z - u.z) < 0.9 && phys.speed > 3) {
        u.vel = 7 + phys.speed * 0.25;
        audio.flag();
      }
    }
  }
  if (d >= C.FINISH_D) finishRun();
}

// ---------------------------------------------------------------- Figur ausrichten
const mBasis = new THREE.Matrix4(), vF = new THREE.Vector3(), vR = new THREE.Vector3(), vB = new THREE.Vector3();
function updateSkier(dt) {
  const k = (r) => 1 - Math.exp(-dt * r);
  const crashed = phys.crashed > 0;
  const leanT = clamp(Math.atan(phys.aLat / G) * 0.9, -0.88, 0.88);
  vis.lean += (leanT - vis.lean) * k(9);
  const crouchT = clamp(inp.tuck + inp.brake * 0.2 + 0.14 * clamp(phys.speed / 18, 0, 1), 0, 1);
  vis.crouch += (crouchT - vis.crouch) * k(7);
  vis.compress *= Math.exp(-dt * 4.5);
  vis.shake *= Math.exp(-dt * 3.2);
  vis.crashCam += ((crashed ? 1 : 0) - vis.crashCam) * k(3);
  vis.plow += (inp.brake * (1 - Math.abs(inp.steer)) * clamp(phys.speed / 2, 0, 1) - vis.plow) * k(8);
  vis.air += ((phys.grounded ? 0 : 1) - vis.air) * k(phys.grounded ? 14 : 6);

  if (phys.grounded) tV.copy(phys.normal);
  else tV.set(0, 1, 0).lerp(phys.normal, 0.55).normalize();
  vis.up.lerp(tV, k(phys.grounded ? 14 : 5)).normalize();
  vF.set(Math.sin(phys.heading), 0, -Math.cos(phys.heading));
  vR.crossVectors(vF, vis.up).normalize();
  vF.crossVectors(vis.up, vR).normalize();
  vB.copy(vF).negate();
  mBasis.makeBasis(vR, vis.up, vB);
  skier.root.quaternion.setFromRotationMatrix(mBasis);
  skier.root.position.copy(phys.pos);
  skier.root.position.y -= phys.sink * (Q.patch > 0 ? 0.12 : 0.8);

  const pv = skier.pivot;
  if (crashed) {
    // Überschlagen: schnelle Rotation um mehrere Achsen, Körper hüpft und schlägt immer wieder auf
    const sp = clamp(phys.speed / 10, 0, 1);
    vis.crashAngle += vis.crashSpin * dt * (0.25 + 0.75 * sp);
    pv.rotation.set(-vis.crashAngle, vis.crashAngle * 0.37, Math.sin(vis.crashAngle * 0.6) * 1.1);
    pv.position.y = 0.42 + Math.abs(Math.sin(vis.crashAngle * 0.5)) * (0.1 + 0.42 * sp);
    if (Math.abs(Math.sin(vis.crashAngle * 0.5)) < 0.12 && sp > 0.2) vis.shake = Math.max(vis.shake, 0.45 * sp);
  } else {
    pv.rotation.set(trick.pitch, -trick.yaw, vis.spin * 0.18);
    pv.position.y = 0.85;
  }
  skier.update({
    lean: vis.lean, crouch: vis.crouch, steer: phys.grounded ? inp.steer : 0, plow: vis.plow, air: vis.air, compress: vis.compress,
    speed: phys.speed, grab: trick.grab, tuck: vis.tuck, spin: vis.spin, extend: vis.extend, crash: crashed ? 1 : 0, crashA: vis.crashAngle,
  }, dt);
  skier.updateLoose(dt, C.height);
}

// ---------------------------------------------------------------- Minikarte & Zonen
const ZONE_NAMES = { start: 'Start', cruise: 'Panorama-Piste', glade: 'Waldbahn', bowl: 'Pulverhang', park: 'Ski-Cross-Park', bigair: 'Big Air', couloir: 'Rinne', cliff: 'Klippenband', flat: 'Auslauf' };
let lastZone = -1, zoneTimer = 0;
function updateZone(dt) {
  if (game.kind !== 'endless' || game.mode !== 'run') return;
  const z = C.zoneAt(-phys.pos.z);
  if (z && z.idx !== lastZone) {
    lastZone = z.idx;
    const el = $('zone');
    el.textContent = ZONE_NAMES[z.type] || z.type;
    el.className = '';
    void el.offsetWidth;
    el.className = 'show';
    zoneTimer = 3;
  }
}
const mmc = $('minimap'), mm = mmc.getContext('2d');
let mmAcc = 0;
const LANE_COL = ['#58a7ff', '#ffb02e', '#ffd84a'];
function drawMinimap(dt) {
  const on = game.kind === 'endless' && (game.mode === 'run' || game.mode === 'countdown');
  mmc.style.display = on ? 'block' : 'none';
  if (!on) return;
  mmAcc += dt;
  if (mmAcc < 0.16) return;
  mmAcc = 0;
  const W = mmc.width, H = mmc.height, d = -phys.pos.z, px = phys.pos.x;
  const AHEAD = 420, BEHIND = 50, LAT = 170;
  const sx = W / (2 * LAT), sy = H / (AHEAD + BEHIND);
  const X = (x) => W / 2 + (x - px) * sx, Y = (dd) => H - (dd - (d - BEHIND)) * sy;
  const data = C.mapSlice(Math.max(0, d - BEHIND), d + AHEAD, 8);
  mm.clearRect(0, 0, W, H);
  mm.fillStyle = 'rgba(14,24,40,0.5)';
  mm.fillRect(0, 0, W, H);
  const rows = data.rows;
  // Tal (hell) gegen Felswände (dunkel)
  mm.fillStyle = 'rgba(235,242,255,0.28)';
  mm.beginPath();
  rows.forEach((r, i) => { const x = X(r.hub - r.valley), y = Y(r.d); if (i === 0) mm.moveTo(x, y); else mm.lineTo(x, y); });
  for (let i = rows.length - 1; i >= 0; i--) mm.lineTo(X(rows[i].hub + rows[i].valley), Y(rows[i].d));
  mm.closePath();
  mm.fill();
  // Spuren
  for (let li = rows[0].lanes.length - 1; li >= 0; li--) {
    for (let i = 0; i < rows.length - 1; i++) {
      const a = rows[i].lanes[li], b = rows[i + 1].lanes[li];
      if (a.w < 1 || b.w < 1) continue;
      const k = a.k;
      mm.strokeStyle = k === 3 ? '#ff8a2e' : k === 1 ? '#ffd84a' : rows[i].slope < 0.27 ? '#58a7ff' : rows[i].slope < 0.37 ? '#ff5b4d' : '#2b2f3a';
      mm.lineWidth = Math.max(2, Math.min(7, a.w * 2 * sx * 0.9));
      mm.lineCap = 'round';
      mm.beginPath(); mm.moveTo(X(a.x), Y(rows[i].d)); mm.lineTo(X(b.x), Y(rows[i + 1].d)); mm.stroke();
    }
  }
  // Features
  for (const f of data.feats) {
    const x = X(f.x), y = Y(f.d);
    if (f.kind === 'cliff') { mm.strokeStyle = '#ff3b30'; mm.lineWidth = 3; mm.beginPath(); mm.moveTo(5, y); mm.lineTo(W - 5, y); mm.setLineDash([5, 4]); mm.stroke(); mm.setLineDash([]); }
    else if (f.kind === 'jump') { mm.fillStyle = f.size > 5 ? '#ff9f0a' : '#ffe14a'; mm.beginPath(); mm.arc(x, y, f.size > 5 ? 4.5 : 3, 0, 6.3); mm.fill(); }
  }
  // Fahrer
  mm.fillStyle = '#fff';
  mm.strokeStyle = '#0f1722'; mm.lineWidth = 1.5;
  mm.beginPath(); mm.moveTo(W / 2, Y(d) - 8); mm.lineTo(W / 2 - 5, Y(d) + 5); mm.lineTo(W / 2 + 5, Y(d) + 5); mm.closePath(); mm.fill(); mm.stroke();
}

// ---------------------------------------------------------------- HUD
let hudAcc = 0;
function updateHud(dt) {
  hudAcc += dt;
  if (hudAcc < 0.033) return;
  hudAcc = 0;
  $('speed').textContent = Math.round(phys.speed * 3.6);
  $('speedfill').style.width = `${clamp(phys.speed / 42, 0, 1) * 100}%`;
  if (game.kind === 'endless') {
    $('time').innerHTML = num(totalScore()) + (game.pend > 0 ? `<span class="pend"> +${num(game.pend)}</span>` : '');
    $('best').textContent = `${num(game.maxD)} m${game.combo > 1 ? ` · ×${game.combo.toFixed(1).replace('.0', '')}` : ''} · Rekord ${num(Math.max(game.bestEndless, totalScore()))} P / ${num(Math.max(game.bestDist, game.maxD))} m`;
    $('gates').innerHTML = game.cp ? '<span class="lives">✓ gesetzt</span>' : '<span class="lives">–</span>';
    $('penalty').textContent = isTouch ? (game.cp ? '↺ zurück · ⚑ neu setzen' : '⚑ = Punkt setzen') : game.cp ? 'T = zurück · F = neu setzen' : 'F = Punkt setzen';
  } else {
    $('time').textContent = fmt(game.time + game.penalty);
    $('gates').innerHTML = `${game.passed}<span>/${C.gates.length}</span>`;
    const pr = clamp(-phys.pos.z / C.FINISH_D, 0, 1) * 100;
    $('progfill').style.height = `${pr}%`;
    $('progdot').style.top = `${pr}%`;
    $('best').textContent = (game.best ? `Bestzeit ${fmt(game.best)}` : 'Bestzeit –') + (game.score ? ` · ${num(game.score)} P` : '');
  }
}

// ---------------------------------------------------------------- Schleife
const H = 1 / 120;
let acc = 0, last = performance.now(), time = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const raw = (now - last) / 1000;
  const dt = Math.min(0.05, raw);
  last = now;
  if (window.__game && window.__game.paused) return;
  watchPerformance(raw);
  tick(dt, true);
}

function tick(dt, render) {
  time += dt;

  const airNow = game.mode === 'run' && !phys.grounded && phys.crashed <= 0;
  updateTouch(airNow, dt);
  if (touchCtl) touchCtl.setRunning(game.mode === 'run' || game.mode === 'countdown');
  // Handy: analoger Lenkwert aus Neigung/Daumen (am Boden); sonst Tasten
  const st = touch.steer !== null && !airNow ? touch.steer : (keys.right ? 1 : 0) - (keys.left ? 1 : 0);
  // Analog (Neigen/Daumen): direkt folgen; Tasten: weich einblenden
  const rate = touch.steer !== null && !airNow ? 14 : st === 0 ? 9 : Math.sign(st) !== Math.sign(inp.steer) && inp.steer !== 0 ? 12 : 6;
  inp.steer += clamp(st - inp.steer, -rate * dt, rate * dt);
  inp.tuck += clamp((keys.up ? 1 : 0) - inp.tuck, -5 * dt, 5 * dt);
  inp.brake += clamp((keys.down ? 1 : 0) - inp.brake, -8 * dt, 8 * dt);

  let stepInp = zeroInp;
  if (game.mode === 'run') stepInp = inp;
  else if (game.mode === 'finished') { inp.steer = 0; inp.tuck = 0; inp.brake = 1; stepInp = inp; game.finishT += dt; }
  else { inp.steer = 0; inp.tuck = 0; inp.brake = 0; }

  if (game.mode === 'countdown') {
    game.countdown -= dt;
    const n = Math.ceil(game.countdown);
    if (n !== game.lastCount) {
      game.lastCount = n;
      if (n > 0) { $('count').innerHTML = `<span>${n}</span>`; audio.beep(false); }
      else {
        $('count').innerHTML = '<span>LOS!</span>';
        audio.beep(true);
        game.mode = 'run';
        phys.vel.copy(phys.fwd).multiplyScalar(4.5);
        setTimeout(() => { $('count').innerHTML = ''; }, 900);
      }
    }
  }

  if (game.mode !== 'loading') {
    acc += dt;
    while (acc >= H) {
      inp.jump = jumpQueued && game.mode === 'run';
      jumpQueued = false;
      if (game.mode === 'menu' || game.mode === 'countdown') { phys.vel.set(0, 0, 0); phys.step(H, zeroInp); phys.vel.set(0, 0, 0); }
      else phys.step(H, stepInp);
      if (game.mode === 'run') { game.time += H; game.topSpeed = Math.max(game.topSpeed, phys.speed); }
      acc -= H;
    }
    if (game.mode === 'run') game.maxD = Math.max(game.maxD, -phys.pos.z);
    handleEvents();
    updatePoints(dt);
    updateTricks(dt);
    if (game.mode === 'run' && game.kind === 'race') checkGates();
    if (game.mode === 'finished' && game.finishT > 1.6) { $('finish').classList.remove('hidden'); $('hud').classList.add('hidden'); }

    updateSkier(dt);
    updateCamera(dt, time);
    stampTracks();
    emitSpray(dt);
    emitCrash(dt);
    spray.setFocus(tV.set(phys.pos.x, phys.pos.y + 0.9, phys.pos.z));
    spray.update(dt);
    if (Q.dust) dust.update(time, camera);
    world.update(dt, time, camera.position, phys.pos, game.kind === 'race' && (game.mode === 'run' || game.mode === 'countdown') ? C.gates[game.gateIdx] : null);
    audio.update(phys.speed, phys.skid + inp.brake * phys.speed * 0.15, clamp(Math.abs(phys.aLat) / 14, 0, 1), phys.grounded, phys.off, phys.pow);
    updateHud(dt);
    updateZone(dt);
    drawMinimap(dt);
    patch.update(phys.pos.x, phys.pos.z, C.cfg.endless && Q.patch > 0 && phys.pow > 0.18 && game.mode !== 'menu');
    tracks.update(phys.pos.x, phys.pos.z);
  }
  if (render) composer.render();
}

// ---------------------------------------------------------------- Start
(async () => {
  setTier(qualSetting === 'auto' ? localStorage.getItem(AUTO_KEY) || (isTouch ? 'low' : 'high') : qualSetting);
  resize();
  buildMenuControls();
  const models = await loadModels();
  world = new World(scene, models);
  skier = new Skier(models);
  scene.add(skier.root);
  tracks = new SnowTracks(renderer);
  patch = new PowderPatch(scene);
  spray = new Spray(scene);
  dust = new DiamondDust(scene);
  applyQuality();
  setKind('race');
  applyOutfit();
  tracks.update(phys.pos.x, phys.pos.z);
  $('loading').classList.add('hidden');
  game.mode = 'menu';
  window.addEventListener('beforeunload', saveEndlessBest);
  window.__game = {
    game, phys, inp, keys, airKey, trick, world, skier, camera, renderer, scene, vis, Q, startRun, setKind, toMenu, setCheckpoint, toCheckpoint, chooseQuality, C,
    tp: (d, lane = 0, speed = 0) => { const L = C.mapSlice(d, d + 1, 1).rows[0].lanes[lane]; teleport(L.x, -d); const x0 = C.centerX(d + 6) - C.centerX(d); phys.heading = Math.atan2(x0, 6); phys.vel.set(Math.sin(phys.heading) * speed, 0, -Math.cos(phys.heading) * speed); if (game.mode === 'menu') { game.mode = 'run'; } },
        advance: (sec, noRender) => { const n = Math.round(sec * 60); for (let i = 0; i < n; i++) tick(1 / 60, !noRender && i === n - 1); },
  };
  requestAnimationFrame((t) => { last = t; frame(t); });
})().catch((err) => {
  console.error(err);
  $('loading').textContent = 'Fehler beim Laden: ' + err.message;
});

// ---------------------------------------------------------------- Offline-Betrieb (nur in der gebauten Version)
// Der Service Worker speichert beim ersten Laden alles, was das Spiel braucht; danach läuft es auch ohne Internet.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  const reg = () => navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Offline-Modus nicht verfügbar:', err));
  // main.js wartet beim Start auf die Modelle; das load-Ereignis kann dann schon vorbei sein
  if (document.readyState === 'complete') reg(); else window.addEventListener('load', reg);
}
