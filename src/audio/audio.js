// Everything you hear is synthesised live: a slow generative score, wind, water, birds,
// crickets at golden hour, and footsteps. No audio files.

const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);

// Dmaj9 → Bm11 → Gmaj9(#11) → Asus/E  — slow and open.
const CHORDS = [
  [50, 57, 61, 64, 66],
  [47, 54, 57, 62, 64],
  [43, 50, 54, 57, 61],
  [45, 52, 57, 59, 64],
];
const SCALE = [62, 64, 66, 69, 71, 74, 76, 78, 81, 83]; // D major pentatonic, two octaves

export class Soundscape {
  constructor() {
    this.ctx = null;
    this.musicVol = 0.8;
    this.natureVol = 0.9;
    this.started = false;
  }

  start() {
    if (this.started) { this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = (this.ctx = new AC());
    this.started = true;

    this.master = ctx.createGain();
    this.master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3;
    this.master.connect(comp).connect(ctx.destination);
    this.master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 4);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = this.impulse(4.2, 2.6);
    const revOut = ctx.createGain(); revOut.gain.value = 0.9;
    this.reverb.connect(revOut).connect(this.master);

    this.music = ctx.createGain(); this.music.gain.value = this.musicVol * 0.55;
    this.music.connect(this.master);
    this.musicSend = ctx.createGain(); this.musicSend.gain.value = 0.7;
    this.music.connect(this.musicSend).connect(this.reverb);

    this.nature = ctx.createGain(); this.nature.gain.value = this.natureVol;
    this.nature.connect(this.master);
    this.natureSend = ctx.createGain(); this.natureSend.gain.value = 0.25;
    this.nature.connect(this.natureSend).connect(this.reverb);

    this.noise = this.noiseBuffer(4);
    this.buildAmbience();
    this.chord = 0;
    this.bar = 0;
    this.nextChord = ctx.currentTime + 0.5;
    this.nextNote = ctx.currentTime + 3;
    this.nextBird = ctx.currentTime + 1.5;
    this.lastNote = 4;
    this.silentCycle = false;
  }

