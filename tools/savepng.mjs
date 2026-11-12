// Winziger lokaler Empfänger: speichert PNG-Data-URLs, die eine Prüfseite per POST schickt, nach docs/img/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'img');
fs.mkdirSync(OUT, { recursive: true });

http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url, 'http://x');
  const name = path.basename(url.searchParams.get('name') || 'bild.png');
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const b64 = body.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(path.join(OUT, name), Buffer.from(b64, 'base64'));
    res.writeHead(200); res.end('ok ' + name);
  });
}).listen(5190, () => console.log('savepng lauscht auf 5190, Ziel:', OUT));
