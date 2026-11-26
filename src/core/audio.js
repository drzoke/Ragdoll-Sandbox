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
      case 'timeSlow': this._tone(t, 520, 0.45, { gain: 0.14, endFreq: 130 }); break;
      case 'timeFast': this._tone(t, 180, 0.3, { gain: 0.12, endFreq: 720 }); break;
    }
  }
}
