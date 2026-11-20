// Leistungsstufen: werden im Menü gewählt oder (bei „Auto“) während der Fahrt automatisch heruntergeregelt.
// pr = höchste Auflösung (Pixel pro CSS-Pixel), minPR = Untergrenze der dynamischen Auflösung.
// Früher war pr fest (niedrig 0,8): auf einem iPhone (3 Pixel pro CSS-Pixel) war das ein Viertel der Auflösung – stark verpixelt.
// Ultra (nur von Hand, für starke Rechner): fein modellierte Fichten im Nahbereich, Licht aus der Himmelskuppel, neutrale
// Tonkurve, Felsrelief in den Bergen und der Heli-Fernsicht, Wolken mit Eigenschatten, Lichtstrahlen, Umgebungsverdeckung,
// Bewegungs- und Tiefenunschärfe, feinere Schatten, mehr Sichtweite und Schneestaub. Die Automatik wählt Ultra nie.
const BASE = { ultra: false, fx: 1, shadowArea: 95, lowq: false };
export const TIERS = {
  ultra: { pr: 2.0, minPR: 1.25, shadow: 8192, msaa: 4, bloom: true, grid: 1.6, view: 1300, trees: 1, dust: true, budget: 4, patch: 0.4, ultra: true, fx: 1.6, shadowArea: 140 },
  high: { pr: 2.0, minPR: 1.0, shadow: 4096, msaa: 4, bloom: true, grid: 1.6, view: 1000, trees: 1, dust: true, budget: 3.5, patch: 0.5 },
  mid: { pr: 1.7, minPR: 1.0, shadow: 2048, msaa: 2, bloom: true, grid: 2.0, view: 800, trees: 0.75, dust: true, budget: 3, patch: 0.65 },
  low: { pr: 1.4, minPR: 1.0, shadow: 0, msaa: 0, bloom: false, grid: 2.5, view: 760, trees: 0.5, dust: false, budget: 2.5, patch: 0.8, lowq: true },
  // Sparsam: nur für sehr schwache Rechner (die Automatik wählt sie erst, wenn selbst Niedrig lange ruckelt). Gespart wird
  // an Sichtweite, Bäumen, Pulverschicht, Schneestaub und an der Überabtastung, nie unter der echten Bildschirmauflösung:
  // das Bild bleibt scharf, nur schlichter.
  minimal: { pr: 1.0, minPR: 1.0, shadow: 0, msaa: 0, bloom: false, grid: 2.8, view: 600, trees: 0.35, dust: false, budget: 2, patch: 0, lowq: true, fx: 0.6 },
};
export const ORDER = ['high', 'mid', 'low', 'minimal'];   // Reihenfolge der Automatik (ohne Ultra)
export const Q = { tier: 'high', ...BASE, ...TIERS.high };
export function setTier(name) {
  if (!TIERS[name]) name = 'high';
  Object.assign(Q, BASE, TIERS[name], { tier: name });
}
