/**
 * Interference field and stereo goniometer.
 *
 * Brief:
 *   The waterfall shows what the output contains. This view shows what the
 *   active tones are doing to each other: the analytic superposition of
 *   every audible channel, per stereo leg, with the individual
 *   contributions drawn underneath as ghosts.
 *
 *   It is computed analytically rather than read from an analyser, and that
 *   is deliberate. An FFT cannot show you that two tones are cancelling,
 *   only that the result is quiet. Summing the channels' own parameters
 *   makes the mechanism visible: two 180-degree-opposed sines collapse to a
 *   flat line while their ghosts keep swinging at full amplitude.
 */

import { sampleWaveform } from '../core/waveforms.js';
import { convertDbToLinear } from '../util/amplitude.js';
import { formatFrequency } from '../util/frequency.js';
import { clampToRange } from '../util/numeric.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** One full turn, in radians. */
const TWO_PI_FLOAT = Math.PI * 2;

/** Upper bound on the device pixel ratio honoured when resizing. */
const MAX_PIXEL_RATIO_FLOAT = 2;

/** Horizontal padding inside the field, in CSS pixels before scaling. */
const FIELD_PAD_X_PX_FLOAT = 12;

/** Vertical extent of the trace, as a fraction of canvas height. */
const FIELD_AMPLITUDE_RATIO_FLOAT = 0.36;

/** Horizontal rules drawn behind the trace. */
const GRID_DIVISION_COUNT_INT = 4;

/**
 * Beat-detection band, in hertz.
 *
 * Differences below the lower bound are indistinguishable from detuning
 * drift; above the upper bound the pair is heard as two separate tones
 * rather than one beating tone, so following the beat would be misleading.
 */
const MIN_BEAT_HERTZ_FLOAT = 0.05;
const MAX_BEAT_HERTZ_FLOAT = 40;

/** Beat periods shown when a beat is present, and the window clamp. */
const BEAT_PERIODS_SHOWN_FLOAT = 2.5;
const MIN_BEAT_WINDOW_SECONDS_FLOAT = 0.05;
const MAX_BEAT_WINDOW_SECONDS_FLOAT = 2.5;

/** Cycles of the lowest tone shown when there is no beat. */
const CYCLES_SHOWN_FLOAT = 4;
const MIN_CYCLE_WINDOW_SECONDS_FLOAT = 0.002;
const MAX_CYCLE_WINDOW_SECONDS_FLOAT = 0.25;

/** Window used when nothing is audible. */
const IDLE_WINDOW_SECONDS_FLOAT = 0.02;

/** Trace resolution bounds. */
const MIN_SAMPLE_COUNT_INT = 320;
const MAX_SAMPLE_COUNT_INT = 1400;

/** Scroll phase wraps here so the accumulator never loses precision. */
const PHASE_WRAP_SECONDS_FLOAT = 1000;

/** A null is marked where the envelope falls below this share of the peak. */
const NULL_THRESHOLD_RATIO_FLOAT = 0.12;

/** Minimum spacing between null markers, in CSS pixels before scaling. */
const NULL_MARKER_SPACING_PX_FLOAT = 26;

/** Half-width, in samples, of the local-minimum test for a null. */
const NULL_NEIGHBOUR_SPAN_INT = 2;

/** Cancellation ratios at which the verdict changes. */
const DESTRUCTIVE_THRESHOLD_FLOAT = 0.4;
const CONSTRUCTIVE_THRESHOLD_FLOAT = -0.15;

/** Goniometer sizing, as a fraction of the smaller canvas dimension. */
const GONIO_FULL_SIZE_RATIO_FLOAT = 0.82;
const GONIO_INSET_SIZE_RATIO_FLOAT = 0.34;
const GONIO_INSET_MARGIN_PX_FLOAT = 14;

/** Samples plotted in the goniometer, and its trace radius. */
const GONIO_SAMPLE_LIMIT_INT = 1024;
const GONIO_TRACE_RADIUS_RATIO_FLOAT = 0.92;

/** Palette. */
const GRID_STROKE_STR = 'rgba(255,255,255,0.05)';
const BASELINE_STROKE_STR = 'rgba(255,255,255,0.11)';
const LEFT_LEG_STROKE_STR = 'rgba(0, 242, 254, 0.92)';
const LEFT_LEG_GLOW_STR = 'rgba(0,242,254,0.55)';
const RIGHT_LEG_STROKE_STR = 'rgba(168, 85, 247, 0.80)';
const RIGHT_LEG_GLOW_STR = 'rgba(127,0,255,0.45)';
const NULL_MARKER_FILL_STR = 'rgba(255, 61, 113, 0.9)';
const LEGEND_FILL_STR = 'rgba(125, 137, 166, 0.9)';
const DESTRUCTIVE_FILL_STR = 'rgba(255,61,113,0.95)';
const CONSTRUCTIVE_FILL_STR = 'rgba(41,255,154,0.95)';

