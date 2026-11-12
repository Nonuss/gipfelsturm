// Leistungsstufen: werden im Menü gewählt oder (bei „Auto“) während der Fahrt automatisch heruntergeregelt.
// pr = höchste Auflösung (Pixel pro CSS-Pixel), minPR = Untergrenze der dynamischen Auflösung.
// Früher war pr fest (niedrig 0,8): auf einem iPhone (3 Pixel pro CSS-Pixel) war das ein Viertel der Auflösung – stark verpixelt.
export const TIERS = {
  high: { pr: 2.0, minPR: 1.0, shadow: 4096, msaa: 4, bloom: true, grid: 1.6, view: 1000, trees: 1, dust: true, budget: 3.5, patch: 0.5 },
  mid: { pr: 1.7, minPR: 1.0, shadow: 2048, msaa: 2, bloom: true, grid: 2.0, view: 800, trees: 0.75, dust: true, budget: 3, patch: 0.65 },
  low: { pr: 1.4, minPR: 1.0, shadow: 0, msaa: 0, bloom: false, grid: 2.5, view: 760, trees: 0.5, dust: false, budget: 2.5, patch: 0 },
};
export const ORDER = ['high', 'mid', 'low'];
export const Q = { tier: 'high', ...TIERS.high };
export function setTier(name) {
  Object.assign(Q, TIERS[name], { tier: name });
}
