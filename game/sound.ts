// Sound effects for the big screen, synthesized with Web Audio (no sound files, nothing to
// download, all ours). Phones stay silent to save battery; they buzz instead.
// Browsers only allow audio after a user gesture, so the context starts on the first
// click or key press on the host page.

import type { Card } from "../shared/rules";

export type SoundName =
  | "beep" | "go" | "lap" | "finalLap" | "finish" | "glitch" | "react" | "draft" | "vote" | "caught" | "innocent" | "podium"
  | "lava" | "crabs" | `trap.${Card}`;

const MUTE_KEY = "tt-muted";

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem(MUTE_KEY) === "1";
    } catch {}
  }

  /** Call from a user gesture (click / key). Safe to call many times. */
  unlock() {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem(MUTE_KEY, m ? "1" : "0");
    } catch {}
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.5, this.ctx.currentTime, 0.02);
  }

  play(name: SoundName) {
    const c = this.ctx;
    if (!c || this.muted || c.state !== "running") return;
    const t = c.currentTime;
    switch (name) {
      case "beep": return this.tone(t, 660, 0.15, "square", 0.25);
      case "go": return this.tone(t, 990, 0.45, "square", 0.3);
      case "lap": return (this.tone(t, 880, 0.08, "triangle", 0.3), this.tone(t + 0.09, 1320, 0.12, "triangle", 0.3));
      case "finalLap": return [0, 0.12, 0.24].forEach((d, i) => this.tone(t + d, [660, 880, 1100][i], 0.12, "square", 0.22));
      case "finish": return [523, 659, 784, 1046].forEach((f, i) => this.tone(t + i * 0.1, f, 0.22, "triangle", 0.3));
      case "podium": return [523, 659, 784, 659, 784, 1046].forEach((f, i) => this.tone(t + i * 0.13, f, i === 5 ? 0.6 : 0.16, "triangle", 0.3));
      case "glitch": return (this.noise(t, 0.4, 3000, 0.35, "bandpass"), this.tone(t, 120, 0.35, "sawtooth", 0.12, 60));
      case "react": return this.tone(t, 900 + Math.random() * 500, 0.06, "sine", 0.15, 1600);
      case "draft": return this.noise(t, 0.35, 1200, 0.2, "lowpass", 4000);
      case "vote": return (this.tone(t, 220, 0.3, "sawtooth", 0.12), this.tone(t + 0.15, 196, 0.45, "sawtooth", 0.12));
      case "caught": return [392, 311, 262].forEach((f, i) => this.tone(t + i * 0.18, f, 0.25, "square", 0.22));
      case "innocent": return (this.tone(t, 330, 0.2, "triangle", 0.25), this.tone(t + 0.2, 440, 0.35, "triangle", 0.25));
      case "lava": return (this.noise(t, 0.6, 800, 0.4, "lowpass", 200), this.tone(t, 90, 0.5, "sawtooth", 0.18, 50));
      case "crabs": return [0, 0.07, 0.14, 0.21].forEach((d) => this.noise(t + d, 0.04, 5000, 0.3, "highpass"));
      case "trap.oil": return (this.noise(t, 0.7, 900, 0.3, "bandpass", 300), this.tone(t, 500, 0.6, "sine", 0.12, 200));
      case "trap.crab": return [0, 0.09].forEach((d) => (this.noise(t + d, 0.05, 4000, 0.4, "highpass"), this.tone(t + d, 1400, 0.05, "square", 0.15)));
      case "trap.coconut": return (this.tone(t, 160, 0.25, "sine", 0.6, 50), this.noise(t, 0.12, 600, 0.4, "lowpass"));
      case "trap.fake": return this.tone(t, 600, 0.6, "sawtooth", 0.18, 120);
      case "trap.boost": return (this.tone(t, 200, 0.5, "sawtooth", 0.15, 900), this.noise(t, 0.5, 2000, 0.15, "bandpass", 6000));
      case "trap.ramp": return this.tone(t, 300, 0.35, "sine", 0.3, 800);
    }
  }

  private tone(at: number, freq: number, dur: number, type: OscillatorType, vol: number, slideTo?: number) {
    const c = this.ctx!;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, at);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g).connect(this.master!);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  private noise(at: number, dur: number, freq: number, vol: number, kind: BiquadFilterType, slideTo?: number) {
    const c = this.ctx!;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const flt = c.createBiquadFilter();
    flt.type = kind;
    flt.frequency.setValueAtTime(freq, at);
    if (slideTo) flt.frequency.exponentialRampToValueAtTime(slideTo, at + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(vol, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    src.connect(flt).connect(g).connect(this.master!);
    src.start(at);
    src.stop(at + dur + 0.02);
  }
}
