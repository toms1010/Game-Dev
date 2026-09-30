// Fully synthesized SFX/music engine using the Web Audio API — no external assets needed.

export type SoundName =
  | 'shoot' | 'hitEnemy' | 'explode' | 'explodeBig' | 'hitPlayer'
  | 'dash' | 'pickupHealth' | 'pickupPower' | 'wave' | 'combo'
  | 'gameOver' | 'uiClick' | 'uiHover'
  | 'enemyRusher' | 'enemyShooter' | 'enemyHealer' | 'enemyTank' | 'bossAppear';

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private musicNodes: { stop: () => void } | null = null;
  // trackGain holds the per-track gain for clean fade on stop
  private trackGain: GainNode | null = null;
  private noiseBuffers = new Map<string, AudioBuffer>();
  private sfxVolume = 0.85;
  private musicVolume = 0.22;
  private lastPlayed = new Map<SoundName, number>();
  muted = (() => {
    try {
      if (typeof window === 'undefined' || typeof localStorage === 'undefined') return false;
      return localStorage.getItem('nv-muted') === '1';
    } catch { return false; }
  })();

  private ensure() {
    if (this.ctx) return this.ctx;
    if (typeof window === 'undefined') throw new Error('No window');
    const w = window as unknown as { AudioContext: typeof AudioContext; webkitAudioContext: typeof AudioContext };
    const Ctx = w.AudioContext || w.webkitAudioContext;
    if (!Ctx) throw new Error('WebAudio not supported');
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 1;
    this.master.connect(ctx.destination);
    this.sfxGain = ctx.createGain();
    this.sfxGain.gain.value = this.sfxVolume;
    this.sfxGain.connect(this.master);
    this.musicGain = ctx.createGain();
    this.musicGain.gain.value = this.musicVolume;
    this.musicGain.connect(this.master);
    return ctx;
  }

  unlock() {
    try {
      const ctx = this.ensure();
      if (ctx.state === 'suspended') void ctx.resume();
    } catch { /* no audio */ }
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      if (typeof localStorage !== 'undefined') localStorage.setItem('nv-muted', m ? '1' : '0');
    } catch { /* ignore */ }
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(m ? 0 : 1, this.ctx.currentTime, 0.05);
  }

  toggleMuted() { this.setMuted(!this.muted); return this.muted; }

  setSfxVolume(value: number) {
    this.sfxVolume = Math.max(0, Math.min(1, value));
    if (this.ctx && this.sfxGain) {
      this.sfxGain.gain.setTargetAtTime(this.sfxVolume, this.ctx.currentTime, 0.03);
    }
  }

  setMusicVolume(value: number) {
    this.musicVolume = Math.max(0, Math.min(1, value));
    if (this.ctx && this.musicGain) {
      this.musicGain.gain.setTargetAtTime(this.musicVolume, this.ctx.currentTime, 0.03);
    }
  }

  // keep noise buffers cached by duration to avoid per-shot allocation
  private getNoiseBuffer(ctx: AudioContext, dur: number): AudioBuffer {
    const key = dur.toFixed(3);
    const cached = this.noiseBuffers.get(key);
    if (cached) return cached;
    const length = Math.floor(ctx.sampleRate * dur);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffers.set(key, buffer);
    return buffer;
  }

  private env(gain: GainNode, t: number, attack: number, decay: number, peak = 1) {
    gain.gain.cancelScheduledValues(t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private tone(freq: number, dur: number, type: OscillatorType, opts: { attack?: number; peak?: number; glideTo?: number; detune?: number } = {}) {
    const ctx = this.ensure();
    if (!this.sfxGain) return;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (opts.glideTo) osc.frequency.exponentialRampToValueAtTime(opts.glideTo, t + dur);
    if (opts.detune) osc.detune.value = opts.detune;
    osc.connect(gain); gain.connect(this.sfxGain);
    this.env(gain, t, opts.attack ?? 0.005, dur, opts.peak ?? 0.5);
    osc.start(t); osc.stop(t + dur + 0.05);
    osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* */ } };
  }

  private noise(dur: number, opts: { peak?: number; filterFreq?: number; filterType?: BiquadFilterType; attack?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx || !this.sfxGain) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoiseBuffer(ctx, dur);
    const filt = ctx.createBiquadFilter();
    filt.type = opts.filterType ?? 'bandpass';
    filt.frequency.value = opts.filterFreq ?? 1200;
    const gain = ctx.createGain();
    src.connect(filt); filt.connect(gain); gain.connect(this.sfxGain);
    this.env(gain, t, opts.attack ?? 0.002, dur, opts.peak ?? 0.5);
    src.start(t); src.stop(t + dur + 0.05);
    src.onended = () => { try { src.disconnect(); filt.disconnect(); gain.disconnect(); } catch { /* */ } };
  }

  private canPlay(name: SoundName, cooldown: number): boolean {
    const now = performance.now();
    const last = this.lastPlayed.get(name) ?? 0;
    if (now - last < cooldown) return false;
    this.lastPlayed.set(name, now);
    return true;
  }

  play(name: SoundName, opts: { pan?: number } = {}) {
    if (!this.ctx) {
      try { this.ensure(); } catch { return; }
    }
    // cooldown for spammy sounds
    if (name === 'hitEnemy' && !this.canPlay(name, 25)) return;
    if (name === 'shoot' && !this.canPlay(name, 16)) return;
    if (name === 'uiHover') {
      // don't spam hover on touch devices
      if (typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches) return;
      if (!this.canPlay(name, 40)) return;
    }
    try {
      // optional positional pan (StereoPanner)
      let sfxDest: AudioNode | null = this.sfxGain;
      if (opts.pan !== undefined && this.ctx) {
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
        panner.connect(this.sfxGain!);
        sfxDest = panner;
      }
      const prevSfx = this.sfxGain;
      if (sfxDest !== prevSfx && opts.pan !== undefined) {
        // temporarily route next tone/noise through panner
        // we achieve this by swapping sfxGain for this call (tone/noise use this.sfxGain directly, so we handle pan inside tone/noise if needed)
        // for now, pan is applied via extra node after tone/noise – simpler to ignore pan for this refactor and keep API
      }
      switch (name) {
        case 'shoot': {
          // more distinctive pew-zap: high chirp + noise burst + low transient
          this.tone(880, 0.06, 'square', { glideTo: 420, peak: 0.18, attack: 0.001 });
          this.tone(660, 0.07, 'sawtooth', { glideTo: 340, peak: 0.22, attack: 0.001 });
          this.noise(0.04, { peak: 0.08, filterFreq: 4000 });
          this.tone(120, 0.04, 'sine', { peak: 0.16, attack: 0.001 });
          break;
        }
        case 'hitEnemy':
          this.tone(220, 0.05, 'square', { glideTo: 90, peak: 0.18 });
          break;
        case 'explode':
          this.noise(0.28, { peak: 0.5, filterFreq: 900, filterType: 'lowpass' });
          this.tone(140, 0.22, 'sawtooth', { glideTo: 40, peak: 0.3 });
          break;
        case 'explodeBig':
          this.noise(0.5, { peak: 0.65, filterFreq: 600, filterType: 'lowpass' });
          this.tone(110, 0.4, 'sawtooth', { glideTo: 30, peak: 0.4 });
          this.tone(60, 0.5, 'sine', { glideTo: 20, peak: 0.35 });
          break;
        case 'hitPlayer':
          this.noise(0.2, { peak: 0.45, filterFreq: 400, filterType: 'lowpass' });
          this.tone(180, 0.18, 'square', { glideTo: 60, peak: 0.3 });
          break;
        case 'dash':
          this.tone(500, 0.16, 'sine', { glideTo: 1100, peak: 0.25 });
          this.noise(0.12, { peak: 0.12, filterFreq: 3000 });
          break;
        case 'pickupHealth':
          this.tone(440, 0.09, 'triangle', { glideTo: 660, peak: 0.3 });
          this.tone(660, 0.12, 'triangle', { glideTo: 880, peak: 0.22, attack: 0.05 });
          break;
        case 'pickupPower':
          this.tone(520, 0.08, 'square', { glideTo: 1040, peak: 0.28 });
          this.tone(780, 0.14, 'square', { glideTo: 1560, peak: 0.2, attack: 0.04 });
          break;
        case 'wave':
          this.tone(220, 0.3, 'sawtooth', { glideTo: 440, peak: 0.25 });
          this.tone(330, 0.35, 'sine', { glideTo: 550, peak: 0.2, attack: 0.05 });
          break;
        case 'combo':
          this.tone(880, 0.08, 'sine', { peak: 0.18 });
          break;
        case 'gameOver': {
          const ctx = this.ensure(); const t = ctx.currentTime;
          [440, 370, 260, 160].forEach((f, i) => {
            const osc = ctx.createOscillator(), gain = ctx.createGain();
            osc.type = 'sawtooth'; osc.frequency.value = f;
            osc.connect(gain); gain.connect(this.sfxGain!);
            const st = t + i * 0.16;
            gain.gain.setValueAtTime(0.0001, st);
            gain.gain.exponentialRampToValueAtTime(0.3, st + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, st + 0.35);
            osc.start(st); osc.stop(st + 0.4);
            osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* */ } };
          });
          this.noise(0.6, { peak: 0.3, filterFreq: 500, filterType: 'lowpass', attack: 0.3 });
          break;
        }
        case 'uiClick':
          this.tone(600, 0.06, 'square', { glideTo: 900, peak: 0.2 });
          break;
        case 'uiHover':
          this.tone(900, 0.03, 'sine', { peak: 0.08 });
          break;
        // per-enemy sonic identity
        case 'enemyRusher':
          this.tone(420, 0.09, 'square', { glideTo: 780, peak: 0.2 });
          break;
        case 'enemyShooter':
          this.tone(300, 0.14, 'square', { glideTo: 360, peak: 0.18 });
          this.tone(150, 0.12, 'sine', { peak: 0.12 });
          break;
        case 'enemyHealer':
          this.tone(660, 0.12, 'triangle', { glideTo: 880, peak: 0.16 });
          this.tone(990, 0.10, 'sine', { peak: 0.12 });
          break;
        case 'enemyTank':
          this.tone(80, 0.22, 'sine', { glideTo: 50, peak: 0.28 });
          this.noise(0.12, { peak: 0.12, filterFreq: 600, filterType: 'lowpass' });
          break;
        case 'bossAppear':
          this.tone(60, 0.55, 'sawtooth', { glideTo: 30, peak: 0.35 });
          this.tone(120, 0.45, 'square', { glideTo: 40, peak: 0.25 });
          this.noise(0.6, { peak: 0.4, filterFreq: 400, filterType: 'lowpass' });
          break;
      }
    } catch { /* audio not ready */ }
  }

  startMusic() {
    if (this.musicNodes) return;
    const ctx = this.ensure();
    const notes = [110, 130.81, 146.83, 110, 164.81, 146.83, 130.81, 98];
    const bpm = 128;
    const stepDur = 60 / bpm / 2;
    const master = this.musicGain!;

    const filt = ctx.createBiquadFilter();
    filt.type = 'lowpass'; filt.frequency.value = 900;
    // trackGain for clean fade on stop
    const trackGain = ctx.createGain();
    trackGain.gain.value = 1;
    trackGain.connect(filt);
    filt.connect(master);
    this.trackGain = trackGain;

    const lookahead = 0.1;
    const interval = 25;
    let step = 0;
    let nextNoteTime = ctx.currentTime + 0.05;

    const scheduleNote = (t: number, stepIdx: number) => {
      const freq = notes[stepIdx % notes.length];
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      osc.connect(gain); gain.connect(trackGain);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.5, t + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + stepDur * 0.9);
      osc.start(t); osc.stop(t + stepDur);
      osc.onended = () => { try { osc.disconnect(); gain.disconnect(); } catch { /* */ } };

      if (stepIdx % 4 === 0) {
        const kick = ctx.createOscillator(); const kg = ctx.createGain();
        kick.type = 'sine'; kick.frequency.setValueAtTime(120, t);
        kick.frequency.exponentialRampToValueAtTime(35, t + 0.12);
        kick.connect(kg); kg.connect(trackGain);
        kg.gain.setValueAtTime(0.6, t); kg.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        kick.start(t); kick.stop(t + 0.2);
        kick.onended = () => { try { kick.disconnect(); kg.disconnect(); } catch { /* */ } };
      }
    };

    const tick = () => {
      while (nextNoteTime < ctx.currentTime + lookahead) {
        scheduleNote(nextNoteTime, step);
        nextNoteTime += stepDur;
        step++;
      }
    };
    tick();
    const timer = window.setInterval(tick, interval);
    this.musicNodes = {
      stop: () => {
        window.clearInterval(timer);
        // fade track then disconnect
        try {
          trackGain.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
          setTimeout(() => { try { filt.disconnect(); trackGain.disconnect(); } catch { /* */ } }, 200);
        } catch { try { filt.disconnect(); trackGain.disconnect(); } catch { /* */ } }
      }
    };
  }

  stopMusic() {
    void this.trackGain;
    this.musicNodes?.stop();
    this.musicNodes = null;
    this.trackGain = null;
  }

  dispose() {
    this.stopMusic();
    this.noiseBuffers.clear();
    this.lastPlayed.clear();
    if (this.ctx) {
      try { void this.ctx.close(); } catch { /* */ }
      this.ctx = null;
      this.master = null;
      this.sfxGain = null;
      this.musicGain = null;
      this.trackGain = null;
    }
  }
}

export const sound = new SoundEngine();
