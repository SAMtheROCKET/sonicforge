/**
 * Infinite rotational frequency dial.
 *
 * Brief:
 *   Two properties matter here, and most web dials get both wrong.
 *
 *   It is infinite. There is no start or end stop; the knob accumulates
 *   angle forever, because frequency is a ratio scale and a bounded
 *   270-degree sweep gives you either 1 Hz resolution at the top or none at
 *   the bottom.
 *
 *   It is logarithmic. A fixed angular movement always changes the pitch by
 *   the same musical interval, so dragging from 100 Hz to 200 Hz takes
 *   exactly as much wrist as 5 kHz to 10 kHz. Anything else feels broken to
 *   anyone with ears.
 *
 *   Modifiers: Shift is fine, Alt is coarse, Ctrl or Cmd snaps to the
 *   nearest chromatic step of the current A4 reference.
 */

import { TAU_FLOAT, clampToRange } from '../util/numeric.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Rotation required to travel one octave, in degrees. */
const DEGREES_PER_OCTAVE_FLOAT = 150;

/**
 * Lowest frequency the dial will reach, in hertz.
 *
 * 0.05 Hz is one cycle every twenty seconds, well into the range used for
 * candle-flicker and thermoacoustic work where the interesting rates are
 * below anything a person can hear.
 */
const MIN_FREQUENCY_HERTZ_FLOAT = 0.05;

/** Starting value and the value the Home key returns to, in hertz. */
const DEFAULT_FREQUENCY_HERTZ_FLOAT = 440;

/** Upper bound used when the caller does not supply one, in hertz. */
const DEFAULT_MAX_HERTZ_FLOAT = 22000;

/** Drag and wheel multipliers for the fine and coarse modifiers. */
const FINE_SENSITIVITY_FLOAT = 0.125;
const COARSE_SENSITIVITY_FLOAT = 4;

/** Rotation applied by one wheel notch, in degrees. */
const WHEEL_DEGREES_PER_NOTCH_FLOAT = 6;

/** Frequency ratio of one equal-tempered semitone. */
const SEMITONE_RATIO_FLOAT = 2 ** (1 / 12);

/** Per-frame decay of the momentum trail and the interaction glow. */
const SPIN_DECAY_FLOAT = 0.86;
const GLOW_DECAY_FLOAT = 0.94;

/** Upper bound on the device pixel ratio honoured when resizing. */
const MAX_PIXEL_RATIO_FLOAT = 2;

/** Tick marks around the rim, and how often one is drawn as a major. */
const TICK_COUNT_INT = 72;
const MAJOR_TICK_EVERY_INT = 6;

/** Momentum smear thresholds. */
const MIN_SMEAR_SPIN_DEGREES_FLOAT = 0.15;
const SMEAR_SPIN_SCALE_FLOAT = 26;
const MAX_SMEAR_ALPHA_FLOAT = 0.7;

/* ------------------------------------------------------------------------ */

/**
 * Infinite logarithmic frequency dial with keyboard and wheel support.
 *
 * Brief:
 *   Owns its own canvas and render loop. The value is authoritative here;
 *   the caller is notified through on_change_fn and is expected to push the
 *   value back with setFrequencyHertz when it changes elsewhere.
 *
 * Arguments:
 *   container_el (HTMLElement): The .dial container.
 *   options_obj (Object): { on_change_fn, tuning_obj, max_hertz_float }.
 *
 * Returns:
 *   (FrequencyDial): The constructed dial.
 *
 * Warning:
 *   The render loop runs until destroy() is called.
 */
export class FrequencyDial {
  frequency_hertz_float = DEFAULT_FREQUENCY_HERTZ_FLOAT;
  max_hertz_float = DEFAULT_MAX_HERTZ_FLOAT;

  #angle_degrees_float = 0;
  #is_dragging_bool = false;
  #last_angle_radians_float = 0;
  #animation_frame_id_int = 0;
  #spin_degrees_float = 0;
  #glow_float = 0;

  constructor(container_el, options_obj) {
    const {
      on_change_fn,
      tuning_obj,
      max_hertz_float = DEFAULT_MAX_HERTZ_FLOAT,
    } = options_obj;

    this.container_el = container_el;
    this.on_change_fn = on_change_fn;
    this.tuning_obj = tuning_obj;
    this.max_hertz_float = max_hertz_float;

    this.canvas = container_el.querySelector('canvas') ??
      document.createElement('canvas');
    if (!this.canvas.parentElement) {
      container_el.prepend(this.canvas);
    }
    this.canvas_ctx = this.canvas.getContext('2d');

    this.#bindInteractions();
    this.#startRenderLoop();
  }

