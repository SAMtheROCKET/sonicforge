/**
 * The global noise generator.
 *
 * Brief:
 *   Seven spectral colours, any two of which can be cross-blended live - the
 *   Acoustic Shielding preset leans on a brown-to-pink hybrid - plus a
 *   shaping filter and a dedicated vocal-band emphasis stage.
 *
 *   Signal path:
 *     sourceA -> gainA --+
 *                        +-> blend -> shape -> shield -> level -> pan -> bus
 *     sourceB -> gainB --+
 *
 *   Buffers are synthesised once per colour and cached for the life of the
 *   page, because generating one costs a full inverse FFT. Looping is
 *   seam-free: spectrally designed colours are periodic by construction and
 *   the time-domain colours are cross-faded before being cached.
 */

import { Emitter } from '../util/events.js';
import {
  SILENCE_THRESHOLD_DB_FLOAT,
  convertDbToLinear,
} from '../util/amplitude.js';
import { clampToRange } from '../util/numeric.js';
import {
  buildNoiseBuffer,
  NOISE_COLOURS_DICT,
} from '../dsp/noise-colours.js';
import { VOCAL_BAND_HERTZ_DICT } from '../dsp/weighting.js';
import { SMOOTHING_TIME_CONSTANT_FLOAT } from './audio-engine.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/**
 * Samples per cached noise buffer.
 *
 * 2^18 is about 5.5 seconds at 48 kHz, long enough that the loop point is
 * not perceptible even on sustained listening, and short enough that
 * synthesis stays under a tenth of a second.
 */
const BUFFER_SAMPLE_COUNT_INT = 1 << 18;

/** Shaping filters offered to the user. */
export const SHAPE_FILTER_LABELS_DICT = Object.freeze({
  off: 'Off',
  lowpass: 'Low-pass',
  highpass: 'High-pass',
  bandpass: 'Band-pass',
  notch: 'Notch',
});

/** Default colours, level and shaping for a fresh generator. */
const DEFAULT_PRIMARY_COLOUR_STR = 'brown';
const DEFAULT_SECONDARY_COLOUR_STR = 'pink';
const DEFAULT_LEVEL_DB_FLOAT = -24;
const DEFAULT_SHAPE_FREQUENCY_HERTZ_FLOAT = 1000;
const DEFAULT_SHAPE_Q_FLOAT = 0.9;

/**
 * Quality factor of the vocal shield.
 *
 * About 2.2 octaves wide, which spans roughly 300 Hz to 3400 Hz - the band
 * that carries speech intelligibility. Narrower would miss the consonants
 * that make speech comprehensible; wider would just raise the whole room.
 */
const SHIELD_Q_FLOAT = 0.62;

/** Bounds on the vocal shield, in decibels. */
const MAX_SHIELD_DB_FLOAT = 12;

/** Bounds on the shaping filter. */
const MIN_SHAPE_FREQUENCY_HERTZ_FLOAT = 20;
const MAX_SHAPE_FREQUENCY_HERTZ_FLOAT = 20000;
const MIN_SHAPE_Q_FLOAT = 0.05;
const MAX_SHAPE_Q_FLOAT = 20;

/** Analyser size for the noise level meter. */
const METER_FFT_SIZE_INT = 256;

/** Fade applied when the generator starts or stops, in seconds. */
const START_FADE_SECONDS_FLOAT = 0.06;
const STOP_FADE_SECONDS_FLOAT = 0.08;

/** Grace period before a replaced source is stopped, in seconds. */
const SOURCE_SWAP_SECONDS_FLOAT = 0.02;

/**
 * Sample offset decorrelating the right channel from the left.
 *
 * A prime number, so the two channels never re-align on a short cycle.
 * Without this the noise collapses to the centre of the stereo image and
 * sounds like a hole in the middle of the head.
 */
const STEREO_DECORRELATION_OFFSET_INT = 7919;

