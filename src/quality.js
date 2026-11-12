// Leistungsstufen: werden im Menü gewählt oder (bei „Auto“) während der Fahrt automatisch heruntergeregelt.
export const TIERS = {
  high: { pr: 1.5, shadow: 4096, msaa: 4, bloom: true, grid: 1.6, view: 1000, trees: 1, dust: true, budget: 3.5, patch: 0.5 },
  mid: { pr: 1.1, shadow: 2048, msaa: 2, bloom: true, grid: 2.0, view: 800, trees: 0.75, dust: true, budget: 3, patch: 0.65 },
  low: { pr: 0.8, shadow: 1024, msaa: 0, bloom: false, grid: 2.5, view: 620, trees: 0.5, dust: false, budget: 2.5, patch: 0 },
};
export const ORDER = ['high', 'mid', 'low'];
export const Q = { tier: 'high', ...TIERS.high };
export function setTier(name) {
  Object.assign(Q, TIERS[name], { tier: name });
}
