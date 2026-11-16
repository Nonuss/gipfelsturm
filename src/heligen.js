// Verwaltung des Gebirgs-Workers: Berge anfordern, fertige Berge zwischenspeichern, den nächsten vorab erzeugen.
import * as HB from './heliberg.js';

let worker = null;
const jobs = new Map();     // seed -> { promise, resolve }
const done = new Map();     // seed -> data
function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./heliworker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const d = e.data, j = jobs.get(d.seed);
    done.set(d.seed, d);
    if (j) { jobs.delete(d.seed); j.resolve(d); }
  };
  return worker;
}
/** Gebirge mit diesem Startwert erzeugen lassen; das Promise liefert die Daten, sobald sie fertig sind. */
export function request(seed, tier) {
  if (done.has(seed)) return Promise.resolve(done.get(seed));
  if (jobs.has(seed)) return jobs.get(seed).promise;
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  jobs.set(seed, { promise, resolve });
  try { getWorker().postMessage({ seed, tier }); }
  catch { done.set(seed, null); resolve(null); }   // ohne Worker: wird später im Hauptthread erzeugt
  return promise;
}
export const isReady = (seed) => done.has(seed) && !!done.get(seed);
/** Fertiges Gebirge für den nächsten Moduswechsel bereitlegen (wird beim Übernehmen aus dem Speicher entfernt). */
export function use(seed) {
  const d = done.get(seed);
  done.delete(seed);
  if (d) HB.setPending(d);
  return !!d;
}
