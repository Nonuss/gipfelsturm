import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import * as C from './course.js';
import { World, loadModels, SUN_DIR } from './world.js';
import { SnowTracks } from './snow.js';
import { SkiPhysics } from './physics.js';
import { Skier, BUTTER_TH } from './skier.js';
import { Spray, DiamondDust } from './particles.js';
import { GameAudio } from './audio.js';
import { Q, setTier, ORDER } from './quality.js';
import { PowderPatch } from './powder.js';
import { setupTouch, updateTouch, touch, isTouch, viewSize, view } from './touch.js';
import { Avalanche } from './avalanche.js';
import * as HG from './heligen.js';
import { shop, OUTFITS } from './shop.js';
import { Shop3D } from './shop3d.js';
import { SKIS, BOARDS, statMul, SKI_TRICKS } from './gear.js';
import { setupDonate } from './donate.js';

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
// ---- Ultra: Umgebungsverdeckung (GTAO) in halber Auflösung, nur im Umkreis um die Kamera (die Ferne liegt im Dunst).
// Kein zweites Zeichnen der Szene: GTAO liest die Tiefe aus dem normalen Bilddurchgang (Tiefentextur an den Zwischenbildern
// des Composers, nur auf Ultra angehängt) und leitet die Flächennormalen daraus ab.
const gtao = new GTAOPass(scene, camera, 1, 1, { depthTexture: new THREE.DepthTexture(1, 1) }, { radius: 1.5, distanceExponent: 1.3, thickness: 2.0, scale: 1.6, samples: 12, distanceFallOff: 1 }, { radius: 6, samples: 12, rings: 2 });
gtao.output = GTAOPass.OUTPUT.Off;   // nur rechnen; eingemischt wird im Ultra-Durchgang unten (spart zwei Vollbild-Durchgänge)
gtao.needsSwap = false;
gtao.enabled = false;
const gtaoSize = gtao.setSize.bind(gtao), AO_RES = 0.5;
gtao.setSize = (w, h) => gtaoSize(Math.max(1, Math.round(w * AO_RES)), Math.max(1, Math.round(h * AO_RES)));
const aoBox = new THREE.Box3();
let sceneDepth = null;
const gtaoRender = gtao.render.bind(gtao);
gtao.render = (r, wb, rb, dt, mask) => {
  sceneDepth = rb.depthTexture;   // das Zwischenbild, in das die Szene eben gezeichnet wurde
  for (const m of [gtao.gtaoMaterial, gtao.pdMaterial, gtao.depthRenderMaterial, ufx.material]) m.uniforms.tDepth.value = sceneDepth;
  gtaoRender(r, wb, rb, dt, mask);
};
/** Tiefentexturen an den Zwischenbildern nur auf Ultra (sonst bleiben die Zwischenbilder wie bisher). */
function sceneDepthTargets(on) {
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    if (!!rt.depthTexture === on) continue;
    if (rt.depthTexture) rt.depthTexture.dispose();
    rt.depthTexture = on ? new THREE.DepthTexture(rt.width, rt.height) : null;
    rt.dispose();
  }
}
composer.addPass(gtao);
// ---- Ultra: Bewegungsunschärfe bei Tempo (aus der Kamerabewegung, der Fahrer bleibt scharf) und Tiefenunschärfe in den
// Spezialtrick-Kameras. Liest die Tiefe aus dem GTAO-Durchgang, kostet also keinen weiteren Szenen-Durchlauf.
const ufx = new ShaderPass({
  uniforms: {
    tDiffuse: { value: null }, tDepth: { value: null }, uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() },
    tAO: { value: gtao.pdRenderTarget.texture }, uAOI: { value: 1 },
    uSunUV: { value: new THREE.Vector3() }, uSunCol: { value: new THREE.Color(1.0, 0.86, 0.66) }, uSkier: { value: new THREE.Vector3() },
    uPrevVP: { value: new THREE.Matrix4() }, uMB: { value: 0 }, uDof: { value: 0 }, uFocus: { value: 5 }, uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: /* glsl */ `uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform sampler2D tAO; uniform float uAOI; uniform vec3 uSunUV; uniform vec3 uSunCol; uniform vec3 uSkier; uniform mat4 uInvProj; uniform mat4 uCamWorld; uniform mat4 uPrevVP;
    uniform float uMB; uniform float uDof; uniform float uFocus; uniform vec2 uRes; varying vec2 vUv;
    vec3 vpos(vec2 uv){ float d = texture2D(tDepth, uv).x; vec4 c = uInvProj * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return c.xyz / c.w; }
    float coc(float d){ return clamp(abs(d - uFocus) / max(d, 0.1) * uDof, 0.0, 1.0) * 10.0; }
    float gAoK;
    vec3 colAt(vec2 uv){ return texture2D(tDiffuse, uv).rgb * mix(1.0, texture2D(tAO, uv).r, gAoK); }
    float h12(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
    void main(){
      vec3 vp = vpos(vUv);
      float dist = -vp.z;
      // Der Fahrer verdeckt nichts: um ihn herum keine Umgebungsverdeckung (sonst dunkler, körniger Fleck unter den Ski)
      gAoK = uAOI * smoothstep(1.4, 2.8, length((uCamWorld * vec4(vp, 1.0)).xyz - uSkier));
      vec3 col = colAt(vUv);
      float jit = h12(gl_FragCoord.xy);
      if (uDof > 0.001) {
        // Tiefenunschärfe: Scheibe aus 20 Proben; scharfe Vordergrund-Pixel (der Fahrer) verschmieren nicht in den Hintergrund
        float r = coc(dist);
        if (r > 0.6) {
          vec3 acc = col; float ws = 1.0;
          for (int i = 0; i < 20; i++) {
            float a = (float(i) + jit) * 2.39996, rr = sqrt((float(i) + 0.5) / 20.0) * r;
            vec2 uv = vUv + vec2(cos(a), sin(a)) * rr / uRes;
            float w = clamp(coc(-vpos(uv).z) - rr + 1.0, 0.0, 1.0);
            acc += colAt(uv) * w; ws += w;
          }
          col = acc / ws;
        }
      } else if (uMB > 0.001) {
        // Bewegungsunschärfe: wohin ist dieser Punkt seit dem letzten Bild auf dem Schirm gewandert?
        vec4 pc = uPrevVP * (uCamWorld * vec4(vp, 1.0));
        if (pc.w > 0.0) {
          vec2 vel = (vUv - (pc.xy / pc.w * 0.5 + 0.5)) * uMB * smoothstep(5.0, 22.0, dist);
          float L = length(vel); if (L > 0.03) vel *= 0.03 / L;
          if (length(vel * uRes) > 1.5) {
            vec3 acc = col; float ws = 1.0;
            for (int i = 0; i < 10; i++) {
              vec2 uv = vUv + vel * ((float(i) + jit) / 10.0 - 0.5);
              float w = smoothstep(4.0, 7.0, -vpos(uv).z);   // nichts vom Fahrer in die Umgebung ziehen
              acc += colAt(uv) * w; ws += w;
            }
            col = acc / ws;
          }
        }
      }
      vec2 sdl = uSunUV.xy - vUv;
      float fall = exp(-length(sdl * vec2(uRes.x / uRes.y, 1.0)) * 1.7) * uSunUV.z;
      if (fall > 0.012) {
        // Lichtstrahlen: vom Bildpunkt Richtung Sonne laufen und zählen, wie viel freier Himmel dazwischen liegt.
        // Bäume, Grate und der Fahrer schneiden so Schattenbahnen in den hellen Dunst. Zu weit von der Sonne: nichts.
        vec2 stp = sdl / 16.0, uv = vUv + stp * jit;
        float acc = 0.0, wsum = 0.0, wgt = 1.0;
        for (int i = 0; i < 16; i++) {
          uv += stp;
          vec2 inb = step(vec2(0.0), uv) * step(uv, vec2(1.0));
          acc += step(0.99999, texture2D(tDepth, uv).x) * inb.x * inb.y * wgt; wsum += wgt; wgt *= 0.92;
        }
        // Dunst liegt in der Luft: auf nahem Schnee und am Fahrer kaum, in der Ferne und am Himmel voll
        float airW = texture2D(tDepth, vUv).x >= 0.99999 ? 1.0 : smoothstep(80.0, 700.0, dist);
        col += uSunCol * (acc / wsum) * fall * airW;
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
});
ufx.uniforms.tAO.value = gtao.pdRenderTarget.texture;   // ShaderPass kopiert Texturen in den Uniforms, daher erst hier setzen
ufx.enabled = false;
composer.addPass(ufx);
const prevVP = new THREE.Matrix4(), curVP = new THREE.Matrix4(), prevCamPos = new THREE.Vector3();
let prevFov = 0;
const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.28, 0.55, 1.0);
composer.addPass(bloom);
composer.addPass(new OutputPass());
// Farblook: etwas mehr Kontrast und Sättigung, kühle Schatten, warme Lichter, leichte Vignette (sehr günstig)
const grade = new ShaderPass({
  uniforms: { tDiffuse: { value: null }, uVig: { value: 0.22 }, uRew: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uVig; uniform float uRew; varying vec2 vUv;
    void main(){
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c = mix(vec3(l), c, 1.1);                                   // Sättigung
      c = c + (c - 0.5) * 0.06 * (1.0 - abs(c - 0.5) * 2.0);      // sanfte S-Kurve
      c *= mix(vec3(0.97, 0.99, 1.04), vec3(1.03, 1.0, 0.96), smoothstep(0.25, 0.85, l));   // Schatten kühl, Lichter warm
      vec2 q = vUv - 0.5;
      c *= 1.0 - (uVig + 0.25 * uRew) * smoothstep(0.35, 0.85, length(q * vec2(1.15, 1.0)));
      c = mix(c, vec3(dot(c, vec3(0.299, 0.587, 0.114))) * vec3(0.9, 0.97, 1.1), uRew * 0.6);   // Zurückspulen: entsättigt, kühl
      gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
    }`,
});
composer.addPass(grade);
// Kantenglättung per Nachbearbeitung, wenn MSAA aus ist (niedrige Stufe, Handys)
const fxaa = new FXAAPass();
composer.addPass(fxaa);

let world, skier, tracks, spray, dust, patch, blob, aval;
const phys = new SkiPhysics();
const audio = new GameAudio();

