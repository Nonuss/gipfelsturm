// Handy-Steuerung: Lenken durch Neigen (wie ein Lenkrad, Handy quer) oder durch Ziehen mit dem Daumen,
// Knöpfe für Sprung/Grab, Hocke und Bremse. In der Luft: Neigen = Spin, Wischen hoch/runter = Flip.
// Knöpfe lösen dieselben Tastatur-Ereignisse aus wie am PC, so bleibt die Spiellogik an einer Stelle.

export const isTouch = (typeof window !== 'undefined') && (window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);

export const touch = {
  steer: null,          // analoger Lenkwert -1..1 (null = keine Touch-/Neigungslenkung aktiv)
  tilt: false,          // Neigungssteuerung an
  tiltOk: false,        // Sensor liefert Werte
  mode: 'tilt',         // 'tilt' Neigen, 'thumb' Daumen ziehen, 'stick' Joystick (v35)
  stick: { on: false, x: 0, y: 0 },   // Joystick: x -1..1 (rechts +), y -1..1 (unten +)
};
let stickKeys = { w: false, s: false };

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
  if (!haveTilt) { haveTilt = true; filtTilt = rawTilt; }
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
// Geradeaus ist immer „Handy waagrecht wie ein Lenkrad“ (Winkel zur Schwerkraft in der Bildschirmebene). Früher wurde
// die aktuelle Haltung übernommen, z. B. nach einem Sturz oder wenn die Adressleiste die Fenstergröße ändert – dann
// galt eine schiefe Haltung als geradeaus. Deshalb gibt es keine automatische Nulllage mehr.
export function calibrate() { neutral = 0; filtTilt = rawTilt; }

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
  // Joystick: seitlich = lenken (in der Luft drehen), unten = Hocke (Luft: Frontflip), oben = bremsen (Luft: Backflip)
  if (touch.mode === 'stick') {
    const st = touch.stick, dz = (v) => (Math.abs(v) < 0.12 ? 0 : Math.sign(v) * (Math.abs(v) - 0.12) / 0.88);
    s = st.on ? dz(st.x) : 0;
    const wantW = st.on && st.y > (stickKeys.w ? 0.28 : 0.4), wantS = st.on && st.y < (stickKeys.s ? -0.35 : -0.5);
    if (wantW !== stickKeys.w) { key('KeyW', wantW); stickKeys.w = wantW; }
    if (wantS !== stickKeys.s) { key('KeyS', wantS); stickKeys.s = wantS; }
  } else if (stickKeys.w || stickKeys.s) { if (stickKeys.w) key('KeyW', false); if (stickKeys.s) key('KeyS', false); stickKeys = { w: false, s: false }; }
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
  };
  window.addEventListener('resize', applyRot);
  window.addEventListener('orientationchange', () => setTimeout(applyRot, 150));
  const ui = document.createElement('div');
  ui.id = 'touchUI';
  // Wenige Knöpfe mit eigenen Symbolen: rechts Sprung (halten = Grab) und Hocke, links Bremse, oben klein Menü, Kamera
  // und Respawn-Punkt (tippen = zurück, halten = neu setzen; im Heli-Modus ausgeblendet). Lenken: Neigen oder Daumen.
  ui.innerHTML = `
    <div class="tz" id="tzDrag"></div>
    <div class="tstickzone" id="tStickZone"><div class="tstick" id="tStick"><i></i><b></b></div></div>
    <div class="tb right">
      <button class="tbtn big" id="tJump" aria-label="Springen, in der Luft halten für Grab"><svg viewBox="0 0 24 24"><path d="M5 15l7-7 7 7"/><path d="M5 20h14"/></svg></button>
      <button class="tbtn spec" id="tSpec" aria-label="Spezialtrick (in der Luft)"><svg viewBox="0 0 24 24"><path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6L3.3 9.3l6.1-.7z"/></svg></button>
      <button class="tbtn" id="tTuck" aria-label="Hocke"><svg viewBox="0 0 24 24"><path d="M6 6l6 6 6-6"/><path d="M6 13l6 6 6-6"/></svg></button>
    </div>
    <div class="tb left">
      <button class="tbtn" id="tBrake" aria-label="Bremsen"><svg viewBox="0 0 24 24"><path d="M8 4l-3 16M16 4l3 16"/><path d="M6.5 13h11"/></svg></button>
    </div>
    <div class="tb top">
      <button class="tsm" id="tMenu" aria-label="Menü"><svg viewBox="0 0 24 24"><path d="M5 7h14M5 12h14M5 17h14"/></svg></button>
      <button class="tsm" id="tCam" aria-label="Kamera wechseln"><svg viewBox="0 0 24 24"><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.6"/></svg></button>
      <button class="tsm" id="tCp" aria-label="Respawn-Punkt: tippen zurück, halten neu setzen"><svg viewBox="0 0 24 24"><path d="M6 21V4"/><path d="M6 5h11l-2.5 4L17 13H6"/></svg></button>
    </div>`;
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
  tap($('tMenu'), 'Escape'); tap($('tCam'), 'KeyC'); tap($('tSpec'), 'Digit0');
  // Respawn-Punkt: kurz tippen = zurück (ohne Punkt: zurück auf die Spur), halten = hier neu setzen
  { const el = $('tCp'); let tm = null, long = false;
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); long = false; el.classList.add('on'); tm = setTimeout(() => { long = true; key('KeyF', true); key('KeyF', false); }, 550); });
    const up = (e) => { e.preventDefault(); el.classList.remove('on'); clearTimeout(tm); if (!long && e.type === 'pointerup') { key('KeyT', true); key('KeyT', false); } };
    el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up); }
  const showTilt = () => {};
  const setTilt = async (on) => {
    if (!on) { touch.tilt = false; window.removeEventListener('deviceorientation', onOrient); }
    else { await enableTilt(); calibrate(); }
    touch.wantTilt = on;
    try { localStorage.setItem('gs_tilt', touch.tilt ? '1' : '0'); } catch {}
  };
  /** Steuerart: 'tilt' Neigen, 'thumb' Daumen ziehen, 'stick' Joystick. */
  const setMode = async (m) => {
    touch.mode = m;
    try { localStorage.setItem('gs_ctrl', m); } catch {}
    ui.classList.toggle('stick', m === 'stick');
    await setTilt(m === 'tilt');
  };
  // Joystick: setzt dort auf, wo der Daumen in der linken Bildhälfte landet; der Knopf folgt bis zum Rand des Rings
  { const zone = $('tStickZone'), st = $('tStick'), knob = st.querySelector('b'), R = 56;
    let pid2 = null, cx = 0, cy = 0;
    const local = (e) => { const [x, y] = pt(e), r = zone.getBoundingClientRect(), [zx, zy] = view.rot ? [r.top, window.innerWidth - r.right] : [r.left, r.top]; return [x - zx, y - zy]; };
    const home = () => { st.style.left = ''; st.style.top = ''; st.classList.remove('on'); knob.style.transform = ''; };
    zone.addEventListener('pointerdown', (e) => {
      if (touch.mode !== 'stick') return;
      e.preventDefault(); pid2 = e.pointerId; try { zone.setPointerCapture(pid2); } catch {}
      [cx, cy] = local(e); st.style.left = cx + 'px'; st.style.top = cy + 'px'; st.classList.add('on');
      touch.stick.on = true; touch.stick.x = 0; touch.stick.y = 0;
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pid2) return;
      const [x, y] = local(e); let dx = x - cx, dy = y - cy; const l = Math.hypot(dx, dy);
      if (l > R) { dx *= R / l; dy *= R / l; }
      knob.style.transform = `translate(${dx}px, ${dy}px)`;
      touch.stick.x = dx / R; touch.stick.y = dy / R;
    });
    const end = (e) => { if (e.pointerId !== pid2) return; pid2 = null; touch.stick.on = false; touch.stick.x = 0; touch.stick.y = 0; home(); };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end); }

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
    } else if (isAir() && Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) && !flip) {
      flip = dx < 0 ? 'ArrowLeft' : 'ArrowRight';   // seitlich wischen und halten = Mute Grab (links) / Tail Grab (rechts)
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

  // Neigen ist Standard, sobald erlaubt (gemerkte Wahl); Joystick seit v35 wählbar
  let want = true, mode = null;
  try { want = localStorage.getItem('gs_tilt') !== '0'; mode = localStorage.getItem('gs_ctrl'); } catch {}
  touch.mode = mode === 'stick' || mode === 'thumb' || mode === 'tilt' ? mode : want ? 'tilt' : 'thumb';
  touch.wantTilt = touch.mode === 'tilt';
  ui.classList.toggle('stick', touch.mode === 'stick');
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
    setAir(a) { ui.classList.toggle('air', a); },
    setTilt,
    setMode,
    mode: () => touch.mode,
    tiltOn: () => touch.wantTilt,
    setCheckpoints(on) { $('tCp').style.display = on ? '' : 'none'; },
    isRunning,
  };
}
