// Shop im Startmenü: Punkte aus den Läufen sammeln (im Browser gespeichert) und dafür Ski, Snowboards und Outfits kaufen.
// Gekauftes bleibt gekauft; angelegt wird mit einem Klick. Die Punkte gibt es nur im Spiel, kein echtes Geld.
import { SKIS, BOARDS, SKI_TRICKS } from './gear.js';

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
  freerider: { name: 'Freerider', text: 'Weite Jacke in Oliv und Sand, gedeckte Farben fürs Gelände', jacket: '#4b5a3c', accent: '#d8c9a3', pants: '#2c2f33', price: 700 },
  worldcup: { name: 'Weltcup-Rennanzug', text: 'Schwarz mit Neongelb, dazu die Startnummer', jacket: '#16171b', accent: '#e6ff2e', pants: '#16171b', body: 'racer', price: 900 },
  alpine: { name: 'Alpin Klassik', text: 'Rot und Weiß mit gestreifter Strickmütze und Bommel', jacket: '#b3121f', accent: '#f4f2ee', pants: '#2a2d35', head: 'beanie_alpine', price: 1100 },
  polar: { name: 'Polarnacht', text: 'Eisweiß und Gletscherblau mit Strickmütze', jacket: '#e9eef3', accent: '#7cc8ff', pants: '#1d2c52', head: 'beanie_polar', price: 1300 },
};
const SKI_INFO = {
  allround: ['Taillierter Allround-Ski mit leichtem Rocker an der Schaufel', 0],
  slalom: ['Kurzer Rennski mit schmaler Mitte (66 mm) und Rennplatte: enge Bögen, beißt auf Eis', 300],
  giant: ['Langer Riesentorlauf-Ski für weite, schnelle Bögen, Tempo statt Tricks', 600],
  park: ['Weicher Twin-Tip mit Rocker vorne und hinten. Der Trick-Ski: dreht schneller, bis 30 % mehr Trickpunkte, kann den Nose Butter', 700],
  powder: ['118 mm breit, viel Rocker: schwimmt im Tiefschnee obenauf, auf Eis wenig Halt, kann den Powder Slash', 900],
  wood: ['Echtholz-Optik mit hellen Seitenwangen', 1000],
  carbon: ['Carbon-Gewebe, blaue Akzente, leichte Bindung', 1400],
  gold: ['Goldene Oberfläche, schwarze Mitte, für die Bestenliste', 2500],
  tele: ['Schmal und leicht, rot und weiß wie früher: kurvt eng und tanzt im Gelände', 1600],
  charger: ['108 mm, lang und stabil für steile, offene Hänge und Tiefschnee bei Tempo', 1900],
  speed: ['2,05 m langer Abfahrtsski mit Rennplatte: das schnellste Gleiten, kaum wendig, keine Tricks', 2200],
  legend: ['Titan und Carbon, alles auf Höchstwert. Nur für alle, die in allen vier Rennen Spitzenzeiten fahren', 15000],
};
// Freischaltung: der Spitzen-Ski braucht Bestzeiten unter diesen Werten in allen vier Rennen (Sekunden inklusive Strafzeit).
// v55 auf Gold-Niveau der Rennserie: schnellster fehlerfreier Bot (tools/cup_fast.mjs) Riesentorlauf 49,2, Super-G 75,9,
// Abfahrt 88,1; Grenze 2 bzw. 3 % darunter. Slalom unverändert 43,0 (passte; dort ist der Bot mit 39,3 übermenschlich).
export const LEGEND_TIMES = { sl: 43, gs: 48.2, sg: 73.6, dh: 85.5 };
const REQ = { legend: 'race' };
const BOARD_INFO = {
  classic: ['Twin-Board mit Streifen, das Brett vom Start', 0],
  freestyle: ['Weiches Park-Board mit Schachbrett-Grafik. Das Trick-Brett: dreht schneller, mehr Trickpunkte', 300],
  freeride: ['Directional mit langer Nase und Wellen-Grafik', 800],
  powder: ['Swallowtail: Schwalbenschwanz hinten, Nase hoch, für tiefen Pulver', 1100],
  aurora: ['Nachtblau mit Polarlicht-Verlauf', 1300],
  gold: ['Gold mit schwarzen Streifen', 2500],
  split: ['Splitboard in Oliv und Sand: im Tiefschnee und bei harten Bedingungen zuhause', 1700],
  pro: ['Kurzes Park-Brett mit Graffiti-Grafik, wendig und verspielt', 1500],
};

export const CATALOG = {
  ski: Object.keys(SKIS).map((id) => ({ id, name: SKIS[id].name, text: SKI_INFO[id][0], price: SKI_INFO[id][1], colors: SKIS[id].top, st: SKIS[id].st, trick: SKIS[id].trick ? SKI_TRICKS[SKIS[id].trick] : null, req: REQ[id] || null })),
  board: Object.keys(BOARDS).map((id) => ({ id, name: BOARDS[id].name, text: BOARD_INFO[id][0], price: BOARD_INFO[id][1], colors: BOARDS[id].top, st: BOARDS[id].st })),
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
  /** Freischaltung prüfen (Bestzeiten in allen vier Rennen für den Spitzen-Ski). */
  unlocked(it) {
    if (!it || it.req !== 'race') return true;
    return Object.entries(LEGEND_TIMES).every(([d, lim]) => { const b = parseFloat(read('gipfelsturm_best_' + d, 0)) || 0; return b > 0 && b <= lim; });
  },
  buy(cat, id) {
    const it = CATALOG[cat].find((q) => q.id === id);
    if (!it || this.has(cat, id) || this.wallet < it.price || !this.unlocked(it)) return false;
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