// Dynamische Auflösung: startet scharf (bis zur vollen Pixeldichte der Stufe) und regelt nur so weit herunter,
// wie es für flüssige Bilder nötig ist. Danach wird langsam wieder hochgeregelt.
let renderScale = 0;
const maxScale = () => Math.min(window.devicePixelRatio || 1, Q.pr);
// Handys: Auflösung nie unter 1,5 (bzw. die Pixeldichte) – unscharfes Bild stört dort mehr als ein paar Effekte weniger
// Nie unter die echte Bildschirmauflösung (am Handy nie unter 1,5): unscharfes, pixeliges Bild stört mehr als
// fehlende Effekte. Schwache Geräte sparen stattdessen über die Grafikstufe (Schatten, Bäume, Leuchten).
const minScale = () => Math.min(maxScale(), isTouch ? Math.max(1.5, Q.minPR || 0.75) : Math.max(1.0, Q.minPR || 0.75));
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
  // Handys: Leistung in Auflösung statt in Effekte stecken – kein Leuchten, FXAA statt MSAA (MSAA auf Gleitkomma-
  // Zwischenbildern ist auf iOS unsicher und teuer)
  if (isTouch) { Q.msaa = 0; Q.bloom = false; Q.pr = Math.max(Q.pr, 2.0); }
  for (const rt of [composer.renderTarget1, composer.renderTarget2]) {
    if (rt.samples !== Q.msaa) { rt.samples = Q.msaa; rt.dispose(); }
  }
  bloom.enabled = Q.bloom;
  fxaa.enabled = Q.msaa === 0;
  gtao.enabled = ufx.enabled = Q.ultra;
  sceneDepthTargets(Q.ultra);
  if (Q.shadow > renderer.capabilities.maxTextureSize) Q.shadow = renderer.capabilities.maxTextureSize;
  // Niedrig: keine Echtzeit-Schatten (größter Einzelposten auf schwacher Grafik); Geländeform bleibt durch die
  // vorberechnete Schattierung lesbar
  renderer.shadowMap.enabled = Q.shadow > 0;
  renderScale = maxScale();
  C.cfg.treeMul = Q.trees;
  if (world) {
    world.setLowQuality(Q.lowq);
    if (Q.shadow > 0) world.setShadowSize(Q.shadow);
    world.setShadowArea(Q.shadowArea);
    if (C.cfg.endless && !C.cfg.heli) scene.fog.far = Q.view - 30;
  }
  if (dust) dust.points.visible = Q.dust;
  if (patch && Q.patch > 0 && patch.cell !== Q.patch) { const old = patch; scene.remove(old.mesh); old.geo.dispose(); patch = new PowderPatch(scene, Q.patch, Math.round(18 / Q.patch) + 1); }
  if (world) world.setUltra(Q.ultra, patch ? [patch.mesh.material] : []);
  if (world) world.setTreeDetail(Q.ultra);
  if (world) world.setSkyLight(Q.ultra, renderer);
  applyTone();
  // Ultra: mehr Schneestaub (größerer Ringspeicher), mehr Eiskristalle in der Luft
  const sprayMax = Q.ultra ? 16000 : 9000;
  if (spray && spray.max !== sprayMax) { scene.remove(spray.points); spray.geo.dispose(); spray.mat.dispose(); spray = new Spray(scene, sprayMax); }
  if (dust) dust.points.geometry.setDrawRange(0, Q.ultra ? 2800 : 1400);
  ultraSlowT = 0; ultraWarned = false;
  resize();
  for (const b of $('quality').children) b.classList.toggle('sel', b.dataset.q === qualSetting);
}
/** Tonwerte: Ultra mit neutraler Kurve (weißer Schnee, natürliche Farben), sonst wie bisher ACES. Heli knapper belichtet. */
function applyTone() {
  renderer.toneMapping = Q.ultra ? THREE.NeutralToneMapping : THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = (C.cfg.heli ? 0.74 : 0.9) * (Q.ultra ? 1.0 : 1);   // viel Schnee in der Fernsicht: etwas knapper belichten
}
function chooseQuality(q) {
  qualSetting = q;
  localStorage.setItem(QUAL_KEY, q);
  setTier(q === 'auto' ? (!isTouch && localStorage.getItem(AUTO_KEY)) || 'high' : q);
  applyQuality();
}
// „Auto“: bleibt die Bildrate länger unter 40, wird eine Stufe heruntergeschaltet (und gemerkt)
let fpsEma = 60, slowT = 0;
let drsT = 0, drsN = 0, drsUpBlock = 0, drsStable = 0;
function dynamicResolution(rawDt) {
  // Von Hand gewählte Stufe bleibt genau so, wie sie ist (auch wenn es ruckelt): volle Auflösung der Stufe, kein
  // Herunterregeln. Nur „Auto“ passt Auflösung und Stufe an.
  if (qualSetting !== 'auto') { drsT = 0; drsN = 0; if (Math.abs(renderScale - maxScale()) > 0.01) { renderScale = maxScale(); resize(); } return; }
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
// Ultra wird nie still heruntergeschaltet; bleibt die Bildrate lange sehr niedrig, kommt einmal pro Lauf ein Hinweis
let ultraEma = 60, ultraSlowT = 0, ultraWarned = false;
function watchUltra(rawDt) {
  if (!Q.ultra || game.mode !== 'run' || document.hidden || rawDt > 0.25) return;
  ultraEma += (1 / Math.max(rawDt, 1e-3) - ultraEma) * 0.04;
  ultraSlowT = ultraEma < 28 ? ultraSlowT + rawDt : 0;
  if (ultraSlowT > 5 && !ultraWarned) { ultraWarned = true; showMsg('Ultra ist für diesen Rechner sehr schwer. Unter Einstellungen läuft Hoch flüssiger', 'bad'); }
}
function watchPerformance(rawDt) {
  dynamicResolution(rawDt);
  watchUltra(rawDt);
  if (qualSetting !== 'auto' || game.mode !== 'run' || document.hidden || rawDt > 0.25) return;
  fpsEma += (1 / Math.max(rawDt, 1e-3) - fpsEma) * 0.05;
  // Handys: im Stromsparmodus sind 30 Bilder/s gedeckelt – das ist kein Grund, die Grafik zu senken
  // Von Niedrig auf Sparsam nur bei wirklich schwachen Rechnern: deutlich unter 26 Bildern und 6 s lang
  const idx = ORDER.indexOf(Q.tier), toMin = ORDER[idx + 1] === 'minimal';
  const slowFps = toMin ? (isTouch ? 22 : 26) : isTouch ? 27 : 40, slowNeed = toMin ? 6 : isTouch ? 4 : 2.5;
  slowT = fpsEma < slowFps && renderScale <= minScale() + 0.01 ? slowT + rawDt : 0;
  if (slowT > slowNeed && idx < ORDER.length - 1) {
    slowT = 0; fpsEma = 60;
    setTier(ORDER[idx + 1]);
    if (!isTouch) localStorage.setItem(AUTO_KEY, Q.tier);   // Handys starten jedes Mal neu oben
    applyQuality();
    showMsg(toMin ? 'Grafik auf Sparsam gestellt, damit es flüssig läuft' : 'Grafik angepasst – läuft jetzt flüssiger', 'good');
  }
}

// ---------------------------------------------------------------- Zustand
const STYLE_SFX = { freestyle: '_fs', heli: '_heli' };
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
const keys = { left: false, right: false, up: false, down: false, space: false, gl: false, gr: false, rew: false };
const airKey = { left: false, right: false, up: false, down: false, space: false, gl: false, gr: false };
const inp = { steer: 0, tuck: 0, brake: 0, jump: false };
const zeroInp = { steer: 0, tuck: 0, brake: 0, jump: false };
const vis = {
  lean: 0, crouch: 0, compress: 0, plow: 0, air: 0, up: new THREE.Vector3(0, 1, 0), crashAngle: 0, crashSpin: 0,
  tuck: 0, spin: 0, extend: 0, zoom: 0, shake: 0, crashCam: 0, bcam: 0,
  camSide: 1, flipCam: 0, bigAir: 0, dip: 0, fpv: 0, slide: 0, grindSide: 1, look: 0, avZoom: 0,
};
// Renn-Disziplin (Slalom, Riesentorlauf, Super-G, Abfahrt). Wird gemerkt.
let disc = 'sg';
try { const v = localStorage.getItem('gipfelsturm_disc'); if (v && C.DISCIPLINES[v]) disc = v; } catch {}
const raceBestKey = () => BEST_KEY + '_' + disc;
// Ausrüstung: Ski oder Snowboard (gleiche Tasten, eigene Haltung und Tricknamen). Wird gemerkt.
let gear = 'ski', boardEdge = 0, boardLift = 0;
try { gear = localStorage.getItem('gipfelsturm_gear') === 'board' ? 'board' : 'ski'; } catch {}
const BOARD = () => gear === 'board';
function setGear(g) {
  gear = g;
  try { localStorage.setItem('gipfelsturm_gear', g); } catch {}
  if (skier) skier.setGear(g);
  phys.setGearStats(gearStats());
  syncOpts();
}
/** Eigenschaften des angelegten Skis bzw. Bretts als Multiplikatoren (1 = neutral). */
let gsCache = null, gsKey = '';
function gearStats() {
  const key = gear + ':' + (gear === 'board' ? shop.equip.board : shop.equip.ski);
  if (key !== gsKey) {
    const d = gear === 'board' ? BOARDS[shop.equip.board] || BOARDS.classic : SKIS[shop.equip.ski] || SKIS.allround;
    gsCache = statMul(d.st); gsKey = key;
  }
  return gsCache;
}
// Switch: Körper ist um 180° gedreht (fährt rückwärts). swYaw ist 0 oder pi.
let swYaw = 0;
const isSwitch = () => Math.abs(Math.sin(swYaw / 2)) > 0.7;
// Kameraperspektive: false = Verfolger, true = Ego-Sicht (Helmkamera). Wird gemerkt.
let firstPerson = localStorage.getItem('gipfelsturm_fpv') === '1';
function toggleView(set) {
  firstPerson = set === undefined ? !firstPerson : set;
  try { localStorage.setItem('gipfelsturm_fpv', firstPerson ? '1' : '0'); } catch {}
  if (set === undefined) showMsg(firstPerson ? 'Ego-Sicht' : 'Verfolger-Kamera', 'good');
  syncOpts();
}
function setMuted(m) {
  audio.setMuted(m);
  try { localStorage.setItem('gipfelsturm_muted', m ? '1' : '0'); } catch {}
  syncOpts();
}
function syncOpts() {
  const sel = (id, v) => { const el = $(id); if (el) for (const b of el.children) b.classList.toggle('sel', b.dataset.v === v); };
  sel('optSound', audio.muted ? '0' : '1');
  sel('optCam', firstPerson ? '1' : '0');
  sel('optFs', fsOn() ? '1' : '0');
  sel('optGear', gear);
  if (typeof touchCtl !== 'undefined' && touchCtl) sel('optSteer', touchCtl.mode());
}

// ---------------------------------------------------------------- Vollbild
// Fullscreen-API mit WebKit-Fallback. Am iPhone gibt es kein Vollbild für Webseiten: Knopf und Einstellung entfallen.
const fsEl = document.documentElement;
const fsSupported = !!(fsEl.requestFullscreen || fsEl.webkitRequestFullscreen) && !/iPhone|iPod/.test(navigator.userAgent);
if (!fsSupported) document.body.classList.add('nofs');
function fsOn() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }
function toggleFs(want) {
  if (!fsSupported) return;
  const on = fsOn();
  if (want === undefined) want = !on;
  if (want === on) return;
  try {
    const r = want ? (fsEl.requestFullscreen ? fsEl.requestFullscreen({ navigationUI: 'hide' }) : fsEl.webkitRequestFullscreen())
      : (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
    if (r && r.catch) r.catch(() => {});
  } catch { /* vom Browser abgelehnt */ }
}
document.addEventListener('fullscreenchange', () => syncOpts());
document.addEventListener('webkitfullscreenchange', () => syncOpts());
const trick = { pitch: 0, yaw: 0, pv: 0, yv: 0, grab: 0, grabT: 0, wasAir: false, gs: 0, gT: { safety: 0, mute: 0, tail: 0 } };
/** Trick-Faktor der angelegten Ausrüstung (Werte aus dem Shop, 5 = neutral): Dreh-Tempo und Trickpunkte. */
const trickMul = () => gearStats().trick;
let jumpQueued = false;
let quietCrash = false;

// ---------------------------------------------------------------- Spezialtricks (Tasten 1 bis 0 in der Luft)
// Jeder Spezialtrick ist eine fest choreografierte Bewegung mit eigener Kamera und Zeitlupe. Er startet nur, wenn die
// Flugzeit reicht; wer zu früh aufsetzt, ist nicht ausgedreht und stürzt wie bei normalen Tricks.
const ezSpin = (u) => u - Math.sin(TAU * u) / TAU * 0.6;   // weich an- und ausdrehen, nie ganz still
const bump = (u, p = 0.6) => Math.pow(Math.max(0, Math.sin(Math.PI * u)), p);
// v37: Drehungen wie im echten Contest. Corks, Rodeos und Mistys drehen um eine SCHRÄGE Achse (axis: Richtung im
// Körper, x rechts, y oben, z hinten; ang: Drehwinkel), die am Anfang und Ende senkrecht steht: so geht der Kopf in der
// Mitte zur Seite nach unten und der Fahrer landet sauber. Dazu ein Grab in der Mitte der Drehung (grab, gs: 0 Safety,
// -1 Mute, 1 Tail; Brett bgs: 0 Indy, -1 Melon, 1 Tail) und eine kompakte Haltung (tuck). Vorher drehte der Körper starr
// erst um die Hochachse und kippte dabei nach vorn, ohne Grab: das sah nicht echt aus.
const mid = (a, b, c, d) => (u) => smoothstep(a, b, u) * (1 - smoothstep(c, d, u));   // Grab/Haltung in der Mitte
/** Schräge Achse: kippt mit bump(u) um maximal deg Grad in Richtung (x, z) (Körper: x rechts, z hinten). */
const tiltAxis = (deg, x, z, p = 0.75) => { const l = Math.hypot(x, z) || 1; x /= l; z /= l; return (u) => { const k = bump(u, p) * deg * Math.PI / 180; return [Math.sin(k) * x, Math.cos(k), Math.sin(k) * z]; }; };
const SPECIALS = [
  // 1 Cork 720: zwei Umdrehungen um eine stark schräge Achse, der Kopf taucht seitlich ab, Mute Grab (Brett: Indy)
  { key: 'Digit1', ski: 'Cork 720 Mute', board: 'Backside Cork 720 Indy', T: 1.3, Tmin: 0.95, slow: 0.5, cam: 'orbit', pts: 2400,
    axis: tiltAxis(58, 0.8, 0.6), ang: (u) => -2 * TAU * ezSpin(u), pitch: () => 0, yaw: (u) => -2 * TAU * ezSpin(u), roll: () => 0,
    grab: mid(0.18, 0.32, 0.7, 0.86), gs: -1, bgs: 0, tuck: mid(0.1, 0.3, 0.75, 0.9) },
  // 2 Rodeo 540: Rückwärtssalto mit halber Schraube (Achse fast quer), Tail Grab, Landung rückwärts
  { key: 'Digit2', ski: 'Rodeo 540 Tail', board: 'Backside Rodeo 540 Melon', T: 1.35, Tmin: 1.0, slow: 0.55, cam: 'side', pts: 2700,
    axis: tiltAxis(72, -1, 0.2, 0.6), ang: (u) => 3 * Math.PI * ezSpin(u), pitch: () => 0, yaw: (u) => 3 * Math.PI * ezSpin(u), roll: () => 0,
    grab: mid(0.15, 0.3, 0.72, 0.88), gs: 1, bgs: -1, tuck: mid(0.08, 0.28, 0.75, 0.92) },
  // 3 Japan Air: gerader Sprung, Ski hinter dem Körper hochgezogen und verdreht, linke Hand am Ski (Brett: Method Air)
  { key: 'Digit3', ski: 'Japan Air', board: 'Method Air', T: 1.05, Tmin: 0.7, slow: 0.6, cam: 'hero', pts: 1500,
    pitch: (u) => -0.42 * bump(u, 0.7), yaw: (u) => 0.35 * bump(u), roll: (u) => 0.45 * bump(u, 0.8), grab: (u) => bump(u, 0.45), gs: -1, tuck: (u) => 0.55 * bump(u, 0.5), tweak: (u) => bump(u, 0.55), sup: (u) => (BOARD() ? bump(u, 0.5) : 0) },
  // 4 Iron Cross: Skienden zusammen, Spitzen weit gespreizt zum X, Tail Grab, Körper leicht gedreht (Brett: Stalefish)
  { key: 'Digit4', ski: 'Iron Cross', board: 'Stalefish', T: 0.95, Tmin: 0.6, slow: 0.6, cam: 'frog', pts: 1300,
    pitch: (u) => -0.25 * bump(u), yaw: (u) => 0.55 * bump(u), roll: (u) => -0.35 * bump(u), cross: (u) => bump(u, 0.5), grab: (u) => 0.85 * bump(u, 0.6), gs: 1 },
  // 5 Doppel-Backflip: zwei Salti rückwärts, eng gehockt mit Safety Grab, Kamera fährt einmal rundherum
  { key: 'Digit5', ski: 'Bullet Time Doppel-Backflip', board: 'Bullet Time Doppel-Backflip', T: 1.45, Tmin: 1.15, slow: 0.4, cam: 'bullet', pts: 4200,
    axis: () => [-1, 0, 0], ang: (u) => 2 * TAU * ezSpin(u), pitch: () => 0, yaw: () => 0, roll: () => 0,
    grab: mid(0.12, 0.25, 0.75, 0.88), gs: 0, bgs: 0, tuck: mid(0.05, 0.2, 0.8, 0.95) },
  // 6 Misty 720: vorwärts gekippte Schraube (Kopf geht nach vorn unten), Mute Grab; Brett: Frontside Misty 540 auf Fakie
  { key: 'Digit6', ski: 'Misty 720 Mute', board: 'Frontside Misty 540 Indy', T: 1.3, Tmin: 0.95, slow: 0.55, cam: 'hero', pts: 2500,
    axis: tiltAxis(60, -0.6, -0.8), ang: (u) => (BOARD() ? -3 * Math.PI : -2 * TAU) * ezSpin(u), pitch: () => 0, yaw: (u) => (BOARD() ? -3 * Math.PI : -2 * TAU) * ezSpin(u), roll: () => 0,
    grab: mid(0.2, 0.35, 0.7, 0.85), gs: -1, bgs: 0, tuck: mid(0.1, 0.3, 0.75, 0.9) },
  // 7 Flatspin 540: Körper flach gekippt, dreht wie ein Teller, ohne Kopfüber; Landung rückwärts
  { key: 'Digit7', ski: 'Flatspin 540 Safety', board: 'Backside Flatspin 540', T: 1.2, Tmin: 0.9, slow: 0.55, cam: 'side', pts: 2100,
    axis: tiltAxis(42, 0.2, 1), ang: (u) => 3 * Math.PI * ezSpin(u), pitch: () => 0, yaw: (u) => 3 * Math.PI * ezSpin(u), roll: () => 0,
    grab: mid(0.2, 0.35, 0.65, 0.8), gs: 0, bgs: 1, tuck: mid(0.15, 0.3, 0.7, 0.85) },
  // 8 Double Cork 1080: drei Umdrehungen mit zwei schrägen Überschlägen, Safety Grab
  { key: 'Digit8', ski: 'Double Cork 1080 Safety', board: 'Double Cork 1080 Indy', T: 1.65, Tmin: 1.3, slow: 0.45, cam: 'orbit', pts: 4800,
    axis: tiltAxis(62, 0.85, 0.5, 0.55), ang: (u) => -3 * TAU * ezSpin(u), pitch: () => 0, yaw: (u) => -3 * TAU * ezSpin(u), roll: () => 0,
    grab: mid(0.15, 0.28, 0.75, 0.88), gs: 0, bgs: 0, tuck: mid(0.08, 0.22, 0.8, 0.92) },
  // 9 Daffy (Ski): Klassiker aus den 80ern, Beine weit vor und zurück gegrätscht. Brett: Frontside 360 mit Indy Grab
  { key: 'Digit9', ski: 'Daffy', board: 'Frontside 360 Indy', T: 1.0, Tmin: 0.6, slow: 0.6, cam: 'side', pts: 1000,
    pitch: (u) => -0.12 * bump(u), yaw: (u) => (BOARD() ? -TAU * ezSpin(u) : 0), roll: () => 0, daffy: (u) => bump(u, 0.45), bgrab: (u) => bump(u, 0.5), bgs: 0 },
  // 10 (Taste 0) Triple Cork 1440: vier Umdrehungen mit drei schrägen Überschlägen, der Big-Air-Trick der Profis
  { key: 'Digit0', ski: 'Triple Cork 1440 Mute', board: 'Triple Cork 1440 Indy', T: 2.0, Tmin: 1.6, slow: 0.4, cam: 'bullet', pts: 7000,
    axis: tiltAxis(64, 0.85, 0.5, 0.45), ang: (u) => -4 * TAU * ezSpin(u), pitch: () => 0, yaw: (u) => -4 * TAU * ezSpin(u), roll: () => 0,
    grab: mid(0.12, 0.24, 0.8, 0.9), gs: -1, bgs: 0, tuck: mid(0.06, 0.18, 0.84, 0.94) },
];
let special = null, lastSpecial = null, timeScale = 1;
const specCam = { w: 0, mode: 'orbit', a0: 0, u: 0 };
/** Restliche Flugzeit (s): ballistisch bis zur heutigen Bodenhöhe, der Hang fällt meist weiter ab (eher mehr Zeit). */
function airLeft() {
  const vy = phys.vel.y, g = Math.max(0, phys.gap);
  return (vy + Math.sqrt(vy * vy + 2 * G * g)) / G;
}
function startSpecial(def) {
  if (game.mode !== 'run' || phys.grounded || phys.crashed > 0 || phys.grind || special) return;
  if (!def) {   // Handy: der längste Trick, der noch in die Flugzeit passt
    const t = airLeft() - 0.1;
    const fit = SPECIALS.filter((d) => d.Tmin <= t).sort((a, b) => b.Tmin - a.Tmin);
    def = fit[Math.floor(Math.random() * Math.min(2, fit.length))];
    if (!def) { showMsg('Zu wenig Höhe für einen Spezialtrick', 'bad'); return; }
  }
  const tl = airLeft() - 0.1;
  const name = BOARD() ? def.board : def.ski;
  if (tl < def.Tmin) { showMsg(`Zu wenig Höhe für ${name}`, 'bad'); return; }
  // laufende Drehung zuerst auf die nächste ganze Stellung runden, dann übernimmt die Choreografie
  const p0 = Math.round(trick.pitch / TAU) * TAU, y0 = Math.round(trick.yaw / Math.PI) * Math.PI;
  special = { def, name, t: 0, T: Math.min(def.T, tl), p0, y0, pIn: trick.pitch - p0, yIn: trick.yaw - y0 };
  for (const k in airKey) airKey[k] = false;
  specCam.mode = def.cam; specCam.u = 0;
  specCam.a0 = Math.atan2(camera.position.x - phys.pos.x, camera.position.z - phys.pos.z);
  showMsg(name, 'gold');
  audio.gate();
}
function updateSpecial(dt) {
  const sp = special;
  if (!sp) return false;
  if (phys.grounded || phys.crashed > 0) { special = null; return false; }   // zu früh gelandet: scoreLanding entscheidet
  sp.t += dt;
  const u = Math.min(1, sp.t / sp.T), d = sp.def, fade = 1 - smoothstep(0, 0.25, u);
  const pPrev = trick.pitch, yPrev = trick.yaw;
  trick.pitch = sp.p0 + sp.pIn * fade + d.pitch(u);
  trick.yaw = sp.y0 + sp.yIn * fade + d.yaw(u);
  trick.pv = (trick.pitch - pPrev) / Math.max(1e-4, dt);
  trick.yv = (trick.yaw - yPrev) / Math.max(1e-4, dt);
  vis.specRoll = d.roll(u);
  vis.sup = d.sup ? d.sup(u) : 0;
  vis.cross = d.cross ? d.cross(u) : 0;
  vis.daffy = d.daffy && !BOARD() ? d.daffy(u) : 0;
  vis.specTuck = d.tuck ? d.tuck(u) : 0;
  vis.tweak = d.tweak ? d.tweak(u) : 0;
  if (d.grab) { trick.grab = d.grab(u); trick.gs = BOARD() && d.bgs !== undefined ? d.bgs : d.gs; }
  if (BOARD() && (vis.sup > 0 || vis.cross > 0)) { trick.grab = Math.max(vis.sup, vis.cross); trick.gs = vis.sup > 0 ? -1 : 1; }
  if (BOARD() && d.bgrab) { trick.grab = d.bgrab(u); trick.gs = d.bgs; }
  specCam.u = u;
  if (u >= 1) {
    trick.pitch = sp.p0 + d.pitch(1); trick.yaw = sp.y0 + d.yaw(1);
    trick.pv = 0; trick.yv = 0;
    lastSpecial = { name: sp.name, pts: d.pts };
    special = null;
  }
  return true;
}
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

/** Ausrüstung aus dem Shop am Fahrer anlegen (Ski, Brett, Outfit mit Kopfteil). */
function applyEquip() {
  phys.setGearStats(gearStats());
  if (!skier) return;
  skier.setSkiDesign(shop.equip.ski);
  skier.setBoardDesign(shop.equip.board);
  const o = OUTFITS[shop.equip.outfit];
  if (o && o.jacket) { skier.setColors(o.jacket, o.accent, o.pants); skier.setHead(o.head || null); skier.setBody(o.body || shop.equip.outfit); }
  else { skier.setColors(outfit.jacket, outfit.accent, outfit.pants); skier.setHead(null); skier.setBody(null); }
  renderOwnedOutfits();
}
/** Im Fenster „Outfit“: gekaufte Outfits als Knöpfe (anlegen per Klick), dazu wie bisher eigene Farben. */
function renderOwnedOutfits() {
  const el = $('ownedOutfits');
  if (!el) return;
  el.innerHTML = '';
  for (const id of Object.keys(OUTFITS)) {
    if (!shop.has('outfit', id)) continue;
    const o = OUTFITS[id], b = document.createElement('button');
    const cols = o.jacket ? [o.jacket, o.accent, o.pants] : [outfit.jacket, outfit.accent, outfit.pants];
    b.innerHTML = `<span class="ow">${cols.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${o.name}`;
    b.classList.toggle('sel', shop.equip.outfit === id);
    b.setAttribute('aria-pressed', String(shop.equip.outfit === id));
    b.addEventListener('click', () => { shop.wear('outfit', id); applyEquip(); if (shop3d) shop3d.refresh(); b.blur(); });
    el.appendChild(b);
  }
  const hint = $('ownedHint');
  if (hint) hint.textContent = Object.keys(OUTFITS).some((id) => id !== 'custom' && shop.has('outfit', id)) ? '' : 'Weitere Outfits gibt es im Shop.';
}
function updateWallet() { const b = $('shopBtn'); if (b) b.textContent = `Shop · ${num(shop.wallet)}`; }
/** Punkte eines Laufs in den Shop: gibt die gutgeschriebene Zahl zurück. */
function earn(n, why) {
  const got = shop.earn(n);
  if (got) { updateWallet(); if (why) showMsg(`+${num(got)} Shop-Punkte · ${why}`, 'good'); }
  return got;
}
/** Freeride und Freestyle: gesicherte Punkte am Ende eines Laufs (Menü oder neuer Lauf) als Shop-Münzen, 40 je 100.000 Punkte
 * (v43; vorher ein Vierzigstel der Punkte, also 2500 je 100.000). */
function payEndless() {
  if (tut.on) return 0;
  if (C.cfg.heli || game.kind !== 'endless' || game.paid || !(game.mode === 'run' || game.mode === 'countdown')) return 0;
  game.paid = true;
  return earn(Math.floor(game.score / 2500));
}
let shop3d = null;   // 3D-Shop (Laden mit Regal und Puppe), entsteht nach dem Laden der Modelle
/** Eigene Farben gewählt: Outfit „Eigene Farben“ anlegen. */
function applyOutfit() {
  if (shop.equip.outfit !== 'custom') shop.wear('outfit', 'custom');
  applyEquip();
  applyOutfitUI();
}
function applyOutfitUI() {
  try { localStorage.setItem(OUTFIT_KEY, JSON.stringify(outfit)); } catch {}
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
  MODES.forEach((m, i) => {
    const b = document.createElement('button');
    b.setAttribute('aria-label', m.name);
    b.addEventListener('click', () => selectMode(i));
    $('mDots').appendChild(b);
  });
  for (const b of document.querySelectorAll('.mtools button[data-dlg]')) {
    b.setAttribute('aria-expanded', 'false');
    b.addEventListener('click', () => {
      const d = $(b.dataset.dlg), was = !d.classList.contains('hidden');
      closeDlg();
      if (!was) { d.classList.remove('hidden'); b.classList.add('on'); b.setAttribute('aria-expanded', 'true'); d.querySelector('.x').focus(); }
    });
  }
  for (const x of document.querySelectorAll('.dlg .x')) x.addEventListener('click', () => { const id = x.closest('.dlg').id; closeDlg(); document.querySelector(`[data-dlg="${id}"]`).focus(); });
  for (const b of $('optSound').children) b.addEventListener('click', () => setMuted(b.dataset.v === '0'));
  for (const b of $('optCam').children) b.addEventListener('click', () => toggleView(b.dataset.v === '1'));
  for (const b of $('optFs').children) b.addEventListener('click', () => toggleFs(b.dataset.v === '1'));
  for (const b of $('optGear').children) b.addEventListener('click', () => { setGear(b.dataset.v); b.blur(); });
  for (const b of $('optDisc').children) b.addEventListener('click', () => { selectDisc(b.dataset.v); b.blur(); });
  for (const b of $('optSteer').children) b.addEventListener('click', async () => { if (touchCtl) await touchCtl.setMode(b.dataset.v); syncOpts(); });
  $('fsBtn').addEventListener('click', () => { toggleFs(); $('fsBtn').blur(); });
  shop.onChange = () => { updateWallet(); if (shop3d) shop3d.refresh(); };
  $('shopBtn').addEventListener('click', () => { if (!shop3d || game.mode !== 'menu') return; closeDlg(); shop3d.open(); });
  updateWallet();
  try { if (localStorage.getItem('gipfelsturm_muted') === '1') audio.setMuted(true); } catch {}
  syncOpts();
  for (const b of $('quality').children) {
    b.addEventListener('click', () => {
      chooseQuality(b.dataset.q);
      if (game.mode === 'menu' && game.kind === 'endless' && !C.cfg.heli) selectMode(modeIdx, true);
      b.blur();
    });
  }
}

// ---------------------------------------------------------------- Startbildschirm: Modi als Karussell
// Jeder Modus hat eine eigene Szene im 3D-Hintergrund: Rennen am Start-Tor, Freeride als Drohnenflug über Wald und
// Pulverhang, Freestyle mit einem Fahrer, der über die Kicker springt und greift, Heli-Skiing mit dem Helikopter am Grat.
const MODES = [
  { id: 'race', name: 'Rennen', kicker: '', line: '', acc: '#ff7a2e' },
  { id: 'endless', name: 'Freeride', kicker: 'Endloser Berg · jedes Mal neu', line: 'Wald, Pulverhänge und Klippen. Punkte zählen erst nach sauberer Landung, ein Sturz kostet alle.', acc: '#63e6b0' },
  { id: 'freestyle', name: 'Freestyle', kicker: 'Endlos · Kicker, Gaps, Rails', line: 'Riesige Sprünge und Rails. Grabs mit Pfeil links und rechts, Rails und Boxen fährst du bis zum Ende.', acc: '#ffd23f' },
  { id: 'heli', name: 'Heli-Skiing', kicker: 'Gipfel bis Tal · Wertung wie im Freeride-Contest', line: 'Der Helikopter setzt dich ab, wo du willst. Bewertet werden Linie, Flüssigkeit, Kontrolle und Sprünge.', acc: '#7cc8ff' },
];
const MODE_KEY = 'gipfelsturm_mode';
let modeIdx = 0;
try { modeIdx = Math.max(0, MODES.findIndex((m) => m.id === localStorage.getItem(MODE_KEY))); } catch {}
const RM = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const demo = { on: false, t: 0, kind: '', lane: 0, d0: 0, v0: 0, inp: { steer: 0, tuck: 0, brake: 0, jump: false } };

const DISC_LINE = {
  sl: 'Enge Tore, schnelle Richtungswechsel. Tempo dosieren, sonst rauschst du am nächsten Tor vorbei.',
  gs: 'Weite, runde Schwünge durch offene Tore. Wer früh andreht, bleibt schnell.',
  sg: 'Lange, schnelle Bögen und zwei Sprünge. Die Linie halten bei über 100 km/h.',
  dh: 'Die ganze Piste von ganz oben, wenige Tore, drei Sprünge. In der Hocke über 130 km/h.',
};
// Heli: gewählter Absprungpunkt (wird nach Name gemerkt, jeder Berg hat eigene Punkte)
let dropPref = 'Gipfel';
try { dropPref = localStorage.getItem('gipfelsturm_drop') || 'Gipfel'; } catch {}
function applyDropPref() {
  if (!C.cfg.heli) return;
  const l = C.HB.dropPoints(), i = l.findIndex((q) => q.name.split(' ')[0] === dropPref.split(' ')[0]);
  C.HB.setDrop(i < 0 ? 0 : i);
}
function heliInfo() {
  if (!C.cfg.heli) return null;
  const l = C.HB.dropPoints(), q = l[C.HB.dropIndex()];
  return { kicker: `Absprung ${q.name} · Schwierigkeit ${q.diff} von 5`, line: `${q.note[0].toUpperCase() + q.note.slice(1)}. Bewertet werden Linie, Flüssigkeit, Kontrolle und Sprünge, dazu zählt die Zeit.`, list: l, idx: C.HB.dropIndex() };
}
function renderDrops() {
  const el = $('optDrop'), hi = MODES[modeIdx].id === 'heli' ? heliInfo() : null;
  el.classList.toggle('hidden', !hi);
  if (!hi) return;
  const sig = hi.list.map((q) => q.name).join('|');
  if (el.dataset.sig !== sig) {
    el.dataset.sig = sig;
    el.innerHTML = '';
    hi.list.forEach((q, i) => {
      const b = document.createElement('button');
      b.dataset.i = String(i);
      b.innerHTML = `${q.name} <i aria-hidden="true">${'●'.repeat(q.diff)}${'○'.repeat(5 - q.diff)}</i>`;
      b.setAttribute('aria-label', `${q.name}, Schwierigkeit ${q.diff} von 5`);
      b.addEventListener('click', () => { selectDrop(i); b.blur(); });
      el.appendChild(b);
    });
  }
  [...el.children].forEach((b, i) => { b.classList.toggle('sel', i === hi.idx); b.setAttribute('aria-pressed', String(i === hi.idx)); });
}
/** Absprungpunkt wählen: Helikopter fliegt hin (weicher Übergang), Kacheln bauen sich dort auf. */
function selectDrop(i) {
  if (!C.cfg.heli || game.mode !== 'menu' || switching) return;
  const l = C.HB.dropPoints();
  i = (i + l.length) % l.length;
  if (i === C.HB.dropIndex()) return;
  dropPref = l[i].name;
  try { localStorage.setItem('gipfelsturm_drop', dropPref); } catch {}
  switching = true;
  freezeFrame();
  requestAnimationFrame(() => setTimeout(() => {
    C.HB.setDrop(i);
    const dp = C.HB.dropPoint();
    world.updateChunks(dp.d, true, dp.x);
    demoStart();
    menuIntro = RM ? 0 : 1;
    renderMode(true);
    switching = false;
    releaseFrame();
  }, 16));
}
function raceInfo() {
  const D = C.DISCIPLINES[disc], len = C.RACE_FINISH - D.start, n = C.cfg.disc === disc && !C.cfg.endless ? C.gates.length : 0;
  return { kicker: `${D.name} · ${len >= 1000 ? (len / 1000).toFixed(1).replace('.', ',') + ' km' : len + ' m'}${n ? ` · ${n} Tore` : ''}`, line: DISC_LINE[disc] + ' Jedes verpasste Tor kostet zwei Sekunden.' };
}
function bestText(id) {
  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  if (id === 'race') { const b = parseFloat(get(raceBestKey()) || '0'); return ['Bestzeit ' + C.DISCIPLINES[disc].short, b ? fmt(b) : 'noch keine']; }
  if (id === 'heli') { const sc = parseFloat(get('gipfelsturm_heli_score') || '0'), b = parseFloat(get(BEST_KEY + '_heli') || '0'); return ['Beste Wertung', sc ? `${sc.toFixed(1).replace('.', ',')} · ${b ? fmt(b) : ''}` : 'noch keine']; }
  const p = parseInt(get(BEST_E_KEY + (id === 'freestyle' ? STYLE_SFX.freestyle : '')) || '0', 10) || 0;
  return ['Rekord', p ? `${num(p)} Punkte` : 'noch keiner'];
}
function renderMode(anim) {
  const m = MODES[modeIdx];
  const ri = m.id === 'race' ? raceInfo() : m.id === 'heli' ? heliInfo() : null;
  $('menu').style.setProperty('--acc', m.acc);
  $('menuKicker').textContent = ri ? ri.kicker : m.kicker;
  $('optDisc').classList.toggle('hidden', m.id !== 'race');
  for (const b of $('optDisc').children) { const on = b.dataset.v === disc; b.classList.toggle('sel', on); b.setAttribute('aria-pressed', String(on)); }
  renderDrops();
  const h = $('mName');
  h.setAttribute('aria-label', m.name);
  h.classList.toggle('anim', !!anim);
  h.innerHTML = [...m.name].map((c, i) => `<span aria-hidden="true" style="--i:${i}">${c}</span>`).join('');
  const l = $('mLine');
  l.textContent = ri ? ri.line : m.line;
  l.classList.remove('anim'); void l.offsetWidth; l.classList.toggle('anim', !!anim);
  const [bl, bv] = bestText(m.id);
  $('mBestLbl').textContent = bl;
  $('mBest').textContent = bv;
  $('mIdx').textContent = String(modeIdx + 1).padStart(2, '0');
  [...$('mDots').children].forEach((b, i) => { b.classList.toggle('sel', i === modeIdx); b.setAttribute('aria-pressed', String(i === modeIdx)); });
}
let switching = false, builtIdx = -1, menuIntro = 0;
// Übergang zwischen den Modi: das aktuelle Bild wird eingefroren (2D-Leinwand über dem 3D-Bild), dahinter entsteht die
// neue Welt, dann löst sich das eingefrorene Bild mit leichtem Zoom und Unschärfe auf, während die neue Kamera einfährt.
const snap = $('snap'), snapCtx = snap.getContext('2d');
function freezeFrame() {
  composer.render();
  const w = canvas.width, h = canvas.height, k = Math.min(1, 1400 / w);
  snap.width = Math.max(1, Math.round(w * k)); snap.height = Math.max(1, Math.round(h * k));
  snapCtx.drawImage(canvas, 0, 0, snap.width, snap.height);   // gleiche Aufgabe wie render(): der Bildpuffer ist noch gültig
  snap.style.transition = 'none';
  snap.style.opacity = '1'; snap.style.transform = 'none'; snap.style.filter = 'none';
  snap.classList.add('on');
}
function releaseFrame() {
  const ms = RM ? 260 : 820;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    snap.style.transition = RM ? `opacity ${ms}ms linear` : `opacity ${ms}ms cubic-bezier(0.33, 0, 0.2, 1), transform ${ms + 200}ms cubic-bezier(0.2, 0.7, 0.2, 1), filter ${ms}ms ease-out`;
    snap.style.opacity = '0';
    if (!RM) { snap.style.transform = 'scale(1.06)'; snap.style.filter = 'blur(10px) brightness(1.08)'; }
    setTimeout(() => { if (snap.style.opacity === '0') snap.classList.remove('on'); }, ms + 260);
  }));
}
// Heli-Gebirge entstehen im Web Worker; der nächste Berg wird schon vorab erzeugt
let heliNext = 0;
const newSeed = () => 1 + Math.floor(Math.random() * 1e6);
function prefetchHeli() { heliNext = newSeed(); HG.request(heliNext, Q.tier); }
async function buildMode() {
  const id = MODES[modeIdx].id;
  let seed;
  if (id === 'heli') {
    seed = heliNext || newSeed();
    heliNext = 0;
    await HG.request(seed, Q.tier);
    if (MODES[modeIdx].id !== id) { heliNext = seed; return; }   // inzwischen weitergeblättert: Berg für später aufheben
    HG.use(seed);
  }
  setKind(id, seed);
  if (id === 'heli') { applyDropPref(); const dp = C.HB.dropPoint(); world.updateChunks(dp.d, false, dp.x); renderMode(); }
  if (id === 'race') $('menuKicker').textContent = raceInfo().kicker;   // Toranzahl steht erst nach dem Aufbau fest
  demoStart();
  builtIdx = modeIdx;
  menuIntro = RM ? 0 : 1;
  if (id === 'heli') prefetchHeli();
}
/** Modus wechseln. Mehrfaches Drücken während des Übergangs springt direkt zum zuletzt gewählten Modus. */
function selectMode(i, instant) {
  i = (i + MODES.length) % MODES.length;
  if (!instant && game.mode !== 'menu') return;
  modeIdx = i;
  try { localStorage.setItem(MODE_KEY, MODES[i].id); } catch {}
  renderMode(!instant);
  if (instant) return buildMode().then(() => { menuIntro = 0; });
  if (switching) return;
  switching = true;
  freezeFrame();
  // erst das eingefrorene Bild zeigen lassen, dann die neue Welt bauen (Heli: im Worker, das Menü bleibt bedienbar)
  requestAnimationFrame(() => setTimeout(async () => {
    while (builtIdx !== modeIdx) await buildMode();
    switching = false;
    releaseFrame();
  }, 16));
}
/** Renn-Disziplin wechseln: Rennpiste mit neuen Toren und neuem Start, weicher Übergang wie beim Moduswechsel. */
function selectDisc(id) {
  if (!C.DISCIPLINES[id] || game.mode !== 'menu') return;
  if (id === disc && C.cfg.disc === id) return;
  disc = id;
  try { localStorage.setItem('gipfelsturm_disc', id); } catch {}
  if (MODES[modeIdx].id !== 'race') { renderMode(); return; }
  if (switching) return;
  switching = true;
  freezeFrame();
  requestAnimationFrame(() => setTimeout(() => {
    setKind('race');
    demoStart();
    menuIntro = RM ? 0 : 1;
    renderMode(true);
    switching = false;
    releaseFrame();
  }, 16));
}
function closeDlg() {
  for (const d of document.querySelectorAll('.dlg')) d.classList.add('hidden');
  for (const b of document.querySelectorAll('.mtools button')) { b.classList.remove('on'); b.setAttribute('aria-expanded', 'false'); }
}
function demoStart() {
  const id = MODES[modeIdx].id;
  Object.assign(demo, { kind: id, t: 0, on: !RM && (id === 'endless' || id === 'freestyle') });
  heliStart();   // nur im Heli-Modus sichtbar: schwebt am Grat, Fahrer auf der Kufe
  if (demo.on) {
    let d = 230, lane = 0, v = 9;
    if (id === 'freestyle') {
      const f = C.featuresIn(0, 1600).find((q) => q.kind === 'jump' && q.vDes > 12);
      if (f) { d = Math.max(20, f.d - 95); lane = f.lane || 0; v = f.vDes * 0.8; }
    }
    Object.assign(demo, { d0: d, lane, v0: v });
    demoReset();
  }
  camSnap = true;
}
function demoReset() {
  const d = demo.d0, x = C.laneX(d, demo.lane);
  teleport(x, -d);
  phys.heading = Math.atan2(C.laneX(d + 8, demo.lane) - x, 8);
  phys.vel.set(Math.sin(phys.heading) * demo.v0, 0, -Math.cos(phys.heading) * demo.v0);
  demo.t = 0; demo.inp.steer = 0;
}
/** Demo-Fahrer im Menü: folgt der Spur, greift in der Luft. */
function demoUpdate(dt) {
  demo.t += dt;
  const p = phys.pos, d = -p.z, sp = phys.speed, LA = 14 + sp * 0.8;
  const e = Math.atan2(C.laneX(d + LA, demo.lane) - p.x, LA) - phys.heading;
  demo.inp.steer += clamp(clamp(e * 3.2, -1, 1) - demo.inp.steer, -9 * dt, 9 * dt);
  const vMax = demo.kind === 'freestyle' ? 32 : 19;
  demo.inp.brake = sp > vMax ? clamp((sp - vMax) / 4, 0, 1) : 0;
  airKey.space = demo.kind === 'freestyle' && !phys.grounded && phys.airTime > 0.12;
  if (demo.t > (demo.kind === 'freestyle' ? 16 : 34) && !switching && phys.grounded) {
    freezeFrame();
    demoReset();
    menuIntro = 1;
    releaseFrame();
  }
}

