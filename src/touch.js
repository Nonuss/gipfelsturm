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

let neutral = 0, rawTilt = 0, haveTilt = false, dragSteer = null, airSpin = 0;
const TILT_RANGE = 24;   // Grad bis voller Lenkeinschlag
const DEAD = 2.5;        // Totzone in Grad

function tiltAngle(e) {
  // Lenkachse je nach Bildschirmlage: quer = beta (Drehen wie ein Lenkrad), hochkant = gamma (seitlich kippen)
  const a = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
  if (a === 90) return e.beta;
  if (a === -90 || a === 270) return -e.beta;
  return e.gamma;
}

function onOrient(e) {
  if (e.beta == null && e.gamma == null) return;
  rawTilt = tiltAngle(e) || 0;
  if (!haveTilt) { haveTilt = true; neutral = rawTilt; }
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
export function calibrate() { neutral = rawTilt; }

/** Pro Bild aufrufen: berechnet den Lenkwert und die Spin-Tasten in der Luft. */
export function updateTouch(inAir) {
  let s = null;
  if (dragSteer !== null) s = dragSteer;
  else if (touch.tilt && touch.tiltOk) {
    let d = rawTilt - neutral;
    if (d > 180) d -= 360; else if (d < -180) d += 360;
    const m = Math.max(0, Math.abs(d) - DEAD) / (TILT_RANGE - DEAD);
    s = Math.sign(d) * Math.min(1, m * (0.6 + 0.4 * m));   // fein in der Mitte, kräftig am Rand
  }
  touch.steer = s;
  // In der Luft: deutliches Neigen/Ziehen dreht (Spin) – wie A/D am PC
  const want = inAir && s !== null ? (s > 0.5 ? 1 : s < -0.5 ? -1 : (Math.abs(s) < 0.3 ? 0 : airSpin)) : 0;
  if (want !== airSpin) {
    if (airSpin === 1) key('KeyD', false); else if (airSpin === -1) key('KeyA', false);
    if (want === 1) key('KeyD', true); else if (want === -1) key('KeyA', true);
    airSpin = want;
  }
}

export function setupTouch({ isAir, isRunning }) {
  if (!isTouch) return;
  document.body.classList.add('touch');
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
      <button class="tsm" id="tCp" aria-label="Respawn-Punkt setzen">⚑</button>
      <button class="tsm" id="tBack" aria-label="Zum Respawn-Punkt">↺</button>
      <button class="tsm" id="tTilt" aria-label="Neigungssteuerung an oder aus">Neigen</button>
      <button class="tsm" id="tMenu" aria-label="Menü">☰</button>
    </div>
    <div id="tHelp">Handy neigen = lenken · Wischen ↑↓ in der Luft = Flip · neigen in der Luft = Spin</div>`;
  document.body.appendChild(ui);
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
  dz.addEventListener('pointerdown', (e) => { pid = e.pointerId; sx = e.clientX; sy = e.clientY; try { dz.setPointerCapture(pid); } catch {} });
  dz.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pid) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
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
      if (touch.wantTilt && !touch.tilt) await enableTilt();
      calibrate();
      showTilt();
      ui.classList.toggle('noTilt', !touch.tilt);
    },
    setRunning(r) { ui.classList.toggle('active', r); },
    isRunning,
  };
}