/** Monospace stack used for the on-canvas readouts. */
const MONO_FONT_STACK_STR = '"JetBrains Mono", ui-monospace, monospace';

/* ------------------------------------------------------------------------ */

/**
 * Convert one channel into the voice record this view draws from.
 *
 * Brief:
 *   The pan position becomes an equal-power pair of leg gains, matching the
 *   StereoPannerNode the audio graph actually uses, so the picture agrees
 *   with what is being heard.
 *
 * Arguments:
 *   channel_obj (ToneChannel): A currently audible channel.
 *
 * Returns:
 *   (Object): Frequency, phase, waveform, amplitude and per-leg gains.
 */
function describeVoice(channel_obj) {
  const amplitude_float = convertDbToLinear(channel_obj.gain_db_float);
  const pan_angle_radians_float =
    ((channel_obj.pan_position_float + 1) * Math.PI) / 4;

  return {
    frequency_hertz_float: channel_obj.frequency_hertz_float,
    phase_degrees_int: channel_obj.phase_degrees_int,
    waveform_name_str: channel_obj.waveform_name_str,
    amplitude_float,
    left_gain_float: amplitude_float * Math.cos(pan_angle_radians_float),
    right_gain_float: amplitude_float * Math.sin(pan_angle_radians_float),
    hue_degrees_int: channel_obj.hue_degrees_int,
    index_int: channel_obj.index_int,
  };
}

/**
 * Find the slowest audible beat between any pair of voices.
 *
 * Arguments:
 *   voices_list (Array<Object>): Voice records.
 *
 * Returns:
 *   (number): Beat rate in hertz, or 0 when no pair beats.
 */
function findBeatHertz(voices_list) {
  let beat_hertz_float = 0;
  for (let first_int = 0; first_int < voices_list.length; first_int++) {
    for (let second_int = first_int + 1;
      second_int < voices_list.length; second_int++) {
      const difference_hertz_float = Math.abs(
        voices_list[first_int].frequency_hertz_float -
        voices_list[second_int].frequency_hertz_float
      );
      const is_beat_bool =
        difference_hertz_float > MIN_BEAT_HERTZ_FLOAT &&
        difference_hertz_float < MAX_BEAT_HERTZ_FLOAT;
      const is_slower_bool =
        beat_hertz_float === 0 || difference_hertz_float < beat_hertz_float;
      if (is_beat_bool && is_slower_bool) {
        beat_hertz_float = difference_hertz_float;
      }
    }
  }
  return beat_hertz_float;
}

/**
 * Choose the time window the field should display.
 *
 * Brief:
 *   When two voices beat against each other the beat period is the story,
 *   so the window follows it. Otherwise it shows a handful of cycles of the
 *   lowest tone present.
 *
 * Arguments:
 *   voices_list (Array<Object>): Voice records.
 *
 * Returns:
 *   (Object): { window_seconds_float, beat_hertz_float }.
 */
function chooseTimeWindow(voices_list) {
  if (!voices_list.length) {
    return {
      window_seconds_float: IDLE_WINDOW_SECONDS_FLOAT,
      beat_hertz_float: 0,
    };
  }

  const beat_hertz_float = findBeatHertz(voices_list);
  if (beat_hertz_float > 0) {
    return {
      window_seconds_float: clampToRange(
        BEAT_PERIODS_SHOWN_FLOAT / beat_hertz_float,
        MIN_BEAT_WINDOW_SECONDS_FLOAT,
        MAX_BEAT_WINDOW_SECONDS_FLOAT
      ),
      beat_hertz_float,
    };
  }

  const lowest_hertz_float = Math.min(
    ...voices_list.map((voice_obj) => voice_obj.frequency_hertz_float)
  );
  return {
    window_seconds_float: clampToRange(
      CYCLES_SHOWN_FLOAT / Math.max(lowest_hertz_float, 1),
      MIN_CYCLE_WINDOW_SECONDS_FLOAT,
      MAX_CYCLE_WINDOW_SECONDS_FLOAT
    ),
    beat_hertz_float: 0,
  };
}

/**
 * Map a sample index onto its horizontal position in the field.
 *
 * Arguments:
 *   geometry_obj (Object): Field geometry for this frame.
 *   sample_index_int (number): Index into the trace arrays.
 *
 * Returns:
 *   (number): X coordinate in device pixels.
 */