// ---------------------------------------------------------------- Modus
function resetVisuals() {
  hasPrevSki = false;
  rew.buf.length = 0; rew.on = false; rew.t = 0;
  Object.assign(vis, { lean: 0, crouch: 0, compress: 0, plow: 0, air: 0, crashAngle: 0, crashSpin: 0, tuck: 0, spin: 0, extend: 0, zoom: 0, shake: 0, crashCam: 0, bcam: 0, camSide: 1, flipCam: 0, bigAir: 0, dip: 0 });
  Object.assign(trick, { pitch: 0, yaw: 0, pv: 0, yv: 0, grab: 0, grabT: 0, wasAir: false });
  swYaw = 0; vis.look = 0; vis.specRoll = 0; vis.sup = 0; vis.cross = 0; vis.daffy = 0; vis.tweak = 0; vis.specTuck = 0; vis.avZoom = 0;
  avCam = 0; avNear = 0; phys.noRockCrash = false;
  special = null; lastSpecial = null; timeScale = 1; specCam.w = 0; skiTrick = null;
  skier.attachSkis();
  skier.pivot.rotation.set(0, 0, 0);
  skier.pivot.position.y = 0.85;
  camSnap = true;
}
function resetRunState() {
  if (patch) patch.reset();
  phys.reset(C.cfg.endless ? -1 : C.START_D - 1);
  phys.events.length = 0;
  tracks.clear();
  game.cp = null;
  world.setFlag(null);
  resetVisuals();
}

function setKind(kind, seed) {
  // 'freestyle' ist eine Endlos-Welt mit eigenem Generator-Stil (fast nur Sprünge)
  const style = kind === 'freestyle' || kind === 'heli' ? kind : 'freeride';
  if (kind === 'freestyle' || kind === 'heli') kind = 'endless';
  game.kind = kind;
  game.style = style;
  const sfx = STYLE_SFX[style] || '';
  game.bestEndless = parseInt(localStorage.getItem(BEST_E_KEY + sfx) || '0', 10) || 0;
  game.bestDist = parseInt(localStorage.getItem(BEST_D_KEY + sfx) || '0', 10) || 0;
  C.cfg.treeMul = Q.trees;
  C.setMode(kind === 'endless', seed || 1 + Math.floor(Math.random() * 1e6), style, disc);
  applyTone();
  if (patch) { const pm = patch.mesh.material, on = !!C.cfg.heli; if (!!pm.defines.HELISUN !== on) { if (on) pm.defines.HELISUN = 1; else delete pm.defines.HELISUN; pm.needsUpdate = true; } }
  world.setMode();
  resetRunState();
  game.bestHeli = parseFloat(localStorage.getItem(BEST_KEY + '_heli') || '0') || 0;
  game.best = parseFloat(localStorage.getItem(raceBestKey()) || '0') || 0;
  $('lblMain').textContent = kind === 'endless' && !C.cfg.heli ? 'Punkte' : 'Zeit';
  $('lblSide').textContent = C.cfg.heli ? 'Über Tal' : kind === 'endless' ? 'Respawn' : 'Tore';
  $('progress').classList.toggle('off', kind === 'endless');
}

function startRun(same) {
  const fromMenu = game.mode === 'menu';
  if (fromMenu && !tut.on && !tutDone()) { startTutorial(); return; }   // allererster Start: zuerst das Tutorial
  closeDlg();
  demo.on = false; airKey.space = false;
  audio.start();
  saveEndlessBest();
  payEndless();
  // Heli-Berg: nach einem Sturz geht es auf demselben Berg wieder ganz oben los (same), sonst gibt es einen neuen.
  // Aus dem Menü heraus wird der Berg gefahren, der im Hintergrund zu sehen war.
  if ((C.cfg.heli && same === true) || (game.kind === 'endless' && fromMenu)) { resetRunState(); if (C.cfg.heli) { const dp = C.HB.dropPoint(); world.updateChunks(dp.d, true, dp.x); } else world.updateChunks(0, true); }
  else if (C.cfg.heli && !game.forceSeed) {
    // neuer Berg, wenn der vorab erzeugte fertig ist; sonst derselbe Berg noch einmal (kein Warten)
    if (heliNext && HG.isReady(heliNext)) { const sd = heliNext; HG.use(sd); setKind('heli', sd); applyDropPref(); const dp = C.HB.dropPoint(); world.updateChunks(dp.d, true, dp.x); prefetchHeli(); }
    else { resetRunState(); const dp = C.HB.dropPoint(); world.updateChunks(dp.d, true, dp.x); }
  }
  else if (game.kind === 'endless') setKind(game.style !== 'freeride' && game.style ? game.style : 'endless', game.forceSeed);   // jedes Mal ein neuer Berg (forceSeed nur für Tests)
  else { world.resetGates(); resetRunState(); }
  $('menu').classList.add('hidden');
  $('finish').classList.add('hidden');
  $('hud').classList.remove('hidden');
  $('hint').classList.remove('fade');
  setTimeout(() => $('hint').classList.add('fade'), 10000);
  Object.assign(game, {
    mode: 'countdown', time: 0, penalty: 0, passed: 0, gateIdx: 0, topSpeed: 0, bestJump: 0, countdown: same === true ? 2.0 : 3.0, lastCount: 4, finishT: 0,
    score: 0, maxD: 0, bestTrick: '', bestTrickPts: 0, tricks: 0, pend: 0, pendT: 0, combo: 1, comboT: 0, paid: false,
  });
  $('penalty').textContent = ''; $('penalty').dataset.h = ''; $('gates').dataset.cp = '';
  $('hint').classList.toggle('heli', !!C.cfg.heli);   // im Heli gibt es weder Zurückspulen noch Spezialtricks am Start
  heliStart();
  fwtReset();
  if (aval) { aval.stop(); aval.cool = 6; } avRisk = 0;
}

