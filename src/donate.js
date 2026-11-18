// Freiwillige Unterstützung: ein Knopf „Unterstützen“ im Menü und ein kleiner Hinweis auf dem Zielbildschirm.
// Solange DONATE_URL leer ist, bleibt alles ausgeblendet. Den eigenen Link (Ko-fi, PayPal.Me, Buy Me a Coffee ...)
// hier eintragen, z. B. 'https://ko-fi.com/deinname'. Spender bekommen nichts im Spiel: alle spielen gleich.
export const DONATE_URL = '';

const NAMES = [['ko-fi.com', 'Ko-fi'], ['paypal.me', 'PayPal'], ['paypal.com', 'PayPal'], ['buymeacoffee.com', 'Buy Me a Coffee'], ['patreon.com', 'Patreon'], ['github.com', 'GitHub Sponsors']];

/** Nur echte https-Links zeigen (kein Platzhalter, kein javascript:). */
export function donateUrl(url = DONATE_URL) {
  try { const u = new URL(url); return u.protocol === 'https:' ? u : null; } catch { return null; }
}

export function setupDonate(url = DONATE_URL) {
  const u = donateUrl(url);
  const btn = document.getElementById('donateBtn'), link = document.getElementById('donateLink'), fin = document.getElementById('finDonate');
  for (const el of [btn, fin]) if (el) el.hidden = !u;
  if (!u) return false;
  const host = u.hostname.replace(/^www\./, '');
  const name = (NAMES.find(([h]) => host === h || host.endsWith('.' + h)) || [null, host])[1];
  for (const a of [link, fin]) if (a) { a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  if (link) link.textContent = `Unterstützen über ${name}`;
  return true;
}