  /**
   * Set the displayed frequency.
   *
   * Arguments:
   *   frequency_hertz_float (number): Requested value, clamped into range.
   *   options_obj (Object): { is_silent_bool } to suppress the callback.
   *
   * Returns:
   *   (FrequencyDial): This instance, for chaining.
   *
   * Warning:
   *   Pass is_silent_bool when echoing a value that came from the owning
   *   channel, or the callback will write it straight back and loop.
   */
  setFrequencyHertz(frequency_hertz_float, options_obj = {}) {
    const { is_silent_bool = false } = options_obj;
    const next_hertz_float = clampToRange(
      Number(frequency_hertz_float) || MIN_FREQUENCY_HERTZ_FLOAT,
      MIN_FREQUENCY_HERTZ_FLOAT,
      this.max_hertz_float
    );
    if (next_hertz_float === this.frequency_hertz_float) {
      return this;
    }
    this.frequency_hertz_float = next_hertz_float;
    if (!is_silent_bool) {
      this.on_change_fn?.(this.frequency_hertz_float);
    }
    return this;
  }

  /**
   * Stop the render loop.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  destroy() {
    cancelAnimationFrame(this.#animation_frame_id_int);
  }

  /* =================================================================== */

  /**
   * Measure the dial's centre in viewport coordinates.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): { x_px_float, y_px_float, radius_px_float }.
   */
  #measureCentre() {
    const bounds_obj = this.container_el.getBoundingClientRect();
    return {
      x_px_float: bounds_obj.left + bounds_obj.width / 2,
      y_px_float: bounds_obj.top + bounds_obj.height / 2,
      radius_px_float: bounds_obj.width / 2,
    };
  }

  /**
   * Measure the angle from the dial centre to a pointer.
   *
   * Arguments:
   *   pointer_event (PointerEvent): Event carrying client coordinates.
   *
   * Returns:
   *   (number): Angle in radians, in the range returned by atan2.
   */
  #measurePointerAngle(pointer_event) {
    const centre_obj = this.#measureCentre();
    return Math.atan2(
      pointer_event.clientY - centre_obj.y_px_float,
      pointer_event.clientX - centre_obj.x_px_float
    );
  }

  /**
   * Resolve the speed multiplier implied by the modifier keys.
   *
   * Arguments:
   *   input_event (Event): Event carrying shiftKey and altKey.
   *
   * Returns:
   *   (number): Multiplier applied to the rotation.
   */
  #resolveSensitivity(input_event) {
    if (input_event.shiftKey) {
      return FINE_SENSITIVITY_FLOAT;
    }
    if (input_event.altKey) {
      return COARSE_SENSITIVITY_FLOAT;
    }
    return 1;
  }

  /**
   * Apply a rotation to the value, snapping when asked.
   *
   * Arguments:
   *   degrees_float (number): Signed rotation to apply.
   *   should_snap_bool (boolean): True to snap to the nearest semitone.
   *
   * Returns:
   *   (none)
   */
  #applyRotation(degrees_float, should_snap_bool) {
    this.#angle_degrees_float += degrees_float;
    this.#spin_degrees_float = degrees_float;
    this.#glow_float = 1;

    let next_hertz_float = this.frequency_hertz_float *
      2 ** (degrees_float / DEGREES_PER_OCTAVE_FLOAT);
    if (should_snap_bool) {
      next_hertz_float =
        this.tuning_obj.snapToNearestSemitone(next_hertz_float);
    }
    this.setFrequencyHertz(next_hertz_float);
  }

  /**
   * Wire the pointer drag gesture.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bindPointerGesture() {
    const container_el = this.container_el;

    const handlePointerDown = (pointer_event) => {
      // Ignore the secondary button so right-click can still open a menu.
      const is_mouse_bool = pointer_event.pointerType === 'mouse';
      if (pointer_event.button !== 0 && is_mouse_bool) {
        return;
      }
      this.#is_dragging_bool = true;
      this.#last_angle_radians_float =
        this.#measurePointerAngle(pointer_event);
      container_el.classList.add('is-dragging');
      container_el.setPointerCapture?.(pointer_event.pointerId);
      pointer_event.preventDefault();
    };

    const handlePointerMove = (pointer_event) => {
      if (!this.#is_dragging_bool) {
        return;
      }
      const angle_radians_float = this.#measurePointerAngle(pointer_event);

      // Unwrap across the seam so a drag through 12 o'clock is continuous.
      let delta_radians_float =
        angle_radians_float - this.#last_angle_radians_float;
      if (delta_radians_float > Math.PI) {
        delta_radians_float -= TAU_FLOAT;
      } else if (delta_radians_float < -Math.PI) {
        delta_radians_float += TAU_FLOAT;
      }
      this.#last_angle_radians_float = angle_radians_float;

      const degrees_float = (delta_radians_float * 180) / Math.PI *
        this.#resolveSensitivity(pointer_event);
      this.#applyRotation(
        degrees_float, pointer_event.ctrlKey || pointer_event.metaKey
      );
      pointer_event.preventDefault();
    };

    const handlePointerUp = (pointer_event) => {
      if (!this.#is_dragging_bool) {
        return;
      }
      this.#is_dragging_bool = false;
      container_el.classList.remove('is-dragging');
      container_el.releasePointerCapture?.(pointer_event.pointerId);
    };

    container_el.addEventListener('pointerdown', handlePointerDown);
    container_el.addEventListener('pointermove', handlePointerMove);
    for (const event_name_str of
      ['pointerup', 'pointercancel', 'lostpointercapture']) {
      container_el.addEventListener(event_name_str, handlePointerUp);
    }
  }

  /**
   * Wire the wheel gesture.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Registered non-passive because it calls preventDefault to stop the
   *   page scrolling while the pointer is over the dial.
   */
  #bindWheelGesture() {
    this.container_el.addEventListener('wheel', (wheel_event) => {
      wheel_event.preventDefault();
      const degrees_float = -Math.sign(wheel_event.deltaY) *
        WHEEL_DEGREES_PER_NOTCH_FLOAT *
        this.#resolveSensitivity(wheel_event);
      this.#applyRotation(
        degrees_float, wheel_event.ctrlKey || wheel_event.metaKey
      );
    }, { passive: false });
  }

  /**
   * Wire keyboard control and the slider semantics that go with it.
   *
   * Brief:
   *   The dial is a real focusable control, not decoration, so it carries a
   *   slider role and responds to the arrow, page and Home keys.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bindKeyboard() {
    const container_el = this.container_el;
    container_el.tabIndex = 0;
    container_el.setAttribute('role', 'slider');
    container_el.setAttribute('aria-label', 'Frequency');

    container_el.addEventListener('keydown', (keyboard_event) => {
      const sensitivity_float = this.#resolveSensitivity(keyboard_event);
      const step_ratio_float = SEMITONE_RATIO_FLOAT ** sensitivity_float;
      const current_hertz_float = this.frequency_hertz_float;
      let is_handled_bool = true;

      switch (keyboard_event.key) {
        case 'ArrowUp':
        case 'ArrowRight':
          this.setFrequencyHertz(current_hertz_float * step_ratio_float);
          break;
        case 'ArrowDown':
        case 'ArrowLeft':
          this.setFrequencyHertz(current_hertz_float / step_ratio_float);
          break;
        case 'PageUp':
          this.setFrequencyHertz(current_hertz_float * 2);
          break;
        case 'PageDown':
          this.setFrequencyHertz(current_hertz_float / 2);
          break;
        case 'Home':
          this.setFrequencyHertz(DEFAULT_FREQUENCY_HERTZ_FLOAT);
          break;
        default:
          is_handled_bool = false;
      }

      if (is_handled_bool) {
        keyboard_event.preventDefault();
        this.#glow_float = 1;
      }
    });
  }

  /**
   * Wire every input gesture the dial responds to.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bindInteractions() {
    this.#bindPointerGesture();
    this.#bindWheelGesture();
    this.#bindKeyboard();
  }

  /* =================================================================== */

  /**
   * Start the continuous render loop.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #startRenderLoop() {
    const drawFrame = () => {
      this.#animation_frame_id_int = requestAnimationFrame(drawFrame);
      this.#renderDial();
    };
    this.#animation_frame_id_int = requestAnimationFrame(drawFrame);
  }

  /**
   * Resize the backing canvas to the container, if needed.
   *
   * Arguments:
   *   pixel_ratio_float (number): Device pixel ratio in use.
   *
   * Returns:
   *   (boolean): False when the container has no width yet.
   */
  #syncCanvasSize(pixel_ratio_float) {
    const bounds_obj = this.container_el.getBoundingClientRect();
    if (!bounds_obj.width) {
      return false;
    }
    const side_px_int = Math.round(bounds_obj.width * pixel_ratio_float);
    if (this.canvas.width !== side_px_int) {
      this.canvas.width = side_px_int;
      this.canvas.height = side_px_int;
    }
    return true;
  }

  /**
   * Draw the faint outer track.
   *
   * Arguments:
   *   geometry_obj (Object): Dial geometry for this frame.
   *
   * Returns:
   *   (none)
   */
  #drawTrack(geometry_obj) {
    const canvas_ctx = this.canvas_ctx;
    canvas_ctx.beginPath();
    canvas_ctx.arc(
      geometry_obj.centre_px_float,
      geometry_obj.centre_px_float,
      geometry_obj.radius_px_float - 1.5 * geometry_obj.pixel_ratio_float,
      0,
      TAU_FLOAT
    );
    canvas_ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    canvas_ctx.lineWidth = 1 * geometry_obj.pixel_ratio_float;
    canvas_ctx.stroke();
  }

  /**
   * Draw the rotating tick ring.
   *
   * Brief:
   *   Ticks fade away from the top so the dial reads as a lit indicator
   *   rather than a flat ring, which is what makes the rotation legible at
   *   a glance.
   *
   * Arguments:
   *   geometry_obj (Object): Dial geometry for this frame.
   *
   * Returns:
   *   (none)
   */
  #drawTicks(geometry_obj) {
    const canvas_ctx = this.canvas_ctx;
    const pixel_ratio_float = geometry_obj.pixel_ratio_float;
    const centre_px_float = geometry_obj.centre_px_float;
    const base_radians_float = (this.#angle_degrees_float * Math.PI) / 180;

    for (let tick_int = 0; tick_int < TICK_COUNT_INT; tick_int++) {
      const angle_radians_float =
        base_radians_float + (tick_int / TICK_COUNT_INT) * TAU_FLOAT;
      const is_major_bool = tick_int % MAJOR_TICK_EVERY_INT === 0;
      const length_px_float = (is_major_bool ? 11 : 5.5) * pixel_ratio_float;
      const outer_px_float =
        geometry_obj.radius_px_float - 3 * pixel_ratio_float;
      const inner_px_float = outer_px_float - length_px_float;

      const facing_float = Math.cos(angle_radians_float + Math.PI / 2);
      const alpha_float = 0.14 + 0.5 * Math.max(0, facing_float) ** 2;

      canvas_ctx.beginPath();
      canvas_ctx.moveTo(
        centre_px_float + Math.cos(angle_radians_float) * outer_px_float,
        centre_px_float + Math.sin(angle_radians_float) * outer_px_float
      );
      canvas_ctx.lineTo(
        centre_px_float + Math.cos(angle_radians_float) * inner_px_float,
        centre_px_float + Math.sin(angle_radians_float) * inner_px_float
      );
      canvas_ctx.strokeStyle = is_major_bool
        ? `rgba(0, 242, 254, ${alpha_float + 0.2})`
        : `rgba(185, 196, 220, ${alpha_float * 0.7})`;
      canvas_ctx.lineWidth = (is_major_bool ? 1.6 : 1) * pixel_ratio_float;
      canvas_ctx.stroke();
    }
  }

  /**
   * Draw the fixed index marker at 12 o'clock.
   *
   * Arguments:
   *   geometry_obj (Object): Dial geometry for this frame.
   *
   * Returns:
   *   (none)
   */
  #drawIndexMarker(geometry_obj) {
    const canvas_ctx = this.canvas_ctx;
    const pixel_ratio_float = geometry_obj.pixel_ratio_float;
    const centre_px_float = geometry_obj.centre_px_float;
    const top_px_float = centre_px_float - geometry_obj.radius_px_float;

    canvas_ctx.beginPath();
    canvas_ctx.moveTo(centre_px_float, top_px_float + 1 * pixel_ratio_float);
    canvas_ctx.lineTo(centre_px_float, top_px_float + 15 * pixel_ratio_float);
    canvas_ctx.strokeStyle = '#00f2fe';
    canvas_ctx.lineWidth = 2 * pixel_ratio_float;
    canvas_ctx.shadowBlur = 10 * pixel_ratio_float;
    canvas_ctx.shadowColor = 'rgba(0,242,254,0.85)';
    canvas_ctx.stroke();
    canvas_ctx.shadowBlur = 0;
  }

  /**
   * Draw the arc showing where the value sits inside its octave.
   *
   * Arguments:
   *   geometry_obj (Object): Dial geometry for this frame.
   *
   * Returns:
   *   (none)
   */
  #drawOctaveArc(geometry_obj) {
    const canvas_ctx = this.canvas_ctx;
    const octave_fraction_float = Math.log2(this.frequency_hertz_float) % 1;
    const positive_fraction_float = octave_fraction_float < 0
      ? octave_fraction_float + 1
      : octave_fraction_float;
    const sweep_radians_float = positive_fraction_float * TAU_FLOAT;

    canvas_ctx.beginPath();
    canvas_ctx.arc(
      geometry_obj.centre_px_float,
      geometry_obj.centre_px_float,
      geometry_obj.radius_px_float - 20 * geometry_obj.pixel_ratio_float,
      -Math.PI / 2,
      -Math.PI / 2 + sweep_radians_float
    );
    canvas_ctx.strokeStyle =
      `rgba(168, 85, 247, ${0.45 + this.#glow_float * 0.4})`;
    canvas_ctx.lineWidth = 2.5 * geometry_obj.pixel_ratio_float;
    canvas_ctx.lineCap = 'round';
    canvas_ctx.stroke();
  }

  /**
   * Draw the decaying momentum smear behind a fast rotation.
   *
   * Arguments:
   *   geometry_obj (Object): Dial geometry for this frame.
   *
   * Returns:
   *   (none)
   */
  #drawMomentumSmear(geometry_obj) {
    if (Math.abs(this.#spin_degrees_float) <= MIN_SMEAR_SPIN_DEGREES_FLOAT) {
      return;
    }
    const canvas_ctx = this.canvas_ctx;
    const alpha_float = clampToRange(
      Math.abs(this.#spin_degrees_float) / SMEAR_SPIN_SCALE_FLOAT,
      0,
      MAX_SMEAR_ALPHA_FLOAT
    );
    const base_radians_float = (this.#angle_degrees_float * Math.PI) / 180;
    const sweep_radians_float =
      ((this.#spin_degrees_float * Math.PI) / 180) * 6;

    canvas_ctx.beginPath();
    canvas_ctx.arc(
      geometry_obj.centre_px_float,
      geometry_obj.centre_px_float,
      geometry_obj.radius_px_float - 10 * geometry_obj.pixel_ratio_float,
      base_radians_float,
      base_radians_float + sweep_radians_float
    );
    canvas_ctx.strokeStyle = `rgba(0, 242, 254, ${alpha_float})`;
    canvas_ctx.lineWidth = 3 * geometry_obj.pixel_ratio_float;
    canvas_ctx.stroke();
  }

  /**
   * Draw one frame of the dial.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #renderDial() {
    const pixel_ratio_float = Math.min(
      window.devicePixelRatio || 1, MAX_PIXEL_RATIO_FLOAT
    );
    if (!this.#syncCanvasSize(pixel_ratio_float)) {
      return;
    }

    const side_px_int = this.canvas.width;
    const geometry_obj = {
      pixel_ratio_float,
      centre_px_float: side_px_int / 2,
      radius_px_float: side_px_int / 2 - 2 * pixel_ratio_float,
    };

    this.canvas_ctx.clearRect(0, 0, side_px_int, side_px_int);

    // Decay the momentum trail and the interaction glow.
    this.#spin_degrees_float *= SPIN_DECAY_FLOAT;
    this.#glow_float *= GLOW_DECAY_FLOAT;

    this.#drawTrack(geometry_obj);
    this.#drawTicks(geometry_obj);
    this.#drawIndexMarker(geometry_obj);
    this.#drawOctaveArc(geometry_obj);
    this.#drawMomentumSmear(geometry_obj);
  }
}
