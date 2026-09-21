/**
 * The SonicForge audio engine: context lifecycle and the master signal chain.
 *
 * Brief:
 *   Owns the AudioContext and every node between a sound source and the
 *   speakers. Nothing else in the application is permitted to touch
 *   context.destination directly, because routing everything through here is
 *   what guarantees the calibration EQ and the safety limiter are always in
 *   circuit. A source that bypassed the chain could hand the user a clipped
 *   square wave with no indication anything was wrong.
 *
 *   Signal flow:
 *     channels --+
 *                +--> preMaster --> [EQ x10] --> masterGain --> limiter -->
 *     noise -----+                                                  |
 *                                                                   +--> out
 *                                                                   +--> meter
 */

import { Emitter } from '../util/events.js';
import {
  SILENCE_THRESHOLD_DB_FLOAT,
  convertDbToLinear,
} from '../util/amplitude.js';
import { clampToRange } from '../util/numeric.js';
import { MasterMeter, SPECTRUM_FFT_SIZE_INT } from './master-meter.js';
import { CalibrationEqualiser } from './calibration-equaliser.js';
import { armGestureUnlock } from './gesture-unlock.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/**
 * Time constant for every user-driven gain change, in seconds.
 *
 * Short enough to feel instantaneous, long enough that no zipper noise or
 * click is produced. Every module that ramps a gain uses this one value so
 * that the whole application feels consistent under the hand.
 */
export const SMOOTHING_TIME_CONSTANT_FLOAT = 0.015;

/**
 * Selectable context sample rates.
 *
 * The rate is the hard ceiling on what can be synthesised: nothing above
 * Nyquist exists, no matter what the interface lets the user type. 96 kHz is
 * the entry point for ultrasonic work; 192 kHz is accepted by few devices
 * and costs four times the CPU of 48 kHz for no benefit below 24 kHz.
 */
export const SAMPLE_RATE_OPTIONS_LIST = Object.freeze([
  {
    rate_hertz_int: 44100,
    label_str: '44.1 kHz',
    nyquist_hertz_int: 22050,
    note_str: 'CD standard',
  },
  {
    rate_hertz_int: 48000,
    label_str: '48 kHz',
    nyquist_hertz_int: 24000,
    note_str: 'Default - audio to 24 kHz',
  },
  {
    rate_hertz_int: 96000,
    label_str: '96 kHz',
    nyquist_hertz_int: 48000,
    note_str: 'Ultrasonic - up to 48 kHz',
  },
  {
    rate_hertz_int: 192000,
    label_str: '192 kHz',
    nyquist_hertz_int: 96000,
    note_str: 'Rarely supported',
  },
]);

/** Where the audible band begins and ends, for labelling only. */
export const AUDIBLE_BAND_HERTZ_DICT = Object.freeze({
  lower_hertz_int: 20,
  upper_hertz_int: 20000,
});

/** Default master level on a first run, in dBFS. */
const DEFAULT_MASTER_LEVEL_DB_FLOAT = -12;

/** Highest master level the user may select, in dBFS. */
const MAX_MASTER_LEVEL_DB_FLOAT = 6;

/** Safety limiter settings. Not a creative effect: it exists so that
 *  stacking sixteen channels at full scale cannot produce a square wave. */
const LIMITER_THRESHOLD_DB_FLOAT = -1.5;
const LIMITER_KNEE_DB_FLOAT = 0;
const LIMITER_RATIO_FLOAT = 20;
const LIMITER_ATTACK_SECONDS_FLOAT = 0.003;
const LIMITER_RELEASE_SECONDS_FLOAT = 0.1;

/* ------------------------------------------------------------------------ */

/**
 * Create and own the AudioContext, master chain and metering taps.
 *
 * Brief:
 *   Construction is cheap and allocates nothing; the context and graph are
 *   built by init(), which must run inside a user gesture on every modern
 *   browser. Call armGestureUnlock() to have that handled automatically.
 *
 * Arguments:
 *   options_obj (Object): Optional spectrum_fft_size_int.
 *
 * Returns:
 *   (AudioEngine): An engine with no context yet.
 *
 * Warning:
 *   Every property that names an audio node is null until init() resolves.
 */