function computeSampleX(geometry_obj, sample_index_int) {
  const span_px_float =
    geometry_obj.width_px_int - geometry_obj.pad_x_px_float * 2;
  return geometry_obj.pad_x_px_float +
    (span_px_float * sample_index_int) / (geometry_obj.sample_count_int - 1);
}

/**
 * Measure how far the coherent sum falls short of an incoherent one.
 *
 * Brief:
 *   The reference is the RMS the same voices would produce if they were
 *   mutually incoherent. Reporting the shortfall against that, rather than
 *   against the arithmetic sum, is what makes the number readable as
 *   "destructive" or "constructive" rather than merely "quiet".
 *
 * Arguments:
 *   sum_left_float32array (Float32Array): Left leg superposition.
 *   sum_right_float32array (Float32Array): Right leg superposition.
 *   voices_list (Array<Object>): Voice records.
 *
 * Returns:
 *   (Object): { cancellation_ratio_float, peak_amplitude_float }.
 */
function measureCancellation(
  sum_left_float32array,
  sum_right_float32array,
  voices_list
) {
  const sample_count_int = sum_left_float32array.length;
  let sum_of_squares_float = 0;
  let peak_amplitude_float = 0;

  for (let sample_int = 0; sample_int < sample_count_int; sample_int++) {
    const mid_float =
      (sum_left_float32array[sample_int] +
        sum_right_float32array[sample_int]) * 0.5;
    sum_of_squares_float += mid_float * mid_float;
    const magnitude_float = Math.abs(mid_float);
    if (magnitude_float > peak_amplitude_float) {
      peak_amplitude_float = magnitude_float;
    }
  }

  const coherent_rms_float = Math.sqrt(
    sum_of_squares_float / sample_count_int
  );

  let incoherent_power_float = 0;
  for (const voice_obj of voices_list) {
    const mid_gain_float =
      (voice_obj.left_gain_float + voice_obj.right_gain_float) * 0.5;
    incoherent_power_float += mid_gain_float ** 2 * 0.5;
  }
  const incoherent_rms_float = Math.sqrt(incoherent_power_float);

  const ratio_float = incoherent_rms_float > 0
    ? coherent_rms_float / incoherent_rms_float
    : 1;

  return {
    cancellation_ratio_float: clampToRange(1 - ratio_float, -1, 1),
    peak_amplitude_float,
  };
}

/**
 * Describe the interference verdict for the legend.
 *
 * Arguments:
 *   cancellation_ratio_float (number): Shortfall against an incoherent sum.
 *
 * Returns:
 *   (Object): { fill_style_str, verdict_str }.
 */
function describeVerdict(cancellation_ratio_float) {
  const percent_str = (cancellation_ratio_float * 100).toFixed(0);

  if (cancellation_ratio_float > DESTRUCTIVE_THRESHOLD_FLOAT) {
    return {
      fill_style_str: DESTRUCTIVE_FILL_STR,
      verdict_str: `destructive  −${percent_str}%`,
    };
  }
  if (cancellation_ratio_float < CONSTRUCTIVE_THRESHOLD_FLOAT) {
    const positive_str = (-cancellation_ratio_float * 100).toFixed(0);
    return {
      fill_style_str: CONSTRUCTIVE_FILL_STR,
      verdict_str: `constructive  +${positive_str}%`,
    };
  }
  return {
    fill_style_str: LEGEND_FILL_STR,
    verdict_str: `incoherent  ${percent_str}%`,
  };
}

/* ------------------------------------------------------------------------ */

/**
 * Analytic interference field with an optional stereo goniometer.
 *
 * Brief:
 *   Draws the superposition of the audible channels from their own
 *   parameters, so cancellation is visible as a mechanism rather than
 *   inferred from a quiet analyser.
 *
 * Arguments:
 *   target_canvas (HTMLCanvasElement): Canvas to render into.
 *   engine_obj (AudioEngine): Source of the stereo time-domain pair.
 *   rack_obj (ChannelRack): Source of the audible channels.
 *
 * Returns:
 *   (InterferenceView): The constructed view.
 */
export class InterferenceView {
  is_running_bool = false;
  display_mode_str = 'both';

