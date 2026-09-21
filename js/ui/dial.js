/**
 * Infinite rotational frequency dial.
 *
 * Two properties matter here and most web dials get both wrong:
 *
 *   1. It is INFINITE. There is no start or end stop — the knob accumulates
 *      angle forever, because frequency is a ratio scale and a bounded 270°
 *      sweep either gives you 1 Hz resolution at the top or none at the bottom.
 *
 *   2. It is LOGARITHMIC. A fixed angular movement always changes the pitch by
 *      the same musical interval, so dragging from 100 Hz to 200 Hz takes
 *      exactly as much wrist as 5 kHz to 10 kHz. Anything else feels broken to
 *      anyone with ears.
 *
 * Modifiers: Shift = fine (⅛ speed), Alt = coarse (4×), Ctrl/Cmd = snap to
 * the nearest chromatic step of the current A4 reference.
 */

import { TAU_FLOAT, clampToRange } from '../util/numeric.js';

const DEG_PER_OCTAVE = 150;

/**
 * 0.05 Hz is one cycle every twenty seconds — well into the range used for
 * candle-flicker and thermoacoustic work, where the interesting rates are
 * below anything a person can hear.
 */
const MIN_HZ = 0.05;

export class FrequencyDial {
  value = 440;
  maxHz = 22000;
  #angle = 0;
  #dragging = false;
  #lastAngle = 0;
  #raf = 0;
  #spin = 0;
  #glow = 0;

  /**
   * @param {HTMLElement} el      the .dial container
   * @param {{onChange:(hz:number)=>void, tuning_obj:import('../core/tuning.js').Tuning}} opts
   */
  constructor(el, { onChange, tuning_obj, maxHz = 22000 }) {
    this.el = el;
    this.onChange = onChange;
    this.tuning_obj = tuning_obj;
    this.maxHz = maxHz;

    this.canvas = el.querySelector('canvas') ?? document.createElement('canvas');
    if (!this.canvas.parentElement) el.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.#bind();
    this.#loop();
  }

  set(hz, { silent = false } = {}) {
    const next = clampToRange(Number(hz) || MIN_HZ, MIN_HZ, this.maxHz);
    if (next === this.value) return this;
    this.value = next;
    if (!silent) this.onChange?.(this.value);
    return this;
  }

  /* =================================================================== */

