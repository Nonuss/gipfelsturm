// Rennserie („Weitere Rennen ansehen“ im Feld Rennen): zehn eigene Rennen. Jedes hat eine eigene Strecke (Kurven, Breite, Steilheit, Sprünge, Wald) auf Basis
// einer Disziplin und eine eigene Stimmung (Tageszeit, Licht, Wetter). Medaillenzeiten aus dem Renn-Bot
// (tools/cup_validate.mjs): Gold knapp über dem schnellen Bot, Silber und Bronze mit Abstand.
//
// terrain: siehe course.js (RV): cx = drei Wellen der Mittellinie [Stärke, Länge, Phase] x 3, wBase/wAmp = halbe
// Pistenbreite, slope = Steilheitsfaktor, bumps = Steilstufen [Ort, Stärke, Breite]. kick: Sprünge [d, h, L].

export const MOODS = {
  // klarer Wintertag (Standard der Rennpiste)
  day: { name: 'Sonnig' },
  // kalter, klarer Morgen: tiefe Sonne von vorn rechts, sehr blauer Himmel, lange Schatten
  crisp: {
    name: 'Klarer Morgen', sun: [0.62, 0.26, -0.74], sunCol: [1.0, 0.9, 0.78], sunI: 2.6, hemiSky: [0.46, 0.62, 1.0], hemiGround: [0.66, 0.76, 1.0], hemiI: 1.0,
    zen: [0.03, 0.16, 0.6], mid: [0.2, 0.46, 0.92], hor: [0.6, 0.76, 0.96], halo: [1.0, 0.9, 0.72], fog: [0.62, 0.76, 0.96], fogNear: 240, fogFar: 2400, exp: 0.92,
  },
  // Morgenrot: Sonne knapp über dem Horizont, Gegenlicht talwärts, rosa und orange
  dawn: {
    mtn: [1.0, 0.78, 0.8], name: 'Morgenrot', sun: [0.18, 0.12, -0.98], sunCol: [1.0, 0.6, 0.4], sunI: 2.3, hemiSky: [0.62, 0.55, 0.82], hemiGround: [0.86, 0.72, 0.74], hemiI: 0.85,
    zen: [0.1, 0.15, 0.4], mid: [0.62, 0.5, 0.66], hor: [1.0, 0.66, 0.5], halo: [1.0, 0.62, 0.36], cloud: [1.0, 0.72, 0.66], fog: [0.93, 0.72, 0.66], fogNear: 200, fogFar: 1900, exp: 0.96,
  },
  // später Nachmittag im Wald: warmes, flaches Licht durch die Bäume
  afternoon: {
    mtn: [1.0, 0.93, 0.86], name: 'Nachmittag', sun: [-0.5, 0.3, -0.81], sunCol: [1.0, 0.82, 0.62], sunI: 2.6, hemiSky: [0.52, 0.64, 0.92], hemiGround: [0.78, 0.76, 0.82], hemiI: 0.95,
    zen: [0.08, 0.22, 0.6], mid: [0.32, 0.52, 0.86], hor: [0.86, 0.8, 0.8], halo: [1.0, 0.8, 0.55], fog: [0.82, 0.8, 0.84], fogNear: 200, fogFar: 2100, exp: 0.92,
  },
  // Abendrot: Sonne seitlich hinten, Himmel glüht, Schnee rosa, Schatten violett
  dusk: {
    mtn: [1.0, 0.66, 0.6], name: 'Abendrot', sun: [-0.72, 0.1, 0.68], sunCol: [1.0, 0.48, 0.24], sunI: 2.5, hemiSky: [0.5, 0.42, 0.66], hemiGround: [0.86, 0.62, 0.56], hemiI: 0.78,
    zen: [0.1, 0.1, 0.3], mid: [0.72, 0.42, 0.42], hor: [1.0, 0.56, 0.3], halo: [1.0, 0.5, 0.22], cloud: [1.0, 0.6, 0.5], fog: [0.94, 0.62, 0.48], fogNear: 200, fogFar: 1800, exp: 1.0,
  },
  // Nebelwand: kaum Sicht, weiches graues Licht, Tore tauchen spät auf
  fog: {
    hideMtn: 1, name: 'Nebel', sun: [-0.3, 0.8, -0.5], sunCol: [1.0, 0.98, 0.95], sunI: 0.7, hemiSky: [0.86, 0.88, 0.92], hemiGround: [0.8, 0.82, 0.86], hemiI: 1.55,
    zen: [0.74, 0.76, 0.8], mid: [0.78, 0.8, 0.83], hor: [0.82, 0.83, 0.86], halo: [0.2, 0.2, 0.2], cloudK: 0, fog: [0.8, 0.81, 0.84], fogNear: 12, fogFar: 175, exp: 0.95, snow: 0.15,
  },
  // Schneesturm: dichter Schneefall, graues Licht, Sicht rund 300 m
  storm: {
    hideMtn: 1, name: 'Schneesturm', sun: [-0.2, 0.85, -0.45], sunCol: [0.95, 0.97, 1.0], sunI: 0.55, hemiSky: [0.74, 0.78, 0.86], hemiGround: [0.7, 0.74, 0.82], hemiI: 1.45,
    zen: [0.5, 0.54, 0.6], mid: [0.6, 0.63, 0.68], hor: [0.7, 0.72, 0.76], halo: [0.15, 0.15, 0.15], cloudK: 0, fog: [0.69, 0.71, 0.75], fogNear: 25, fogFar: 330, exp: 0.98, snow: 1, wind: 8, flake: 1.5,
  },
  // Gletscher: hohe, harte Mittagssonne, tiefblauer Himmel, weite Sicht
  glacier: {
    name: 'Gletscher', sun: [-0.42, 0.62, -0.66], sunCol: [1.0, 0.98, 0.95], sunI: 2.5, hemiSky: [0.38, 0.56, 1.0], hemiGround: [0.72, 0.82, 1.0], hemiI: 1.0,
    zen: [0.01, 0.08, 0.42], mid: [0.08, 0.3, 0.78], hor: [0.5, 0.7, 0.95], halo: [1.0, 0.95, 0.85], cloudK: 0.4, fog: [0.55, 0.7, 0.95], fogNear: 400, fogFar: 3600, exp: 0.8,
  },
  // Nacht mit Flutlicht: dunkler Himmel mit Sternen, Mondlicht kühl, helle Lichtinseln auf der Piste
  flood: {
    mtn: [0.1, 0.13, 0.24], name: 'Flutlicht', sun: [0.35, 0.62, 0.7], sunCol: [0.55, 0.66, 1.0], sunI: 0.22, hemiSky: [0.1, 0.14, 0.28], hemiGround: [0.08, 0.1, 0.18], hemiI: 0.55,
    zen: [0.004, 0.008, 0.025], mid: [0.015, 0.028, 0.07], hor: [0.05, 0.07, 0.14], halo: [0.5, 0.6, 0.9], moon: 1, stars: 1, cloud: [0.1, 0.12, 0.2], cloudK: 0.5, fog: [0.035, 0.05, 0.1], fogNear: 110, fogFar: 900, exp: 1.05,
    lights: 'flood',
  },
  // Fackellauf: Vollmondnacht, die Strecke ist mit Fackeln gesäumt, leichter Schneefall
  torch: {
    mtn: [0.13, 0.17, 0.3], name: 'Fackeln', sun: [-0.4, 0.55, 0.73], sunCol: [0.6, 0.72, 1.0], sunI: 0.42, hemiSky: [0.14, 0.2, 0.38], hemiGround: [0.1, 0.13, 0.24], hemiI: 0.6,
    zen: [0.006, 0.012, 0.04], mid: [0.025, 0.045, 0.1], hor: [0.07, 0.1, 0.19], halo: [0.6, 0.7, 1.0], moon: 1, stars: 1, cloud: [0.12, 0.14, 0.24], cloudK: 0.4, fog: [0.05, 0.07, 0.13], fogNear: 90, fogFar: 760, exp: 1.08, snow: 0.3,
    lights: 'torch',
  },
};