/** The two colour slots the blend crossfades between. */
const NOISE_SLOT_NAMES_TUPLE = Object.freeze(['primary', 'secondary']);

/* ------------------------------------------------------------------------ */

/**
 * Generate, shape and blend continuous background noise.
 *
 * Brief:
 *   State on the instance is authoritative; the audio nodes follow it. The
 *   generator can therefore be configured while stopped and will start in
 *   exactly the configured state.
 *
 * Arguments:
 *   engine_obj (AudioEngine): Engine supplying the context and noise bus.
 *
 * Returns:
 *   (NoiseGenerator): A stopped generator with its chain connected.
 *
 * Warning:
 *   Requires an initialised engine; the nodes are built on construction.
 */
export class NoiseGenerator extends Emitter {
  #buffer_cache_map = new Map();
  #pending_builds_map = new Map();

  is_running_bool = false;
  primary_colour_str = DEFAULT_PRIMARY_COLOUR_STR;
  secondary_colour_str = DEFAULT_SECONDARY_COLOUR_STR;
  blend_ratio_float = 0;
  gain_db_float = DEFAULT_LEVEL_DB_FLOAT;
  pan_position_float = 0;
  shape_type_str = 'off';
  shape_frequency_hertz_float = DEFAULT_SHAPE_FREQUENCY_HERTZ_FLOAT;
  shape_q_float = DEFAULT_SHAPE_Q_FLOAT;
  shield_db_float = 0;

  constructor(engine_obj) {
    super();
    this.engine_obj = engine_obj;
    this.#buildSignalChain();
  }

  /** Build the permanent chain from the blend stage to the noise bus. */
  #buildSignalChain() {
    const context_obj = this.engine_obj.context_obj;

    this.primary_gain_node = context_obj.createGain();
    this.secondary_gain_node = context_obj.createGain();
    this.blend_sum_node = context_obj.createGain();
    this.primary_gain_node.gain.value = 1;
    this.secondary_gain_node.gain.value = 0;
    this.primary_gain_node.connect(this.blend_sum_node);
    this.secondary_gain_node.connect(this.blend_sum_node);

    this.shape_filter_node = context_obj.createBiquadFilter();
    this.shape_filter_node.type = 'allpass';
    this.shape_filter_node.frequency.value =
      this.shape_frequency_hertz_float;
    this.shape_filter_node.Q.value = this.shape_q_float;

    this.shield_filter_node = context_obj.createBiquadFilter();
    this.shield_filter_node.type = 'peaking';
    this.shield_filter_node.frequency.value =
      VOCAL_BAND_HERTZ_DICT.centre_hertz_float;
    this.shield_filter_node.Q.value = SHIELD_Q_FLOAT;
    this.shield_filter_node.gain.value = 0;

    this.level_gain_node = context_obj.createGain();
    this.level_gain_node.gain.value = 0;
    this.panner_node = context_obj.createStereoPanner();

    this.meter_analyser_node = context_obj.createAnalyser();
    this.meter_analyser_node.fftSize = METER_FFT_SIZE_INT;
    this.meter_samples_float32array = new Float32Array(METER_FFT_SIZE_INT);