  #centre() {
    const r = this.el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: r.width / 2 };
  }

  #angleAt(e) {
    const c = this.#centre();
    return Math.atan2(e.clientY - c.y, e.clientX - c.x);
  }

  #sensitivity(e) {
    if (e.shiftKey) return 0.125;   // fine
    if (e.altKey) return 4;         // coarse
    return 1;
  }

  #bind() {
    const el = this.el;

    const down = (e) => {
      // Ignore the secondary button so right-click can still open a menu.
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      this.#dragging = true;
      this.#lastAngle = this.#angleAt(e);
      el.classList.add('is-dragging');
      el.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };

    const move = (e) => {
      if (!this.#dragging) return;
      const a = this.#angleAt(e);

      // Unwrap across the ±π seam so a drag through "12 o'clock" is continuous.
      let delta = a - this.#lastAngle;
      if (delta > Math.PI) delta -= TAU_FLOAT;
      else if (delta < -Math.PI) delta += TAU_FLOAT;
      this.#lastAngle = a;

      const degrees = (delta * 180) / Math.PI * this.#sensitivity(e);
      this.#angle += degrees;
      this.#spin = degrees;

      let next = this.value * 2 ** (degrees / DEG_PER_OCTAVE);
      if (e.ctrlKey || e.metaKey) next = this.tuning_obj.snapToNearestSemitone(next);

      this.#glow = 1;
      this.set(next);
      e.preventDefault();
    };

    const up = (e) => {
      if (!this.#dragging) return;
      this.#dragging = false;
      el.classList.remove('is-dragging');
      el.releasePointerCapture?.(e.pointerId);
    };

    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);

    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const step = -Math.sign(e.deltaY) * 6 * this.#sensitivity(e);
      this.#angle += step;
      this.#spin = step;
      this.#glow = 1;
      let next = this.value * 2 ** (step / DEG_PER_OCTAVE);
      if (e.ctrlKey || e.metaKey) next = this.tuning_obj.snapToNearestSemitone(next);
      this.set(next);
    }, { passive: false });

    // Keyboard access: the dial is a real focusable control, not decoration.
    el.tabIndex = 0;
    el.setAttribute('role', 'slider');
    el.setAttribute('aria-label', 'Frequency');
    el.addEventListener('keydown', (e) => {
      const fine = e.shiftKey ? 0.125 : e.altKey ? 4 : 1;
      const semitone = 2 ** (1 / 12);
      let handled = true;
      switch (e.key) {
        case 'ArrowUp': case 'ArrowRight': this.set(this.value * semitone ** fine); break;
        case 'ArrowDown': case 'ArrowLeft': this.set(this.value / semitone ** fine); break;
        case 'PageUp': this.set(this.value * 2); break;
        case 'PageDown': this.set(this.value / 2); break;
        case 'Home': this.set(440); break;
        default: handled = false;
      }
      if (handled) { e.preventDefault(); this.#glow = 1; }
    });
  }

  /* =================================================================== */

  #loop() {
    const draw = () => {
      this.#render();
      this.#raf = requestAnimationFrame(draw);
    };
    this.#raf = requestAnimationFrame(draw);
  }

  destroy() {
    cancelAnimationFrame(this.#raf);
  }

  #render() {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.el.getBoundingClientRect();
    if (!rect.width) return;

    const w = Math.round(rect.width * dpr);
    if (canvas.width !== w) {
      canvas.width = w;
      canvas.height = w;
    }

    const c = this.ctx;
    const size = canvas.width;
    const cx = size / 2;
    const cy = size / 2;
    const R = size / 2 - 2 * dpr;

    c.clearRect(0, 0, size, size);

    // Decay the momentum trail and the glow.
    this.#spin *= 0.86;
    this.#glow *= 0.94;

    // --- outer track ------------------------------------------------
    c.beginPath();
    c.arc(cx, cy, R - 1.5 * dpr, 0, TAU_FLOAT);
    c.strokeStyle = 'rgba(255,255,255,0.07)';
    c.lineWidth = 1 * dpr;
    c.stroke();

    // --- rotating ticks ----------------------------------------------
    const ticks = 72;
    const base = (this.#angle * Math.PI) / 180;
    for (let i = 0; i < ticks; i++) {
      const a = base + (i / ticks) * TAU_FLOAT;
      const major = i % 6 === 0;
      const len = (major ? 11 : 5.5) * dpr;
      const r0 = R - 3 * dpr;
      const r1 = r0 - len;

      // Fade ticks away from the top so the dial reads as a lit indicator.
      const facing = Math.cos(a + Math.PI / 2);
      const alpha = 0.14 + 0.5 * Math.max(0, facing) ** 2;

      c.beginPath();
      c.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      c.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      c.strokeStyle = major
        ? `rgba(0, 242, 254, ${alpha + 0.2})`
        : `rgba(185, 196, 220, ${alpha * 0.7})`;
      c.lineWidth = (major ? 1.6 : 1) * dpr;
      c.stroke();
    }

    // --- index marker at 12 o'clock -----------------------------------
    c.beginPath();
    c.moveTo(cx, cy - R + 1 * dpr);
    c.lineTo(cx, cy - R + 15 * dpr);
    c.strokeStyle = '#00f2fe';
    c.lineWidth = 2 * dpr;
    c.shadowBlur = 10 * dpr;
    c.shadowColor = 'rgba(0,242,254,0.85)';
    c.stroke();
    c.shadowBlur = 0;

    // --- octave arc: position of the current value within its octave ----
    const octFraction = Math.log2(this.value) % 1;
    const sweep = (octFraction < 0 ? octFraction + 1 : octFraction) * TAU_FLOAT;
    c.beginPath();
    c.arc(cx, cy, R - 20 * dpr, -Math.PI / 2, -Math.PI / 2 + sweep);
    c.strokeStyle = `rgba(168, 85, 247, ${0.45 + this.#glow * 0.4})`;
    c.lineWidth = 2.5 * dpr;
    c.lineCap = 'round';
    c.stroke();

    // --- momentum smear ------------------------------------------------
    if (Math.abs(this.#spin) > 0.15) {
      const smear = clampToRange(Math.abs(this.#spin) / 26, 0, 0.7);
      c.beginPath();
      c.arc(cx, cy, R - 10 * dpr, base, base + (this.#spin * Math.PI) / 180 * 6);
      c.strokeStyle = `rgba(0, 242, 254, ${smear})`;
      c.lineWidth = 3 * dpr;
      c.stroke();
    }
  }
}