export class AudioEngine extends Emitter {
  context_obj = null;
  is_ready_bool = false;

  #master_level_db_float = DEFAULT_MASTER_LEVEL_DB_FLOAT;
  #is_muted_bool = false;
  #is_limiter_enabled_bool = true;
  #unlock_handler_fn = null;

  constructor(options_obj = {}) {
    super();
    this.spectrum_fft_size_int =
      options_obj.spectrum_fft_size_int ?? SPECTRUM_FFT_SIZE_INT;
  }

  /* ===================================================================
     Lifecycle
     =================================================================== */

  /**
   * Create the AudioContext and build the master chain.
   *
   * Brief:
   *   Safe to call repeatedly; a second call simply resumes. An explicit
   *   sample rate is how ultrasonic work gets above the usual 24 kHz
   *   ceiling, and a device that refuses the request falls back to its
   *   native rate rather than failing outright.
   *
   * Arguments:
   *   options_obj (Object): Optional sample_rate_hertz_int.
   *
   * Returns:
   *   (Promise<AudioEngine>): This engine, once the graph exists.
   *
   * Warning:
   *   Must be triggered by a real user gesture on Safari and on Chrome's
   *   autoplay-restricted origins, or the context starts suspended.
   */
  async init(options_obj = {}) {
    if (this.is_ready_bool) {
      await this.resume();
      return this;
    }

    const context_constructor_fn =
      window.AudioContext || window.webkitAudioContext;
    if (!context_constructor_fn) {
      const error_obj = new Error(
        'Web Audio API unavailable in this browser.'
      );
      this.emit('error', error_obj);
      throw error_obj;
    }

    this.context_obj = this.#createContext(
      context_constructor_fn,
      options_obj.sample_rate_hertz_int ?? null
    );
    this.#buildSignalChain();
    this.is_ready_bool = true;

    this.context_obj.addEventListener?.('statechange', () =>
      this.emit('state', this.context_obj.state)
    );
    await this.resume();