    this.blend_sum_node.connect(this.shape_filter_node);
    this.shape_filter_node.connect(this.shield_filter_node);
    this.shield_filter_node.connect(this.level_gain_node);
    this.level_gain_node.connect(this.panner_node);
    this.panner_node.connect(this.meter_analyser_node);
    this.meter_analyser_node.connect(this.engine_obj.noise_bus_node);
  }

  /* ===================================================================
     Buffer synthesis
     =================================================================== */

  /**
   * Fetch, or synthesise, the looping buffer for a colour.
   *
   * Brief:
   *   Concurrent requests for the same colour share one build, so rapidly
   *   clicking through colours cannot start six overlapping inverse FFTs.
   *   Two frames are yielded before synthesis so the interface can paint a
   *   spinner rather than appearing to freeze.
   *
   * Arguments:
   *   colour_name_str (string): Key from NOISE_COLOURS_DICT.
   *
   * Returns:
   *   (Promise<AudioBuffer>): A stereo, seamlessly looping buffer.
   *
   * Warning:
   *   The first request for a spectrally designed colour costs a full
   *   inverse FFT and will block the main thread briefly.
   */
  async getColourBuffer(colour_name_str) {
    if (this.#buffer_cache_map.has(colour_name_str)) {
      return this.#buffer_cache_map.get(colour_name_str);
    }
    if (this.#pending_builds_map.has(colour_name_str)) {
      return this.#pending_builds_map.get(colour_name_str);
    }

    const build_promise = this.#synthesiseColourBuffer(colour_name_str);
    this.#pending_builds_map.set(colour_name_str, build_promise);
    return build_promise;
  }

  /** Synthesise one colour into a decorrelated stereo AudioBuffer. */
  async #synthesiseColourBuffer(colour_name_str) {
    this.emit('building', colour_name_str);
    await new Promise((resolve_fn) => requestAnimationFrame(resolve_fn));
    await new Promise((resolve_fn) => setTimeout(resolve_fn, 0));

    const sample_rate_float = this.engine_obj.sampleRateHertz;
    const samples_float32array = buildNoiseBuffer(
      colour_name_str,
      BUFFER_SAMPLE_COUNT_INT,
      sample_rate_float
    );

    const buffer_obj = this.engine_obj.context_obj.createBuffer(
      2,
      samples_float32array.length,
      sample_rate_float
    );
    this.#fillStereoBuffer(buffer_obj, samples_float32array);

    this.#buffer_cache_map.set(colour_name_str, buffer_obj);
    this.#pending_builds_map.delete(colour_name_str);
    this.emit('built', colour_name_str);
    return buffer_obj;
  }

  /** Copy mono samples into both channels, offsetting the right one. */
  #fillStereoBuffer(buffer_obj, samples_float32array) {
    const left_float32array = buffer_obj.getChannelData(0);
    const right_float32array = buffer_obj.getChannelData(1);
    const length_int = samples_float32array.length;

    left_float32array.set(samples_float32array);
    for (let index_int = 0; index_int < length_int; index_int += 1) {
      const offset_index_int =
        (index_int + STEREO_DECORRELATION_OFFSET_INT) % length_int;
      right_float32array[index_int] =
        samples_float32array[offset_index_int];
    }
  }

  /**
   * Pre-synthesise colours during idle time.
   *
   * Arguments:
   *   colour_names_list (string[]): Colours to build ahead of use.
   *
   * Returns:
   *   (Promise<void>)
   */
  async warmColourCache(colour_names_list) {
    for (const colour_name_str of colour_names_list) {
      await this.getColourBuffer(colour_name_str);
    }
  }

  /** Create a looping source node for a buffer. */
  #createLoopingSource(buffer_obj) {
    const source_node = this.engine_obj.context_obj.createBufferSource();
    source_node.buffer = buffer_obj;
    source_node.loop = true;
    return source_node;
  }

  /* ===================================================================
     Transport
     =================================================================== */

  /**
   * Start the noise generator.
   *
   * Brief:
   *   Each source starts at a random offset into its buffer, so restarting
   *   the generator does not replay an identical sequence.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<NoiseGenerator>): This generator, once sounding.
   */
  async start() {
    if (this.is_running_bool) {
      return this;
    }

    const needs_secondary_bool = this.blend_ratio_float > 0;
    const [primary_buffer_obj, secondary_buffer_obj] = await Promise.all([
      this.getColourBuffer(this.primary_colour_str),
      needs_secondary_bool
        ? this.getColourBuffer(this.secondary_colour_str)
        : Promise.resolve(null),
    ]);

    this.#stopSources(this.engine_obj.context_obj.currentTime);

    this.primary_source_node = this.#createLoopingSource(primary_buffer_obj);
    this.primary_source_node.connect(this.primary_gain_node);
    this.primary_source_node.start(
      0,
      Math.random() * primary_buffer_obj.duration
    );

    if (secondary_buffer_obj) {
      this.secondary_source_node =
        this.#createLoopingSource(secondary_buffer_obj);
      this.secondary_source_node.connect(this.secondary_gain_node);
      this.secondary_source_node.start(
        0,
        Math.random() * secondary_buffer_obj.duration
      );
    }

    this.is_running_bool = true;
    this.#applyBlend();
    this.#applyLevel(START_FADE_SECONDS_FLOAT);
    this.emit('start', this);
    this.emit('change', this);
    return this;
  }

  /**
   * Stop the noise generator with a short fade.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (NoiseGenerator): This generator, for chaining.
   */
  stop() {
    if (!this.is_running_bool) {
      return this;
    }

    const now_seconds_float = this.engine_obj.context_obj.currentTime;
    const level_param = this.level_gain_node.gain;
    level_param.cancelScheduledValues(now_seconds_float);
    level_param.setValueAtTime(level_param.value, now_seconds_float);
    level_param.linearRampToValueAtTime(
      0,
      now_seconds_float + STOP_FADE_SECONDS_FLOAT
    );

    this.#stopSources(now_seconds_float + STOP_FADE_SECONDS_FLOAT + 0.02);
    this.is_running_bool = false;
    this.emit('stop', this);
    this.emit('change', this);
    return this;
  }

  /** Stop and release both buffer sources. */
  #stopSources(when_seconds_float) {
    for (const property_name_str of [
      'primary_source_node',
      'secondary_source_node',
    ]) {
      const source_node = this[property_name_str];
      if (!source_node) {
        continue;
      }
      this[property_name_str] = null;
      try {
        source_node.stop(when_seconds_float);
        source_node.onended = () => {
          try {
            source_node.disconnect();
          } catch {
            // Context already torn down.
          }
        };
      } catch {
        try {
          source_node.disconnect();
        } catch {
          // Already disconnected.
        }
      }
    }
  }

  /**
   * Toggle the generator between running and stopped.
   *
   * Arguments:
   *   should_run_bool (boolean): Desired state; defaults to the inverse.
   *
   * Returns:
   *   (Promise<NoiseGenerator>): This generator.
   */
  async toggle(should_run_bool = !this.is_running_bool) {
    return should_run_bool ? this.start() : this.stop();
  }

  /* ===================================================================
     Parameters
     =================================================================== */

  /**
   * Choose the colour for one of the two blend slots.
   *
   * Arguments:
   *   colour_name_str (string): Key from NOISE_COLOURS_DICT.
   *   slot_name_str (string): 'primary' or 'secondary'.
   *
   * Returns:
   *   (Promise<NoiseGenerator>): This generator.
   *
   * Warning:
   *   Throws RangeError for an unknown colour. Swapping a colour while
   *   running briefly overlaps the old and new sources, which is
   *   deliberate: it is inaudible, whereas a gap is not.
   */
  async setColour(colour_name_str, slot_name_str = 'primary') {
    if (!NOISE_COLOURS_DICT[colour_name_str]) {
      throw new RangeError(`unknown noise colour: ${colour_name_str}`);
    }
    // Rejected rather than treated as primary. Silently falling back meant
    // a caller using the interface's own 'A'/'B' labels overwrote slot one
    // and quietly disabled the blend.
    if (!NOISE_SLOT_NAMES_TUPLE.includes(slot_name_str)) {
      throw new RangeError(
        `unknown noise slot: ${slot_name_str} ` +
        `(expected ${NOISE_SLOT_NAMES_TUPLE.join(' or ')})`
      );
    }

    const is_secondary_bool = slot_name_str === 'secondary';
    const property_name_str = is_secondary_bool
      ? 'secondary_colour_str'
      : 'primary_colour_str';

    if (this[property_name_str] === colour_name_str) {
      return this;
    }
    this[property_name_str] = colour_name_str;

    if (this.is_running_bool) {
      await this.#swapRunningSource(colour_name_str, is_secondary_bool);
    }
    this.emit('change', this);
    return this;
  }

  /** Replace a running source with one playing a different colour. */
  async #swapRunningSource(colour_name_str, is_secondary_bool) {
    const buffer_obj = await this.getColourBuffer(colour_name_str);
    const source_property_str = is_secondary_bool
      ? 'secondary_source_node'
      : 'primary_source_node';
    const gain_node = is_secondary_bool
      ? this.secondary_gain_node
      : this.primary_gain_node;

    const previous_source_node = this[source_property_str];
    const next_source_node = this.#createLoopingSource(buffer_obj);
    next_source_node.connect(gain_node);
    next_source_node.start(0, Math.random() * buffer_obj.duration);
    this[source_property_str] = next_source_node;

    if (previous_source_node) {
      const stop_at_float =
        this.engine_obj.context_obj.currentTime + SOURCE_SWAP_SECONDS_FLOAT;
      try {
        previous_source_node.stop(stop_at_float);
        previous_source_node.onended = () => {
          try {
            previous_source_node.disconnect();
          } catch {
            // Already released.
          }
        };
      } catch {
        // The source had already ended.
      }
    }
  }

  /**
   * Set the blend between the two colours.
   *
   * Brief:
   *   Equal-power rather than linear, so a fifty-fifty hybrid is not three
   *   decibels quieter than either extreme - which is exactly what a naive
   *   linear cross-fade produces and why hybrids so often sound wrong.
   *
   * Arguments:
   *   blend_ratio_float (number): 0 for pure primary, 1 for pure secondary.
   *
   * Returns:
   *   (Promise<NoiseGenerator>): This generator.
   */
  async setBlendRatio(blend_ratio_float) {
    const next_ratio_float = clampToRange(
      Number(blend_ratio_float) || 0,
      0,
      1
    );
    const was_primary_only_bool = this.blend_ratio_float === 0;
    this.blend_ratio_float = next_ratio_float;

    const needs_source_bool =
      this.is_running_bool &&
      was_primary_only_bool &&
      next_ratio_float > 0 &&
      !this.secondary_source_node;

    if (needs_source_bool) {
      const buffer_obj = await this.getColourBuffer(
        this.secondary_colour_str
      );
      this.secondary_source_node = this.#createLoopingSource(buffer_obj);
      this.secondary_source_node.connect(this.secondary_gain_node);
      this.secondary_source_node.start(
        0,
        Math.random() * buffer_obj.duration
      );
    }

    this.#applyBlend();
    this.emit('change', this);
    return this;
  }

  /** Move both blend gains along an equal-power curve. */
  #applyBlend() {
    const now_seconds_float = this.engine_obj.context_obj.currentTime;
    const primary_gain_float = Math.cos(
      (this.blend_ratio_float * Math.PI) / 2
    );
    const secondary_gain_float = Math.sin(
      (this.blend_ratio_float * Math.PI) / 2
    );

    this.primary_gain_node.gain.setTargetAtTime(
      primary_gain_float,
      now_seconds_float,
      SMOOTHING_TIME_CONSTANT_FLOAT
    );
    this.secondary_gain_node.gain.setTargetAtTime(
      secondary_gain_float,
      now_seconds_float,
      SMOOTHING_TIME_CONSTANT_FLOAT
    );
  }

  /**
   * Set the generator output level in dBFS.
   *
   * Arguments:
   *   level_db_float (number): Level to set.
   *
   * Returns:
   *   (NoiseGenerator): This generator, for chaining.
   */
  setGainDb(level_db_float) {
    this.gain_db_float = clampToRange(
      Number(level_db_float) ?? SILENCE_THRESHOLD_DB_FLOAT,
      SILENCE_THRESHOLD_DB_FLOAT,
      0
    );
    this.#applyLevel();
    this.emit('change', this);
    return this;
  }

  /** Move the level gain to the configured value. */
  #applyLevel(ramp_seconds_float = null) {
    const now_seconds_float = this.engine_obj.context_obj.currentTime;
    const level_param = this.level_gain_node.gain;
    const target_linear_float = this.is_running_bool
      ? convertDbToLinear(this.gain_db_float)
      : 0;

    level_param.cancelScheduledValues(now_seconds_float);
    if (ramp_seconds_float) {
      level_param.setValueAtTime(level_param.value, now_seconds_float);
      level_param.linearRampToValueAtTime(
        target_linear_float,
        now_seconds_float + ramp_seconds_float
      );
    } else {
      level_param.setTargetAtTime(
        target_linear_float,
        now_seconds_float,
        SMOOTHING_TIME_CONSTANT_FLOAT
      );
    }
  }

  /**
   * Set the stereo position of the noise.
   *
   * Arguments:
   *   pan_position_float (number): -1 hard left through +1 hard right.
   *
   * Returns:
   *   (NoiseGenerator): This generator, for chaining.
   */
  setPanPosition(pan_position_float) {
    this.pan_position_float = clampToRange(
      Number(pan_position_float) || 0,
      -1,
      1
    );
    this.panner_node.pan.setTargetAtTime(
      this.pan_position_float,
      this.engine_obj.context_obj.currentTime,
      SMOOTHING_TIME_CONSTANT_FLOAT
    );
    this.emit('change', this);
    return this;
  }

  /**
   * Configure the shaping filter.
   *
   * Arguments:
   *   options_obj (Object): Optional type_str, frequency_hertz_float and
   *     q_float.
   *
   * Returns:
   *   (NoiseGenerator): This generator, for chaining.
   *
   * Warning:
   *   A type of 'off' puts the filter into allpass rather than bypassing
   *   it, so the node count stays constant and no reconnection is needed.
   */
  setShapeFilter(options_obj = {}) {
    const {
      type_str = this.shape_type_str,
      frequency_hertz_float = this.shape_frequency_hertz_float,
      q_float = this.shape_q_float,
    } = options_obj;

    this.shape_type_str =
      type_str in SHAPE_FILTER_LABELS_DICT ? type_str : 'off';
    this.shape_frequency_hertz_float = clampToRange(
      Number(frequency_hertz_float) || DEFAULT_SHAPE_FREQUENCY_HERTZ_FLOAT,
      MIN_SHAPE_FREQUENCY_HERTZ_FLOAT,
      MAX_SHAPE_FREQUENCY_HERTZ_FLOAT
    );
    this.shape_q_float = clampToRange(
      Number(q_float) || DEFAULT_SHAPE_Q_FLOAT,
      MIN_SHAPE_Q_FLOAT,
      MAX_SHAPE_Q_FLOAT
    );

    const now_seconds_float = this.engine_obj.context_obj.currentTime;
    this.shape_filter_node.type =
      this.shape_type_str === 'off' ? 'allpass' : this.shape_type_str;
    this.shape_filter_node.frequency.setTargetAtTime(
      this.shape_frequency_hertz_float,
      now_seconds_float,
      0.03
    );
    this.shape_filter_node.Q.setTargetAtTime(
      this.shape_q_float,
      now_seconds_float,
      0.03
    );

    this.emit('change', this);
    return this;
  }

  /**
   * Set the vocal-band emphasis.
   *
   * Brief:
   *   Raises masking energy across roughly 300 Hz to 3400 Hz, the band that
   *   carries speech intelligibility, without brightening the whole signal.
   *   Concentrating energy where conversation lives beats simply turning
   *   everything up, which raises the room without improving the ratio.
   *
   * Arguments:
   *   shield_db_float (number): Emphasis in decibels, -12 through +12.
   *
   * Returns:
   *   (NoiseGenerator): This generator, for chaining.
   */
  setShieldDb(shield_db_float) {
    this.shield_db_float = clampToRange(
      Number(shield_db_float) || 0,
      -MAX_SHIELD_DB_FLOAT,
      MAX_SHIELD_DB_FLOAT
    );
    this.shield_filter_node.gain.setTargetAtTime(
      this.shield_db_float,
      this.engine_obj.context_obj.currentTime,
      0.05
    );
    this.emit('change', this);
    return this;
  }

  /**
   * Measure the generator's own peak level.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): Peak level in dBFS, or -Infinity when stopped.
   */
  readPeakLevelDb() {
    if (!this.is_running_bool) {
      return -Infinity;
    }

    this.meter_analyser_node.getFloatTimeDomainData(
      this.meter_samples_float32array
    );

    let peak_linear_float = 0;
    for (
      let index_int = 0;
      index_int < this.meter_samples_float32array.length;
      index_int += 1
    ) {
      const magnitude_float = Math.abs(
        this.meter_samples_float32array[index_int]
      );
      if (magnitude_float > peak_linear_float) {
        peak_linear_float = magnitude_float;
      }
    }
    return peak_linear_float > 0
      ? 20 * Math.log10(peak_linear_float)
      : -Infinity;
  }

  /**
   * Capture the generator's state as a plain object.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): Every user-settable parameter.
   */
  toJSON() {
    return {
      is_running_bool: this.is_running_bool,
      primary_colour_str: this.primary_colour_str,
      secondary_colour_str: this.secondary_colour_str,
      blend_ratio_float: this.blend_ratio_float,
      gain_db_float: this.gain_db_float,
      pan_position_float: this.pan_position_float,
      shape_type_str: this.shape_type_str,
      shape_frequency_hertz_float: this.shape_frequency_hertz_float,
      shape_q_float: this.shape_q_float,
      shield_db_float: this.shield_db_float,
    };
  }

  /**
   * Restore the generator from a captured state object.
   *
   * Arguments:
   *   state_obj (Object): State produced by toJSON.
   *
   * Returns:
   *   (Promise<NoiseGenerator>): This generator.
   *
   * Warning:
   *   Starts or stops the generator, because running state is captured.
   */
  async fromJSON(state_obj = {}) {
    if (!state_obj || typeof state_obj !== 'object') {
      return this;
    }

    if (NOISE_COLOURS_DICT[state_obj.primary_colour_str]) {
      this.primary_colour_str = state_obj.primary_colour_str;
    }
    if (NOISE_COLOURS_DICT[state_obj.secondary_colour_str]) {
      this.secondary_colour_str = state_obj.secondary_colour_str;
    }
    if (Number.isFinite(state_obj.blend_ratio_float)) {
      this.blend_ratio_float = clampToRange(
        state_obj.blend_ratio_float,
        0,
        1
      );
    }
    if (Number.isFinite(state_obj.gain_db_float)) {
      this.gain_db_float = clampToRange(
        state_obj.gain_db_float,
        SILENCE_THRESHOLD_DB_FLOAT,
        0
      );
    }
    if (Number.isFinite(state_obj.pan_position_float)) {
      this.pan_position_float = clampToRange(
        state_obj.pan_position_float,
        -1,
        1
      );
    }

    this.setShapeFilter({
      type_str: state_obj.shape_type_str,
      frequency_hertz_float: state_obj.shape_frequency_hertz_float,
      q_float: state_obj.shape_q_float,
    });
    this.setShieldDb(state_obj.shield_db_float ?? 0);

    if (state_obj.is_running_bool) {
      await this.start();
    } else {
      this.stop();
    }

    this.emit('change', this);
    return this;
  }
}
