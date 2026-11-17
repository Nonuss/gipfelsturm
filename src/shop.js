// Shop im Startmenü: Punkte aus den Läufen sammeln (im Browser gespeichert) und dafür Ski, Snowboards und Outfits kaufen.
// Gekauftes bleibt gekauft; angelegt wird mit einem Klick. Die Punkte gibt es nur im Spiel, kein echtes Geld.
import { SKIS, BOARDS } from './gear.js';

const KEY = { wallet: 'gipfelsturm_wallet', owned: 'gipfelsturm_owned', equip: 'gipfelsturm_equip', earned: 'gipfelsturm_earned' };
const START_POINTS = 300;   // Startguthaben: das erste Teil ist gleich erreichbar

// Outfits: Jacke, Akzent, Hose, Kopfteil. „Eigene Farben“ ist das bisherige Outfit-Fenster.
export const OUTFITS = {
  custom: { name: 'Eigene Farben', text: 'Farben frei wählbar unter Outfit', price: 0 },
  santa: { name: 'Weihnachtsmann', text: 'Rote Jacke mit Pelzbesatz, Zipfelmütze mit Bommel und weißer Rauschebart', jacket: '#c8102e', accent: '#f4f2ee', pants: '#a50d26', head: 'santa', price: 1500 },
  racer: { name: 'Rennanzug Rot-Weiß-Rot', text: 'Enger Rennanzug in den Farben Österreichs', jacket: '#d7141a', accent: '#f6f6f4', pants: '#d7141a', price: 600 },
  retro: { name: 'Retro 1985', text: 'Neon wie in den Achtzigern, mit Stirnband', jacket: '#ff3d7f', accent: '#27c3ff', pants: '#5b3ea8', head: 'headband', price: 800 },
  guide: { name: 'Bergführer', text: 'Leuchtorange und Schwarz, gut sichtbar im Gelände', jacket: '#ff6a13', accent: '#23262d', pants: '#23262d', price: 250 },
  snowman: { name: 'Schneemann', text: 'Ganz in Weiß, mit Zylinder und Karottennase', jacket: '#f2f2f0', accent: '#16171b', pants: '#e9e6df', head: 'tophat', price: 1200 },
  gold: { name: 'Gipfelkönig', text: 'Gold und Schwarz mit Krone, für echte Rekordjäger', jacket: '#d4a62a', accent: '#16171b', pants: '#16171b', head: 'crown', price: 3000 },
};
const SKI_INFO = {
  allround: ['Taillierter Allround-Ski mit leichtem Rocker an der Schaufel', 0],
  slalom: ['Kurzer Rennski mit schmaler Mitte (66 mm) und Rennplatte', 300],
  giant: ['Langer Riesentorlauf-Ski für weite, schnelle Bögen', 600],
  park: ['Twin-Tip mit Rocker vorne und hinten, für Rails und Rückwärtslandungen', 700],
  powder: ['118 mm breit, viel Rocker: schwimmt im Tiefschnee obenauf', 900],
  wood: ['Echtholz-Optik mit hellen Seitenwangen', 1000],
  carbon: ['Carbon-Gewebe, blaue Akzente, leichte Bindung', 1400],
  gold: ['Goldene Oberfläche, schwarze Mitte, für die Bestenliste', 2500],
};
const BOARD_INFO = {
  classic: ['Twin-Board mit Streifen, das Brett vom Start', 0],
  freestyle: ['Weiches Park-Board mit Schachbrett-Grafik', 300],
  freeride: ['Directional mit langer Nase und Wellen-Grafik', 800],
  powder: ['Swallowtail: Schwalbenschwanz hinten, Nase hoch, für tiefen Pulver', 1100],
  aurora: ['Nachtblau mit Polarlicht-Verlauf', 1300],
  gold: ['Gold mit schwarzen Streifen', 2500],
};