    this.emit('ready', this);
    return this;
  }

  /**
   * Construct an AudioContext, falling back if a rate is refused.
   *
   * Arguments:
   *   context_constructor_fn (Function): AudioContext or its webkit alias.
   *   sample_rate_hertz_int (number): Requested rate, or null for native.
   *
   * Returns:
   *   (AudioContext): A live context.
   */
  #createContext(context_constructor_fn, sample_rate_hertz_int) {
    const options_obj = { latencyHint: 'interactive' };
    if (sample_rate_hertz_int) {
      options_obj.sampleRate = sample_rate_hertz_int;
    }

    try {
      return new context_constructor_fn(options_obj);
    } catch {
      if (sample_rate_hertz_int) {
        this.emit(
          'warn',
          `This device refused ${sample_rate_hertz_int} Hz; ` +
            'using its native rate instead.'
        );
      }
      return new context_constructor_fn({ latencyHint: 'interactive' });
    }
  }

  /**
   * Build the complete master signal chain.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #buildSignalChain() {
    const context_obj = this.context_obj;

    this.channel_bus_node = context_obj.createGain();
    this.noise_bus_node = context_obj.createGain();
    this.pre_master_node = context_obj.createGain();
    this.master_gain_node = context_obj.createGain();

    this.channel_bus_node.gain.value = 1;
    this.noise_bus_node.gain.value = 1;
    this.pre_master_node.gain.value = 1;
    this.master_gain_node.gain.value = convertDbToLinear(
      this.#master_level_db_float
    );

    this.channel_bus_node.connect(this.pre_master_node);
    this.noise_bus_node.connect(this.pre_master_node);

    this.equaliser_obj = new CalibrationEqualiser(context_obj);
    this.pre_master_node.connect(this.equaliser_obj.inputNode);
    this.equaliser_obj.outputNode.connect(this.master_gain_node);

    this.#buildLimiterAndOutput();

    this.meter_obj = new MasterMeter(context_obj, this.spectrum_fft_size_int);
    this.output_tap_node.connect(this.meter_obj.inputNode);
  }


  /**
   * Insert the safety limiter and the output tap.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #buildLimiterAndOutput() {
    const context_obj = this.context_obj;

    this.limiter_node = context_obj.createDynamicsCompressor();
    this.limiter_node.threshold.value = LIMITER_THRESHOLD_DB_FLOAT;
    this.limiter_node.knee.value = LIMITER_KNEE_DB_FLOAT;
    this.limiter_node.ratio.value = LIMITER_RATIO_FLOAT;
    this.limiter_node.attack.value = LIMITER_ATTACK_SECONDS_FLOAT;
    this.limiter_node.release.value = LIMITER_RELEASE_SECONDS_FLOAT;

    this.limiter_bypass_node = context_obj.createGain();
    this.limiter_bypass_node.gain.value = 1;
    this.master_gain_node.connect(this.limiter_node);
    this.limiter_node.connect(this.limiter_bypass_node);

    this.output_tap_node = context_obj.createGain();
    this.limiter_bypass_node.connect(this.output_tap_node);
    this.output_tap_node.connect(context_obj.destination);
  }

  /**
   * Unlock audio on the first genuine user gesture.
   *
   * Brief:
   *   Delegates the browser-specific detail to gesture-unlock.js and simply
   *   reports the outcome through this engine's event emitter.
   *
   * Arguments:
   *   target_el (EventTarget): Element to listen on; defaults to window.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Calling this twice is a no-op; the first arming remains in force.
   */
  armGestureUnlock(target_el = window) {
    if (this.#unlock_handler_fn) {
      return;
    }

    this.#unlock_handler_fn = armGestureUnlock(
      target_el,
      async () => {
        await this.init();
        return this.context_obj;
      },
      () => {
        this.#unlock_handler_fn = null;
        this.emit('unlocked', this);
      },
      (error_obj) => this.emit('error', error_obj)
    );
  }


  /**
   * Resume a suspended context.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<boolean>): True when the context is running afterwards.
   */
  async resume() {
    if (!this.context_obj) {
      return false;
    }

    if (this.context_obj.state === 'suspended') {
      try {
        await this.context_obj.resume();
      } catch {
        return false;
      }
    }

    this.emit('state', this.context_obj.state);
    return this.context_obj.state === 'running';
  }

  /**
   * Suspend the context, halting all processing.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<void>)
   */
  async suspend() {
    if (this.context_obj && this.context_obj.state === 'running') {
      await this.context_obj.suspend();
    }
    this.emit('state', this.context_obj?.state);
  }

  /**
   * Close the context and release its hardware resources.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<void>)
   *
   * Warning:
   *   A closed context can never be reopened; a new engine is required.
   */
  async close() {
    if (!this.context_obj) {
      return;
    }
    try {
      await this.context_obj.close();
    } finally {
      this.context_obj = null;
      this.is_ready_bool = false;
      this.emit('closed');
    }
  }

  /* ===================================================================
     Clock and telemetry
     =================================================================== */

  /** Current position of the sample clock, in seconds. */
  get currentTimeSeconds() {
    return this.context_obj ? this.context_obj.currentTime : 0;
  }

  /** Sample rate of the context, in hertz. */
  get sampleRateHertz() {
    return this.context_obj ? this.context_obj.sampleRate : 48000;
  }

  /** Highest frequency representable without aliasing, in hertz. */
  get nyquistHertz() {
    return this.sampleRateHertz / 2;
  }

  /** Practical ceiling for a user-settable oscillator frequency. */
  get maxFrequencyHertz() {
    return this.nyquistHertz - 1;
  }

  /** Lifecycle state of the context. */
  get state() {
    return this.context_obj ? this.context_obj.state : 'closed';
  }

  /** Round-trip latency estimate in milliseconds, where reported. */
  get latencyMs() {
    if (!this.context_obj) {
      return 0;
    }
    const base_latency_float = this.context_obj.baseLatency || 0;
    const output_latency_float = this.context_obj.outputLatency || 0;
    return (base_latency_float + output_latency_float) * 1000;
  }

  /* ===================================================================
     Master controls
     =================================================================== */

  /** Master output level in dBFS. */
  get masterLevelDb() {
    return this.#master_level_db_float;
  }

  set masterLevelDb(level_db_float) {
    this.#master_level_db_float = clampToRange(
      Number(level_db_float) || SILENCE_THRESHOLD_DB_FLOAT,
      SILENCE_THRESHOLD_DB_FLOAT,
      MAX_MASTER_LEVEL_DB_FLOAT
    );
    this.#applyMasterLevel();
    this.emit('master', this.#master_level_db_float);
  }

  /** Whether the master output is muted. */
  get isMuted() {
    return this.#is_muted_bool;
  }

  set isMuted(is_muted_bool) {
    this.#is_muted_bool = !!is_muted_bool;
    this.#applyMasterLevel();
    this.emit('mute', this.#is_muted_bool);
  }

  /**
   * Ramp the master gain node to the current level and mute state.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #applyMasterLevel() {
    if (!this.is_ready_bool) {
      return;
    }

    const target_linear_float = this.#is_muted_bool
      ? 0
      : convertDbToLinear(this.#master_level_db_float);
    const gain_param = this.master_gain_node.gain;

    gain_param.cancelScheduledValues(this.currentTimeSeconds);
    gain_param.setTargetAtTime(
      target_linear_float,
      this.currentTimeSeconds,
      SMOOTHING_TIME_CONSTANT_FLOAT
    );
  }

  /** Whether the safety limiter is in circuit. */
  get isLimiterEnabled() {
    return this.#is_limiter_enabled_bool;
  }

  /**
   * Engage or bypass the safety limiter.
   *
   * Brief:
   *   Bypassing reconnects the master gain straight to the output tap.
   *   Offered because measurement work sometimes needs a provably linear
   *   path, at the cost of losing clipping protection.
   *
   * Arguments:
   *   is_enabled_bool (boolean): Whether the limiter should be in circuit.
   *
   * Returns:
   *   (none)
   */
  set isLimiterEnabled(is_enabled_bool) {
    const next_bool = !!is_enabled_bool;

    if (next_bool === this.#is_limiter_enabled_bool || !this.is_ready_bool) {
      this.#is_limiter_enabled_bool = next_bool;
      return;
    }

    this.#is_limiter_enabled_bool = next_bool;
    try {
      this.master_gain_node.disconnect();
    } catch {
      // Already disconnected; reconnecting below is still correct.
    }

    if (next_bool) {
      this.master_gain_node.connect(this.limiter_node);
    } else {
      this.master_gain_node.connect(this.limiter_bypass_node);
    }
    this.emit('limiter', next_bool);
  }

  /** Instantaneous limiter gain reduction, in decibels (negative). */
  get gainReductionDb() {
    const is_active_bool =
      this.is_ready_bool && this.#is_limiter_enabled_bool;
    return is_active_bool ? this.limiter_node.reduction : 0;
  }

  /**
   * Silence every output immediately without tearing down the graph.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Sets the master gain to zero with no ramp, which is audible as a hard
   *   cut. That is the intent: this is the control a user reaches for when
   *   something is painfully loud.
   */
  panic() {
    if (!this.is_ready_bool) {
      return;
    }
    const gain_param = this.master_gain_node.gain;
    gain_param.cancelScheduledValues(this.currentTimeSeconds);
    gain_param.setValueAtTime(0, this.currentTimeSeconds);
    this.emit('panic');
  }

  /* ===================================================================
     Calibration equaliser
     =================================================================== */


  /**
   * Expose the calibration equaliser for direct control.
   *
   * Brief:
   *   Returned as an object rather than wrapped in forwarding methods, so
   *   that the equaliser's own contract is the only one to learn.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (CalibrationEqualiser): The equaliser, or null before init().
   */
  get equaliser() {
    return this.equaliser_obj ?? null;
  }

  /**
   * Expose the master meter for direct reads.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (MasterMeter): The meter, or null before init().
   */
  get meter() {
    return this.meter_obj ?? null;
  }

}
