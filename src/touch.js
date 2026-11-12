// Handy-Steuerung: Lenken durch Neigen (wie ein Lenkrad, Handy quer) oder durch Ziehen mit dem Daumen,
// Knöpfe für Sprung/Grab, Hocke und Bremse. In der Luft: Neigen = Spin, Wischen hoch/runter = Flip.
// Knöpfe lösen dieselben Tastatur-Ereignisse aus wie am PC, so bleibt die Spiellogik an einer Stelle.

export const isTouch = (typeof window !== 'undefined') && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);

export const touch = {
  steer: null,          // analoger Lenkwert -1..1 (null = keine Touch-/Neigungslenkung aktiv)
  tilt: false,          // Neigungssteuerung an
  tiltOk: false,        // Sensor liefert Werte
};

const key = (code, down) => window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, bubbles: true }));

let neutral = 0, rawTilt = 0, filtTilt = 0, haveTilt = false, dragSteer = null, airSpin = 0;
const TILT_RANGE = 26;   // Grad bis voller Lenkeinschlag
const DEAD = 2;          // Totzone in Grad

// ---- Querformat: Ist das Handy hochkant (z. B. mit Rotationssperre), wird das ganze Spiel per CSS gedreht.
export const view = { rot: false };
function screenAngle() {
  if (view.rot) return 90;   // gedrehte Darstellung entspricht physisch dem Querformat (Oberkante links)
  return (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
}
/** Größe der Spielfläche (bei gedrehter Darstellung vertauscht). */
export function viewSize() {
  return view.rot ? { w: window.innerHeight, h: window.innerWidth } : { w: window.innerWidth, h: window.innerHeight };
}

// Lenkwinkel wie ein Lenkrad: Richtung „oben“ (Schwerkraft) in der Bildschirmebene, aus beta/gamma berechnet.
// Unabhängig davon, wie weit man das Handy nach hinten kippt (anders als beta allein).
function tiltAngle(e) {
  const D = Math.PI / 180, b = (e.beta || 0) * D, g = (e.gamma || 0) * D;
  const ux = -Math.sin(g) * Math.cos(b), uy = Math.sin(b);           // „oben“ in Gerätekoordinaten (x, y)
  const a = screenAngle();
  let sx, sy;
  if (a === 90) { sx = -uy; sy = ux; }
  else if (a === -90 || a === 270) { sx = uy; sy = -ux; }
  else { sx = ux; sy = uy; }
  if (Math.hypot(sx, sy) < 0.15) return rawTilt;                       // Handy liegt flach: Wert halten
  return -Math.atan2(sx, sy) / D;                                       // + = rechts
}

function onOrient(e) {
  if (e.beta == null && e.gamma == null) return;
  rawTilt = tiltAngle(e);
  if (!haveTilt) { haveTilt = true; neutral = rawTilt; filtTilt = rawTilt; }
  touch.tiltOk = true;
}

/** Neigung freischalten (iOS fragt hier um Erlaubnis; muss aus einem Tipp heraus aufgerufen werden). */
export async function enableTilt() {
  try {
    const D = window.DeviceOrientationEvent;
    if (D && typeof D.requestPermission === 'function') {
      const r = await D.requestPermission();
      if (r !== 'granted') { touch.tilt = false; return false; }
    }
    window.addEventListener('deviceorientation', onOrient);
    touch.tilt = true;
    return true;
  } catch { touch.tilt = false; return false; }
}
/** Aktuelle Haltung als „geradeaus“ übernehmen. */
export function calibrate() { neutral = rawTilt; filtTilt = rawTilt; }

/** Pro Bild aufrufen: berechnet den Lenkwert und die Spin-Tasten in der Luft. */
export function updateTouch(inAir, dt = 1 / 60) {
  let s = null;
  if (touch.tilt && touch.tiltOk) {
    let d0 = rawTilt - filtTilt;
    if (d0 > 180) d0 -= 360; else if (d0 < -180) d0 += 360;
    filtTilt += d0 * (1 - Math.exp(-dt * 16));                          // Sensorrauschen glätten, ohne träge zu werden
    let d = filtTilt - neutral;
    if (d > 180) d -= 360; else if (d < -180) d += 360;
    const m = Math.max(0, Math.abs(d) - DEAD) / (TILT_RANGE - DEAD);
    s = Math.sign(d) * Math.min(1, m * (0.55 + 0.45 * m));              // fein in der Mitte, kräftig am Rand
  }
  if (dragSteer !== null) s = dragSteer;                                 // Daumen hat Vorrang
  touch.steer = s;
  // In der Luft: deutliches Neigen/Ziehen dreht (Spin) – wie A/D am PC
  const want = inAir && s !== null ? (s > 0.5 ? 1 : s < -0.5 ? -1 : (Math.abs(s) < 0.3 ? 0 : airSpin)) : 0;
  if (want !== airSpin) {
    if (airSpin === 1) key('KeyD', false); else if (airSpin === -1) key('KeyA', false);
    if (want === 1) key('KeyD', true); else if (want === -1) key('KeyA', true);
    airSpin = want;
  }
}

/** Beim Start: Vollbild und Querformat sperren (Android); sonst dreht die CSS-Darstellung. */
export async function goLandscape() {
  try {
    const el = document.documentElement;
    if (!document.fullscreenElement && el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch { /* iPhone: kein Vollbild/keine Sperre – die gedrehte Darstellung übernimmt */ }
}

export function setupTouch({ isAir, isRunning, onResize }) {
  if (!isTouch) return;
  document.body.classList.add('touch');
  // Alles in einen Container, der bei hochkant gehaltenem Handy um 90° gedreht wird
  const app = document.createElement('div');
  app.id = 'app';
  while (document.body.firstChild) app.appendChild(document.body.firstChild);
  document.body.appendChild(app);
  const applyRot = () => {
    const portrait = window.innerHeight > window.innerWidth;
    view.rot = portrait;
    document.documentElement.classList.toggle('rot', portrait);
    if (portrait) {
      app.style.width = window.innerHeight + 'px';
      app.style.height = window.innerWidth + 'px';
      app.style.transform = `translateX(${window.innerWidth}px) rotate(90deg)`;
    } else { app.style.width = ''; app.style.height = ''; app.style.transform = ''; }
    if (onResize) onResize();
    calibrate();
  };
  window.addEventListener('resize', applyRot);
  window.addEventListener('orientationchange', () => setTimeout(applyRot, 150));
  const ui = document.createElement('div');
  ui.id = 'touchUI';
  ui.innerHTML = `
    <div class="tz" id="tzDrag"></div>
    <div class="tb right">
      <button class="tbtn big" id="tJump" aria-label="Springen, in der Luft Grab">SPRUNG<small>halten = Grab</small></button>
      <button class="tbtn" id="tTuck" aria-label="Hocke">HOCKE</button>
    </div>
    <div class="tb left">
      <button class="tbtn" id="tBrake" aria-label="Bremsen">BREMSE</button>
    </div>
    <div class="tb top">
      <button class="tsm" id="tCp" aria-label="Respawn-Punkt setzen">⚑ Punkt</button>
      <button class="tsm" id="tBack" aria-label="Zurück zum Respawn-Punkt oder auf die Piste">↺ Zurück</button>
      <button class="tsm" id="tTilt" aria-label="Neigungssteuerung an oder aus">Neigen</button>
      <button class="tsm" id="tMenu" aria-label="Menü">☰</button>
    </div>
    <div id="tHelp">Handy neigen = lenken · Wischen ↑↓ in der Luft = Flip · neigen in der Luft = Spin</div>`;
  app.appendChild(ui);
  applyRot();
  const $ = (id) => ui.querySelector('#' + id);

  // Halten-Knöpfe: Pointer-Ereignisse, mehrere Finger gleichzeitig möglich
  const hold = (el, code) => {
    const up = (e) => { e.preventDefault(); el.classList.remove('on'); key(code, false); };
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch {} el.classList.add('on'); key(code, true); });
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  };
  hold($('tJump'), 'Space');
  hold($('tTuck'), 'KeyW');
  hold($('tBrake'), 'KeyS');
  const tap = (el, code) => el.addEventListener('click', (e) => { e.preventDefault(); key(code, true); key(code, false); });
  tap($('tCp'), 'KeyF'); tap($('tBack'), 'KeyT'); tap($('tMenu'), 'Escape');
  const tiltBtn = $('tTilt');
  const showTilt = () => tiltBtn.classList.toggle('on', touch.tilt);
  tiltBtn.addEventListener('click', async () => {
    if (touch.tilt) { touch.tilt = false; window.removeEventListener('deviceorientation', onOrient); }
    else { await enableTilt(); calibrate(); }
    try { localStorage.setItem('gs_tilt', touch.tilt ? '1' : '0'); } catch {}
    showTilt();
  });

  // Fläche: Daumen ziehen = lenken (wenn Neigen aus ist oder zusätzlich), in der Luft wischen = Flip
  const dz = $('tzDrag');
  let sx = 0, sy = 0, pid = null, flip = null;
  // Bildschirm- in Spielkoordinaten (gedreht: rechts im Spiel = unten auf dem Bildschirm)
  const pt = (e) => (view.rot ? [e.clientY, window.innerWidth - e.clientX] : [e.clientX, e.clientY]);
  dz.addEventListener('pointerdown', (e) => { pid = e.pointerId; [sx, sy] = pt(e); try { dz.setPointerCapture(pid); } catch {} });
  dz.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const [px, py] = pt(e);
    const dx = px - sx, dy = py - sy;
    if (isAir() && Math.abs(dy) > 36 && Math.abs(dy) > Math.abs(dx) && !flip) {
      flip = dy < 0 ? 'KeyS' : 'KeyW';     // hoch = Backflip, runter = Frontflip
      key(flip, true);
    } else if (!isAir()) {   // Daumen-Lenkung geht immer, auch wenn Neigen an ist (Ziehen hat Vorrang)
      dragSteer = Math.max(-1, Math.min(1, dx / 70));
    }
  });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null; dragSteer = null;
    if (flip) { key(flip, false); flip = null; }
  };
  dz.addEventListener('pointerup', end); dz.addEventListener('pointercancel', end);

  // Neigen ist Standard, sobald erlaubt (gemerkte Wahl)
  let want = true;
  try { want = localStorage.getItem('gs_tilt') !== '0'; } catch {}
  touch.wantTilt = want;
  showTilt();
  return {
    /** Beim Start aus dem Tipp heraus: Neigung erlauben lassen und Nulllage setzen. */
    async onStart() {
      goLandscape();
      if (touch.wantTilt && !touch.tilt) await enableTilt();
      calibrate();
      showTilt();
      ui.classList.toggle('noTilt', !touch.tilt);
    },
    setRunning(r) { ui.classList.toggle('active', r); },
    isRunning,
  };
}