// ---------------------------------------------------------------- Heli-Skiing: Absprung aus dem Helikopter
// Während des Countdowns schwebt der Helikopter über dem Gipfel, der Fahrer steht in der offenen Tür.
// Bei „Spring!“ fällt er gut 4 m in den Tiefschnee, der Helikopter dreht ab und fliegt davon.
const heli = { on: false, t: 0, pos: new THREE.Vector3(), drop: new THREE.Vector3(), group: null, rotor: null, tail: null, vel: new THREE.Vector3() };
function heliStart() {
  heli.on = game.kind === 'endless' && game.style === 'heli';
  if (!heli.group) {
    heli.group = new THREE.Group();
    const m = (name) => { const o = new THREE.Mesh(world.models[name], world.propMat); o.castShadow = true; o.receiveShadow = true; return o; };
    heli.group.add(m('Heli'));
    heli.rotor = m('HeliRotor'); heli.rotor.position.set(-0.2, 0.35, 0); heli.group.add(heli.rotor);
    heli.tail = m("HeliTail"); heli.tail.position.set(-6.5, -0.1, -0.22); heli.group.add(heli.tail);
    scene.add(heli.group);
  }
  heli.group.visible = heli.on;
  if (!heli.on) { audio.setHeli(0); return; }
  heli.t = 0;
  // Absprungpunkt: 4,5 m über dem Schnee am Gipfel, Helikopter quer zum Hang, Tür zum Fahrer
  const dp = C.cfg.heli ? C.HB.dropPoint() : null;
  const d = dp ? dp.d : 18, x = dp ? dp.x : C.centerX(d), z = -d, gy = C.height(x, z);
  // Blick talwärts in die Falllinie des gewählten Absprungpunkts; der Helikopter steht quer zum Hang
  const hd = dp && dp.fx !== undefined ? Math.atan2(dp.fx, dp.fd) : 0;
  heli.yaw = -hd;
  heli.drop.set(x, gy + 4.5, z);
  const cy = Math.cos(heli.yaw), sy = Math.sin(heli.yaw), ox = 0.3, oz = -1.75;   // Fahrer steht außen auf der Kufe vor der offenen Tür
  heli.pos.set(x + ox * cy + oz * sy, gy + 4.5 + 2.7, z - ox * sy + oz * cy);
  heli.group.position.copy(heli.pos);
  heli.group.rotation.set(0, heli.yaw, 0);
  heli.vel.set(0, 0, 0);
  phys.reset(d, x);
  phys.heading = hd;
  phys.pos.copy(heli.drop);
  phys.grounded = false;
}
// ---------------------------------------------------------------- Heli: Wertung wie bei der Freeride World Tour
// Bewertet werden Linie (Steilheit, genutzte Features, Schwierigkeit des Absprungs), Flüssigkeit (kein Stehen, kein
// Bremsen, lange Flow-Ketten), Kontrolle (weiche Landungen, wenig Rutschen) und Sprünge (Drop-Höhe, Luftzeit, Tricks).
// Gesamtwertung 0 bis 100. Flow: jeder saubere Sprung, Drop oder Trick erhöht die Kette; stehen bleiben oder hartes
// Bremsen bricht sie, ohne neues Feature sinkt sie langsam.
const fwt = { t: 0, steep: 0, slowT: 0, brake: 0, skid: 0, airs: [], tricks: 0, maxDrop: 0, flow: 0, flowMax: 0, flowT: 0, couloirT: 0, inCou: false, hinted: new Set(), hintT: 0, diff: 1, brakeT: 0 };
const flowMult = () => 1 + Math.min(2, fwt.flow * 0.25);
function fwtReset() {
  Object.assign(fwt, { t: 0, steep: 0, slowT: 0, brake: 0, skid: 0, airs: [], tricks: 0, maxDrop: 0, flow: 0, flowMax: 0, flowT: 0, couloirT: 0, inCou: false, hintT: 0, brakeT: 0 });
  fwt.hinted = new Set();
  fwt.diff = C.cfg.heli ? C.HB.dropPoints()[C.HB.dropIndex()].diff : 1;
}
function flowBreak(why) {
  if (fwt.flow >= 2) showMsg(`Flow gerissen (${why})`, 'bad');
  fwt.flow = 0; fwt.flowT = 0;
}
function flowUp(n, what) {
  fwt.flow += n; fwt.flowT = 0;
  fwt.flowMax = Math.max(fwt.flowMax, fwt.flow);
  return `${what}${fwt.flow >= 2 ? `  ·  Flow ×${flowMult().toFixed(2).replace(/0$/, '').replace('.', ',')}` : ''}`;
}
function fwtUpdate(dt) {
  if (!C.cfg.heli || game.mode !== 'run' || phys.crashed > 0) return;
  fwt.t += dt;
  const sp = phys.speed;
  if (phys.grounded && sp > 4) { const ny = Math.max(0.3, phys.normal.y); fwt.steep += (Math.sqrt(1 - ny * ny) / ny) * dt; }
  if (fwt.t > 4 && sp < 4 && phys.grounded) { fwt.slowT += dt; if (fwt.flow > 0 && sp < 2) flowBreak('angehalten'); }
  fwt.brake += inp.brake * dt;
  fwt.brakeT = inp.brake > 0.6 ? fwt.brakeT + dt : 0;
  if (fwt.brakeT > 1.2 && fwt.flow > 0) flowBreak('gebremst');
  fwt.skid += Math.min(phys.skid, 6) * dt;
  fwt.flowT += dt;
  if (fwt.flowT > 8 && fwt.flow > 0) { fwt.flow = Math.max(0, fwt.flow - 1); fwt.flowT = 4; }
  // Couloir und Hinweise auf Features voraus (alle 0,25 s): man liest den Berg selbst, bekommt aber eine Vorwarnung
  fwt.hintT -= dt;
  if (fwt.hintT > 0) return;
  fwt.hintT = 0.25;
  const S = C.HB.info(), px = phys.pos.x, pd = -phys.pos.z;
  let inC = false;
  for (const c of S.couloirs || []) {
    const w2 = (c.W + 4) * (c.W + 4);
    for (let k = 0; k < c.path.length; k += 2) { const dx = c.path[k][0] - px, dd = c.path[k][1] - pd; if (dx * dx + dd * dd < w2) { inC = true; break; } }
    if (inC) break;
  }
  if (inC) fwt.couloirT += 0.25;
  if (inC && !fwt.inCou) { hint('Couloir', 'Felswände links und rechts'); flowUp(1, ''); }
  fwt.inCou = inC;
  const vx = phys.vel.x, vd = -phys.vel.z;
  for (const c of S.cliffs) {
    if (fwt.hinted.has(c)) continue;
    const rx = px - c.x, rd = pd - c.d, al = rx * c.fx + rd * c.fd, u = rx * c.ax + rd * c.ad;
    if (al < -95 || al > -12 || u < c.u0 - 6 || u > c.u1 + 6 || vx * c.fx + vd * c.fd < 3) continue;
    fwt.hinted.add(c);
    hint(`Klippe ${Math.round(c.h)} m`, 'voraus, Kante nach rechts und links absuchen');
  }
  for (const f of S.feats || []) {
    if (f.k !== 'kick' || fwt.hinted.has(f)) continue;
    const rx = px - f.x, rd = pd - f.d, al = rx * f.fx + rd * f.fd, u = rx * f.ax + rd * f.ad;
    if (al < -60 || al > -f.L || Math.abs(u) > f.w || vx * f.fx + vd * f.fd < 3) continue;
    fwt.hinted.add(f);
    hint('Windlippe', 'natürlicher Kicker voraus');
  }
}
function hint(title, sub) {
  const el = $('zone');
  el.innerHTML = `${title}<small>${sub}</small>`;
  el.className = ''; void el.offsetWidth; el.className = 'show';
}
/** Landung im Heli-Berg: Luftzeit, Drop-Höhe und Aufprall merken, Flow erhöhen. Gibt einen Text für die Anzeige zurück. */
function fwtLand(e) {
  if (!C.cfg.heli || game.mode !== 'run' || e.airTime < 0.6) return null;
  const drop = Math.max(0, phys.airStart.y - phys.pos.y);
  fwt.airs.push({ air: e.airTime, drop, impact: e.impact, mult: flowMult() });
  fwt.maxDrop = Math.max(fwt.maxDrop, drop);
  if (phys.crashed > 0 || e.impact > 16) return null;
  if (drop > 6) return flowUp(drop > 15 ? 2 : 1, `Drop ${Math.round(drop)} m`);
  if (e.airTime > 0.9) return flowUp(1, `${e.dist.toFixed(0)} m Sprung`);
  return null;
}
function fwtScore() {
  const T = Math.max(20, fwt.t), cl = (v) => clamp(v, 0, 1);
  const steepS = cl((fwt.steep / T - 0.3) / 0.45);
  let dropS = 0, airSum = 0, q = 0;
  for (const a of fwt.airs) { if (a.drop > 5) dropS += Math.min(1, a.drop / 25) * a.mult; airSum += a.air * a.mult; q += cl(1 - (a.impact - 5) / 12); }
  const featS = cl(dropS * 0.3 + fwt.airs.length * 0.05 + fwt.couloirT / 15);
  const line = 10 * (0.5 * steepS + 0.35 * featS + 0.15 * (fwt.diff - 1) / 4);
  const flow = 10 * (cl(0.85 - (3 * fwt.slowT) / T - fwt.brake / T) + 0.15 * cl(fwt.flowMax / 5));
  const control = 10 * (0.7 * (fwt.airs.length ? q / fwt.airs.length : 0.75) + 0.3 * (1 - cl(fwt.skid / T / 2.5)));
  const air = 10 * (0.45 * cl(fwt.maxDrop / 28) + 0.25 * cl(airSum / 12) + 0.3 * cl(fwt.tricks / 4000));
  const total = 10 * (0.3 * line + 0.25 * flow + 0.2 * control + 0.25 * air);
  return { line, flow, control, air, total: Math.round(total * 10) / 10 };
}
const dec1 = (v) => v.toFixed(1).replace('.', ',');

// ---------------------------------------------------------------- Lawinen (Heli-Berg)
// Steile, tiefverschneite Hänge können abreißen: je steiler, schneller und härter (Landungen), desto eher.
// Das Brett reißt oberhalb ab, die Front rollt hinab – wer schnell genug ist oder seitlich rausfährt, entkommt.
let avRisk = 0, avCam = 0, avNear = 0;
function avalancheUpdate(dt) {
  if (!aval) return;
  const heliMode = game.kind === 'endless' && game.style === 'heli';
  if (heliMode && game.mode === 'run' && !aval.active && aval.cool <= 0 && phys.grounded && phys.crashed <= 0) {
    const ny = Math.max(0.3, phys.normal.y), tanS = Math.sqrt(1 - ny * ny) / ny;
    // realistisch: nur steile (ab etwa 32 Grad), tief eingeschneite Hänge; scharfe Schwünge belasten die Schneedecke zusätzlich
    if (tanS > 0.62 && phys.pow > 0.6 && phys.speed > 6 && -phys.pos.z > 60) avRisk += dt * (tanS - 0.6) * (0.045 + 0.12 * clamp(Math.abs(phys.aLat) / 9, 0, 1.5));
    if (avRisk > 1 + Math.random() * 0.02) triggerAvalanche();
  }
  const r = aval.update(dt, C, phys.pos);
  avNear = aval.active ? r.near : 0;
  // Lawinen-Sicht (v29): solange die Lawine abgeht und nah ist, zoomt die Kamera heraus (siehe updateCamera); in
  // dieser Zeit lassen Felsen und Felswände den Fahrer nicht stürzen, er prallt nur ab
  avCam = Math.max(0, avCam - dt);
  phys.noRockCrash = game.mode === 'run' && (avCam > 0 || avNear > 0.25);
  audio.setRumble(aval.active ? r.near : 0);
  if (aval.active) vis.shake = Math.max(vis.shake, r.near * 0.45);
  if (r.caught && phys.crashed <= 0 && game.mode === 'run') {
    showMsg('Von der Lawine erfasst!', 'bad');
    quietCrash = true;
    phys.crash();
    aval.active = false; aval.cool = 1e9;   // die Lawine läuft sichtbar aus; weg ist sie erst beim nächsten Start am Gipfel
  } else if (r.ended && game.mode === 'run' && phys.crashed <= 0) {
    showMsg('Lawine entkommen!', 'gold');
  }
  if (r.broke) { audio.crack(); vis.shake = 1; showMsg('LAWINE! Raus aus dem Hang!', 'bad'); }
}
function triggerAvalanche(landing = false) {
  avRisk = 0;
  const d = -phys.pos.z, hub = C.centerX(d);
  // Abriss oberhalb des Fahrers, quer zur örtlichen Falllinie
  const px = phys.pos.x, pz = phys.pos.z, e = 4;
  let gx = C.height(px + e, pz) - C.height(px - e, pz), gd = C.height(px, pz - e) - C.height(px, pz + e);
  const gl = Math.hypot(gx, gd) || 1; gx /= gl; gd /= gl;
  const back = landing ? 7 : 16, side = (Math.random() - 0.5) * 20;
  aval.start({ x: px + gx * back + gd * side, d: d + gd * back - gx * side, fx: -gx, fd: -gd }, 70 + Math.random() * 60, C);
  audio.crack();
  avCam = 2.5;   // mindestens so lange etwas weitere Sicht, danach solange die Lawine wirklich nah ist
  vis.shake = 0.5;
  showMsg('Der Hang reißt!', 'bad');
}

function heliUpdate(dt) {
  if (!heli.group || !heli.group.visible) return;
  heli.t += dt;
  heli.rotor.rotation.y += dt * 38;
  heli.tail.rotation.z += dt * 60;
  if (game.mode === 'countdown' || game.mode === 'menu') {
    // Schweben mit leichtem Wackeln; Fahrer bleibt in der Tür
    heli.group.position.set(heli.pos.x, heli.pos.y + Math.sin(heli.t * 1.7) * 0.12, heli.pos.z);
    heli.group.rotation.set(Math.sin(heli.t * 1.3) * 0.02, heli.yaw || 0, Math.sin(heli.t * 0.9) * 0.025);
    phys.pos.copy(heli.drop); phys.pos.y += Math.sin(heli.t * 1.7) * 0.12;
    phys.vel.set(0, 0, 0); phys.grounded = false;
  } else {
    // Abdrehen: Nase runter, beschleunigen, steigen, Kurve weg vom Hang
    const k = Math.min(1, heli.t * 0.3);
    const cy = Math.cos(heli.yaw || 0), sy = Math.sin(heli.yaw || 0);
    heli.vel.x += dt * (7 * cy - 1.5 * sy); heli.vel.y += dt * 3.2; heli.vel.z += dt * (-7 * sy - 1.5 * cy);
    heli.group.position.addScaledVector(heli.vel, dt);
    heli.group.rotation.set(0.08 * k, (heli.yaw || 0) + 0.35 * k, -0.22 * k);
    if (heli.t > 16) heli.group.visible = false;
  }
  const dist = heli.group.position.distanceTo(camera.position);
  audio.setHeli(heli.group.visible ? clamp(1 - dist / 260, 0, 1) : 0);
}

function toMenu() {
  if (game.mode === 'loading') return;
  saveEndlessBest();
  payEndless();
  game.mode = 'menu';
  resetRunState();
  heli.on = false; if (heli.group) heli.group.visible = false; audio.setHeli(0);
  if (aval) aval.stop(); audio.setRumble(0);
  $('menu').classList.remove('hidden');
  $('finish').classList.add('hidden');
  $('hud').classList.add('hidden');
  $('count').innerHTML = '';
  // Heli: den gerade gefahrenen Berg im Menü behalten (kein Warten); sonst frische Welt im Hintergrund
  if (MODES[modeIdx].id === 'heli' && C.cfg.heli) { renderMode(); demoStart(); }
  else selectMode(modeIdx, true);
  if (tut.on) closeTutorial();
}

const totalScore = () => Math.round(game.score);
function saveEndlessBest() {
  if (tut.on) return;
  if (C.cfg.heli || game.kind !== 'endless' || game.mode === 'menu' || game.mode === 'loading') return;
  const t = totalScore();
  const sfx = STYLE_SFX[game.style] || '';
  if (t > game.bestEndless) { game.bestEndless = t; localStorage.setItem(BEST_E_KEY + sfx, String(t)); }
  const m = Math.round(game.maxD);
  if (m > game.bestDist) { game.bestDist = m; localStorage.setItem(BEST_D_KEY + sfx, String(m)); }
}
/** Endlos-Welt: Punkte einer Landung vormerken; gesichert werden sie erst nach sauberem Weiterfahren. */
function addPending(pts, isTrick) {
  if (C.cfg.heli) return 0;   // Speedrun: keine Punkte
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
  const hk = C.cfg.heli, bk = hk ? 'bestHeli' : 'best';
  const isBest = !game[bk] || total < game[bk];
  if (isBest) { game[bk] = total; localStorage.setItem(hk ? BEST_KEY + '_heli' : raceBestKey(), String(total)); }
  audio.finish();
  $('finTitle').textContent = (isBest ? 'Neue Bestzeit!' : hk ? 'Im Tal' : 'Im Ziel') + (hk ? '' : ` · ${C.DISCIPLINES[disc].name}`);
  $('finTime').textContent = fmt(total);
  if (hk) {
    // Freeride-Wertung: Gesamtnote groß, Teilnoten als Zeilen; Rekord wird gemerkt
    const sc = fwtScore();
    let bestSc = 0;
    try { bestSc = parseFloat(localStorage.getItem('gipfelsturm_heli_score') || '0') || 0; } catch {}
    const newBest = sc.total > bestSc;
    if (newBest) { bestSc = sc.total; try { localStorage.setItem('gipfelsturm_heli_score', String(sc.total)); } catch {} }
    game.lastScore = sc;
    $('finTitle').textContent = newBest ? 'Neue Bestwertung!' : isBest ? 'Neue Bestzeit!' : 'Im Tal';
    $('finTime').innerHTML = `${dec1(sc.total)}<small> / 100</small>`;
    const rowsH = [['Linie', dec1(sc.line)], ['Flüssigkeit', dec1(sc.flow)], ['Kontrolle', dec1(sc.control)], ['Sprünge', dec1(sc.air)],
      ['Zeit', fmt(total)], ['Größter Drop', `${Math.round(fwt.maxDrop)} m`], ['Längste Flow-Kette', `×${(1 + Math.min(2, fwt.flowMax * 0.25)).toFixed(2).replace(/0$/, '').replace('.', ',')}`], ['Beste Wertung', dec1(bestSc)]];
    // v44 angeglichen an Freeride (40 Münzen je 100.000 Punkte, rund 8 je Minute): 2 bis 42 je Abfahrt (vorher bis 270)
    const gotH = earn(Math.round(sc.total * 0.4 + 2));
    rowsH.push(['Shop-Punkte', `+${num(gotH)}`]);
    $('finStats').innerHTML = rowsH.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('');
    return;
  }
  const rows = hk ? [['Höhenmeter', `${num(-C.baseH(C.FINISH_D))} m`], ['Höchsttempo', `${Math.round(game.topSpeed * 3.6)} km/h`], ['Weitester Sprung', `${game.bestJump.toFixed(1).replace('.', ',')} m`], ['Bestzeit', fmt(game.bestHeli)]] : [['Tore', `${game.passed}/${C.gates.length}`], ['Strafzeit', `+${game.penalty.toFixed(0)} s`], ['Trickpunkte', num(game.score)],
    ['Höchsttempo', `${Math.round(game.topSpeed * 3.6)} km/h`], ['Weitester Sprung', `${game.bestJump.toFixed(1).replace('.', ',')} m`], ['Bestzeit', fmt(game.best)]];
  // Shop-Punkte: getroffene Tore, Länge der Disziplin, Bonus für eine neue Bestzeit
  const lenF = { sl: 1, gs: 1.3, sg: 1.7, dh: 2.1 }[disc] || 1;
  const missed = C.gates.length - game.passed;
  // v44 angeglichen an Freeride (rund 8 Münzen je Minute): sauberer Lauf Slalom 6, Riesentorlauf 8, Super-G 10, Abfahrt 13;
  // verpasste Tore zählen doppelt dagegen, neue Bestzeit +2 (vorher 50 bis über 200 je Lauf)
  const quality = C.gates.length ? Math.max(0, (game.passed - 2 * missed) / C.gates.length) : 0;
  rows.push(['Shop-Punkte', `+${num(earn(Math.round(6 * lenF * quality) + (isBest ? 2 : 0)))}`]);
  $('finStats').innerHTML = rows.map(([a, b]) => `<div><span>${a}</span><b>${b}</b></div>`).join('');
}

