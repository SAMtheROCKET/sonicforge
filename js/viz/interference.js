/**
 * Interference field + stereo goniometer.
 *
 * The waterfall shows what the output *contains*. This view shows what the
 * active tones are *doing to each other*: the analytic superposition of every
 * audible channel, per stereo leg, with the individual contributions drawn
 * underneath as ghosts.
 *
 * It is computed analytically rather than read from an analyser, and that is
 * deliberate — an FFT cannot show you that two tones are cancelling, only that
 * the result is quiet. Summing the channels' own parameters makes the mechanism
 * visible: you can watch two 180°-opposed sines collapse to a flat line while
 * their ghosts keep swinging at full amplitude.
 */

import { sampleWaveform } from '../core/waveforms.js';
import { convertDbToLinear } from '../util/amplitude.js';
import { formatFrequency } from '../util/frequency.js';
import { clampToRange } from '../util/numeric.js';

const TWO_PI = Math.PI * 2;

export class InterferenceView {
  running = false;
  mode = 'both';        // 'field' | 'gonio' | 'both'

  #raf = 0;
  #dpr = 1;
  #phase = 0;
  #last = 0;
  #stats = { cancellation: 0, beatHz: 0, voices: 0, peak: 0 };

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/engine.js').AudioEngine} engine
   * @param {import('../core/channel.js').ChannelRack} rack
   */
  constructor(canvas, engine, rack) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.rack = rack;
  }

  get stats() {
    return this.#stats;
  }

  setMode(mode) {
    this.mode = mode;
    return this;
  }

  start() {
    if (this.running) return this;
    this.running = true;
    this.#last = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.#frame();
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
    return this;
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.#raf);
    return this;
  }

  /* =================================================================== */

  #resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * dpr));
    const h = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.#dpr = dpr;
    return { w, h };
  }

  #frame() {
    const now = performance.now();
    const dt = (now - this.#last) / 1000;
    this.#last = now;

    const { w, h } = this.#resize();
    const c = this.ctx;
    c.clearRect(0, 0, w, h);

    const voices = this.#collect();
    this.#stats.voices = voices.length;

    if (this.mode !== 'gonio') this.#drawField(c, w, h, voices, dt);
    if (this.mode !== 'field') {
      const size = this.mode === 'gonio' ? Math.min(w, h) * 0.82 : Math.min(w, h) * 0.34;
      const x = this.mode === 'gonio' ? (w - size) / 2 : w - size - 14 * this.#dpr;
      const y = this.mode === 'gonio' ? (h - size) / 2 : 14 * this.#dpr;
      this.#drawGoniometer(c, x, y, size);
    }
  }

  /** Snapshot the audible channels with their equal-power stereo weights. */
  #collect() {
    return this.rack.audibleChannels.map((ch) => {
      const amp = convertDbToLinear(ch.gain_db_float);
      const theta = ((ch.pan_position_float + 1) * Math.PI) / 4;
      return {
        freq: ch.frequency_hertz_float,
        phase: ch.phase_degrees_int,
        waveform: ch.waveform_name_str,
        amp,
        gl: amp * Math.cos(theta),
        gr: amp * Math.sin(theta),
        hue: ch.hue_degrees_int,
        index: ch.index_int,
      };
    });
  }

  /**
   * Choose the time window to display.
   * When two voices beat against each other, the beat period is the story, so
   * the window follows it. Otherwise a handful of cycles of the lowest tone.
   */
  #window(voices) {
    if (!voices.length) return { seconds: 0.02, beatHz: 0 };

    let beatHz = 0;
    for (let i = 0; i < voices.length; i++) {
      for (let j = i + 1; j < voices.length; j++) {
        const d = Math.abs(voices[i].freq - voices[j].freq);
        if (d > 0.05 && d < 40 && (beatHz === 0 || d < beatHz)) beatHz = d;
      }
    }
    if (beatHz > 0) return { seconds: clampToRange(2.5 / beatHz, 0.05, 2.5), beatHz };

    const lowest = Math.min(...voices.map((v) => v.freq));
    return { seconds: clampToRange(4 / Math.max(lowest, 1), 0.002, 0.25), beatHz: 0 };
  }

  #drawField(c, w, h, voices, dt) {
    const dpr = this.#dpr;
    const padX = 12 * dpr;
    const midY = h * 0.5;
    const amplitude = h * 0.36;

    // --- baseline + grid ---------------------------------------------
    c.strokeStyle = 'rgba(255,255,255,0.05)';
    c.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const y = (h * i) / 4;
      c.beginPath();
      c.moveTo(padX, y);
      c.lineTo(w - padX, y);
      c.stroke();
    }
    c.strokeStyle = 'rgba(255,255,255,0.11)';
    c.beginPath();
    c.moveTo(padX, midY);
    c.lineTo(w - padX, midY);
    c.stroke();

    if (!voices.length) {
      this.#stats.cancellation = 0;
      this.#stats.beatHz = 0;
      this.#stats.peak = 0;
      return;
    }

    const { seconds, beatHz } = this.#window(voices);
    this.#stats.beatHz = beatHz;

    // Scroll the window so the display animates instead of standing still.
    this.#phase = (this.#phase + dt) % 1000;
    const t0 = this.#phase;

    const samples = Math.min(1400, Math.max(320, Math.round((w - padX * 2) / dpr) * 2));
    const step = seconds / (samples - 1);

    const sumL = new Float32Array(samples);
    const sumR = new Float32Array(samples);

    // --- ghosts: each voice on its own -------------------------------
    c.lineWidth = 1 * dpr;
    for (const v of voices) {
      c.beginPath();
      for (let i = 0; i < samples; i++) {
        const t = t0 + i * step;
        const s = sampleWaveform(v.waveform, (t * v.freq) % 1, v.phase);
        const l = s * v.gl;
        const r = s * v.gr;
        sumL[i] += l;
        sumR[i] += r;

        const x = padX + ((w - padX * 2) * i) / (samples - 1);
        const y = midY - (l + r) * 0.5 * amplitude;
        i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.strokeStyle = `hsla(${v.hue}, 85%, 62%, 0.22)`;
      c.stroke();
    }

    // --- cancellation metric ------------------------------------------
    let sumSq = 0;
    let peak = 0;
    for (let i = 0; i < samples; i++) {
      const m = (sumL[i] + sumR[i]) * 0.5;
      sumSq += m * m;
      const a = Math.abs(m);
      if (a > peak) peak = a;
    }
    const coherentRms = Math.sqrt(sumSq / samples);
    // What the RMS would be if the voices were mutually incoherent.
    let incoherent = 0;
    for (const v of voices) incoherent += ((v.gl + v.gr) * 0.5) ** 2 * 0.5;
    incoherent = Math.sqrt(incoherent);

    const ratio = incoherent > 0 ? coherentRms / incoherent : 1;
    this.#stats.cancellation = clampToRange(1 - ratio, -1, 1);
    this.#stats.peak = peak;

    // --- the sum ------------------------------------------------------
    const drawLeg = (arr, color, glow) => {
      c.beginPath();
      for (let i = 0; i < samples; i++) {
        const x = padX + ((w - padX * 2) * i) / (samples - 1);
        const y = midY - arr[i] * amplitude;
        i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.strokeStyle = color;
      c.lineWidth = 1.8 * dpr;
      if (glow) {
        c.shadowBlur = 12 * dpr;
        c.shadowColor = glow;
      }
      c.stroke();
      c.shadowBlur = 0;
    };

    drawLeg(sumL, 'rgba(0, 242, 254, 0.92)', 'rgba(0,242,254,0.55)');
    drawLeg(sumR, 'rgba(168, 85, 247, 0.80)', 'rgba(127,0,255,0.45)');

    // --- null markers: where the superposition collapses ---------------
    if (voices.length > 1) {
      const nullThreshold = 0.12 * Math.max(...voices.map((v) => v.amp));
      c.fillStyle = 'rgba(255, 61, 113, 0.9)';
      let lastMarkX = -1e9;
      for (let i = 2; i < samples - 2; i++) {
        const env = Math.abs((sumL[i] + sumR[i]) * 0.5);
        const prev = Math.abs((sumL[i - 2] + sumR[i - 2]) * 0.5);
        const next = Math.abs((sumL[i + 2] + sumR[i + 2]) * 0.5);
        if (env < nullThreshold && env <= prev && env <= next) {
          const x = padX + ((w - padX * 2) * i) / (samples - 1);
          if (x - lastMarkX < 26 * dpr) continue;
          lastMarkX = x;
          c.beginPath();
          c.arc(x, midY, 2.4 * dpr, 0, TWO_PI);
          c.fill();
        }
      }
    }

    // --- legend --------------------------------------------------------
    c.font = `${9.5 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
    c.textBaseline = 'top';
    c.fillStyle = 'rgba(125, 137, 166, 0.9)';
    const label = beatHz > 0
      ? `window ${(seconds * 1000).toFixed(0)} ms   beat ${beatHz.toFixed(2)} Hz`
      : `window ${(seconds * 1000).toFixed(1)} ms   ${formatFrequency(Math.min(...voices.map((v) => v.freq)))}`;
    c.fillText(label, padX, 8 * dpr);

    const cancel = this.#stats.cancellation;
    if (voices.length > 1) {
      c.fillStyle =
        cancel > 0.4 ? 'rgba(255,61,113,0.95)'
        : cancel < -0.15 ? 'rgba(41,255,154,0.95)'
        : 'rgba(125,137,166,0.9)';
      const verdict =
        cancel > 0.4 ? `destructive  −${(cancel * 100).toFixed(0)}%`
        : cancel < -0.15 ? `constructive  +${(-cancel * 100).toFixed(0)}%`
        : `incoherent  ${(cancel * 100).toFixed(0)}%`;
      c.fillText(verdict, padX, 22 * dpr);
    }
  }

  /**
   * Stereo goniometer (Lissajous of L against R), rotated 45° so that a
   * centred mono signal draws a vertical line — the orientation every
   * mastering engineer already reads fluently.
   */
  #drawGoniometer(c, x, y, size) {
    const dpr = this.#dpr;
    const { l, r } = this.engine.meter.readStereoWaveforms();
    const cx = x + size / 2;
    const cy = y + size / 2;
    const rad = size / 2;

    c.save();
    c.beginPath();
    c.arc(cx, cy, rad, 0, TWO_PI);
    c.fillStyle = 'rgba(0,0,0,0.42)';
    c.fill();
    c.strokeStyle = 'rgba(255,255,255,0.09)';
    c.lineWidth = 1;
    c.stroke();
    c.clip();

    // Axis cross: vertical = mono, horizontal = out of phase.
    c.strokeStyle = 'rgba(255,255,255,0.07)';
    c.beginPath();
    c.moveTo(cx, cy - rad); c.lineTo(cx, cy + rad);
    c.moveTo(cx - rad, cy); c.lineTo(cx + rad, cy);
    c.stroke();

    const n = Math.min(l.length, 1024);
    const k = rad * 0.92;
    const SQRT1_2 = Math.SQRT1_2;

    c.beginPath();
    for (let i = 0; i < n; i++) {
      // 45° rotation: mid up the screen, side across it.
      const mid = (l[i] + r[i]) * SQRT1_2;
      const side = (l[i] - r[i]) * SQRT1_2;
      const px = cx + side * k;
      const py = cy - mid * k;
      i === 0 ? c.moveTo(px, py) : c.lineTo(px, py);
    }
    c.strokeStyle = 'rgba(0, 242, 254, 0.72)';
    c.lineWidth = 1 * dpr;
    c.shadowBlur = 8 * dpr;
    c.shadowColor = 'rgba(0,242,254,0.5)';
    c.stroke();
    c.restore();

    c.font = `${8.5 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
    c.fillStyle = 'rgba(125,137,166,0.75)';
    c.textBaseline = 'bottom';
    c.fillText('L/R', x + 2 * dpr, y + size - 1 * dpr);
  }
}
