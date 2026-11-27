// Procedural WebAudio sounds: no asset files needed. Swap these out for samples later.
export class Audio {
  constructor() { this.ctx = null; this.master = null; }

  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { return; }
    const ctx = this.ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);
    // Small synthetic reverb for the shot tail.
    this.reverb = ctx.createConvolver();
    const len = ctx.sampleRate * 1.4, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3.2);
    }
    this.reverb.buffer = ir;
    const rv = ctx.createGain(); rv.gain.value = 0.28;
    this.reverb.connect(rv).connect(this.master);
    this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }

  _noise(t, dur, { type = 'lowpass', freq = 2000, q = 0.7, gain = 1, attack = 0.001, decay = dur, toReverb = false } = {}) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource(); src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0008, t + decay);
    src.connect(f).connect(g).connect(this.master);
    if (toReverb) g.connect(this.reverb);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  _tone(t, freq, dur, { type = 'sine', gain = 0.3, endFreq = freq } = {}) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(); o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0008, t + dur);
    o.connect(g).connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  /** Continuous hum (grab tool beam). Call every frame with a 0..1 level and a pitch factor. */
  hum(level, pitch = 1) {
    if (!this.ctx) return;
    if (!this.humNodes) {
      const ctx = this.ctx;
      const o1 = ctx.createOscillator(); o1.type = 'sawtooth'; o1.frequency.value = 110;
      const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 223;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700;
      const g = ctx.createGain(); g.gain.value = 0;
      o1.connect(f); o2.connect(f); f.connect(g).connect(this.master);
      o1.start(); o2.start();
      this.humNodes = { o1, o2, f, g };
    }
    const { o1, o2, g, f } = this.humNodes, t = this.ctx.currentTime;
    g.gain.setTargetAtTime(level * 0.06, t, 0.05);
    o1.frequency.setTargetAtTime(110 * pitch, t, 0.05);
    o2.frequency.setTargetAtTime(223 * pitch, t, 0.05);
    f.frequency.setTargetAtTime(500 + 600 * pitch, t, 0.05);
  }

  /** Defibrillator charging whine: rises in pitch over dur seconds. Returns a stop() function. */
  charge(dur = 1.1) {
    if (!this.ctx) return () => {};
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(500, t); o.frequency.exponentialRampToValueAtTime(3400, t + dur);
    const o2 = ctx.createOscillator(); o2.type = 'triangle';
    o2.frequency.setValueAtTime(1000, t); o2.frequency.exponentialRampToValueAtTime(6800, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(0.07, t + dur);
    o.connect(g); o2.connect(g); g.connect(this.master);
    o.start(t); o2.start(t);
    // charged: a steady ready beep until it is used
    let stopped = false;
    const stop = () => {
      if (stopped) return; stopped = true;
      const n = ctx.currentTime;
      g.gain.cancelScheduledValues(n); g.gain.setValueAtTime(g.gain.value, n); g.gain.linearRampToValueAtTime(0.0001, n + 0.05);
      o.stop(n + 0.06); o2.stop(n + 0.06);
    };
    return stop;
  }

  /** Grenade explosion; quieter and duller with distance (d in metres). */
  boom(d = 5) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const near = Math.max(0.15, Math.min(1.4, 9 / (d + 4)));
    const lp = 600 + 5000 * Math.min(1, 12 / (d + 6));
    this._noise(t, 2.2, { freq: lp, gain: 1.35 * near, decay: 1.7, toReverb: true });
    this._noise(t, 0.25, { type: 'highpass', freq: 1500, gain: 0.65 * near * near, decay: 0.12 });
    this._tone(t, 70, 1.0, { gain: 1.3 * near, endFreq: 22 });
    this._tone(t, 46, 1.5, { gain: 0.9 * near, endFreq: 18 });   // deep thump you feel more than hear
    // the echo coming back off the far walls
    this._noise(t + 0.35 + Math.min(0.4, d * 0.01), 1.2, { freq: 900, gain: 0.35 * near, decay: 1.0, toReverb: true });
    this._tone(t, 140, 0.35, { gain: 0.6 * near, type: 'triangle', endFreq: 40 });
    // debris pattering down afterwards
    for (let i = 0; i < 6; i++) this._noise(t + 0.3 + Math.random() * 0.9, 0.05, { type: 'bandpass', freq: 1800 + Math.random() * 2000, q: 2, gain: 0.12 * near, decay: 0.04 });
  }

  play(name) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    switch (name) {
      case 'shot':
        this._noise(t, 0.35, { freq: 5200, gain: 1.0, decay: 0.28, toReverb: true });
        this._noise(t, 0.12, { type: 'highpass', freq: 2500, gain: 0.5, decay: 0.06 });
        this._tone(t, 140, 0.22, { gain: 0.9, endFreq: 38 });
        break;
      case 'dry': this._noise(t, 0.04, { type: 'bandpass', freq: 3200, q: 4, gain: 0.5, decay: 0.03 }); break;
      case 'magOut': this._noise(t, 0.08, { type: 'bandpass', freq: 1800, q: 3, gain: 0.5, decay: 0.07 }); this._tone(t, 900, 0.05, { gain: 0.08, type: 'square' }); break;
      case 'magIn': this._noise(t, 0.08, { type: 'bandpass', freq: 1400, q: 3, gain: 0.8, decay: 0.07 }); this._tone(t + 0.01, 600, 0.04, { gain: 0.1, type: 'square' }); break;
      case 'slide': this._noise(t, 0.14, { type: 'bandpass', freq: 2400, q: 2, gain: 0.55, decay: 0.12 }); this._noise(t + 0.08, 0.05, { type: 'bandpass', freq: 3500, q: 5, gain: 0.6, decay: 0.04 }); break;
      case 'click': this._noise(t, 0.03, { type: 'bandpass', freq: 4000, q: 6, gain: 0.35, decay: 0.025 }); break;
      case 'casing': { const f = 3800 + Math.random() * 1600; this._tone(t, f, 0.12, { gain: 0.05, endFreq: f * 0.98 }); this._tone(t + 0.09, f * 1.1, 0.08, { gain: 0.03 }); break; }
      case 'flesh': this._noise(t, 0.12, { freq: 700, gain: 0.7, decay: 0.1 }); this._tone(t, 90, 0.08, { gain: 0.3, endFreq: 50 }); break;
      case 'bone': this._noise(t, 0.08, { type: 'bandpass', freq: 1600, q: 2, gain: 0.7, decay: 0.06 }); break;
      case 'concrete': this._noise(t, 0.1, { type: 'bandpass', freq: 2600, q: 1.2, gain: 0.45, decay: 0.08 }); break;
      case 'splat': this._noise(t, 0.15, { freq: 500, gain: 0.35, decay: 0.12 }); break;
      case 'button': this._tone(t, 520, 0.08, { gain: 0.15, type: 'square', endFreq: 500 }); this._tone(t + 0.09, 780, 0.12, { gain: 0.12, type: 'square', endFreq: 770 }); break;
      case 'thud': this._noise(t, 0.12, { freq: 300, gain: 0.5, decay: 0.1 }); break;
      // grab tool
      case 'grab': this._tone(t, 220, 0.25, { gain: 0.12, type: 'sawtooth', endFreq: 880 }); this._tone(t, 1320, 0.18, { gain: 0.05, endFreq: 1760 }); this._noise(t, 0.1, { type: 'highpass', freq: 3000, gain: 0.25, decay: 0.08 }); break;
      case 'drop': this._tone(t, 660, 0.2, { gain: 0.08, type: 'sawtooth', endFreq: 160 }); break;
      case 'throw': this._noise(t, 0.35, { type: 'bandpass', freq: 900, q: 0.8, gain: 0.7, decay: 0.3, toReverb: true }); this._tone(t, 180, 0.3, { gain: 0.25, type: 'sawtooth', endFreq: 60 }); this._tone(t, 1600, 0.12, { gain: 0.06, endFreq: 3200 }); break;
      case 'deny': this._tone(t, 180, 0.12, { gain: 0.1, type: 'square', endFreq: 150 }); break;
      case 'equip': this._noise(t, 0.08, { type: 'bandpass', freq: 1200, q: 2, gain: 0.35, decay: 0.07 }); this._tone(t + 0.05, 1500, 0.04, { gain: 0.05, type: 'square' }); break;
      // shotgun
      case 'shotgun':
        this._noise(t, 0.6, { freq: 3800, gain: 1.15, decay: 0.45, toReverb: true });
        this._noise(t, 0.16, { type: 'highpass', freq: 1800, gain: 0.7, decay: 0.09 });
        this._tone(t, 95, 0.4, { gain: 1.1, endFreq: 30 });
        this._tone(t, 220, 0.12, { gain: 0.35, type: 'triangle', endFreq: 60 });
        break;
      case 'pumpBack': this._noise(t, 0.09, { type: 'bandpass', freq: 1500, q: 2.5, gain: 0.7, decay: 0.08 }); this._noise(t + 0.06, 0.05, { type: 'bandpass', freq: 2600, q: 5, gain: 0.55, decay: 0.04 }); break;
      case 'pumpFwd': this._noise(t, 0.08, { type: 'bandpass', freq: 1900, q: 2.5, gain: 0.7, decay: 0.07 }); this._noise(t + 0.05, 0.05, { type: 'bandpass', freq: 3400, q: 6, gain: 0.6, decay: 0.035 }); this._tone(t + 0.05, 700, 0.05, { gain: 0.06, type: 'square' }); break;
      case 'shellIn': this._noise(t, 0.07, { type: 'bandpass', freq: 1100, q: 3, gain: 0.6, decay: 0.06 }); this._tone(t + 0.03, 420, 0.06, { gain: 0.1, type: 'square', endFreq: 380 }); break;
      case 'hull': { const f = 900 + Math.random() * 300; this._tone(t, f, 0.08, { gain: 0.06, type: 'triangle', endFreq: f * 0.8 }); this._noise(t, 0.05, { type: 'bandpass', freq: 1200, q: 2, gain: 0.15, decay: 0.04 }); break; }
      // fists
      case 'swing': this._noise(t, 0.22, { type: 'bandpass', freq: 1300 + Math.random() * 500, q: 1.6, gain: 0.5, attack: 0.06, decay: 0.2 }); break;
      case 'slice': this._noise(t, 0.16, { type: 'bandpass', freq: 2200, q: 1.2, gain: 0.65, decay: 0.13 }); this._noise(t, 0.12, { freq: 600, gain: 0.6, decay: 0.1 }); this._tone(t, 110, 0.08, { gain: 0.25, endFreq: 60 }); break;
      case 'stab': this._noise(t, 0.14, { freq: 450, gain: 0.95, decay: 0.12 }); this._tone(t, 85, 0.12, { gain: 0.45, endFreq: 45 }); this._noise(t + 0.05, 0.12, { type: 'bandpass', freq: 1600, q: 2, gain: 0.35, decay: 0.1 }); break;
      case 'clang': { const f = 1800 + Math.random() * 600; this._tone(t, f, 0.35, { gain: 0.12, type: 'triangle', endFreq: f * 0.97 }); this._tone(t, f * 2.7, 0.22, { gain: 0.05, endFreq: f * 2.6 }); this._noise(t, 0.06, { type: 'highpass', freq: 3500, gain: 0.45, decay: 0.05 }); break; }
      case 'zip': this._noise(t, 0.28, { type: 'bandpass', freq: 3600, q: 3, gain: 0.3, attack: 0.02, decay: 0.26 }); break;
      case 'tape': this._noise(t, 0.4, { type: 'bandpass', freq: 2600, q: 1.5, gain: 0.32, attack: 0.03, decay: 0.38 }); this._noise(t + 0.25, 0.25, { type: 'bandpass', freq: 3200, q: 2, gain: 0.25, decay: 0.22 }); break;
      case 'inject': this._noise(t, 0.04, { type: 'bandpass', freq: 3000, q: 4, gain: 0.5, decay: 0.03 }); this._noise(t + 0.04, 0.45, { type: 'highpass', freq: 5000, gain: 0.12, attack: 0.05, decay: 0.42 }); break;
      case 'zap':
        this._noise(t, 0.22, { type: 'highpass', freq: 1800, gain: 1.0, decay: 0.2, toReverb: true });
        this._tone(t, 120, 0.25, { gain: 0.5, type: 'sawtooth', endFreq: 60 });
        this._tone(t, 60, 0.3, { gain: 0.6, type: 'square', endFreq: 40 });
        break;
      case 'beep': this._tone(t, 1250, 0.12, { gain: 0.08, type: 'square', endFreq: 1240 }); break;
      case 'beepGood': this._tone(t, 880, 0.1, { gain: 0.08, type: 'square', endFreq: 880 }); this._tone(t + 0.13, 1320, 0.16, { gain: 0.08, type: 'square', endFreq: 1320 }); break;
      case 'whoosh': this._noise(t, 0.16, { type: 'bandpass', freq: 700 + Math.random() * 300, q: 1.2, gain: 0.35, attack: 0.05, decay: 0.15 }); break;
      case 'punch': this._noise(t, 0.1, { freq: 900, gain: 0.9, decay: 0.08 }); this._tone(t, 120, 0.09, { gain: 0.55, endFreq: 55 }); this._noise(t, 0.03, { type: 'highpass', freq: 3000, gain: 0.25, decay: 0.02 }); break;
      case 'punchHard': this._noise(t, 0.14, { freq: 700, gain: 1.0, decay: 0.12, toReverb: true }); this._tone(t, 100, 0.14, { gain: 0.7, endFreq: 42 }); this._noise(t, 0.04, { type: 'highpass', freq: 2600, gain: 0.35, decay: 0.03 }); break;
      // grenade
      case 'pin': this._tone(t, 2600, 0.05, { gain: 0.08, type: 'triangle', endFreq: 2400 }); this._noise(t, 0.05, { type: 'bandpass', freq: 5000, q: 4, gain: 0.3, decay: 0.04 }); this._tone(t + 0.07, 3200, 0.1, { gain: 0.05, endFreq: 3100 }); break;
      case 'spoon': this._tone(t, 1900, 0.18, { gain: 0.06, type: 'triangle', endFreq: 1700 }); this._tone(t + 0.02, 2900, 0.14, { gain: 0.04, endFreq: 2800 }); break;
      case 'clink': { const f = 600 + Math.random() * 250; this._tone(t, f, 0.12, { gain: 0.12, type: 'triangle', endFreq: f * 0.85 }); this._noise(t, 0.05, { type: 'bandpass', freq: 1500, q: 2, gain: 0.3, decay: 0.04 }); break; }
      case 'timeSlow': this._tone(t, 520, 0.45, { gain: 0.14, endFreq: 130 }); break;
      case 'timeFast': this._tone(t, 180, 0.3, { gain: 0.12, endFreq: 720 }); break;
    }
  }
}