// ---------------------------------------------------------------- Respawn-Punkte
function setCheckpoint() {
  if (C.cfg.heli) return;   // Heli-Berg: keine Respawn-Punkte, ein Sturz heißt zurück zum Gipfel
  if (game.mode !== 'run' || !phys.grounded || phys.crashed > 0) return;
  game.cp = { x: phys.pos.x, z: phys.pos.z, h: phys.heading };
  world.setFlag(game.cp);
  audio.gate();
  showMsg('Respawn-Punkt gesetzt', 'good');
}
function teleport(x, z, heading) {
  if (C.cfg.endless) world.updateChunks(-z, true, x);
  phys.reset(-z, x);
  if (patch) patch.reset();
  if (heading !== undefined) phys.heading = heading;
  phys.events.length = 0;
  tracks.clear();
  resetVisuals();
}
function toCheckpoint() {
  if (C.cfg.heli) return;
  if (game.mode !== 'run' || phys.crashed > 0) return;
  if (game.cp) {
    if (tut.on) tut.cpBack = true;
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

// ---------------------------------------------------------------- Ski-Tricks am Boden (Taste E)
// Nur zwei, wie in echt: Park-Ski (und die Legende) können den Nose Butter, der Powder-Ski den Powder Slash. Läuft am Boden,
// rein am Körper sichtbar; die Fahrt ändert sich kaum (beide kosten etwas Tempo, wie in echt). Ein Sturz bricht ab.
// Die Bewegung hängt nur an der Zeit, nicht an der Grafikstufe (nur die Menge Schneestaub skaliert mit Q.fx).
let skiTrick = null;
const skiTrickId = () => (!BOARD() && SKIS[shop.equip.ski] && SKIS[shop.equip.ski].trick) || null;
const skiTrickReady = () => !!skiTrickId() && game.mode === 'run' && phys.grounded && !phys.grind && phys.crashed <= 0 && !special && !skiTrick && !rew.on;
const smoother = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };
function startSkiTrick() {
  const id0 = skiTrickId();
  if (!id0) { if (game.mode === 'run' && !BOARD()) showMsg('Dieser Ski hat keinen eigenen Trick', 'bad'); return; }
  if (!skiTrickReady()) return;
  // Legende: im Pulver der Slash, sonst der Nose Butter
  const id = id0 === 'legend' ? (phys.pow > 0.3 && phys.speed > 5 ? 'slash' : 'butter') : id0;
  const def = SKI_TRICKS[id];
  if (def.minV && phys.speed < def.minV) { showMsg(`${def.name} braucht mehr Tempo`, 'bad'); return; }
  const side = Math.abs(inp.steer) > 0.2 ? Math.sign(inp.steer) : phys.aLat ? -Math.sign(phys.aLat) || 1 : 1;
  // Drehpunkt des Butters: Mitte der flach aufliegenden Schaufeln (Körper-Maßstab 0,94)
  const zc = id === 'butter' ? -0.94 * (skier.bendS1 + 0.08) : null;
  // Kein Butter gleicht dem anderen: Dauer, Druck, Rhythmus der Drehung und das Wackeln werden pro Versuch ausgewürfelt
  const R = Math.random;
  const rnd = { T: 0.9 + 0.2 * R(), th: 0.75 + 0.25 * R(), pIn: 0.17 + 0.09 * R(), k1: 1 + R() * 0.8, k2: 1 + R() * 0.8, p1: R() * TAU, p2: R() * TAU, a1: 0.008 + 0.008 * R(), a2: 0.006 + 0.006 * R(), seed: R() * 50 };
  skiTrick = { id, def, t: 0, T: def.T * (id === 'butter' ? rnd.T : 1), side, zc, zc0: zc, rnd, legend: id0 === 'legend', yaw: 0 };
}
function endSkiTrick(ok) {
  const st = skiTrick;
  skiTrick = null;
  if (!st || !ok) return;
  const pts = Math.round(st.def.pts * (st.legend ? 1.5 : 1) * trickMul());
  const got = addPending(pts, true);
  game.tricks++;
  if (pts > game.bestTrickPts) { game.bestTrickPts = pts; game.bestTrick = st.def.name; }
  showMsg(got ? `${st.def.name}  +${num(got)}` : st.def.name, 'good');
}
const tvA = new THREE.Vector3(), tvB = new THREE.Vector3(), Y_AX = new THREE.Vector3(0, 1, 0);
/** Haltung und Drehung eines laufenden Ski-Tricks (in updateSkier, nach der normalen Körperstellung). Gibt Zusatzwerte
 * für skier.update zurück. */
function skiTrickPose(dt, pv) {
  const st = skiTrick;
  st.t += dt;
  const u = Math.min(1, st.t / st.T);
  const P = { butter: 0, butterTh: undefined, twist: 0, bob: 0, crouch: 0, lean: null, leanW: 0 };
  const baseYaw = pv.rotation.y;
  let dYaw = 0;
  if (st.id === 'butter') {
    // Ablauf wie bei echten Fahrern (180 auf Nose Butter): Niemand dreht aus dem Stand auf den Schaufeln. Erst Ausholen
    // (Oberkörper gegen die Drehung, kurz einfedern), dann ein 180er auf flachen Ski, der Oberkörper zieht voraus; aus
    // diesem Schwung kippt das Gewicht weit nach vorn auf die Schaufeln, die Enden heben sich, und die zweite halbe
    // Drehung läuft schneller auf den Spitzen, tief und kompakt. Zum Schluss wieder flach auf beide Ski.
    // Nichts davon gleichmäßig: der Druck pumpt (Enden wippen), der Körper geht unruhig auf und ab, die Drehung stockt
    // beim Umsetzen aufs Vorderteil und zieht wieder an, feines Zittern. Ausprägung pro Versuch zufällig (rnd).
    const r = st.rnd, t = st.t, n = (f, o) => C.vnoise(t * f + r.seed, o) * 2 - 1, sd = st.side;
    const wind = smoother(0, 0.12, u) * (1 - smoother(0.12, 0.24, u));                 // Ausholen
    const slide = smoother(0.1, 0.2, u) * (1 - smoother(0.42, 0.52, u));               // 180er auf flachen Ski
    const env = smoother(0.4, 0.5, u) * (1 - smoother(0.78, 0.9, u));                  // auf den Schaufeln
    const press = Math.max(0, 1 + 0.16 * n(2.6, 3.1) + 0.07 * n(8.5, 7.3));
    P.butter = env; P.butterTh = BUTTER_TH * r.th * env * press;
    P.twist = sd * (-0.55 * wind + 0.45 * smoother(0.12, 0.28, u) * (1 - smoother(0.42, 0.56, u)) + 0.15 * smoother(0.45, 0.55, u) * (1 - smoother(0.74, 0.88, u)));
    P.crouch = 0.3 * wind + 0.22 * slide + (0.5 + 0.1 * n(2.1, 11.7)) * env;
    P.bob = env * (0.035 * n(3.3, 4.4) + 0.018 * n(7.7, 1.9)) + slide * 0.015 * n(2.4, 8.8);   // unruhiges Auf und Ab
    P.lean = 0.07 * n(1.4, 5.9) * env; P.leanW = Math.min(1, (env + slide + wind) * 1.6);
    // Drehwinkel: erste Hälfte über flache Ski, zweite schneller auf den Schaufeln; dazwischen das kurze Stocken
    const w1 = smoother(0.1, 0.5, u), w2 = smoother(0.45, 0.77, u);
    const J = Math.sin(Math.PI * w1) * r.a1 * Math.sin(TAU * r.k1 * w1 + r.p1) + Math.sin(Math.PI * w2) * r.a2 * Math.sin(TAU * r.k2 * w2 + r.p2);
    dYaw = sd * (Math.PI * (w1 + w2) + TAU * J) + sd * 0.025 * env * n(10, 2.2);
    // Drehpunkt: beim 180er die Körpermitte, auf den Schaufeln die Spitzen (gleitend umgesetzt)
    st.zc = st.zc0 * env;
    if (phys.grounded) phys.vel.multiplyScalar(Math.exp(-dt * (0.45 * slide + 0.22 * env)));   // Querrutschen und Schaufeln bremsen
    // feiner Schneestaub an den Schaufeln, solange sie über den Schnee drehen
    const turnRate = Math.abs(dYaw - st.yaw) / Math.max(dt, 1e-3);
    if (env > 0.6 && turnRate > 0.6) {
      tvA.set(0, 0, st.zc).applyAxisAngle(Y_AX, baseYaw + dYaw);
      tvA.applyQuaternion(skier.root.quaternion).add(skier.root.position);
      const k = Math.random() < 0.7 * Q.fx ? 1 : 0;
      for (let i = 0; i < k; i++) spray.emit(tvA.x + (Math.random() - 0.5) * 0.3, tvA.y + 0.04, tvA.z + (Math.random() - 0.5) * 0.3, phys.vel.x * 0.5 + (Math.random() - 0.5) * 1.2, 0.3 + Math.random() * 0.6, phys.vel.z * 0.5 + (Math.random() - 0.5) * 1.2, 0.12 + Math.random() * 0.12, 0.5 + Math.random() * 0.4);
    }
  } else if (st.id === 'slash') {
    // Ski quer in Lenkrichtung, auf der Kante (über die normale Kurvenlage, die Ski bleiben auf dem Schnee), Schnee nach außen
    const env = smoother(0, 0.28, u) * (1 - smoother(0.62, 1, u));
    dYaw = -st.side * 1.15 * env; P.lean = st.side * 0.72; P.leanW = env; P.crouch = 0.55 * env;
    if (phys.grounded) phys.vel.multiplyScalar(Math.exp(-dt * 0.9 * env));
    if (u > 0.2 && u < 0.75) { // Schneewand zur Außenseite: im Pulver riesig
      const n = Math.round((10 + phys.pow * 20) * Q.fx * env), r = phys.right, sd = -st.side;
      for (let i = 0; i < n; i++) spray.emit(phys.pos.x + r.x * sd * 0.6, phys.pos.y + 0.15, phys.pos.z + r.z * sd * 0.6,
        r.x * sd * (2 + Math.random() * 5) + phys.vel.x * 0.4, 1.5 + Math.random() * (3 + phys.pow * 4), r.z * sd * (2 + Math.random() * 5) + phys.vel.z * 0.4,
        0.3 + Math.random() * 0.6 + phys.pow * 0.6, 0.8 + Math.random() * 1.2, 3.5, 0.55, 2.4);
    }
  }
  // Butter: auf den Schaufeln dreht der Körper um die Spitzen, nicht um seine Mitte. Der Drehpunkt bleibt liegen, der
  // Körper schwenkt um ihn herum; dieser Versatz wird direkt in die Fahrt übernommen (die Position verschiebt sich über
  // den Schnee, wie in echt), damit am Ende nichts zurückspringt.
  if (st.zc !== null && st.zc !== 0) {
    const y0 = baseYaw + st.yaw, y1 = baseYaw + dYaw;
    tvA.set(0, 0, st.zc).applyAxisAngle(Y_AX, y0).sub(tvB.set(0, 0, st.zc).applyAxisAngle(Y_AX, y1));
    tvA.y = 0; tvA.applyQuaternion(skier.root.quaternion);
    const ox = phys.pos.x, oz = phys.pos.z, nx = ox + tvA.x, nz = oz + tvA.z;
    if (phys.grounded) {
      phys.pos.y += C.height(nx, nz) - C.height(ox, oz);
      phys.pos.x = nx; phys.pos.z = nz;
      skier.root.position.x += tvA.x; skier.root.position.z += tvA.z; skier.root.position.y = phys.pos.y - (phys.sink || 0) * (Q.patch > 0 ? 0.12 : 0.8);
    }
  }
  st.yaw = dYaw;
  pv.rotation.y = baseYaw + dYaw;
  if (st.t >= st.T) endSkiTrick(true);
  return P;
}

// ---------------------------------------------------------------- Tutorial
// Beim ersten Start (erster Druck auf Start) eine geführte Fahrt im Freeride: Lenken, Hocke, Bremsen, Springen, Trick,
// Zurückspulen, Respawn-Punkt. Jeder Schritt zählt erst, wenn man ihn wirklich ausführt. Danach (oder nach Überspringen)
// nur noch über Einstellungen > Tutorial.
const TUT_KEY = 'gipfelsturm_tutorial_done';
const tut = { on: false, i: 0, p: 0, ok: 0, a: 0, b: 0, cpBack: false, endT: 0, w: -1 };
const tutDone = () => { try { return localStorage.getItem(TUT_KEY) === '1'; } catch { return true; } };
const kb = (k) => `<kbd>${k}</kbd>`;
const TUT = [
  { d: `Lenken mit ${kb('A')} und ${kb('D')} oder den Pfeiltasten. Fahr eine Kurve nach links und eine nach rechts.`,
    t: 'Lenken: Handy wie ein Lenkrad neigen (oder Daumen bzw. Joystick, je nach Einstellung). Fahr eine Kurve nach links und eine nach rechts.',
    run: (dt) => { if (phys.grounded && phys.speed > 2) { if (inp.steer < -0.5) tut.a += dt; if (inp.steer > 0.5) tut.b += dt; } return (Math.min(tut.a, 0.7) + Math.min(tut.b, 0.7)) / 1.4; } },
  { d: `${kb('W')} halten: Hocke. So wirst du schneller.`, t: 'Knopf Hocke halten (Joystick: nach unten). So wirst du schneller.',
    run: (dt) => (tut.a += inp.tuck > 0.7 && phys.grounded ? dt : 0) / 1.5 },
  { d: `${kb('S')} halten: bremsen.`, t: 'Knopf Bremse halten (Joystick: nach oben): bremsen.',
    run: (dt) => (tut.a += inp.brake > 0.7 && phys.speed > 1.5 ? dt : 0) / 1.0 },
  { d: `${kb('Leertaste')}: springen.`, t: 'Sprung-Knopf: springen.',
    run: () => (!phys.grounded && !phys.grind && phys.airTime > 0.15 ? 1 : 0) },
  { d: `Spring und drück in der Luft ${kb('S')} für einen Backflip oder ${kb('A')} oder ${kb('D')} für eine Drehung.`, t: 'Spring und wisch in der Luft nach oben (Backflip) oder neig das Handy (Drehung).',
    run: () => (!phys.grounded && (Math.abs(trick.pitch) > 1.3 || Math.abs(trick.yaw) > 1.3) ? 1 : 0) },
  { d: `${kb('Q')} halten: Zurückspulen, bis 8 Sekunden. Praktisch nach einem Sturz.`, t: 'Doppelpfeil-Knopf rechts oben halten: Zurückspulen, bis 8 Sekunden. Praktisch nach einem Sturz.',
    run: (dt) => (tut.a += rew.on ? dt : 0) / 0.8 },
  { d: `${kb('F')}: Respawn-Punkt setzen, ${kb('T')}: dorthin zurück. Probier beides.`, t: 'Fahnen-Knopf halten: Respawn-Punkt setzen. Kurz tippen: dorthin zurück. Probier beides.',
    run: () => (game.cp ? 0.5 : 0) + (tut.cpBack ? 0.5 : 0) },
];
const TUT_END = { d: `Geschafft! Im Menü wählst du Rennen, Freeride, Freestyle oder Heli-Skiing. Spezialtricks liegen auf ${kb('1')} bis ${kb('0')}, alle Tasten stehen unter Steuerung.`,
  t: 'Geschafft! Im Menü wählst du Rennen, Freeride, Freestyle oder Heli-Skiing. Der Stern-Knopf in der Luft zeigt Spezialtricks, alles Weitere steht unter Steuerung.' };
function tutShow() {
  const end = tut.i >= TUT.length, st = end ? TUT_END : TUT[tut.i];
  $('tut').classList.toggle('ok', end);
  $('tutStep').textContent = end ? 'Tutorial fertig' : `Tutorial ${tut.i + 1} von ${TUT.length}`;
  $('tutText').innerHTML = isTouch ? st.t : st.d;
  $('tutSkip').textContent = end ? 'Zum Menü' : 'Überspringen';
  tut.w = -1; tutBar(end ? 1 : 0);
}
function tutBar(p) { const w = Math.round(p * 100); if (w !== tut.w) { tut.w = w; $('tutFill').style.width = w + '%'; } }
function startTutorial() {
  closeDlg();
  if (game.mode !== 'menu') toMenu();
  Object.assign(tut, { on: true, i: 0, p: 0, ok: 0, a: 0, b: 0, cpBack: false, endT: 0 });
  setKind('endless', 4711);   // ruhiger Freeride-Berg
  startRun();
  $('tut').classList.remove('hidden');
  document.documentElement.classList.add('tutorial');
  tutShow();
}
/** Tutorial schließen und merken (auch nach Überspringen oder Esc): kommt nur noch über die Einstellungen. */
function closeTutorial() {
  tut.on = false;
  try { localStorage.setItem(TUT_KEY, '1'); } catch {}
  $('tut').classList.add('hidden');
  document.documentElement.classList.remove('tutorial');
}
function tutUpdate(dt) {
  if (!tut.on || game.mode === 'menu') return;
  if (tut.i >= TUT.length) { tut.endT += dt; if (tut.endT > 8) toMenu(); return; }
  if (tut.ok > 0) { tut.ok -= dt; if (tut.ok <= 0) { tut.i++; tut.a = 0; tut.b = 0; tutShow(); } return; }
  if (game.mode !== 'run') return;
  tut.p = clamp(TUT[tut.i].run(dt), 0, 1);
  tutBar(tut.p);
  if (tut.p >= 1) { tut.ok = 0.9; $('tut').classList.add('ok'); $('tutStep').textContent = 'Gut gemacht'; }
}

// ---------------------------------------------------------------- Zurückspulen (Taste Q halten; nicht im Heli)
// 30-mal pro Sekunde Spielzeit wird der Zustand gemerkt (Physik, Tricks, Haltung, Punkte, Tore), bis zu 8 s. Beim Halten
// läuft die Fahrt doppelt so schnell rückwärts; beim Loslassen geht es von dort weiter. Die Laufzeit im Rennen läuft
// nicht zurück (das Zurückspulen kostet also Zeit). Punkte gehen beim Zurückspulen nur nach unten, nie nach oben: was ein
// Sturz gekostet hat, bleibt weg, und Punkte aus dem zurückgespulten Stück gibt es nicht doppelt. Combo fällt auf 1.
const REW_HZ = 30, REW_MAX = 8 * REW_HZ;
const rew = { buf: [], t: 0, acc: 0, on: false, fx: 0 };
const REW_GAME = ['penalty', 'passed', 'gateIdx', 'topSpeed', 'bestJump', 'score', 'maxD', 'bestTrick', 'bestTrickPts', 'tricks', 'pend', 'pendT', 'combo', 'comboT'];
const REW_DOWN = ['score', 'pend', 'combo', 'tricks'];   // nur nach unten zurücksetzen (nie verlorene Punkte zurückgeben)
const REW_COPY = ['grind', 'gT'];   // kleine Zustands-Objekte kopieren; andere Objekte (Felsen, Rails) bleiben Verweise
function snapObj(o, skip) {
  const r = {};
  for (const k in o) {
    if (skip && skip.includes(k)) continue;
    const v = o[k];
    if (typeof v === 'function') continue;
    r[k] = v && v.isVector3 ? v.clone() : v && REW_COPY.includes(k) ? { ...v } : v;
  }
  return r;
}
function loadObj(o, r) { for (const k in r) { const v = r[k]; if (v && v.isVector3) o[k].copy(v); else o[k] = v && REW_COPY.includes(k) ? { ...v } : v; } }
const rewAllowed = () => game.mode === 'run' && !C.cfg.heli;
function recordRewind(dt) {
  if (!rewAllowed()) return;
  rew.t += dt;
  if (rew.t < 1 / REW_HZ) return;
  rew.t = Math.min(rew.t - 1 / REW_HZ, 1 / REW_HZ);
  const g = {};
  for (const k of REW_GAME) g[k] = game[k];
  rew.buf.push({
    phys: snapObj(phys, ['events', 'gs']), trick: snapObj(trick), vis: snapObj(vis), game: g,
    m: { swYaw, boardEdge, boardLift, timeScale, quietCrash, lastSpecial, special: special && { ...special }, specW: specCam.w, specU: specCam.u, specMode: specCam.mode, specA0: specCam.a0 },
  });
  if (rew.buf.length > REW_MAX) rew.buf.shift();
}
function loadRewind(r) {
  loadObj(phys, r.phys); loadObj(trick, r.trick); loadObj(vis, r.vis);
  for (const k of REW_GAME) game[k] = REW_DOWN.includes(k) ? Math.min(game[k], r.game[k]) : r.game[k];
  const m = r.m;
  swYaw = m.swYaw; boardEdge = m.boardEdge; boardLift = m.boardLift; timeScale = m.timeScale; quietCrash = m.quietCrash; lastSpecial = m.lastSpecial;
  special = m.special && { ...m.special };
  specCam.w = m.specW; specCam.u = m.specU; specCam.mode = m.specMode; specCam.a0 = m.specA0;
  if (phys.crashed <= 0) skier.attachSkis();
}
/** Läuft gerade das Zurückspulen? Spult pro Bild doppelt so viel Zeit zurück, wie vergeht. */
function rewindStep(dt) {
  if (!(keys.rew && rewAllowed() && (rew.on || rew.buf.length > 1))) { if (rew.on) endRewind(); return false; }
  if (!rew.on) { rew.on = true; rew.acc = 0; skiTrick = null; }
  rew.acc += dt * 2 * REW_HZ;
  let n = Math.floor(rew.acc), r = null;
  rew.acc -= n;
  while (n-- > 0 && rew.buf.length > 1) r = rew.buf.pop();
  if (r) loadRewind(r);
  return true;
}
let rewShown = false, rewW = -1;
function rewindHud() {
  if (rew.on !== rewShown) { rewShown = rew.on; $('rew').classList.toggle('hidden', !rew.on); }
  if (!rew.on) return;
  const w = Math.round(100 * rew.buf.length / REW_MAX);
  if (w !== rewW) { rewW = w; $('rewFill').style.width = w + '%'; }
}
function endRewind() {
  skiTrick = null;
  rew.on = false; rew.t = 0;
  phys.events.length = 0;
  hasPrevSki = false;
  acc = 0;
  if (C.cfg.endless) { world.updateChunks(-phys.pos.z, true, phys.pos.x); game.combo = 1; game.comboT = 0; }
  if (patch) patch.reset();
}

// ---------------------------------------------------------------- Eingabe
const KEYMAP = { KeyQ: 'rew', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', Space: 'space' };
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (e.target instanceof HTMLInputElement) return;
  const k = e.code;
  if (game.mode === 'menu') {
    const open = document.querySelector('.dlg:not(.hidden)');
    if (k === 'Escape' && open) { const id = open.id; closeDlg(); document.querySelector(`[data-dlg="${id}"]`)?.focus(); return; }
    if (!open && k === 'KeyB') { setGear(BOARD() ? 'ski' : 'board'); return; }
    if (!open && MODES[modeIdx].id === 'heli' && C.cfg.heli) {
      const i = C.HB.dropIndex();
      if (k === 'ArrowUp' || k === 'KeyW' || k === 'ArrowDown' || k === 'KeyS') { e.preventDefault(); selectDrop(i + (k === 'ArrowUp' || k === 'KeyW' ? -1 : 1)); return; }
      if (/^Digit[1-9]$/.test(k)) { selectDrop(+k.slice(5) - 1); return; }
    }
    if (!open && MODES[modeIdx].id === 'race') {
      const i = C.DISC_ORDER.indexOf(disc);
      if (k === 'ArrowUp' || k === 'KeyW' || k === 'ArrowDown' || k === 'KeyS') { e.preventDefault(); selectDisc(C.DISC_ORDER[(i + (k === 'ArrowUp' || k === 'KeyW' ? -1 : 1) + 4) % 4]); return; }
      if (/^Digit[1-4]$/.test(k)) { selectDisc(C.DISC_ORDER[+k.slice(5) - 1]); return; }
    }
    if (!open && (k === 'ArrowLeft' || k === 'KeyA' || k === 'ArrowRight' || k === 'KeyD')) { e.preventDefault(); selectMode(modeIdx + (k === 'ArrowLeft' || k === 'KeyA' ? -1 : 1)); return; }
  }
  // Enter/Leertaste auf einem Knopf: der Knopf selbst reagiert (sonst würde doppelt gestartet)
  if ((k === 'Enter' || k === 'Space') && e.target instanceof HTMLButtonElement && game.mode !== 'run') return;
  let name = KEYMAP[k];
  // In der Luft: Pfeil links = Mute Grab (linke Hand), Pfeil rechts = Tail Grab (rechte Hand); A/D drehen weiter
  if ((k === 'ArrowLeft' || k === 'ArrowRight') && game.mode === 'run' && !phys.grounded) name = k === 'ArrowLeft' ? 'gl' : 'gr';
  if (name) {
    keys[name] = true;
    // Tricks zählen nur für Tasten, die erst in der Luft gedrückt werden
    if (game.mode === 'run' && !phys.grounded) airKey[name] = true;
  }
  if (game.mode === 'run') { const sd = SPECIALS.find((q) => q.key === k || q.key.replace('Digit', 'Numpad') === k); if (sd) { startSpecial(sd); return; } if (k === 'SpecialRandom') { startSpecial(null); return; } }
  if (k === 'Space' || k === 'Enter') {
    if (game.mode === 'menu' || (game.mode === 'finished' && game.finishT > 1.2)) startRun();
    else if (game.mode === 'run' && (phys.grounded || phys.grind)) jumpQueued = true;   // auch von der Rail abspringen
  } else if (k === 'KeyR') { if (game.mode !== 'loading') startRun(); }
  else if (k === 'KeyE') startSkiTrick();
  else if (k === 'KeyF') setCheckpoint();
  else if (k === 'KeyT' || k === 'Backspace') toCheckpoint();
  else if (k === 'Escape') toMenu();
  else if (k === 'KeyM') setMuted(!audio.muted);
  else if (k === 'KeyC') toggleView();
  else if (k === 'KeyV') toggleFs();
  if (k.startsWith('Arrow') || k === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  const name = KEYMAP[e.code];
  if (name) { keys[name] = false; airKey[name] = false; }
  if (e.code === 'ArrowLeft') { keys.gl = false; airKey.gl = false; }
  if (e.code === 'ArrowRight') { keys.gr = false; airKey.gr = false; }
});
window.addEventListener('blur', () => { for (const k in keys) { keys[k] = false; airKey[k] = false; } });
// Handy: Knöpfe, Neigungssteuerung (Erlaubnis wird beim Start-Tipp eingeholt)
const touchCtl = setupTouch({ isAir: () => game.mode === 'run' && !phys.grounded && phys.crashed <= 0, isRunning: () => game.mode === 'run', onResize: () => resize() });
$('startBtn').addEventListener('click', () => { if (touchCtl) touchCtl.onStart(); if (game.mode === 'menu') startRun(); });
$('againBtn').addEventListener('click', () => { if (touchCtl) touchCtl.onStart(); startRun(); });
$('menuBtn').addEventListener('click', () => toMenu());
$('tutSkip').addEventListener('click', () => toMenu());
$('tutStart').addEventListener('click', () => { if (touchCtl) touchCtl.onStart(); startTutorial(); });
$('mPrev').addEventListener('click', () => selectMode(modeIdx - 1));
$('mNext').addEventListener('click', () => selectMode(modeIdx + 1));
// Handy und Maus: im Menü seitlich wischen wechselt den Modus
let swX = null, swY = 0;
window.addEventListener('pointerdown', (e) => {
  if (game.mode !== 'menu' || e.target.closest('button, input, .dlg')) return;
  swX = view.rot ? e.clientY : e.clientX; swY = view.rot ? e.clientX : e.clientY;
});
window.addEventListener('pointerup', (e) => {
  if (swX === null) return;
  const dx = (view.rot ? e.clientY : e.clientX) - swX, dy = (view.rot ? e.clientX : e.clientY) - swY;
  swX = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) selectMode(modeIdx + (dx < 0 ? 1 : -1));
});

