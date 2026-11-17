// base './': die gebaute Version funktioniert in jedem Unterordner (z. B. GitHub Pages: nutzer.github.io/gipfelsturm/)
// Die Spielversion kommt aus dem Cache-Namen des Service Workers (public/sw.js) und wird im Menü angezeigt.
import fs from 'node:fs';
const ver = (fs.readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8').match(/gipfelsturm-v(\d+)/) || [0, '?'])[1];
export default { base: './', build: { chunkSizeWarningLimit: 1200 }, define: { __GAME_VERSION__: JSON.stringify(ver) } };
