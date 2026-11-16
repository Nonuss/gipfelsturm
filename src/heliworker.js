// Web Worker: erzeugt das Heli-Gebirge und seine Fernsicht abseits des Hauptthreads (Menü und Bild bleiben flüssig).
import * as HB from './heliberg.js';
import { farArrays } from './helifar.js';
self.onmessage = (e) => {
  const { seed, tier } = e.data;
  const s = HB.init(seed);
  const far = farArrays(s, tier);
  const { data, transfer } = HB.pack(s, far);
  data.farTier = tier;
  self.postMessage(data, transfer);
};