// ---------------------------------------------------------------- Tricks
function updateTricks(dt) {
  // auf der Rail zählt man nicht als in der Luft: A/D dreht dort den Körper nicht mehr (v38)
  const inAir = !phys.grounded && !phys.grind && phys.crashed <= 0 && (game.mode === 'run' || (game.mode === 'menu' && demo.on));
  if (inAir && !trick.wasAir) { for (const k in airKey) airKey[k] = false; trick.grabT = 0; trick.gT.safety = trick.gT.mute = trick.gT.tail = 0; lastSpecial = null; }
  trick.wasAir = inAir;
  const kk = (r) => 1 - Math.exp(-dt * r);
  if (!special) { vis.specRoll = (vis.specRoll || 0) * (1 - kk(8)); vis.sup = (vis.sup || 0) * (1 - kk(8)); vis.cross = (vis.cross || 0) * (1 - kk(8)); vis.daffy = (vis.daffy || 0) * (1 - kk(8)); vis.tweak = (vis.tweak || 0) * (1 - kk(8)); }
  if (inAir && updateSpecial(dt)) { /* Choreografie läuft */ }
  else if (inAir) {
    const flipIn = (airKey.down ? 1 : 0) - (airKey.up ? 1 : 0);
    const spinIn = (airKey.right ? 1 : 0) - (airKey.left ? 1 : 0);
    // Ohne Taste dreht die Figur zur nächsten vollen Umdrehung weiter und richtet sich aus
    const rm = 1 + (trickMul() - 1) * 0.6;   // Freestyle-Ski drehen schneller
    const pT = flipIn !== 0 ? flipIn * 8.4 * rm : clamp((Math.round(trick.pitch / TAU) * TAU - trick.pitch) * 9, -8.4 * rm, 8.4 * rm);
    const yT = spinIn !== 0 ? spinIn * 8.8 * rm : clamp((Math.round(trick.yaw / Math.PI) * Math.PI - trick.yaw) * 9, -8.8 * rm, 8.8 * rm);   // auf halbe Drehungen: 180 = rückwärts landen
    // weiches An- und Ausdrehen wirkt natürlicher als ein starres Tempo
    trick.pv += clamp(pT - trick.pv, -38 * dt, 38 * dt);
    trick.yv += clamp(yT - trick.yv, -44 * dt, 44 * dt);
    trick.pitch += trick.pv * dt;
    trick.yaw += trick.yv * dt;
    const gT = airKey.space || airKey.gl || airKey.gr ? 1 : 0;
    if (airKey.gl) trick.gs = -1; else if (airKey.gr) trick.gs = 1; else if (airKey.space) trick.gs = 0;
    trick.grab += clamp(gT - trick.grab, -6 * dt, 6 * dt);
    if (trick.grab > 0.7) { trick.grabT += dt; trick.gT[trick.gs < 0 ? 'mute' : trick.gs > 0 ? 'tail' : 'safety'] += dt; }
  } else {
    const k = 1 - Math.exp(-dt * 12);
    trick.pitch -= trick.pitch * k;
    trick.pv = 0;
    trick.grab += clamp(0 - trick.grab, -10 * dt, 10 * dt);
    trick.yaw -= trick.yaw * k; trick.yv = 0;
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
  vis.tuck += ((inAir ? Math.max(clamp(Math.abs(trick.pv) / 7, 0, 1), special ? vis.specTuck || 0 : 0) : 0) - vis.tuck) * k(9);
  vis.spin += ((inAir ? clamp(-trick.yv / 8.8, -1, 1) : 0) - vis.spin) * k(9);
  // Absprung: kurz strecken. Kurz vor dem Boden: Beine zur Landung ausfahren.
  const nearGround = inAir && phys.vel.y < 0 && phys.gap < 2.6 && Math.abs(trick.pv) < 2.5;
  const pop = inAir && phys.airTime < 0.16;
  vis.extend += ((nearGround || pop ? 1 : 0) - vis.extend) * k(11);
}


/** Wird bei der Landung aufgerufen: wertet Drehungen aus oder lässt den Fahrer stürzen. */
function scoreLanding(e) {
  const flips = Math.round(trick.pitch / TAU), halves = Math.round(trick.yaw / Math.PI);
  const pOff = trick.pitch - flips * TAU, yOff = trick.yaw - halves * Math.PI;
  const wasSwitch = isSwitch();
  const grabT = trick.grabT, gTs = { ...trick.gT };
  trick.pitch = pOff; trick.yaw = yOff; trick.grabT = 0;
  if (phys.crashed > 0) return;
  // Wer (fast) steht, landet quer genauso sicher wie gerade: Drehung wird einfach zur neuen Blickrichtung.
  // Bei Fahrt bleibt es streng – quer aufsetzen heißt stürzen.
  const vh = Math.hypot(phys.vel.x, phys.vel.z);
  const yawTol = vh < 3 ? Infinity : vh < 8 ? lerp(2.6, 1.1, (vh - 3) / 5) : 1.1;
  if (Math.abs(yOff) > 1.1 && Math.abs(yOff) <= yawTol) { phys.heading += yOff; trick.yaw = 0; }
  if (Math.abs(pOff) <= 0.85 && Math.abs(yOff) <= yawTol && halves !== 0) {
    // ungerade halbe Drehung: man landet rückwärts (Switch) bzw. wieder vorwärts
    swYaw = ((swYaw + halves * Math.PI) % TAU + TAU) % TAU;
    trick.yaw = yOff;
  }
  if (Math.abs(pOff) > 0.85 || Math.abs(yOff) > yawTol) {
    showMsg('Nicht ausgedreht!', 'bad');
    quietCrash = true;
    phys.crash();
    return;
  }
  const parts = [];
  let pts = 0, cats = 0;
  const spc = lastSpecial; lastSpecial = null;
  if (spc) { parts.push(spc.name); pts += spc.pts; cats++; }
  if (flips !== 0 && !spc) {
    const n = Math.abs(flips);
    parts.push((n === 2 ? 'Doppel-' : n >= 3 ? 'Dreifach-' : '') + (flips > 0 ? 'Backflip' : 'Frontflip'));
    pts += [0, 500, 1300, 2600][Math.min(3, n)];
    cats++;
  }
  if (halves !== 0 && !spc) {
    const n = Math.abs(halves);
    if (BOARD()) parts.push((wasSwitch ? 'Fakie ' : '') + (halves < 0 ? 'Frontside ' : 'Backside ') + String(n * 180) + (n % 2 && isSwitch() ? ' (Fakie)' : ''));
    else parts.push((wasSwitch ? 'Switch ' : '') + String(n * 180) + (n % 2 ? (isSwitch() ? ' (rückwärts)' : ' (vorwärts)') : ''));
    pts += Math.round(150 * Math.pow(n, 1.45) * (wasSwitch ? 1.25 : 1));
    cats++;
  }
  for (const [k, nm] of BOARD() ? [['safety', 'Indy Grab'], ['mute', 'Melon Grab'], ['tail', 'Tail Grab']] : [['safety', 'Safety Grab'], ['mute', 'Mute Grab'], ['tail', 'Tail Grab']]) {
    if (gTs[k] > 0.25 && !spc) {
      parts.push(nm);
      pts += 150 + Math.round(Math.min(gTs[k], 1.5) * 300);
      cats++;
    }
  }
  void grabT;
  const airPts = e.airTime > 0.55 ? Math.round(e.dist * 4) : 0;
  if (cats > 0) {
    if (cats > 1) pts = Math.round(pts * 1.5);
    pts = Math.round(pts * trickMul());   // Freestyle-Ski bringen mehr Trickpunkte
    pts += airPts;
    const name = parts.join(' + ');
    const comboNow = game.combo;
    if (C.cfg.heli) { fwt.tricks += pts * flowMult(); flowUp(1, ''); }
    pts = addPending(pts, true);
    game.tricks++;
    if (pts > game.bestTrickPts) { game.bestTrickPts = pts; game.bestTrick = name; }
    showMsg(C.cfg.heli ? `${name}${fwt.flow >= 2 ? `  ·  Flow ×${flowMult().toFixed(2).replace(/0$/, '').replace('.', ',')}` : ''}` : `${name}  +${num(pts)}${game.kind === 'endless' && comboNow > 1 ? `  (×${comboNow.toFixed(1).replace('.0', '')})` : ''}`, 'gold');
    audio.gate();
  } else if (C.cfg.heli && e.fwtText) {
    showMsg(e.fwtText, 'gold');
  } else if (e.airTime > 0.55 && e.dist > 3) {   // Hüpfer auf der Stelle zählen nicht als Sprung
    const p = addPending(airPts, false);
    showMsg(`${e.dist.toFixed(1).replace('.', ',')} m Sprung${game.kind === 'endless' && !C.cfg.heli ? `  +${p}` : ''}`, 'gold');
  }
}

// ---------------------------------------------------------------- Kamera
const camPos = new THREE.Vector3(0, 5, 12), camDir = new THREE.Vector3(0, 0, -1), lookSm = new THREE.Vector3();
const tV = new THREE.Vector3(), tV2 = new THREE.Vector3(), tV3 = new THREE.Vector3();
let camSnap = true;

/** Einfahrt der Menükamera nach einem Moduswechsel: startet weiter weg und gleitet weich heran. */
function menuIntroCam(dt) {
  if (menuIntro <= 0) return;
  menuIntro = Math.max(0, menuIntro - dt / 1.4);
  const e = menuIntro * menuIntro * (3 - 2 * menuIntro);
  tV.copy(camera.position).sub(lookSm);
  camera.position.addScaledVector(tV, e * 0.35);
  camera.position.y += e * 1.5;
}
function updateCamera(dt, time) {
  const p = phys.pos, sp = phys.speed;
  if (game.mode === 'menu' && demo.kind === 'heli' && heli.group && heli.on) {
    // Heli am Grat: Kamera kreist langsam, unten fällt der Berg ins Tal ab
    // Kamera talseitig etwas unterhalb des Helikopters: oben der Heli mit dem Fahrer auf der Kufe, dahinter der Grat
    // Kamera bergseitig hinter dem Helikopter: der Heli steht rechts im Bild, darunter fällt der Berg ins Tal ab
    const c = heli.group.position, a = RM ? 0 : Math.sin(time * 0.06) * 0.35;
    tV.set(c.x - 15 + Math.sin(a) * 8, c.y + 4.5, c.z + 24 + Math.cos(a) * 2);
    tV.y = Math.max(tV.y, C.height(tV.x, tV.z) + 2.5);
    camPos.lerp(tV, camSnap ? 1 : 1 - Math.exp(-dt * 2));
    camera.position.copy(camPos);
    lookSm.set(c.x - (camera.aspect > 1.2 ? 4 : 10), c.y - 22, c.z - 90);
    menuIntroCam(dt);
    camera.lookAt(lookSm);
    if (camera.fov !== 52) { camera.fov = 52; camera.updateProjectionMatrix(); }
    camSnap = false;
    return;
  }
  if (game.mode === 'menu' && demo.on && demo.kind === 'endless') {
    // Freeride: Drohnenflug schräg hinter dem Fahrer über Wald und Pulverhang
    tV.set(phys.vel.x, 0, phys.vel.z);
    if (tV.lengthSq() < 1) tV.set(Math.sin(phys.heading), 0, -Math.cos(phys.heading));
    camDir.lerp(tV.normalize(), camSnap ? 1 : 1 - Math.exp(-dt * 1.2)).normalize();
    tV2.copy(p).addScaledVector(camDir, -17);
    tV2.x += -camDir.z * 9; tV2.z += camDir.x * 9;
    tV2.y = Math.max(C.height(tV2.x, tV2.z) + 7, p.y + 8);
    camPos.lerp(tV2, camSnap ? 1 : 1 - Math.exp(-dt * 2.5));
    camera.position.copy(camPos);
    tV3.copy(p).addScaledVector(camDir, 16); tV3.y = p.y + 0.5;
    lookSm.lerp(tV3, camSnap ? 1 : 1 - Math.exp(-dt * 3));
    menuIntroCam(dt);
    camera.lookAt(lookSm);
    if (camera.fov !== 58) { camera.fov = 58; camera.updateProjectionMatrix(); }
    camSnap = false;
    return;
  }
  if (game.mode === 'menu' && !demo.on) {
    const a = RM ? 0.5 : Math.sin(time * 0.16) * 0.9 + 0.5;
    // Rennen: vor dem Start-Tor, der Fahrer steht rechts im Bild, links bleibt Platz für die Schrift
    tV.set(p.x + 1.2 + Math.sin(a) * 1.4, 0, p.z - 4.6 - Math.cos(a) * 0.5);
    tV.y = Math.max(C.height(tV.x, tV.z) + 1.3, p.y + 1.35 + Math.sin(time * 0.23) * 0.2);
    camPos.lerp(tV, camSnap ? 1 : 1 - Math.exp(-dt * 2));
    lookSm.set(p.x - (camera.aspect > 1.2 ? 2.1 : 0.4), p.y + 1.25, p.z);
    camera.position.copy(camPos);
    menuIntroCam(dt);
    camera.lookAt(lookSm);
    camera.fov = 42;
    camera.updateProjectionMatrix();
    camSnap = false;
    return;
  }
  if (heli.on && game.mode === 'countdown' && heli.group) {
    tV.set(phys.pos.x + 7.5, phys.pos.y + 0.6, phys.pos.z + 9);
    camPos.lerp(tV, camSnap ? 1 : 1 - Math.exp(-dt * 3));
    camera.position.copy(camPos);
    lookSm.set((phys.pos.x + heli.group.position.x) / 2, phys.pos.y + 0.8, (phys.pos.z + heli.group.position.z) / 2);
    camera.lookAt(lookSm);
    if (camera.fov !== 58) { camera.fov = 58; camera.updateProjectionMatrix(); }
    camSnap = false;
    return;
  }
  // Lawinen-Sicht (v29, v36 näher): statt seitlich zu schwenken (man sah nicht mehr, was vor einem liegt) geht die Kamera etwas
  // zurück und nach oben und schaut voraus den Hang hinab: Felsen und Bäume vor einem sind früh zu sehen, die Lawine
  // im Rücken bleibt im Bild. Weich ein- und ausgeblendet, Blickrichtung bleibt die Fahrtrichtung.
  vis.avZoom = (vis.avZoom || 0) + (((avCam > 0 || avNear > 0.25) && game.mode === 'run' && !special ? 1 : 0) - (vis.avZoom || 0)) * (1 - Math.exp(-dt * 2.2));
  const av = vis.avZoom;
  const z = vis.zoom * (1 - av), cc = vis.crashCam;
  if (sp > 2) tV.set(phys.vel.x, 0, phys.vel.z).normalize();
  else tV.set(Math.sin(phys.heading), 0, -Math.cos(phys.heading));
  camDir.lerp(tV, camSnap ? 1 : 1 - Math.exp(-dt * 3.2)).normalize();
  // Bei Tricks rückt die Kamera heran und schwenkt leicht zur Seite, beim Sturz geht sie auf Abstand
  const fc = vis.flipCam * z, ba = vis.bigAir * (1 - z * 0.6);
  // Nose Butter: die Kamera rückt langsam etwas heran, geht tiefer und leicht zur Seite, damit man die gebogenen Ski sieht
  vis.bcam += ((skiTrick && skiTrick.id === 'butter' ? 1 : 0) - vis.bcam) * (1 - Math.exp(-dt * (skiTrick ? 1.8 : 1.2)));
  const bc = vis.bcam * vis.bcam * (3 - 2 * vis.bcam) * (1 - av) * (1 - cc);
  const dist = ((lerp(6.4 + sp * 0.07 - inp.tuck * 0.5 + vis.air * 1.2, 4.6 + fc * 0.8, z) + ba * 3.2 + av * 2.4) * (1 - 0.35 * cc) + cc * 2.6) * (1 - 0.45 * bc);
  tV2.copy(p).addScaledVector(camDir, -dist);
  const side = (2.6 * z + 1.6 * fc) * vis.camSide + 1.5 * bc;
  tV2.x += -camDir.z * side;
  tV2.z += camDir.x * side;
  const groundY = C.height(tV2.x, tV2.z);
  tV2.y = Math.max(groundY + 1.9 + sp * 0.012, p.y + 1.55);
  tV2.y = Math.max(groundY + 1.2, lerp(lerp(tV2.y, p.y + 1.3 - fc * 0.35, z * 0.75), p.y + 1.15, bc)) + cc * 1.9 + ba * 1.6 - vis.dip * 0.45 + av * 1.5;
  camPos.lerp(tV2, camSnap ? 1 : 1 - Math.exp(-dt * (7.5 + cc * 9)));
  const gh = C.height(camPos.x, camPos.z) + 0.9;
  if (camPos.y < gh) camPos.y = gh;
  tV3.copy(p).addScaledVector(camDir, (6 + ba * 5 + av * 10) * (1 - z) * (1 - cc) * (1 - 0.6 * bc));
  tV3.y = lerp(lerp(lerp(C.height(tV3.x, tV3.z) + 1.0, p.y + 1.0, 0.5 + vis.air * 0.3 - ba * 0.35 - av * 0.5), p.y + 0.9, Math.max(z, cc)), p.y + 0.55, bc * 0.6);
  lookSm.lerp(tV3, camSnap ? 1 : 1 - Math.exp(-dt * (11 + z * 8)));
  camSnap = false;
  const sh = Math.pow(clamp(sp / 42, 0, 1), 2) * 0.035 + vis.shake * 0.4;
  camera.position.set(
    camPos.x + (C.vnoise(time * 23, 1.3) - 0.5) * sh,
    camPos.y + (C.vnoise(time * 27, 7.7) - 0.5) * sh,
    camPos.z + (C.vnoise(time * 19, 4.1) - 0.5) * sh);
  camera.lookAt(lookSm);
  camera.rotateZ(-vis.lean * 0.09 + (C.vnoise(time * 17, 9.2) - 0.5) * vis.shake * 0.12);
  let fov = 60 + 22 * smoothstep(8, 44, sp) * (1 - 0.5 * av) + inp.tuck * 2 - 15 * z - 20 * cc + 6 * ba + 3 * av - 8 * bc;

  // ---- Ego-Sicht (Helmkamera): Augen im Kopf des Fahrers, dreht bei Flips und Spins voll mit,
  // neigt sich in die Kurve, federt bei Landungen, zittert mit Tempo und Untergrund. Beim Sturz Verfolgerkamera.
  vis.fpv += ((firstPerson && game.mode !== 'menu' ? 1 : 0) - vis.fpv) * (1 - Math.exp(-dt * 4));
  const f = vis.fpv * (1 - smoothstep(0.05, 0.5, cc));
  skier.setFirstPerson(f > 0.55);
  if (f > 0.002) {
    skier.root.updateMatrixWorld(true);
    // Ego-Sicht wie in Ski-Spielen: Kopfposition (wippt mit Hocke und Landung), Blick in Fahrtrichtung leicht nach unten,
    // Kamera ein Stück hinter dem Kopf – so liegen die Skier unten im Bild und der Horizont bleibt sichtbar.
    fpEye.copy(EYE0).applyMatrix4(skier.bones[2].matrixWorld);
    skier.pivot.getWorldQuaternion(fpQ);                                   // Körperausrichtung inkl. Flips und Spins
    if (isSwitch()) fpQ.multiply(fpQ2.setFromAxisAngle(tV.set(0, 1, 0), Math.PI));   // rückwärts: Blick über die Schulter hangabwärts
    fpTmp.set(0, 0.12, FP_BACK).applyQuaternion(fpQ);                      // hinter den Kopf (Körper-Rückseite = +Z)
    fpEye.add(fpTmp);
    fpE.set(-0.34 - 0.06 * vis.crouch - 0.05 * vis.plow + vis.dip * 0.22 + (phys.grounded ? 0 : 0.08), 0, -vis.lean * 0.22);
    fpQ.multiply(fpQ2.setFromEuler(fpE));
    // am Boden ruhig, in der Luft folgt die Kamera den Drehungen direkt
    fpCam.slerp(fpQ, camSnap || fpFirst ? 1 : 1 - Math.exp(-dt * (phys.grounded ? 14 : 30)));
    fpFirst = false;
    // Zittern: Tempo, Rutschen, Tiefschnee, Aufprall
    const shk = (Math.pow(clamp(sp / 35, 0, 1), 2) * 0.006 + phys.skid * 0.0015 + phys.pow * 0.004 * clamp(sp / 20, 0, 1)) * (phys.grounded ? 1 : 0.3) + vis.shake * 0.02;
    fpE.set((C.vnoise(time * 31, 2.1) - 0.5) * shk * 2, (C.vnoise(time * 27, 5.3) - 0.5) * shk, (C.vnoise(time * 23, 8.7) - 0.5) * shk);
    fpQ2.setFromEuler(fpE);
    tV.copy(fpEye); tV.y -= vis.dip * 0.12 + vis.compress * 0.05;
    camera.position.lerp(tV, f);
    camera.quaternion.slerp(fpQ2.premultiply(fpCam), f);
    fov = lerp(fov, 78 + 12 * smoothstep(8, 42, sp) + inp.tuck * 3 + vis.bigAir * 3, f);
  } else fpFirst = true;
  // ---- Spezialtrick-Kamera: eigene Perspektive je Trick, weich überblendet (auch aus der Ego-Sicht)
  specCam.w += ((special ? 1 : 0) - specCam.w) * (1 - Math.exp(-dt * (special ? 6 : 3)));
  if (specCam.w > 0.002 && game.mode === 'run') {
    const w = specCam.w * specCam.w * (3 - 2 * specCam.w), u = specCam.u, pp = phys.pos;
    const fx = camDir.x, fz = camDir.z, rx = -fz, rz = fx;   // vorwärts und rechts in der Ebene
    let px, py, pz, ly = pp.y + 0.6;
    if (specCam.mode === 'orbit' || specCam.mode === 'bullet') {
      // Kreisfahrt um den Fahrer: Cork halber Kreis, Bullet Time ganzer Kreis nah dran
      const a = specCam.a0 + (specCam.mode === 'bullet' ? TAU : Math.PI) * (u * u * (3 - 2 * u));
      const r = specCam.mode === 'bullet' ? 4.6 : 6.2;
      px = pp.x + Math.sin(a) * r; pz = pp.z + Math.cos(a) * r; py = pp.y + (specCam.mode === 'bullet' ? 0.4 : 1.4);
    } else if (specCam.mode === 'side') {
      // Profil von der Seite, tief: man sieht den Überschlag mit der Drehung
      px = pp.x + rx * 7.5 + fx * 1.5; pz = pp.z + rz * 7.5 + fz * 1.5; py = pp.y - 0.4;
    } else if (specCam.mode === 'hero') {
      // vor dem Fahrer, Blick zurück ins Gesicht: er fliegt auf die Kamera zu
      px = pp.x + fx * 6.5 + rx * 1.6; pz = pp.z + fz * 6.5 + rz * 1.6; py = pp.y + 0.3;
    } else {
      // Froschperspektive: von schräg unten vorne gegen den Himmel
      px = pp.x + fx * 4.2 - rx * 1.8; pz = pp.z + fz * 4.2 - rz * 1.8; py = pp.y - 2.6; ly = pp.y + 0.9;
    }
    py = Math.max(py, C.height(px, pz) + 0.7);
    tV.set(px, py, pz);
    tV2.set(pp.x, ly, pp.z);
    specM.lookAt(tV, tV2, camera.up);
    specQ.setFromRotationMatrix(specM);
    camera.position.lerp(tV, w);
    camera.quaternion.slerp(specQ, w);
    fov = lerp(fov, specCam.mode === 'bullet' ? 48 : 56, w);
    if (w > 0.4) skier.setFirstPerson(false);
  }
  const near = f > 0.5 ? 0.06 : 0.3;
  if (camera.near !== near) { camera.near = near; camera.updateProjectionMatrix(); }
  if (Math.abs(fov - camera.fov) > 0.01) {
    camera.fov = lerp(camera.fov, fov, 1 - Math.exp(-dt * (f > 0.5 ? 6 : 4)));
    camera.updateProjectionMatrix();
  }
  grade.uniforms.uVig.value = 0.22 + f * (0.08 + 0.12 * smoothstep(15, 40, sp));   // Tunnelblick bei hohem Tempo
}
const FP_BACK = 0.55;                               // Abstand hinter dem Kopf (m)
const EYE0 = new THREE.Vector3(0, 1.75, -0.04);   // Augenpunkt (Kopfknochen), etwas hinter dem Gesicht, damit die Skispitzen ins Bild kommen
const fpTmp = new THREE.Vector3(), fpScl = new THREE.Vector3(), fpEye = new THREE.Vector3(), fpQ = new THREE.Quaternion(), fpQ2 = new THREE.Quaternion(), fpCam = new THREE.Quaternion(), fpE = new THREE.Euler(0, 0, 0, 'YXZ');
let fpFirst = true;
const specM = new THREE.Matrix4(), specQ = new THREE.Quaternion();

// ---------------------------------------------------------------- Spuren & Gischt
const csTmp = { hx: 0, hz: 0, tx: 0, tz: 0, n: 0 };
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
  if (BOARD()) {
    // eine breite Spur; beim Bremsen steht das Brett quer und schiebt Schnee
    const a = vis.plow * 1.05, ca = Math.cos(a), sa = Math.sin(a);
    const fx = f.x * ca + r.x * sa, fz = f.z * ca + r.z * sa, rx = r.x * ca - f.x * sa, rz = r.z * ca - f.z * sa;
    const bw = 0.15 + phys.pow * 0.08, hx = p.x + fx * 0.78, hz = p.z + fz * 0.78, tx = p.x - fx * 0.78, tz = p.z - fz * 0.78;
    tracks.quad(tx - rx * bw, tz - rz * bw, -1, tx + rx * bw, tz + rz * bw, 1, hx + rx * bw, hz + rz * bw, 1, hx - rx * bw, hz - rz * bw, -1, depth * (0.12 + 0.88 * boardEdge), skidG * 0.6);
    const q = prevSki[0];
    if (hasPrevSki && (skidG > 0.12 || phys.off > 0.3)) tracks.quad(q.tx, q.tz, 0, q.hx, q.hz, 0, hx, hz, 0, tx, tz, 0, 0.25 + skidG * 0.35, Math.max(skidG, phys.off * 0.6));
    q.tx = tx; q.tz = tz; q.hx = hx; q.hz = hz;
  }
  // Ski-Trick: die Spur entsteht genau dort, wo der Ski gerade aufliegt. Beim Nose Butter heben sich die Enden, die
  // zwei Linien werden kürzer und enden; dann liegen nur noch die Schaufeln auf und wischen beim Drehen einen Fächer
  // in den Schnee (rutschend, darum mit Schmierspur vom letzten Bild). Beim Slash stehen die Ski quer: breiter
  // Rutschfleck statt Linie. Danach setzt die normale Doppelspur wieder ein.
  if (!BOARD() && skiTrick) {
    for (let i = 0; i < 2; i++) {
      const c = skier.contactSpan(i, csTmp), q = prevSki[i], RQ = skier.root.quaternion, RP = phys.pos;   // Lage des Fahrers aus diesem Bild
      tvA.set(c.hx, 0, c.hz).applyQuaternion(RQ).add(RP); tvB.set(c.tx, 0, c.tz).applyQuaternion(RQ).add(RP);
      let hx = tvA.x, hz = tvA.z, tx = tvB.x, tz = tvB.z, dx = hx - tx, dz = hz - tz, len = Math.hypot(dx, dz);
      if (len < 0.12) { const ux = len > 1e-3 ? dx / len : f.x, uz = len > 1e-3 ? dz / len : f.z, mx = (hx + tx) / 2, mz = (hz + tz) / 2; hx = mx + ux * 0.06; hz = mz + uz * 0.06; tx = mx - ux * 0.06; tz = mz - uz * 0.06; dx = hx - tx; dz = hz - tz; len = 0.12; }
      const wx = (-dz / len) * hw, wz = (dx / len) * hw;
      // nur Schaufeln: sie schneiden keine Rille, sondern kratzen und wischen den Schnee flach (keine Einzelabdrücke)
      const nose = skiTrick.id === 'butter' ? clamp((1.5 - len) / 0.9, 0, 1) : 0;
      tracks.quad(tx - wx, tz - wz, -1, tx + wx, tz + wz, 1, hx + wx, hz + wz, 1, hx - wx, hz - wz, -1, depth * (1 - 0.6 * nose), Math.max(skidG * 0.5, nose * 0.7));
      if (hasPrevSki) {
        // seitliches Rutschen zwischen zwei Bildern: Fläche zwischen altem und neuem Abdruck verwischen
        const slide = Math.hypot((hx + tx - q.hx - q.tx) / 2, (hz + tz - q.hz - q.tz) / 2), along = Math.abs(((hx + tx - q.hx - q.tx) / 2) * dx / len + ((hz + tz - q.hz - q.tz) / 2) * dz / len);
        const lat = clamp((slide - along) / 0.05, 0, 1);
        if (lat > 0.05 || nose > 0.2 || skiTrick.id === 'slash') tracks.quad(q.tx, q.tz, 0, q.hx, q.hz, 0, hx, hz, 0, tx, tz, 0, 0.2 + 0.3 * lat + 0.15 * nose + skidG * 0.3, Math.max(skidG, 0.45 + 0.4 * lat, 0.7 * nose));
      }
      q.tx = tx; q.tz = tz; q.hx = hx; q.hz = hz;
    }
  }
  for (let i = 0; i < (BOARD() || skiTrick ? 0 : 2); i++) {
    const side = i === 0 ? -1 : 1;
    const yaw = side * vis.plow * 0.33 * (Math.cos(trick.yaw + swYaw) < 0 ? -1 : 1);
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
    // Snowboard: geradeaus drückt das breite Brett den Pulver nur leicht zusammen (es gleitet obenauf); erst auf der
    // Kante schneidet es eine tiefe Rinne. Ski schneiden immer die volle Rinne.
    const bk = BOARD() ? 0.22 + 0.78 * boardEdge : 1;
    const w = (0.42 + phys.pow * 0.25) * (BOARD() ? 0.75 + 0.25 * boardEdge : 1);
    tracks.quad(p.x - r.x * w - f.x * 0.9, p.z - r.z * w - f.z * 0.9, -1, p.x + r.x * w - f.x * 0.9, p.z + r.z * w - f.z * 0.9, 1,
      p.x + r.x * w + f.x * 0.9, p.z + r.z * w + f.z * 0.9, 1, p.x - r.x * w + f.x * 0.9, p.z - r.z * w + f.z * 0.9, -1, 0.7 * Math.max(phys.off, phys.pow) * bk, 0.8 * phys.off);
  }
  hasPrevSki = true;
}