  impulse(sec, decay) {
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        lp = lp * 0.6 + (Math.random() * 2 - 1) * 0.4;
        d[i] = lp * Math.pow(1 - i / len, decay);
      }
    }
    return buf;
  }

  noiseBuffer(sec) {
    const ctx = this.ctx, len = Math.floor(ctx.sampleRate * sec);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  loopNoise(filterType, freq, q, gain, dest) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    src.playbackRate.value = 0.5 + Math.random() * 0.5;
    const f = ctx.createBiquadFilter(); f.type = filterType; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); g.gain.value = gain;
    src.connect(f).connect(g).connect(dest);
    src.start();
    return { f, g };
  }

  buildAmbience() {
    this.wind = this.loopNoise('bandpass', 380, 0.6, 0.0, this.nature);
    this.leaves = this.loopNoise('highpass', 3500, 0.5, 0.0, this.nature);
    this.water = this.loopNoise('lowpass', 650, 0.7, 0.0, this.nature);
    this.fall = this.loopNoise('bandpass', 900, 0.4, 0.0, this.nature);
    this.gust = 0.5;

    // Crickets: a high tone gated by fast pulses
    const ctx = this.ctx;
    const osc = ctx.createOscillator(); osc.frequency.value = 4400;
    const am = ctx.createGain(); am.gain.value = 0;
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 28;
    const lfoG = ctx.createGain(); lfoG.gain.value = 0.5;
    lfo.connect(lfoG).connect(am.gain);
    const cr = ctx.createGain(); cr.gain.value = 0;
    osc.connect(am).connect(cr).connect(this.nature);
    osc.start(); lfo.start();
    this.crickets = cr;
  }

  setMusic(v) { this.musicVol = v; if (this.music) this.music.gain.setTargetAtTime(v * 0.55, this.ctx.currentTime, 0.3); }
  setNature(v) { this.natureVol = v; if (this.nature) this.nature.gain.setTargetAtTime(v, this.ctx.currentTime, 0.3); }

  // --- music voices ---
  pad(notes, t, dur) {
    const ctx = this.ctx;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; lp.Q.value = 0.3;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 3.5);
    g.gain.setValueAtTime(0.05, t + dur - 1);
    g.gain.linearRampToValueAtTime(0, t + dur + 4);
    lp.connect(g).connect(this.music);
    for (const n of notes) {
      for (const [type, det, vol] of [['sine', -5, 0.5], ['triangle', 6, 0.35]]) {
        const o = ctx.createOscillator(); o.type = type; o.frequency.value = midi(n); o.detune.value = det;
        const og = ctx.createGain(); og.gain.value = vol * (n < 50 ? 0.9 : 0.6);
        o.connect(og).connect(lp);
        o.start(t); o.stop(t + dur + 4.5);
      }
    }
  }

  bell(n, t, vol = 0.12) {
    const ctx = this.ctx;
    const f = midi(n);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 3.2);
    const pan = ctx.createStereoPanner(); pan.pan.value = (Math.random() - 0.5) * 0.6;
    g.connect(pan).connect(this.music);
    for (const [ratio, amp] of [[1, 1], [2, 0.28], [3.01, 0.08], [4.2, 0.05]]) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = f * ratio;
      const og = ctx.createGain(); og.gain.value = amp;
      o.connect(og).connect(g);
      o.start(t); o.stop(t + 3.3);
    }
  }

  chime() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + 0.05;
    [74, 78, 81, 86].forEach((n, i) => this.bell(n, t + i * 0.16, 0.1));
  }

  // --- nature voices ---
  bird(daylight) {
    const ctx = this.ctx, t = ctx.currentTime + 0.02;
    const out = ctx.createGain(); out.gain.value = (0.02 + Math.random() * 0.045) * daylight;
    const pan = ctx.createStereoPanner(); pan.pan.value = Math.random() * 2 - 1;
    out.connect(pan).connect(this.nature);
    const kind = Math.random();
    const chirp = (start, f0, f1, len, v = 1) => {
      const o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(f0, start);
      o.frequency.exponentialRampToValueAtTime(f1, start + len);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(v, start + len * 0.2);
      g.gain.linearRampToValueAtTime(0, start + len);
      o.connect(g).connect(out);
      o.start(start); o.stop(start + len + 0.02);
    };
    if (kind < 0.4) {
      // melodic whistle
      const base = 2400 + Math.random() * 1400;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const f = base * (1 + (Math.random() - 0.4) * 0.35);
        chirp(t + i * 0.2, f, f * (0.9 + Math.random() * 0.3), 0.15 + Math.random() * 0.08);
      }
    } else if (kind < 0.75) {
      // trill
      const n = 6 + Math.floor(Math.random() * 8);
      const f = 4200 + Math.random() * 1500;
      for (let i = 0; i < n; i++) chirp(t + i * 0.055, f, f * 0.7, 0.045, 0.8);
    } else {
      // soft two-note call from further away
      const f = 700 + Math.random() * 250;
      out.gain.value *= 0.8;
      chirp(t, f, f * 0.98, 0.32, 1);
      chirp(t + 0.45, f * 0.84, f * 0.82, 0.42, 1);
    }
  }

  footstep(surface, strength = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const off = Math.random() * 3;
    const f = ctx.createBiquadFilter();
    const g = ctx.createGain();
    let len = 0.07, vol = 0.05;
    if (surface === 'water') { f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.8; len = 0.22; vol = 0.07; }
    else if (surface === 'wood') { f.type = 'lowpass'; f.frequency.value = 500; len = 0.09; vol = 0.1; }
    else if (surface === 'stone' || surface === 'path') { f.type = 'bandpass'; f.frequency.value = 1400; f.Q.value = 1.2; len = 0.06; vol = 0.045; }
    else { f.type = 'bandpass'; f.frequency.value = 2600; f.Q.value = 0.7; vol = 0.035; }
    vol *= 0.6 + 0.5 * strength;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + len);
    src.connect(f).connect(g).connect(this.nature);
    src.start(t, off, len + 0.02);
    if (surface === 'wood') {
      const o = ctx.createOscillator(); o.frequency.value = 150 + Math.random() * 30;
      const og = ctx.createGain(); og.gain.setValueAtTime(0.05, t); og.gain.exponentialRampToValueAtTime(0.0005, t + 0.1);
      o.connect(og).connect(this.nature); o.start(t); o.stop(t + 0.12);
    }
  }

  // --- fishing sounds ---
  plop() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(240, t + 0.12);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.09, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.18);
    o.connect(g).connect(this.nature); o.start(t); o.stop(t + 0.2);
  }
  tick() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 1500;
    const g = ctx.createGain(); g.gain.setValueAtTime(0.03, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.05);
    o.connect(g).connect(this.nature); o.start(t); o.stop(t + 0.06);
  }
  whoosh() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(600, t); f.frequency.exponentialRampToValueAtTime(2400, t + 0.25);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.06, t + 0.08); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.35);
    src.connect(f).connect(g).connect(this.nature); src.start(t, Math.random(), 0.4);
  }
  reel() {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    for (let i = 0; i < 14; i++) setTimeout(() => this.tick(), i * 70 + Math.random() * 20);
    return t0;
  }

  splash() {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const src = ctx.createBufferSource(); src.buffer = this.noise;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(2500, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.6);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.12, t); g.gain.exponentialRampToValueAtTime(0.0005, t + 0.7);
    src.connect(f).connect(g).connect(this.nature);
    src.start(t, 0, 0.8);
  }

  // Called every frame with where the listener is and what's around them.
  update(dt, info) {
    if (!this.ctx || this.ctx.state !== 'running') return;
    const ctx = this.ctx, now = ctx.currentTime;

    // Music scheduler: long chords, sparse bell melody, an occasional breath of silence.
    if (now > this.nextChord - 0.1) {
      const len = 11;
      if (!this.silentCycle) this.pad(CHORDS[this.chord], this.nextChord, len);
      if (!this.silentCycle && Math.random() < 0.5) {
        const c = CHORDS[this.chord];
        [c[1] + 12, c[2] + 12, c[3] + 12, c[4] + 12].forEach((n, i) => this.bell(n, this.nextChord + 0.4 + i * 0.22, 0.05));
      }
      this.chord = (this.chord + 1) % CHORDS.length;
      if (this.chord === 0) { this.bar++; this.silentCycle = this.bar % 3 === 2; }
      this.nextChord += len;
    }
    if (now > this.nextNote && !this.silentCycle) {
      this.lastNote = Math.max(0, Math.min(SCALE.length - 1, this.lastNote + Math.floor(Math.random() * 5) - 2));
      this.bell(SCALE[this.lastNote], now + 0.05, 0.07 + Math.random() * 0.05);
      if (Math.random() < 0.25) this.bell(SCALE[Math.max(0, this.lastNote - 2)], now + 0.4, 0.05);
      this.nextNote = now + 1.6 + Math.random() * 3.8;
    }

    // Wind gusts wander slowly
    this.gust += (Math.random() - 0.5) * dt * 0.6;
    this.gust = Math.min(1, Math.max(0.15, this.gust));
    const high = Math.min(1, Math.max(0, (info.height - 8) / 40));
    this.wind.g.gain.setTargetAtTime(0.05 + this.gust * 0.08 + high * 0.08, now, 0.8);
    this.wind.f.frequency.setTargetAtTime(300 + this.gust * 300, now, 1.2);
    this.leaves.g.gain.setTargetAtTime(info.trees * (0.004 + this.gust * 0.012), now, 0.8);

    const lap = 0.5 + 0.5 * Math.sin(now * 0.9);
    this.water.g.gain.setTargetAtTime(info.shore * (0.05 + lap * 0.05) + (info.swimming ? 0.08 : 0), now, 0.4);
    this.fall.g.gain.setTargetAtTime(Math.min(0.28, 6 / Math.max(info.fallDist, 6) * 0.28), now, 0.5);
    this.crickets.gain.setTargetAtTime(0.004 + info.golden * 0.012, now, 1.5);

    if (now > this.nextBird) {
      const daylight = 1 - info.golden * 0.6;
      this.bird(daylight * (0.6 + info.trees * 0.6));
      this.nextBird = now + (info.jungle > 0.5 ? 0.8 : 1.6) + Math.random() * 4.5;
    }
  }

  pause(on) {
    if (!this.ctx) return;
    this.master.gain.setTargetAtTime(on ? 0.25 : 0.9, this.ctx.currentTime, 0.4);
  }
}