export const CATALOG = {
  ski: Object.keys(SKIS).map((id) => ({ id, name: SKIS[id].name, text: SKI_INFO[id][0], price: SKI_INFO[id][1], colors: SKIS[id].top })),
  board: Object.keys(BOARDS).map((id) => ({ id, name: BOARDS[id].name, text: BOARD_INFO[id][0], price: BOARD_INFO[id][1], colors: BOARDS[id].top })),
  outfit: Object.keys(OUTFITS).map((id) => ({ id, name: OUTFITS[id].name, text: OUTFITS[id].text, price: OUTFITS[id].price, colors: OUTFITS[id].jacket ? [OUTFITS[id].jacket, OUTFITS[id].accent, OUTFITS[id].pants] : ['#1d2c52', '#ff6a13', '#33363b'] })),
};

const read = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* privater Modus: nur für diese Sitzung */ } };

export const shop = {
  wallet: read(KEY.wallet, START_POINTS),
  earned: read(KEY.earned, 0),
  owned: new Set(read(KEY.owned, ['ski:allround', 'board:classic', 'outfit:custom'])),
  equip: Object.assign({ ski: 'allround', board: 'classic', outfit: 'custom' }, read(KEY.equip, {})),
  onChange: null,
  save() { write(KEY.wallet, this.wallet); write(KEY.earned, this.earned); write(KEY.owned, [...this.owned]); write(KEY.equip, this.equip); },
  /** Punkte aus einem Lauf gutschreiben. Gibt die gutgeschriebene Zahl zurück. */
  earn(n) {
    n = Math.max(0, Math.round(n));
    if (!n) return 0;
    this.wallet += n; this.earned += n;
    this.save();
    if (this.onChange) this.onChange();
    return n;
  },
  has(cat, id) { return this.owned.has(`${cat}:${id}`); },
  buy(cat, id) {
    const it = CATALOG[cat].find((q) => q.id === id);
    if (!it || this.has(cat, id) || this.wallet < it.price) return false;
    this.wallet -= it.price;
    this.owned.add(`${cat}:${id}`);
    this.equip[cat] = id;
    this.save();
    if (this.onChange) this.onChange();
    return true;
  },
  wear(cat, id) {
    if (!this.has(cat, id)) return false;
    this.equip[cat] = id;
    this.save();
    if (this.onChange) this.onChange();
    return true;
  },
};

const num = (n) => Math.round(n).toLocaleString('de-DE');
/** Fenster mit Reitern (Ski, Snowboard, Outfit) und Karten. apply() legt die Auswahl am Fahrer an. */
export function buildShopUI(root, apply) {
  let tab = 'ski';
  const render = () => {
    root.querySelector('.wallet b').textContent = `${num(shop.wallet)} Punkte`;
    for (const b of root.querySelectorAll('.tabs button')) { const on = b.dataset.t === tab; b.classList.toggle('sel', on); b.setAttribute('aria-selected', String(on)); }
    const grid = root.querySelector('.cards');
    grid.innerHTML = '';
    for (const it of CATALOG[tab]) {
      const own = shop.has(tab, it.id), on = shop.equip[tab] === it.id, afford = shop.wallet >= it.price;
      const card = document.createElement('div');
      card.className = 'card' + (on ? ' on' : '');
      const sw = it.colors.map((c, i) => `<span style="background:${c};flex:${i ? 1 : 2.2}"></span>`).join('');
      const label = on ? 'Angelegt' : own ? 'Anlegen' : `Kaufen · ${num(it.price)}`;
      card.innerHTML = `<div class="sw ${tab}">${sw}</div><b>${it.name}</b><p>${it.text}</p><button ${on || (!own && !afford) ? 'disabled' : ''}>${label}</button>${!own && !afford ? `<small>noch ${num(it.price - shop.wallet)} Punkte</small>` : ''}`;
      card.querySelector('button').addEventListener('click', () => {
        if (own) shop.wear(tab, it.id); else shop.buy(tab, it.id);
        apply();
        render();
      });
      grid.appendChild(card);
    }
  };
  for (const b of root.querySelectorAll('.tabs button')) b.addEventListener('click', () => { tab = b.dataset.t; render(); });
  render();
  return { render, setTab: (t) => { tab = t; render(); } };
}