let sprayAcc = 0, powAcc = 0;
/** Tiefschnee: die Skier ziehen eine große, träge Pulverfahne hinter sich her. */
function emitPowder(dt) {
  if (!phys.grounded || phys.crashed > 0 || phys.pow < 0.12 || phys.speed < 3) return;
  const p = phys.pos, v = phys.vel, f = phys.fwd, r = phys.right, n = phys.normal;
  const carvePlume = clamp(Math.abs(phys.aLat) / 9, 0, 1.4);
  powAcc += dt * phys.pow * (10 + phys.speed * 2.4 + carvePlume * (30 + phys.speed * 5)) * (Q.ultra ? Q.fx : Math.max(0.8, Q.trees));   // Pulverfahne auch auf Niedrig kräftig
  let count = Math.min(Q.ultra ? 42 : 26, Math.floor(powAcc));
  powAcc -= count;
  if (powAcc > 40) powAcc = 0;
  while (count-- > 0) {
    const outer = phys.aLat === 0 ? 0 : -Math.sign(phys.aLat);
    const side = carvePlume > 0.3 && Math.random() < 0.75 ? outer || 1 : Math.random() < 0.5 ? -1 : 1, along = -0.2 - Math.random() * 0.9;
    const x = p.x + r.x * side * 0.3 + f.x * along, y = p.y + 0.15 + Math.random() * 0.3, z = p.z + r.z * side * 0.3 + f.z * along;
    const up = 1.4 + Math.random() * (1.5 + phys.speed * 0.12) + carvePlume * 1.6;
    spray.emit(x, y, z, v.x * (0.3 + Math.random() * 0.25) + r.x * side * (0.8 + Math.random() * 1.8 + carvePlume * 3.2) + n.x * up, v.y * 0.3 + n.y * up, v.z * (0.3 + Math.random() * 0.25) + r.z * side * (0.8 + Math.random() * 1.8 + carvePlume * 3.2) + n.z * up,
      (0.55 + Math.random() * 0.9) * (Q.ultra ? 0.85 : 1), 1.0 + Math.random() * 1.3, 1.4, 0.45 * (0.5 + phys.pow * 0.6), 2.4);
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
  sprayAcc += inten * Math.min(sp, 30) * 26 * dt * Q.fx;
  let count = Math.min(Q.ultra ? 110 : 70, Math.floor(sprayAcc));
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
      (0.16 + Math.random() * 0.3 + inten * 0.12) * (Q.ultra ? 0.8 : 1), 0.45 + Math.random() * 0.75);
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
  cloudAcc += dt * (90 + sp * 40) * Q.fx;
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
    if (e.type === 'hit') lastHit = e.what;
    else if (e.type === 'bump') {   // Lawinen-Sicht: an einen Felsen gestoßen und darüber gesprungen
      vis.shake = Math.max(vis.shake, 0.55); vis.compress = 1; audio.land(7); burst(40, 3.5);
    } else if (e.type === 'land') {
      vis.compress = Math.max(vis.compress, clamp(e.impact / 9, 0.15, 1));
      vis.shake = Math.max(vis.shake, clamp(e.impact / 30, 0, 0.5));
      vis.dip = Math.max(vis.dip, clamp((e.impact - 2) / 14, 0, 0.6));   // Kamera federt bei der Landung kurz mit
      if (game.style === 'heli' && game.mode === 'run' && aval && !aval.active && aval.cool <= 0 && e.airTime > 1.4 && phys.pow > 0.5 && phys.normal.y < 0.88 && Math.random() < 0.45) triggerAvalanche(true);
      audio.land(e.impact);
      burst(Math.min(110, 12 + e.impact * 9), 2 + e.impact * 0.35);
      if (e.impact > 8) cloud(Math.min(40, e.impact * 2), 0.8, 2.5);
      tracks.blob(phys.pos.x, phys.pos.z, 0.55 + e.impact * 0.04, 0.8, 0.7);
      if (game.mode === 'run') {
        if (e.airTime > 0.55) game.bestJump = Math.max(game.bestJump, e.dist);
        e.fwtText = fwtLand(e);
        scoreLanding(e);
      }
    } else if (e.type === 'grindStart') {
      // Rail: quer (Boardslide), Box: gerade (50-50). Seite abwechselnd, damit es lebendig aussieht
      vis.grindSide = -vis.grindSide;
      audio.land(3);
      burst(10, 1.5);
    } else if (e.type === 'grindEnd') {
      if (game.mode === 'run') {
        if (e.clean && e.dist > 1.5) {
          const rail = e.kind === 'rail';
          const name = BOARD() ? (rail ? 'Boardslide' : '50-50') : rail ? 'Railslide' : '50-50 Box';
          let pts = Math.round(((rail ? 120 : 70) + e.dist * (rail ? 34 : 22)) * trickMul());
          pts = addPending(pts, true);
          game.tricks++;
          showMsg(`${name} ${e.dist.toFixed(1).replace('.', ',')} m  +${num(pts)}`, 'gold');
          audio.gate();
        } else if (!e.clean) showMsg('Abgerutscht', 'bad');
      }
    } else if (e.type === 'crash') {
      swYaw = 0;
      vis.crashSpin = 8 + phys.speed * 0.35;
      vis.shake = 1;
      audio.crash();
      cloud(90, 1.9, 4 + phys.speed * 0.16);
      burst(170, 7 + phys.speed * 0.22);
      tV.copy(phys.vel);
      skier.detachSkis(scene, tV);
      if (game.mode === 'run') {
        let lostMsg = C.cfg.heli ? (lastHit === 'flanke' ? 'Abgestürzt! Zurück zum Gipfel' : 'Sturz! Zurück zum Gipfel') : 'Sturz!';
        lastHit = null;
        if (game.kind === 'endless' && !C.cfg.heli) {
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
      if (C.cfg.heli && game.mode === 'run') heliAgain = true;
      else if (game.cp && game.mode === 'run') teleport(game.cp.x, game.cp.z, game.cp.h);
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
  if (heliAgain) { heliAgain = false; startRun(true); }
}
let heliAgain = false, lastHit = null;

function checkGates() {
  const p = phys.pos, d = -p.z;
  while (game.gateIdx < C.gates.length && d >= C.gates[game.gateIdx].d) {
    const g = C.gates[game.gateIdx];
    if (Math.abs(p.x - g.x) < g.half + 0.25) {
      g.state = 1; game.passed++;
      audio.gate();
      showMsg(game.passed % 5 === 0 ? `${game.passed} Tore!` : 'Tor ✓', 'good');
    } else {
      g.state = -1; game.penalty += C.DISCIPLINES[disc].penalty;
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
const vAx = new THREE.Vector3(), qSp = new THREE.Quaternion(), eSp = new THREE.Euler();
const bdTmp = new THREE.Vector3(), BOARD_Y = -0.85 + 0.002 * 0.94;   // Brettmitte im Drehpunkt-System (Körper 0,85 m tiefer, Maßstab 0,94)
function updateSkier(dt) {
  const k = (r) => 1 - Math.exp(-dt * r);
  const crashed = phys.crashed > 0;
  // Lenkung sichtbar machen: der Fahrer legt sich schon mit der Lenkeingabe in die Kurve (Antizipation), im Heli-Pulver
  // deutlicher, weil die Querbeschleunigung dort klein ist und die Ski im Schnee stecken. Beim Kurvenwechsel federt er
  // kurz ein (Entlasten wie beim Tiefschneefahren).
  const heliK = C.cfg.heli ? 1 : 0, grnd = phys.grounded && !crashed;
  const antic = grnd ? inp.steer * (0.18 + 0.3 * heliK) * clamp(phys.speed / 8, 0, 1) : 0;
  const leanT = clamp(Math.atan(phys.aLat / G) * 0.9 + antic, -0.92, 0.92);
  vis.lean += (leanT - vis.lean) * k(9);
  const sgn = Math.abs(inp.steer) > 0.3 ? Math.sign(inp.steer) : 0;
  if (grnd && sgn && vis.lastSteer && sgn !== vis.lastSteer && phys.speed > 5) vis.compress = Math.max(vis.compress, 0.35 + 0.3 * heliK);
  if (sgn) vis.lastSteer = sgn;
  const crouchT = phys.grind ? 0.45 : clamp(inp.tuck + inp.brake * 0.2 + 0.14 * clamp(phys.speed / 18, 0, 1), 0, 1);
  vis.crouch += (crouchT - vis.crouch) * k(7);
  vis.compress *= Math.exp(-dt * 4.5);
  vis.shake *= Math.exp(-dt * 3.2);
  vis.crashCam += ((crashed ? 1 : 0) - vis.crashCam) * k(3);
  // Pizzastück (Pflug) nur am Boden: in der Luft ist S der Backflip, auf der Rail gibt es keinen Pflug. Nach der Landung
  // mit gehaltenem S kommt es wieder.
  const plowOn = phys.grounded && !phys.grind && phys.crashed <= 0;
  vis.plow += ((plowOn ? inp.brake * (1 - Math.abs(inp.steer)) * clamp(phys.speed / 2, 0, 1) : 0) - vis.plow) * k(plowOn ? 8 : 16);
  vis.air += ((phys.grounded ? 0 : 1) - vis.air) * k(phys.grounded ? 14 : 6);
  boardEdge += (clamp(Math.abs(vis.lean) * 2.4 + vis.plow * 1.2 + phys.skid * 0.15, 0, 1) - boardEdge) * k(6);

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
  if (BOARD()) {
    // Snowboard im Pulver: geradeaus gleitet das breite Brett obenauf (Auftrieb), in der Kurve und beim Bremsen
    // gräbt sich die Kante ein. boardEdge: 0 = flach, 1 = voll auf der Kante
    // Die Höhe folgt genau der Pulverschicht, wie sie die Spur (stampTracks) übrig lässt: gleiche Schichtdicke wie
    // powder.js (0,3 m, im Mittel 93 % durch die Wellung) und gleiche Rinnentiefe wie im Schnee-Shader.
    const pp = phys.pos, wob = 0.85 + 0.15 * Math.sin(pp.x * 0.9 + pp.z * 0.7);
    const pk = clamp((phys.pow - 0.18) / 0.4, 0, 1), layer = 0.3 * wob * pk * pk * (3 - 2 * pk);
    const trD = 0.7 * phys.pow * (0.22 + 0.78 * boardEdge), keep = 1 - smoothstep(0.08, 0.5, trD);
    // + 2,7 cm: Schicht liegt 1,2 cm über dem Gelände, dazu ein Teil der Brett-Einsinktiefe (BOARD_Y) – der Belag liegt
    // dann gut 1 cm im Pulver, die Oberseite bleibt sichtbar
    boardLift += ((phys.grounded && Q.patch > 0 && pk > 0 ? layer * keep + 0.027 * pk : 0) - boardLift) * k(14);
    if (Q.patch > 0) skier.root.position.y += boardLift;
    else skier.root.position.y -= phys.sink * 0.8 * (0.2 + 0.8 * boardEdge);
  } else skier.root.position.y -= phys.sink * (Q.patch > 0 ? 0.12 : 0.8);

  const pv = skier.pivot;
  if (crashed) {
    // Überschlagen: schnelle Rotation um mehrere Achsen, Körper hüpft und schlägt immer wieder auf
    const sp = clamp(phys.speed / 10, 0, 1);
    vis.crashAngle += vis.crashSpin * dt * (0.25 + 0.75 * sp);
    pv.rotation.set(-vis.crashAngle, vis.crashAngle * 0.37, Math.sin(vis.crashAngle * 0.6) * 1.1);
    pv.position.y = 0.42 + Math.abs(Math.sin(vis.crashAngle * 0.5)) * (0.1 + 0.42 * sp);
    if (Math.abs(Math.sin(vis.crashAngle * 0.5)) < 0.12 && sp > 0.2) vis.shake = Math.max(vis.shake, 0.45 * sp);
  } else {
    const railSlide = phys.grind && phys.grind.g.kind === 'rail' ? 1 : 0;
    vis.slide += (railSlide * vis.grindSide - vis.slide) * k(14);
    // auf der Rail: Körper quer zur Rail, leichte Neigung (A/D) sichtbar
    const balTilt = phys.grind ? -phys.grind.bal * 0.35 : 0;
    const bs = Math.cos(trick.yaw + swYaw) < 0 ? -1 : 1;
    // Snowboard: das Brett geht stärker auf die Kante als der Körper. Der Körper neigt sich nur halb so weit in die Kurve,
    // den Rest fangen Knie und Hüfte ab (Angulation, wie bei echten Fahrern); Bremsen = Brett quer stellen.
    const bEdge = BOARD() ? -vis.lean * 0.85 * bs : 0, bLean = bEdge * 0.55, bSkid = BOARD() ? vis.plow * 1.05 : 0;
    vis.bEdgeExtra = bEdge - bLean;
    pv.rotation.set(trick.pitch, -(trick.yaw + swYaw) + vis.slide * 1.45 + bSkid, vis.spin * 0.18 + balTilt + bLean + (vis.specRoll || 0));
    vis.look += ((BOARD() ? (phys.grind ? 0 : 0.72 * bs) : isSwitch() && !phys.grind ? 1 : 0) - vis.look) * k(6);
    pv.position.set(0, 0.85, 0);
    if (BOARD()) {
      // Das Brett kippt um seine Kante im Schnee, nicht um die Hüfte: Drehpunkt so verschieben, dass die Brettmitte
      // auf halber Brettbreite über dem Schnee bleibt (sonst hebt es in Schräglage seitlich ab und schwebt)
      const roll = bEdge, g = 1 - vis.air;   // die Kante im Schnee bestimmt die Höhe: halbe Brettbreite mal Kantenwinkel
      bdTmp.set(0, BOARD_Y, 0).applyQuaternion(pv.quaternion.setFromEuler(pv.rotation));
      // im Pulver gut 2 cm eingesunken (liegt sichtbar im Schnee), auf präpariertem Schnee obenauf
      const pkB = clamp((phys.pow - 0.18) / 0.4, 0, 1);
      const ty = -0.002 - 0.026 * pkB + 0.135 * Math.abs(Math.sin(roll));
      pv.position.set(-bdTmp.x * g, 0.85 + (ty - bdTmp.y - 0.85) * g, -bdTmp.z * g);
    }
  }
  // Spezialtrick mit schräger Achse (v37): Ausrichtung = Grundstellung (Blickrichtung, Rest-Drehung beim Einsatz) mal
  // Drehung um die Achse. Am Ende steht die Achse senkrecht, die Euler-Stellung übernimmt nahtlos.
  if (special && special.def.axis && !crashed) {
    const sp = special, u = Math.min(1, sp.t / sp.T), fade = 1 - smoothstep(0, 0.25, u), a = sp.def.axis(u);
    vAx.set(a[0], a[1], a[2]).normalize();
    pv.quaternion.setFromEuler(eSp.set(sp.p0 + sp.pIn * fade, -(sp.y0 + sp.yIn * fade + swYaw), 0, 'YXZ'));
    pv.quaternion.multiply(qSp.setFromAxisAngle(vAx, -sp.def.ang(u)));
  }
  // Ski-Trick am Boden (Taste E): bricht bei Sturz, Absprung oder Rail ab
  if (skiTrick && (crashed || BOARD() || phys.grind || !phys.grounded || game.mode !== 'run')) endSkiTrick(false);
  const stp = skiTrick ? skiTrickPose(dt, pv) : null;
  // Rückwärts (Switch) ist der Körper um 180° gedreht: Neigung und Lenkdrehung müssen im Körper gespiegelt werden,
  // sonst lehnt er sich aus der Kurve heraus statt hinein.
  const bodySign = Math.cos(trick.yaw + swYaw);
  skier.update({
    lean: BOARD() ? 0 : stp && stp.lean !== null ? lerp(vis.lean * bodySign, stp.lean, stp.leanW) : vis.lean * bodySign, crouch: BOARD() ? Math.min(1, vis.crouch + 0.32 * Math.abs(vis.lean)) : Math.min(1, vis.crouch + (stp ? stp.crouch : 0)), edge: BOARD() && !crashed ? vis.bEdgeExtra || 0 : 0, steer: phys.grounded && !BOARD() ? inp.steer * bodySign * (1 + 0.9 * (C.cfg.heli ? 1 : 0)) : 0, plow: BOARD() ? 0 : vis.plow, plowDir: bodySign < 0 ? -1 : 1, air: vis.air, compress: vis.compress,
    butter: stp ? stp.butter : 0, butterTh: stp ? stp.butterTh : undefined, twist: stp ? stp.twist : 0, bob: stp ? stp.bob : 0,
    speed: phys.speed, grab: trick.grab, grabSide: trick.gs, sup: BOARD() ? 0 : vis.sup || 0, cross: BOARD() ? 0 : vis.cross || 0, daffy: BOARD() ? 0 : vis.daffy || 0, tweak: BOARD() ? 0 : vis.tweak || 0, look: vis.look, tuck: vis.tuck, spin: vis.spin, extend: vis.extend, crash: crashed ? 1 : 0, crashA: vis.crashAngle,
  }, dt);
  skier.updateLoose(dt, C.height);
  if (blob) {
    // Kontaktschatten: ohne Echtzeit-Schatten immer, mit Schatten beim Snowboard (klebt das Brett optisch an den Schnee)
    blob.visible = (!renderer.shadowMap.enabled || BOARD()) && phys.crashed <= 0;
    if (blob.visible) {
      const gy = C.height(phys.pos.x, phys.pos.z), hgt = Math.max(0, phys.pos.y - gy);
      blob.position.set(phys.pos.x, gy + 0.04, phys.pos.z);
      blob.quaternion.setFromUnitVectors(tV.set(0, 0, 1), phys.normal);
      blob.rotateZ(-phys.heading);
      const k = 1 / (1 + hgt * 0.25);
      if (BOARD() && renderer.shadowMap.enabled) { blob.scale.set(0.62 + 0.5 * (1 - k), 0.34 + 0.3 * (1 - k), 1); blob.material.opacity = k * 0.8; blob.rotateZ(-vis.plow * 1.05); }
      else { blob.scale.setScalar(0.8 + 0.6 * (1 - k)); blob.material.opacity = k; }
    }
  }
}

// ---------------------------------------------------------------- Minikarte & Zonen
const ZONE_NAMES = { start: 'Start', cruise: 'Panorama-Piste', glade: 'Waldbahn', bowl: 'Pulverhang', park: 'Ski-Cross-Park', bigair: 'Big Air', couloir: 'Rinne', cliff: 'Klippenband', flat: 'Auslauf', summit: 'Gipfel', glacier: 'Gletscher', face: 'Pulverflanke', rockgarden: 'Felsgarten', jumpline: 'Sprunglinie', megaair: 'Mega Air', slopestyle: 'Slopestyle' };
let lastZone = -1, zoneTimer = 0;
function updateZone(dt) {
  if (game.kind !== 'endless' || game.mode !== 'run' || C.cfg.heli) return;   // Heli-Berg: keine Einblendungen, man liest den Berg selbst
  const z = C.zoneAt(-phys.pos.z);
  if (z && z.idx !== lastZone) {
    lastZone = z.idx;
    const el = $('zone');
    el.innerHTML = (ZONE_NAMES[z.type] || z.type) + (z.label ? `<small>${z.label}</small>` : '');
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
  const on = game.kind === 'endless' && !C.cfg.heli && (game.mode === 'run' || game.mode === 'countdown');
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
      mm.strokeStyle = C.cfg.style === 'heli' ? 'rgba(255,255,255,0.45)' : k === 3 ? '#ff8a2e' : k === 1 ? '#ffd84a' : rows[i].slope < 0.27 ? '#58a7ff' : rows[i].slope < 0.37 ? '#ff5b4d' : '#2b2f3a';   // Heli: nur Linien, keine Pisten
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
  if (C.cfg.heli) {
    $('time').textContent = fmt(game.time);
    $('best').textContent = (fwt.flow >= 1 ? `Flow ×${flowMult().toFixed(2).replace(/0$/, '').replace('.', ',')} · ` : '') + (game.bestHeli ? `Bestzeit ${fmt(game.bestHeli)}` : 'Bestzeit –');
    $('gates').innerHTML = `${num(Math.max(0, phys.pos.y - C.baseH(C.FINISH_D)))}<span> m</span>`;
    $('penalty').textContent = '';
  } else if (game.kind === 'endless') {
    $('time').innerHTML = num(totalScore()) + (game.pend > 0 ? `<span class="pend"> +${num(game.pend)}</span>` : '');
    $('best').textContent = `${num(game.maxD)} m${game.combo > 1 ? ` · ×${game.combo.toFixed(1).replace('.0', '')}` : ''} · Rekord ${num(Math.max(game.bestEndless, totalScore()))} P / ${num(Math.max(game.bestDist, game.maxD))} m`;
    const cpH = game.cp ? 'gesetzt' : 'offen';
    if ($('gates').dataset.cp !== cpH) { $('gates').dataset.cp = cpH; $('gates').innerHTML = `<span class="lives${game.cp ? ' on' : ''}">${game.cp ? 'Gesetzt' : 'Offen'}</span>`; }
    const pen = isTouch ? (game.cp ? 'Fahne tippen: zurück, halten: neu' : 'Fahne halten: Punkt setzen') : game.cp ? '<kbd>T</kbd>zurück<kbd>F</kbd>neu' : '<kbd>F</kbd>Punkt setzen';
    if ($('penalty').dataset.h !== pen) { $('penalty').dataset.h = pen; $('penalty').innerHTML = pen; }
  } else {
    $('time').textContent = fmt(game.time + game.penalty);
    $('gates').innerHTML = `${game.passed}<span>/${C.gates.length}</span>`;
    const pr = clamp((-phys.pos.z - C.START_D) / (C.FINISH_D - C.START_D), 0, 1) * 100;
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
  // Zeitlupe während eines Spezialtricks (weich ein- und ausblenden)
  const tsT = special && game.mode === 'run' ? special.def.slow : 1;
  timeScale += (tsT - timeScale) * (1 - Math.exp(-dt * (tsT < timeScale ? 9 : 5)));
  if (Math.abs(timeScale - 1) < 0.003) timeScale = 1;
  dt *= timeScale;
  time += dt;

  const airNow = game.mode === 'run' && !phys.grounded && phys.crashed <= 0;
  updateTouch(airNow, dt);
  if (touchCtl) { touchCtl.setRunning(game.mode === 'run' || game.mode === 'countdown'); touchCtl.setCheckpoints(!C.cfg.heli); touchCtl.setAir(airNow && !special); touchCtl.setSkiTrick(!airNow && skiTrickReady()); }
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
        $('count').innerHTML = heli.on ? '<span>SPRING!</span>' : '<span>LOS!</span>';
        audio.beep(true);
        game.mode = 'run';
        if (heli.on) { heli.t = 0; phys.vel.set(0, 1.2, 0).addScaledVector(phys.fwd, 3); phys.grounded = false; phys.airStart.copy(phys.pos); }
        else phys.vel.copy(phys.fwd).multiplyScalar(4.5);
        setTimeout(() => { $('count').innerHTML = ''; }, 900);
      }
    }
  }

  if (game.mode === 'menu' && demo.on) demoUpdate(dt);
  const rewinding = game.mode !== 'loading' && rewindStep(dt);
  if (game.mode !== 'loading') {
    if (!rewinding) acc += dt;
    while (!rewinding && acc >= H) {
      inp.jump = jumpQueued && game.mode === 'run';
      jumpQueued = false;
      if (heli.on && (game.mode === 'countdown' || game.mode === 'menu')) { /* hängt in der Heli-Tür */ }
      else if (game.mode === 'menu' && demo.on) phys.step(H, demo.inp);
      else if (game.mode === 'menu' || game.mode === 'countdown') { phys.vel.set(0, 0, 0); phys.step(H, zeroInp); phys.vel.set(0, 0, 0); }
      else phys.step(H, stepInp);
      if (game.mode === 'run') { game.time += H; game.topSpeed = Math.max(game.topSpeed, phys.speed); }
      acc -= H;
    }
    if (!rewinding) recordRewind(dt);
    if (game.mode === 'run') game.maxD = Math.max(game.maxD, -phys.pos.z);
    handleEvents();
    fwtUpdate(dt);
    if (!rewinding) {
      updatePoints(dt);
      updateTricks(dt);
      if (game.mode === 'run' && game.kind === 'race') checkGates();
    }
    if (game.mode === 'run' && C.cfg.heli && C.HB.finished(phys.pos.x, -phys.pos.z)) finishRun();
    if (game.mode === 'finished' && game.finishT > 1.6) { $('finish').classList.remove('hidden'); $('hud').classList.add('hidden'); }

    updateSkier(dt);
    heliUpdate(dt);
    avalancheUpdate(dt);
    updateCamera(dt, time);
    if (!rewinding) { stampTracks(); emitSpray(dt); emitCrash(dt); }
    rew.fx += ((rew.on ? 1 : 0) - rew.fx) * (1 - Math.exp(-dt * 10));
    grade.uniforms.uRew.value = rew.fx < 0.003 ? 0 : rew.fx;
    rewindHud();
    tutUpdate(dt);
    spray.setFocus(tV.set(phys.pos.x, phys.pos.y + 0.9, phys.pos.z));
    spray.update(dt);
    if (Q.dust) dust.update(time, camera);
    world.update(dt, time, camera.position, phys.pos, game.kind === 'race' && (game.mode === 'run' || game.mode === 'countdown') ? C.gates[game.gateIdx] : null);
    // auf der Rail: metallisches Kratzen über das Rutsch-Geräusch
    audio.update(phys.speed, phys.grind ? 2.5 + phys.speed * 0.12 : phys.skid + inp.brake * phys.speed * 0.15, clamp(Math.abs(phys.aLat) / 14, 0, 1), phys.grounded || !!phys.grind, phys.grind ? 0 : phys.off, phys.grind ? 0 : phys.pow);
    updateHud(dt);
    updateZone(dt);
    drawMinimap(dt);
    patch.update(phys.pos.x, phys.pos.z, C.cfg.endless && Q.patch > 0 && phys.pow > 0.18 && game.mode !== 'menu');
    tracks.update(phys.pos.x, phys.pos.z);
  }
  if (render) { if (shop3d && shop3d.isOpen) shop3d.render(dt); else { if (Q.ultra) ultraUniforms(); composer.render(); } }
}
/** Ultra: Umkreis der Umgebungsverdeckung, Kamera-Matrizen für die Bewegungsunschärfe, Fokus der Trick-Kameras. */
function ultraUniforms() {
  camera.updateMatrixWorld();
  const c = camera.position;
  aoBox.min.set(c.x - 70, c.y - 70, c.z - 70); aoBox.max.set(c.x + 70, c.y + 70, c.z + 70);
  gtao.setSceneClipBox(aoBox);
  const u = ufx.uniforms;
  u.uInvProj.value.copy(camera.projectionMatrixInverse);
  u.uCamWorld.value.copy(camera.matrixWorld);
  curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  // Schnitt (Moduswechsel, Respawn, Trick-Kamera springt): kein Verwischen über den Sprung hinweg
  const cut = c.distanceTo(prevCamPos) > 6 || Math.abs(camera.fov - prevFov) > 4;
  u.uPrevVP.value.copy(cut ? curVP : prevVP);
  prevVP.copy(curVP); prevCamPos.copy(c); prevFov = camera.fov;
  const run = game.mode === 'run' || game.mode === 'finished';
  u.uMB.value = run ? 0.55 * smoothstep(8, 30, phys.speed) * (1 - specCam.w) : 0;
  u.uDof.value = run ? specCam.w * 1.1 : 0;
  u.uFocus.value = c.distanceTo(tV.set(phys.pos.x, phys.pos.y + 0.9, phys.pos.z));
  u.uSkier.value.set(phys.pos.x, phys.pos.y + 0.55, phys.pos.z);
  u.uRes.value.set(renderer.domElement.width, renderer.domElement.height);
  // Sonne auf dem Schirm: Strahlen nur, wenn sie vor der Kamera und nicht weit außerhalb des Bildes steht
  tV.copy(SUN_DIR).multiplyScalar(1000).add(c).project(camera);
  const inFront = tV.z < 1 && camera.getWorldDirection(tV2).dot(SUN_DIR) > 0.05;
  const off = Math.max(0, Math.max(Math.abs(tV.x), Math.abs(tV.y)) - 1);
  u.uSunUV.value.set(tV.x * 0.5 + 0.5, tV.y * 0.5 + 0.5, inFront ? 0.55 * Math.exp(-off * 2.6) : 0);
}

// ---------------------------------------------------------------- Start
(async () => {
  setTier(qualSetting === 'auto' ? (!isTouch && localStorage.getItem(AUTO_KEY)) || 'high' : qualSetting);
  resize();
  buildMenuControls();
  setupDonate();
  const models = await loadModels();
  world = new World(scene, models);
  skier = new Skier(models);
  scene.add(skier.root);
  // Spiegelung nur für Metallteile (Gold-Ski, Krone, Medaille): eine kleine vorberechnete Umgebung
  let envTex;
  { const pm = new THREE.PMREMGenerator(renderer); envTex = pm.fromScene(new RoomEnvironment(), 0.04).texture; skier.setEnv(envTex); pm.dispose(); }
  shop3d = new Shop3D(renderer, models, envTex, {
    onEquip: () => { applyEquip(); applyOutfitUI(); updateWallet(); },
    setGear, getGear: () => gear, customColors: () => outfit, isRot: () => view.rot,
    onClose: () => { $('shopBtn').focus(); },
  });
  skier.setGear(gear);
  // Ohne Echtzeit-Schatten (niedrige Stufe): weicher Kontaktschatten unter dem Fahrer, damit man Höhe und Landung abschätzen kann
  {
    const c = document.createElement('canvas'); c.width = c.height = 64;
    const x = c.getContext('2d'), gr = x.createRadialGradient(32, 32, 2, 32, 32, 31);
    gr.addColorStop(0, 'rgba(20,30,50,0.55)'); gr.addColorStop(1, 'rgba(20,30,50,0)');
    x.fillStyle = gr; x.fillRect(0, 0, 64, 64);
    blob = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.4), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false, fog: false }));
    blob.rotation.order = 'YXZ';
    blob.renderOrder = 5;
    scene.add(blob);
  }
  tracks = new SnowTracks(renderer);
  patch = new PowderPatch(scene);
  spray = new Spray(scene);
  aval = new Avalanche(scene);
  dust = new DiamondDust(scene);
  applyQuality();
  $('ver').textContent = 'v' + __GAME_VERSION__;   // zeigt, welche Fassung der Browser gerade lädt
  await selectMode(modeIdx, true);
  applyOutfitUI();
  applyEquip();
  tracks.update(phys.pos.x, phys.pos.z);
  $('loading').classList.add('hidden');
  game.mode = 'menu';
  window.addEventListener('beforeunload', saveEndlessBest);
  window.__game = {
    game, phys, inp, keys, airKey, trick, world, skier, camera, renderer, scene, vis, Q, startRun, setKind, toMenu, setCheckpoint, toCheckpoint, chooseQuality, C,
    avalanche: () => triggerAvalanche(), aval: () => aval,
    tp: (d, lane = 0, speed = 0) => { const L = C.cfg.heli ? { x: C.centerX(d) + lane } : C.mapSlice(d, d + 1, 1).rows[0].lanes[lane]; teleport(L.x, -d); const x0 = C.centerX(d + 6) - C.centerX(d); phys.heading = Math.atan2(x0, 6); phys.vel.set(Math.sin(phys.heading) * speed, 0, -Math.cos(phys.heading) * speed); if (game.mode === 'menu') { game.mode = 'run'; } },
    // Testhilfe: freie Kamera für Standbilder (Position, Blickpunkt), rendert genau ein Bild
    shot: (px, py, pz, lx, ly, lz, fov = 55) => { camera.position.set(px, py, pz); camera.fov = fov; camera.near = 0.3; camera.updateProjectionMatrix(); camera.lookAt(lx, ly, lz); world.sky.position.copy(camera.position); if (Q.ultra) ultraUniforms(); composer.render(); },
    ultraUniforms, gtao, ufx, HG, skiTrick: () => skiTrick, startSkiTrick, watchPerformance, renderScale: () => renderScale, qualSetting: () => qualSetting, restartHeli: () => startRun(true), setGear, setupDonate, shop3d: () => shop3d, SPECIALS, startSpecial, special: () => special, airLeft, timeScale: () => timeScale, specCam, edge: () => boardEdge, finishRun, fwt, fwtScore, applyDropPref, renderMode, heliStart, flowUp, shop, applyEquip,
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
