// Ton komplett synthetisch (Web Audio): Fahrtwind, Kantengeräusch, Tore, Landung, Sturz.
export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  start() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (this.ctx = new AC());
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.8;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate * 2;
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuf = buf;
    const loop = (type, freq, q) => {
      const src = ctx.createBufferSource();
      src.buffer = buf; src.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = type; f.frequency.value = freq; f.Q.value = q;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(f); f.connect(g); g.connect(this.master);
      src.start();
      return { f, g };
    };
    this.wind = loop('bandpass', 500, 0.6);
    this.glide = loop('bandpass', 2600, 0.8);
    this.scrape = loop('highpass', 3500, 0.5);
    this.powder = loop('lowpass', 650, 0.3);
  }

  setMuted(m) {
    this.muted = m;
    if (this.master) this.master.gain.value = m ? 0 : 0.8;
  }

  update(speed, skid, edge, grounded, off, pow = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const s = Math.min(1, speed / 42);
    this.wind.g.gain.setTargetAtTime(s * s * 0.5 + (grounded ? 0 : 0.08), t, 0.1);
    this.wind.f.frequency.setTargetAtTime(350 + s * 900, t, 0.1);
    this.glide.g.gain.setTargetAtTime(grounded ? Math.min(0.22, s * 0.1 + edge * 0.12 + off * s * 0.1) : 0, t, 0.05);
    this.glide.f.frequency.setTargetAtTime(1800 + edge * 1500 - off * 900, t, 0.08);
    this.scrape.g.gain.setTargetAtTime(grounded ? Math.min(0.3, skid * 0.07) * (1 - 0.6 * pow) : 0, t, 0.04);
    // Tiefschnee: weiches, tiefes Rauschen, das mit Tempo und Kurvenlage anschwillt
    this.powder.g.gain.setTargetAtTime(grounded ? pow * Math.min(0.5, s * 0.55 + edge * 0.3) : 0, t, 0.12);
    this.powder.f.frequency.setTargetAtTime(420 + s * 500 + edge * 300, t, 0.1);
  }

  tone(freq, dur, type = 'sine', vol = 0.2, slide = 0, delay = 0) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.05);
  }

  burst(dur, freq, vol) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * 0.2), t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random()); src.stop(t + dur + 0.05);
  }

  gate() { this.tone(880, 0.12, 'triangle', 0.16); this.tone(1320, 0.2, 'triangle', 0.16, 0, 0.07); }
  miss() { this.tone(180, 0.3, 'sawtooth', 0.12, 0.6); }
  beep(hi) { this.tone(hi ? 1040 : 520, hi ? 0.5 : 0.18, 'square', 0.1); }
  land(i) { this.burst(0.25, 500 + i * 60, Math.min(0.6, 0.15 + i * 0.04)); }
  crash() { this.burst(0.6, 900, 0.7); this.tone(90, 0.4, 'sine', 0.4, 0.5); }
  flag() { this.burst(0.08, 2500, 0.2); }
  finish() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.35, 'triangle', 0.16, 0, i * 0.11)); }
}