export const CUP = [
  { id: 'flutlicht', name: 'Flutlicht-Slalom', disc: 'sl', start: 1880, mood: 'flood', seed: 101,
    line: 'Nachtslalom unter Flutlicht. Enge Tore in hellen Lichtinseln, dazwischen wird es dunkel.',
    terrain: { cx: [30, 160, 0.7, 14, 80, 2.0, 6, 40, 1.0], wBase: 17, wAmp: 3 }, trees: 1.2 },
  { id: 'morgenrot', name: 'Morgenrot', disc: 'gs', start: 1420, mood: 'dawn', seed: 202,
    line: 'Riesentorlauf bei Sonnenaufgang, die Sonne genau talwärts. Lange Schatten, glühender Schnee.',
    terrain: { cx: [60, 240, 1.5, 22, 95, 0.2, 9, 52, 2.2], wBase: 22 }, trees: 1 },
  { id: 'nebel', name: 'Nebelwand', disc: 'sg', start: 900, mood: 'fog', seed: 303,
    line: 'Super-G im dichten Nebel. Die Tore tauchen erst spät auf, wer die Linie kennt, ist schneller.',
    terrain: { cx: [45, 260, 2.4, 30, 120, 0.8, 6, 44, 1.1] }, kick: [{ d: 1500, h: 1.6 }], trees: 0.9 },
  { id: 'sturm', name: 'Schneesturm', disc: 'dh', start: 300, mood: 'storm', seed: 404,
    line: 'Abfahrt im Schneesturm. Dichter Schneefall, kaum Kontrast, zwei Sprünge im Grau.',
    terrain: { cx: [70, 250, 0.4, 20, 100, 2.5, 8, 50, 0] }, kick: [{ d: 900, h: 1.7 }, { d: 1650, h: 1.9 }], trees: 1.1 },
  { id: 'gletscher', name: 'Gletscher', disc: 'dh', start: 0, mood: 'glacier', seed: 505,
    line: 'Ganz oben über der Baumgrenze: breite Eisflächen, Felsen, drei weite Sprünge in tiefblauem Licht.',
    terrain: { cx: [90, 300, 1.0, 30, 130, 2.0, 10, 60, 0.3], wBase: 32, wAmp: 7, slope: 1.08, bumps: [[600, 0.14, 90], [1500, 0.13, 120]] },
    kick: [{ d: 700, h: 2.2, L: 20 }, { d: 1350, h: 2.4, L: 20 }, { d: 2000, h: 2.0 }], trees: 0, rocks: 3 },
  { id: 'wald', name: 'Waldkorridor', disc: 'gs', start: 1350, mood: 'afternoon', seed: 606,
    line: 'Riesentorlauf durch einen schmalen Waldkorridor. Die Bäume stehen dicht, das Licht fällt in Streifen.',
    terrain: { cx: [40, 180, 2.0, 24, 90, 1.0, 10, 45, 0.2], wBase: 11, wAmp: 2.5 }, trees: 2.4 },
  { id: 'abendrot', name: 'Abendrot', disc: 'sg', start: 650, mood: 'dusk', seed: 707,
    line: 'Super-G in der letzten Sonne. Der Himmel glüht, der Schnee wird rosa, die Schatten violett.',
    terrain: { cx: [65, 230, 0.9, 25, 105, 1.9, 7, 49, 0.6] }, kick: [{ d: 1265, h: 1.8 }], trees: 1 },
  { id: 'buckel', name: 'Kamelbuckel', disc: 'dh', start: 200, mood: 'day', seed: 808,
    line: 'Abfahrt mit drei Doppelbuckeln: kurz hintereinander zwei Sprünge, die Landung des ersten ist der Absprung des zweiten.',
    terrain: { cx: [50, 210, 2.8, 22, 100, 0.4, 8, 46, 1.6], wBase: 22 },
    kick: [{ d: 560, h: 1.4, L: 14 }, { d: 610, h: 1.5, L: 14 }, { d: 1180, h: 1.5, L: 14 }, { d: 1235, h: 1.6, L: 14 }, { d: 1820, h: 1.5, L: 14 }, { d: 1875, h: 1.7, L: 15 }], trees: 1 },
  { id: 'steil', name: 'Steilhang', disc: 'sl', start: 1860, mood: 'crisp', seed: 909,
    line: 'Slalom am steilsten Hang der Serie. Jeder Schwung muss sitzen, sonst wird es zu schnell.',
    terrain: { cx: [25, 150, 0.2, 12, 70, 1.4, 5, 35, 0.9], wBase: 18, slope: 1.3, bumps: [[2080, 0.16, 70], [900, 0.13, 110], [1750, 0.12, 100]] },
    gate: { sp: [11.5, 13.5] }, trees: 1.1 },
  { id: 'fackel', name: 'Fackellauf', disc: 'gs', start: 1450, mood: 'torch', seed: 1010,
    line: 'Riesentorlauf in der Vollmondnacht. Fackeln säumen die Strecke, leichter Schnee fällt.',
    terrain: { cx: [50, 210, 0.5, 20, 96, 2.2, 7, 44, 1.3], wBase: 19 }, trees: 1.3 },
];
// Medaillenzeiten (Sekunden inklusive Strafzeit). Grundlage ist der schnellste fehlerfreie Bot (tools/cup_fast.mjs: höchstes
// Tempolimit, bei dem er noch alle Tore trifft, Hocke in allen Disziplinen). v55, nach Spieltest „viel zu leicht, außer
// Slalom“: eng wie im Weltcup. Abfahrt und Super-G: Gold 3 % unter dem Bot, Silber gleichauf, Bronze 4 % darüber;
// Riesentorlauf: Gold 2 % darunter, Silber 2 %, Bronze 7 % darüber. Slalom unverändert (passte): langsamer Bot plus 2 / 10 /
// 22 % (tools/cup_validate.mjs), denn im Slalom ist der Bot viel schneller als ein Mensch.
export const MEDALS = {"flutlicht": [50.7, 54.7, 60.6], "morgenrot": [53.2, 55.4, 58.1], "nebel": [61.7, 63.6, 66.1], "sturm": [77.3, 79.7, 82.9], "gletscher": [87.6, 90.3, 93.9], "wald": [56.4, 58.6, 61.5], "abendrot": [76.7, 79.1, 82.3], "buckel": [79.0, 81.4, 84.7], "steil": [51.6, 55.7, 61.7], "fackel": [49.6, 51.6, 54.1]};

export const cupById = (id) => CUP.find((c) => c.id === id) || CUP[0];
/** Medaille für eine Zeit: 3 Gold, 2 Silber, 1 Bronze, 0 keine. */
export function medalFor(id, t) {
  const m = MEDALS[id];
  if (!m || !t) return 0;
  return t <= m[0] ? 3 : t <= m[1] ? 2 : t <= m[2] ? 1 : 0;
}
export const MEDAL_NAME = ['', 'Bronze', 'Silber', 'Gold'];
