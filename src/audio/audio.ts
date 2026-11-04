/**
 * Procedural sound (Web Audio API) — no audio assets required.
 * - Thruster whine/hum driven by the real thruster outputs.
 * - Underwater ambience (low rumble) vs. surface (wind/waves).
 * - One-shots: splash, contact knock, UI click.
 * The context is created on the first user gesture (browser autoplay rules).
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private thrustOsc!: OscillatorNode;
  private thrustOsc2!: OscillatorNode;
  private thrustGain!: GainNode;
  private thrustFilter!: BiquadFilterNode;
  private ambUnder!: GainNode;
  private ambSurface!: GainNode;
  private noiseBuffer!: AudioBuffer;
  volume = 0.7;

  /** Must be called from a user gesture. */
  init(): void {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);

    // Noise buffer (brown-ish).
    const len = ctx.sampleRate * 3;
    this.noiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuffer.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const w = Math.random() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5;
    }

    // Thrusters: two detuned saw oscillators through a low-pass + noise.
    this.thrustFilter = ctx.createBiquadFilter();
    this.thrustFilter.type = 'lowpass';
    this.thrustFilter.frequency.value = 400;
    this.thrustGain = ctx.createGain();
    this.thrustGain.gain.value = 0;
    this.thrustOsc = ctx.createOscillator();
    this.thrustOsc.type = 'sawtooth';
    this.thrustOsc.frequency.value = 60;
    this.thrustOsc2 = ctx.createOscillator();
    this.thrustOsc2.type = 'triangle';
    this.thrustOsc2.frequency.value = 121;
    const o2g = ctx.createGain();
    o2g.gain.value = 0.5;
    this.thrustOsc.connect(this.thrustFilter);
    this.thrustOsc2.connect(o2g).connect(this.thrustFilter);
    const tNoise = this.noiseSource();
    const tNoiseG = ctx.createGain();
    tNoiseG.gain.value = 0.6;
    tNoise.connect(tNoiseG).connect(this.thrustFilter);
    this.thrustFilter.connect(this.thrustGain).connect(this.master);
    this.thrustOsc.start();
    this.thrustOsc2.start();

    // Ambience.
    const under = this.noiseSource();
    const uf = ctx.createBiquadFilter();
    uf.type = 'lowpass';
    uf.frequency.value = 180;
    this.ambUnder = ctx.createGain();
    this.ambUnder.gain.value = 0;
    under.connect(uf).connect(this.ambUnder).connect(this.master);
    const surf = this.noiseSource();
    const sf = ctx.createBiquadFilter();
    sf.type = 'bandpass';
    sf.frequency.value = 900;
    sf.Q.value = 0.4;
    this.ambSurface = ctx.createGain();
    this.ambSurface.gain.value = 0;
    surf.connect(sf).connect(this.ambSurface).connect(this.master);
  }

  private noiseSource(): AudioBufferSourceNode {
    const src = this.ctx!.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.loopStart = Math.random();
    src.start(0, Math.random() * 2);
    return src;
  }

  setVolume(v: number): void {
    this.volume = v;
    if (this.ctx) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.05);
  }

  suspend(paused: boolean): void {
    if (!this.ctx) return;
    if (paused) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  /**
   * @param load mean absolute thruster output 0..1
   * @param underwater camera below the surface
   * @param distanceToRov metres between the listener (camera) and the vehicle
   */
  update(load: number, underwater: boolean, distanceToRov: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const near = 1 / (1 + Math.max(0, distanceToRov - 1) * 0.12);
    const l = Math.min(1, load);
    this.thrustOsc.frequency.setTargetAtTime(48 + l * 170, now, 0.12);
    this.thrustOsc2.frequency.setTargetAtTime(97 + l * 330, now, 0.12);
    this.thrustFilter.frequency.setTargetAtTime(underwater ? 220 + l * 900 : 600 + l * 2500, now, 0.1);
    this.thrustGain.gain.setTargetAtTime((0.015 + l * 0.22) * near * (underwater ? 1 : 0.5), now, 0.08);
    this.ambUnder.gain.setTargetAtTime(underwater ? 0.35 : 0, now, 0.3);
    this.ambSurface.gain.setTargetAtTime(underwater ? 0 : 0.12, now, 0.3);
  }

  splash(): void {
    this.burst(0.6, 1200, 0.9, 'bandpass');
  }

  knock(strength: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, now);
    o.frequency.exponentialRampToValueAtTime(45, now + 0.25);
    const g = ctx.createGain();
    g.gain.setValueAtTime(Math.min(1, 0.3 + strength * 0.6), now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
    o.connect(g).connect(this.master);
    o.start(now);
    o.stop(now + 0.45);
    this.burst(0.15, 400, 0.4 * Math.min(1, strength), 'lowpass');
  }

  click(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const o = ctx.createOscillator();
    o.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.06);
    o.connect(g).connect(this.master);
    o.start(now);
    o.stop(now + 0.07);
  }

  private burst(duration: number, freq: number, gain: number, type: BiquadFilterType): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + duration);
    src.connect(f).connect(g).connect(this.master);
    src.start(now, Math.random());
    src.stop(now + duration + 0.05);
  }
}