  #animation_frame_id_int = 0;
  #pixel_ratio_float = 1;
  #scroll_phase_seconds_float = 0;
  #last_frame_ms_float = 0;
  #stats_obj = {
    cancellation_ratio_float: 0,
    beat_hertz_float: 0,
    voice_count_int: 0,
    peak_amplitude_float: 0,
  };

  constructor(target_canvas, engine_obj, rack_obj) {
    this.canvas = target_canvas;
    this.canvas_ctx = target_canvas.getContext('2d');
    this.engine_obj = engine_obj;
    this.rack_obj = rack_obj;
  }

  /** Latest measured statistics, reused between frames. */
  get stats_obj() {
    return this.#stats_obj;
  }

  /**
   * Select which panels this view draws.
   *
   * Arguments:
   *   display_mode_str (string): 'field', 'gonio' or 'both'.
   *
   * Returns:
   *   (InterferenceView): This instance, for chaining.
   */
  setDisplayMode(display_mode_str) {
    this.display_mode_str = display_mode_str;
    return this;
  }

  /**
   * Begin the render loop.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (InterferenceView): This instance, for chaining.
   */
  start() {
    if (this.is_running_bool) {
      return this;
    }
    this.is_running_bool = true;
    this.#last_frame_ms_float = performance.now();

    const stepFrame = () => {
      if (!this.is_running_bool) {
        return;
      }
      // Scheduled before drawing, so a draw that throws cannot silently
      // end the animation and leave a frozen canvas behind.
      this.#animation_frame_id_int = requestAnimationFrame(stepFrame);
      this.#renderFrame();
    };
    this.#animation_frame_id_int = requestAnimationFrame(stepFrame);
    return this;
  }

  /**
   * Halt the render loop.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (InterferenceView): This instance, for chaining.
   */
  stop() {
    this.is_running_bool = false;
    cancelAnimationFrame(this.#animation_frame_id_int);
    return this;
  }

  /* =================================================================== */

  /**
   * Match the drawing buffer to the displayed size.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): { width_px_int, height_px_int }.
   */
  #resizeToDisplay() {
    const pixel_ratio_float = Math.min(
      window.devicePixelRatio || 1, MAX_PIXEL_RATIO_FLOAT
    );
    const bounds_obj = this.canvas.getBoundingClientRect();
    const width_px_int = Math.max(
      1, Math.round(bounds_obj.width * pixel_ratio_float)
    );
    const height_px_int = Math.max(
      1, Math.round(bounds_obj.height * pixel_ratio_float)
    );

    if (this.canvas.width !== width_px_int ||
      this.canvas.height !== height_px_int) {
      this.canvas.width = width_px_int;
      this.canvas.height = height_px_int;
    }
    this.#pixel_ratio_float = pixel_ratio_float;
    return { width_px_int, height_px_int };
  }

  /**
   * Draw one frame of whichever panels are enabled.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #renderFrame() {
    const now_ms_float = performance.now();
    const elapsed_seconds_float =
      (now_ms_float - this.#last_frame_ms_float) / 1000;
    this.#last_frame_ms_float = now_ms_float;

    const { width_px_int, height_px_int } = this.#resizeToDisplay();
    const canvas_ctx = this.canvas_ctx;
    canvas_ctx.clearRect(0, 0, width_px_int, height_px_int);

    const voices_list = this.rack_obj.audibleChannels.map(describeVoice);
    this.#stats_obj.voice_count_int = voices_list.length;

    if (this.display_mode_str !== 'gonio') {
      this.#drawField(
        width_px_int, height_px_int, voices_list, elapsed_seconds_float
      );
    }
    if (this.display_mode_str !== 'field') {
      this.#drawGoniometerPanel(width_px_int, height_px_int);
    }
  }

  /**
   * Place and draw the goniometer for the current display mode.
   *
   * Arguments:
   *   width_px_int (number): Drawing buffer width.
   *   height_px_int (number): Drawing buffer height.
   *
   * Returns:
   *   (none)
   */
  #drawGoniometerPanel(width_px_int, height_px_int) {
    const is_full_bool = this.display_mode_str === 'gonio';
    const smaller_px_int = Math.min(width_px_int, height_px_int);
    const size_px_float = smaller_px_int * (is_full_bool
      ? GONIO_FULL_SIZE_RATIO_FLOAT
      : GONIO_INSET_SIZE_RATIO_FLOAT);

    const margin_px_float =
      GONIO_INSET_MARGIN_PX_FLOAT * this.#pixel_ratio_float;
    const x_px_float = is_full_bool
      ? (width_px_int - size_px_float) / 2
      : width_px_int - size_px_float - margin_px_float;
    const y_px_float = is_full_bool
      ? (height_px_int - size_px_float) / 2
      : margin_px_float;

    this.#drawGoniometer(x_px_float, y_px_float, size_px_float);
  }

  /* =================================================================== */

  /**
   * Draw the horizontal rules and the centre baseline.
   *
   * Arguments:
   *   geometry_obj (Object): Field geometry for this frame.
   *   height_px_int (number): Drawing buffer height.
   *
   * Returns:
   *   (none)
   */
  #drawFieldGrid(geometry_obj, height_px_int) {
    const canvas_ctx = this.canvas_ctx;
    const right_px_float =
      geometry_obj.width_px_int - geometry_obj.pad_x_px_float;

    canvas_ctx.strokeStyle = GRID_STROKE_STR;
    canvas_ctx.lineWidth = 1;
    for (let division_int = 1;
      division_int < GRID_DIVISION_COUNT_INT; division_int++) {
      const y_px_float =
        (height_px_int * division_int) / GRID_DIVISION_COUNT_INT;
      canvas_ctx.beginPath();
      canvas_ctx.moveTo(geometry_obj.pad_x_px_float, y_px_float);
      canvas_ctx.lineTo(right_px_float, y_px_float);
      canvas_ctx.stroke();
    }

    canvas_ctx.strokeStyle = BASELINE_STROKE_STR;
    canvas_ctx.beginPath();
    canvas_ctx.moveTo(
      geometry_obj.pad_x_px_float, geometry_obj.mid_y_px_float
    );
    canvas_ctx.lineTo(right_px_float, geometry_obj.mid_y_px_float);
    canvas_ctx.stroke();
  }

  /**
   * Sum every voice into the stereo legs, stroking each as a ghost.
   *
   * Brief:
   *   Accumulation and drawing share one pass because each voice's samples
   *   are needed for both, and keeping a per-voice buffer for every channel
   *   would allocate sixteen arrays per frame to save nothing.
   *
   * Arguments:
   *   geometry_obj (Object): Field geometry for this frame.
   *   voices_list (Array<Object>): Voice records.
   *   timing_obj (Object): { start_seconds_float, step_seconds_float }.
   *
   * Returns:
   *   (Object): { sum_left_float32array, sum_right_float32array }.
   */
  #sumVoicesAndDrawGhosts(geometry_obj, voices_list, timing_obj) {
    const canvas_ctx = this.canvas_ctx;
    const sample_count_int = geometry_obj.sample_count_int;
    const sum_left_float32array = new Float32Array(sample_count_int);
    const sum_right_float32array = new Float32Array(sample_count_int);

    canvas_ctx.lineWidth = 1 * geometry_obj.pixel_ratio_float;
    for (const voice_obj of voices_list) {
      canvas_ctx.beginPath();
      for (let sample_int = 0; sample_int < sample_count_int; sample_int++) {
        const time_seconds_float = timing_obj.start_seconds_float +
          sample_int * timing_obj.step_seconds_float;
        const sample_float = sampleWaveform(
          voice_obj.waveform_name_str,
          (time_seconds_float * voice_obj.frequency_hertz_float) % 1,
          voice_obj.phase_degrees_int
        );
        const left_float = sample_float * voice_obj.left_gain_float;
        const right_float = sample_float * voice_obj.right_gain_float;
        sum_left_float32array[sample_int] += left_float;
        sum_right_float32array[sample_int] += right_float;

        const x_px_float = computeSampleX(geometry_obj, sample_int);
        const y_px_float = geometry_obj.mid_y_px_float -
          (left_float + right_float) * 0.5 * geometry_obj.amplitude_px_float;
        if (sample_int === 0) {
          canvas_ctx.moveTo(x_px_float, y_px_float);
        } else {
          canvas_ctx.lineTo(x_px_float, y_px_float);
        }
      }
      canvas_ctx.strokeStyle =
        `hsla(${voice_obj.hue_degrees_int}, 85%, 62%, 0.22)`;
      canvas_ctx.stroke();
    }

    return { sum_left_float32array, sum_right_float32array };
  }

  /**
   * Stroke one stereo leg of the superposition.
   *
   * Arguments:
   *   geometry_obj (Object): Field geometry for this frame.
   *   samples_float32array (Float32Array): The leg to draw.
   *   stroke_style_str (string): Line colour.
   *   glow_style_str (string): Shadow colour, or empty for no glow.
   *
   * Returns:
   *   (none)
   */
  #strokeLeg(
    geometry_obj,
    samples_float32array,
    stroke_style_str,
    glow_style_str
  ) {
    const canvas_ctx = this.canvas_ctx;
    canvas_ctx.beginPath();
    for (let sample_int = 0;
      sample_int < geometry_obj.sample_count_int; sample_int++) {
      const x_px_float = computeSampleX(geometry_obj, sample_int);
      const y_px_float = geometry_obj.mid_y_px_float -
        samples_float32array[sample_int] * geometry_obj.amplitude_px_float;
      if (sample_int === 0) {
        canvas_ctx.moveTo(x_px_float, y_px_float);
      } else {
        canvas_ctx.lineTo(x_px_float, y_px_float);
      }
    }

    canvas_ctx.strokeStyle = stroke_style_str;
    canvas_ctx.lineWidth = 1.8 * geometry_obj.pixel_ratio_float;
    if (glow_style_str) {
      canvas_ctx.shadowBlur = 12 * geometry_obj.pixel_ratio_float;
      canvas_ctx.shadowColor = glow_style_str;
    }
    canvas_ctx.stroke();
    canvas_ctx.shadowBlur = 0;
  }

  /**
   * Mark the points where the superposition collapses.
   *
   * Brief:
   *   A null is a local minimum of the envelope below a fraction of the
   *   loudest voice. Markers are spaced apart so a dense beat does not turn
   *   the baseline into a solid red line.
   *
   * Arguments:
   *   geometry_obj (Object): Field geometry for this frame.
   *   sums_obj (Object): The two stereo legs.
   *   voices_list (Array<Object>): Voice records.
   *
   * Returns:
   *   (none)
   */
  #drawNullMarkers(geometry_obj, sums_obj, voices_list) {
    const canvas_ctx = this.canvas_ctx;
    const loudest_float = Math.max(
      ...voices_list.map((voice_obj) => voice_obj.amplitude_float)
    );
    const threshold_float = NULL_THRESHOLD_RATIO_FLOAT * loudest_float;
    const min_spacing_px_float =
      NULL_MARKER_SPACING_PX_FLOAT * geometry_obj.pixel_ratio_float;
    const marker_radius_px_float = 2.4 * geometry_obj.pixel_ratio_float;

    const envelopeAt = (sample_int) => Math.abs(
      (sums_obj.sum_left_float32array[sample_int] +
        sums_obj.sum_right_float32array[sample_int]) * 0.5
    );

    canvas_ctx.fillStyle = NULL_MARKER_FILL_STR;
    let last_marker_x_px_float = -Infinity;
    const last_sample_int =
      geometry_obj.sample_count_int - NULL_NEIGHBOUR_SPAN_INT;

    for (let sample_int = NULL_NEIGHBOUR_SPAN_INT;
      sample_int < last_sample_int; sample_int++) {
      const here_float = envelopeAt(sample_int);
      const before_float = envelopeAt(sample_int - NULL_NEIGHBOUR_SPAN_INT);
      const after_float = envelopeAt(sample_int + NULL_NEIGHBOUR_SPAN_INT);
      const is_null_bool = here_float < threshold_float &&
        here_float <= before_float && here_float <= after_float;
      if (!is_null_bool) {
        continue;
      }

      const x_px_float = computeSampleX(geometry_obj, sample_int);
      if (x_px_float - last_marker_x_px_float < min_spacing_px_float) {
        continue;
      }
      last_marker_x_px_float = x_px_float;
      canvas_ctx.beginPath();
      canvas_ctx.arc(
        x_px_float,
        geometry_obj.mid_y_px_float,
        marker_radius_px_float,
        0,
        TWO_PI_FLOAT
      );
      canvas_ctx.fill();
    }
  }

  /**
   * Draw the window readout and the interference verdict.
   *
   * Arguments:
   *   geometry_obj (Object): Field geometry for this frame.
   *   window_obj (Object): The chosen time window.
   *   voices_list (Array<Object>): Voice records.
   *
   * Returns:
   *   (none)
   */
  #drawFieldLegend(geometry_obj, window_obj, voices_list) {
    const canvas_ctx = this.canvas_ctx;
    const pixel_ratio_float = geometry_obj.pixel_ratio_float;
    const window_ms_float = window_obj.window_seconds_float * 1000;

    canvas_ctx.font = `${9.5 * pixel_ratio_float}px ${MONO_FONT_STACK_STR}`;
    canvas_ctx.textBaseline = 'top';
    canvas_ctx.fillStyle = LEGEND_FILL_STR;

    let label_str;
    if (window_obj.beat_hertz_float > 0) {
      label_str = `window ${window_ms_float.toFixed(0)} ms   ` +
        `beat ${window_obj.beat_hertz_float.toFixed(2)} Hz`;
    } else {
      const lowest_hertz_float = Math.min(
        ...voices_list.map((voice_obj) => voice_obj.frequency_hertz_float)
      );
      label_str = `window ${window_ms_float.toFixed(1)} ms   ` +
        `${formatFrequency(lowest_hertz_float)}`;
    }
    canvas_ctx.fillText(
      label_str, geometry_obj.pad_x_px_float, 8 * pixel_ratio_float
    );

    if (voices_list.length <= 1) {
      return;
    }
    const { fill_style_str, verdict_str } = describeVerdict(
      this.#stats_obj.cancellation_ratio_float
    );
    canvas_ctx.fillStyle = fill_style_str;
    canvas_ctx.fillText(
      verdict_str, geometry_obj.pad_x_px_float, 22 * pixel_ratio_float
    );
  }

  /**
   * Draw the interference field for this frame.
   *
   * Arguments:
   *   width_px_int (number): Drawing buffer width.
   *   height_px_int (number): Drawing buffer height.
   *   voices_list (Array<Object>): Voice records.
   *   elapsed_seconds_float (number): Wall time since the previous frame.
   *
   * Returns:
   *   (none)
   */
  #drawField(
    width_px_int,
    height_px_int,
    voices_list,
    elapsed_seconds_float
  ) {
    const pixel_ratio_float = this.#pixel_ratio_float;
    const pad_x_px_float = FIELD_PAD_X_PX_FLOAT * pixel_ratio_float;
    const geometry_obj = {
      pad_x_px_float,
      mid_y_px_float: height_px_int * 0.5,
      amplitude_px_float: height_px_int * FIELD_AMPLITUDE_RATIO_FLOAT,
      width_px_int,
      pixel_ratio_float,
      sample_count_int: 0,
    };

    this.#drawFieldGrid(geometry_obj, height_px_int);

    if (!voices_list.length) {
      this.#stats_obj.cancellation_ratio_float = 0;
      this.#stats_obj.beat_hertz_float = 0;
      this.#stats_obj.peak_amplitude_float = 0;
      return;
    }

    const window_obj = chooseTimeWindow(voices_list);
    this.#stats_obj.beat_hertz_float = window_obj.beat_hertz_float;

    // Scroll the window so the display animates instead of standing still.
    this.#scroll_phase_seconds_float =
      (this.#scroll_phase_seconds_float + elapsed_seconds_float) %
      PHASE_WRAP_SECONDS_FLOAT;

    const trace_width_px_float = width_px_int - pad_x_px_float * 2;
    geometry_obj.sample_count_int = clampToRange(
      Math.round(trace_width_px_float / pixel_ratio_float) * 2,
      MIN_SAMPLE_COUNT_INT,
      MAX_SAMPLE_COUNT_INT
    );
    const timing_obj = {
      start_seconds_float: this.#scroll_phase_seconds_float,
      step_seconds_float:
        window_obj.window_seconds_float / (geometry_obj.sample_count_int - 1),
    };

    const sums_obj = this.#sumVoicesAndDrawGhosts(
      geometry_obj, voices_list, timing_obj
    );

    const measured_obj = measureCancellation(
      sums_obj.sum_left_float32array,
      sums_obj.sum_right_float32array,
      voices_list
    );
    this.#stats_obj.cancellation_ratio_float =
      measured_obj.cancellation_ratio_float;
    this.#stats_obj.peak_amplitude_float = measured_obj.peak_amplitude_float;

    this.#strokeLeg(
      geometry_obj, sums_obj.sum_left_float32array,
      LEFT_LEG_STROKE_STR, LEFT_LEG_GLOW_STR
    );
    this.#strokeLeg(
      geometry_obj, sums_obj.sum_right_float32array,
      RIGHT_LEG_STROKE_STR, RIGHT_LEG_GLOW_STR
    );

    if (voices_list.length > 1) {
      this.#drawNullMarkers(geometry_obj, sums_obj, voices_list);
    }
    this.#drawFieldLegend(geometry_obj, window_obj, voices_list);
  }

  /* =================================================================== */

  /**
   * Draw the dial, axis cross and clip region for the goniometer.
   *
   * Arguments:
   *   centre_x_px_float (number): Dial centre, horizontal.
   *   centre_y_px_float (number): Dial centre, vertical.
   *   radius_px_float (number): Dial radius.
   *
   * Returns:
   *   (none)
   */
  #drawGoniometerDial(centre_x_px_float, centre_y_px_float, radius_px_float) {
    const canvas_ctx = this.canvas_ctx;

    canvas_ctx.beginPath();
    canvas_ctx.arc(
      centre_x_px_float, centre_y_px_float, radius_px_float, 0, TWO_PI_FLOAT
    );
    canvas_ctx.fillStyle = 'rgba(0,0,0,0.42)';
    canvas_ctx.fill();
    canvas_ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    canvas_ctx.lineWidth = 1;
    canvas_ctx.stroke();
    canvas_ctx.clip();

    // Axis cross: vertical is mono, horizontal is out of phase.
    canvas_ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    canvas_ctx.beginPath();
    canvas_ctx.moveTo(centre_x_px_float, centre_y_px_float - radius_px_float);
    canvas_ctx.lineTo(centre_x_px_float, centre_y_px_float + radius_px_float);
    canvas_ctx.moveTo(centre_x_px_float - radius_px_float, centre_y_px_float);
    canvas_ctx.lineTo(centre_x_px_float + radius_px_float, centre_y_px_float);
    canvas_ctx.stroke();
  }

  /**
   * Stroke the rotated Lissajous trace inside the goniometer dial.
   *
   * Brief:
   *   Rotated 45 degrees so mid runs up the screen and side runs across it.
   *
   * Arguments:
   *   left_samples_float32array (Float32Array): Left time-domain samples.
   *   right_samples_float32array (Float32Array): Right time-domain samples.
   *   centre_x_px_float (number): Dial centre, horizontal.
   *   centre_y_px_float (number): Dial centre, vertical.
   *   trace_radius_px_float (number): Radius a full-scale sample reaches.
   *
   * Returns:
   *   (none)
   */
  #strokeLissajous(
    left_samples_float32array,
    right_samples_float32array,
    centre_x_px_float,
    centre_y_px_float,
    trace_radius_px_float
  ) {
    const canvas_ctx = this.canvas_ctx;
    const plotted_count_int = Math.min(
      left_samples_float32array.length,
      right_samples_float32array.length,
      GONIO_SAMPLE_LIMIT_INT
    );

    canvas_ctx.beginPath();
    for (let sample_int = 0; sample_int < plotted_count_int; sample_int++) {
      const mid_float = (left_samples_float32array[sample_int] +
        right_samples_float32array[sample_int]) * Math.SQRT1_2;
      const side_float = (left_samples_float32array[sample_int] -
        right_samples_float32array[sample_int]) * Math.SQRT1_2;
      const plot_x_px_float =
        centre_x_px_float + side_float * trace_radius_px_float;
      const plot_y_px_float =
        centre_y_px_float - mid_float * trace_radius_px_float;
      if (sample_int === 0) {
        canvas_ctx.moveTo(plot_x_px_float, plot_y_px_float);
      } else {
        canvas_ctx.lineTo(plot_x_px_float, plot_y_px_float);
      }
    }

    canvas_ctx.strokeStyle = 'rgba(0, 242, 254, 0.72)';
    canvas_ctx.lineWidth = 1 * this.#pixel_ratio_float;
    canvas_ctx.shadowBlur = 8 * this.#pixel_ratio_float;
    canvas_ctx.shadowColor = 'rgba(0,242,254,0.5)';
    canvas_ctx.stroke();
  }

  /**
   * Stereo goniometer, drawn as a Lissajous of left against right.
   *
   * Brief:
   *   Rotated 45 degrees so a centred mono signal draws a vertical line,
   *   which is the orientation every mastering engineer already reads
   *   fluently.
   *
   * Arguments:
   *   x_px_float (number): Left edge of the dial's bounding box.
   *   y_px_float (number): Top edge of the dial's bounding box.
   *   size_px_float (number): Bounding box side length.
   *
   * Returns:
   *   (none)
   */
  #drawGoniometer(x_px_float, y_px_float, size_px_float) {
    const canvas_ctx = this.canvas_ctx;
    const pixel_ratio_float = this.#pixel_ratio_float;
    const {
      left_samples_float32array,
      right_samples_float32array,
    } = this.engine_obj.meter.readStereoWaveforms();

    const centre_x_px_float = x_px_float + size_px_float / 2;
    const centre_y_px_float = y_px_float + size_px_float / 2;
    const radius_px_float = size_px_float / 2;

    canvas_ctx.save();
    this.#drawGoniometerDial(
      centre_x_px_float, centre_y_px_float, radius_px_float
    );

    this.#strokeLissajous(
      left_samples_float32array,
      right_samples_float32array,
      centre_x_px_float,
      centre_y_px_float,
      radius_px_float * GONIO_TRACE_RADIUS_RATIO_FLOAT
    );
    canvas_ctx.restore();

    canvas_ctx.font = `${8.5 * pixel_ratio_float}px ${MONO_FONT_STACK_STR}`;
    canvas_ctx.fillStyle = 'rgba(125,137,166,0.75)';
    canvas_ctx.textBaseline = 'bottom';
    canvas_ctx.fillText(
      'L/R',
      x_px_float + 2 * pixel_ratio_float,
      y_px_float + size_px_float - 1 * pixel_ratio_float
    );
  }
}
