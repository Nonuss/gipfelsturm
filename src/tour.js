// Menü-Rundgang (zweiter Teil des Tutorials): hebt nacheinander echte Elemente des Startbildschirms hervor, der Rest ist
// abgedunkelt, daneben steht eine kurze Erklärung. Weiter und Überspringen per Maus, Finger oder Tastatur (Enter, Leertaste,
// Pfeile, Esc). Solange er läuft, ist das Menü dahinter gesperrt (inert).
import { view, viewSize } from './touch.js';

const PAD = 8, GAP = 14, EDGE = 10;

/** Lage eines Elements in Spielkoordinaten (hochkant gehaltenes Handy: das ganze Spiel ist um 90 Grad gedreht). */
function rectOf(el) {
  const r = el.getBoundingClientRect();
  return view.rot ? { x: r.top, y: window.innerWidth - r.right, w: r.height, h: r.width } : { x: r.left, y: r.top, w: r.width, h: r.height };
}
const hits = (a, b, g) => a.x < b.x + b.w + g && a.x + a.w + g > b.x && a.y < b.y + b.h + g && a.y + a.h + g > b.y;

/** Platz für die Karte: über, unter, links oder rechts vom Ziel, sonst die nächste freie Stelle. Nie über einem Ziel. */
function place(c, holes, W, H) {
  const X = (x) => Math.max(EDGE, Math.min(W - c.w - EDGE, x)), Y = (y) => Math.max(EDGE, Math.min(H - c.h - EDGE, y));
  let gap = GAP - 2;
  const free = (x, y) => !holes.some((h) => hits({ x, y, w: c.w, h: c.h }, h, gap));
  const x0 = Math.min(...holes.map((h) => h.x)), y0 = Math.min(...holes.map((h) => h.y));
  const x1 = Math.max(...holes.map((h) => h.x + h.w)), y1 = Math.max(...holes.map((h) => h.y + h.h));
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const cand = holes.length > 1 ? [[X(mx - c.w / 2), Y(my - c.h / 2)]] : [];
  cand.push([X(mx - c.w / 2), Y(y0 - GAP - c.h)], [X(mx - c.w / 2), Y(y1 + GAP)], [X(x0 - GAP - c.w), Y(my - c.h / 2)], [X(x1 + GAP), Y(my - c.h / 2)]);
  for (const [x, y] of cand) if (free(x, y)) return [x, y];
  gap = 2;   // sehr kleine Bildschirme: dichter heran, aber nie auf das Ziel
  for (const [x, y] of cand) if (free(x, y)) return [x, y];
  let best = null, bd = Infinity;
  for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) {
    const x = X(EDGE + (W - c.w - 2 * EDGE) * i / 24), y = Y(EDGE + (H - c.h - 2 * EDGE) * j / 24);
    const d = Math.hypot(x + c.w / 2 - mx, y + c.h / 2 - my);
    if (d < bd && free(x, y)) { bd = d; best = [x, y]; }
  }
  return best || cand[cand.length - 1];
}
const rr = ({ x, y, w, h }, r) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${2 * r - w}a${r} ${r} 0 0 1 ${-r} ${-r}v${2 * r - h}a${r} ${r} 0 0 1 ${r} ${-r}z`;

export function createTour() {
  const $ = (id) => document.getElementById(id);
  const root = $('tour'), card = $('tourCard'), menu = $('menu');
  let steps = [], i = 0, t0 = 0, onEnd = null;
  const tour = { on: false, start, next, end, key, layout, index: () => i };

  function start(list, done) {
    steps = list; onEnd = done; i = 0;
    tour.on = true; t0 = performance.now();
    menu.inert = true;
    root.classList.remove('hidden');
    show();
  }
  function show() {
    const s = steps[i], last = i === steps.length - 1;
    $('tourStep').textContent = `Menü ${i + 1} von ${steps.length}`;
    $('tourTitle').textContent = s.title;
    $('tourText').textContent = s.text;
    $('tourNext').textContent = last ? 'Fertig' : 'Weiter';
    $('tourSkip').classList.toggle('hidden', last);
    card.classList.remove('in'); void card.offsetWidth; card.classList.add('in');
    layout();
    $('tourNext').focus({ preventScroll: true });
  }
  function layout() {
    if (!tour.on) return;
    const { w: W, h: H } = viewSize();
    const holes = steps[i].sel.map((q) => document.querySelector(q)).filter(Boolean).map(rectOf).filter((r) => r.w > 0 && r.h > 0).map((r) => {
      const x = Math.max(3, r.x - PAD), y = Math.max(3, r.y - PAD);
      return { x, y, w: Math.min(W - 3, r.x + r.w + PAD) - x, h: Math.min(H - 3, r.y + r.h + PAD) - y };
    });
    const d = holes.map((h) => rr(h, Math.min(10, h.w / 2, h.h / 2))).join('');
    $('tourSvg').setAttribute('viewBox', `0 0 ${W} ${H}`);
    $('tourDim').setAttribute('d', `M0 0H${W}V${H}H0z${d}`);
    $('tourRing').setAttribute('d', d);
    const c = { w: card.offsetWidth, h: card.offsetHeight };
    const [x, y] = holes.length ? place(c, holes, W, H) : [(W - c.w) / 2, (H - c.h) / 2];
    card.style.left = Math.round(x) + 'px'; card.style.top = Math.round(y) + 'px';
  }
  function next() {
    if (!tour.on || performance.now() - t0 < 350) return;   // Taste, die noch von der Fahrt gedrückt ist, zählt nicht
    if (i >= steps.length - 1) end();
    else { i++; show(); }
  }
  function back() { if (i > 0) { i--; show(); } }
  function end() {
    if (!tour.on) return;
    tour.on = false;
    root.classList.add('hidden');
    menu.inert = false;
    if (onEnd) onEnd();
  }
  /** Tastatur: alles landet im Rundgang, das Menü dahinter reagiert nicht. */
  function key(e) {
    const k = e.code, btn = e.target instanceof HTMLButtonElement && root.contains(e.target);
    if (k === 'Escape') { e.preventDefault(); end(); }
    else if (k === 'ArrowRight' || k === 'KeyD') { e.preventDefault(); next(); }
    else if (k === 'ArrowLeft' || k === 'KeyA') { e.preventDefault(); back(); }
    else if ((k === 'Enter' || k === 'NumpadEnter' || k === 'Space') && !btn) { e.preventDefault(); next(); }
    else if (k === 'Tab') {   // Fokus bleibt in der Karte
      const l = [$('tourSkip'), $('tourNext')].filter((b) => !b.classList.contains('hidden'));
      e.preventDefault();
      l[(Math.max(0, l.indexOf(document.activeElement)) + (e.shiftKey ? l.length - 1 : 1)) % l.length].focus();
    }
  }
  $('tourNext').addEventListener('click', next);
  $('tourSkip').addEventListener('click', end);
  window.addEventListener('resize', layout);
  if (window.ResizeObserver) { const ro = new ResizeObserver(layout); ro.observe(menu); ro.observe(menu.querySelector('.mmain')); }
  return tour;
}
