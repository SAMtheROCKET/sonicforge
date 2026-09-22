/**
 * One independent oscillator voice.
 *
 * Brief:
 *   A channel owns its oscillator, its gain calibrated in dBFS, its stereo
 *   position and its starting phase, and can be driven either by the
 *   interface or by the scripting engine.
 *
 *   Oscillators are created on start and discarded on stop, never reused.
 *   That is not an optimisation choice: an OscillatorNode is single-use by
 *   specification, and once stopped it can never be restarted. Holding one
 *   to "reuse later" produces a channel that silently never sounds again.
 *
 *   A channel's phase is measured against the audio clock (phase-lock.js).
 *   Retuning a running oscillator glides its phase off that reference. So
 *   once the new frequency settles, the rack has the channel build a fresh
 *   voice on a shared frame and crossfade to it. Each oscillator therefore
 *   has a gain of its own, and the old voice fades out through it while
 *   the new one fades in.
 *
 *   Signal path:
 *     oscillator -> voice gain -> gain -> panner -> meter analyser -> bus
 */

import { Emitter } from '../util/events.js';
import {
  SILENCE_THRESHOLD_DB_FLOAT,
  convertDbToLinear,
  convertLinearToDb,
} from '../util/amplitude.js';
import { clampToRange } from '../util/numeric.js';
import {
  applyRotatedWaveform,
  normalisePhaseDegrees,
  WAVEFORM_KEYS_LIST,
} from './waveforms.js';
import { SMOOTHING_TIME_CONSTANT_FLOAT } from './audio-engine.js';
import {
  captureChannelState,
  restoreChannelState,
} from './channel-serialisation.js';
import {
  computeClockPhaseDegrees,
  computeStartFrame,
  convertFrameToStartSeconds,
} from './phase-lock.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Default level for a freshly created channel, in dBFS. */
const DEFAULT_LEVEL_DB_FLOAT = -18;

/** Default frequency for a freshly created channel, in hertz. */
const DEFAULT_FREQUENCY_HERTZ_FLOAT = 440;

/** Lowest frequency a channel will accept, in hertz. */
const MIN_FREQUENCY_HERTZ_FLOAT = 0.01;

/** Attack applied when a voice starts, in seconds. */
const ATTACK_SECONDS_FLOAT = 0.008;

/** Release applied when a voice stops, in seconds. */
const RELEASE_SECONDS_FLOAT = 0.012;

/** Delay between the release ending and the oscillator being stopped. */
const TEARDOWN_SECONDS_FLOAT = 0.02;

/** Dip applied around a discrete timbre change, in seconds. */
const TIMBRE_DIP_DOWN_SECONDS_FLOAT = 0.003;
const TIMBRE_DIP_UP_SECONDS_FLOAT = 0.009;

/** Bounds on detuning, in cents. */
const MAX_DETUNE_CENTS_FLOAT = 1200;

/** Bounds on portamento, in milliseconds. */
const MAX_GLIDE_MS_FLOAT = 10000;

/** Analyser size for the per-channel level meter. */
const CHANNEL_METER_FFT_SIZE_INT = 256;

/** Smoothing applied to the per-channel meter. */
const CHANNEL_METER_SMOOTHING_FLOAT = 0.5;

/** Time constant of an unglided frequency change, in seconds. */
const FREQUENCY_SMOOTHING_SECONDS_FLOAT = SMOOTHING_TIME_CONSTANT_FLOAT * 0.4;

/**
 * Time constants after which a smoothed parameter counts as arrived.
 *
 * Seven leave under a thousandth of the step still to travel.
 */
const SETTLE_TIME_CONSTANTS_FLOAT = 7;

/** Crossfade from the old voice to the new one on a relock, in seconds. */
const RELOCK_CROSSFADE_SECONDS_FLOAT = 0.012;

/* ------------------------------------------------------------------------ */

/**
 * Drive a single oscillator voice with level, pan, phase and glide.
 *
 * Brief:
 *   State on the instance is authoritative and the audio nodes follow it,
 *   never the reverse. That ordering matters because a channel must be able
 *   to describe itself for saving or for broadcasting to a peer even while
 *   it is stopped and owns no oscillator at all.
 *
 * Arguments:
 *   index_int (number): Position of this channel in the rack.
 *   engine_obj (AudioEngine): Engine supplying the context and output bus.
 *   hue_degrees_int (number): Colour used to identify this channel.
 *
 * Returns:
 *   (ToneChannel): A stopped channel with its output nodes connected.
 *
 * Warning:
 *   Requires an initialised engine; the nodes are built immediately.
 */
export class ToneChannel extends Emitter {
  constructor(index_int, engine_obj, hue_degrees_int = 0) {
    super();
    this.index_int = index_int;
    this.engine_obj = engine_obj;
    this.hue_degrees_int = hue_degrees_int;

    this.is_enabled_bool = false;
    this.frequency_hertz_float = DEFAULT_FREQUENCY_HERTZ_FLOAT;
    this.waveform_name_str = 'sine';
    this.gain_db_float = DEFAULT_LEVEL_DB_FLOAT;
    this.pan_position_float = 0;
    this.phase_degrees_int = 0;
    this.detune_cents_float = 0;
    this.glide_ms_float = 0;
    this.is_muted_bool = false;
    this.is_soloed_bool = false;
    this.is_silenced_by_solo_bool = false;

    /** The sounding voice: oscillator, voice gain and clock angle. */
    this.voice_obj = null;
    /** A voice still fading out after a relock, if any. */
    this.outgoing_voice_obj = null;
    /** Context time the current frequency automation finishes. */
    this.phase_settle_seconds_float = -Infinity;
    /** Whether the running voice may have drifted off the audio clock. */
    this.needs_phase_relock_bool = false;

    this.#buildOutputNodes();
  }

  /** The sounding oscillator, or null while the channel is stopped. */
  get oscillator_node() {
    return this.voice_obj ? this.voice_obj.oscillator_node : null;
  }

  /** Build the permanent nodes between the oscillator and the rack bus. */
  #buildOutputNodes() {
    const context_obj = this.engine_obj.context_obj;

    this.gain_node = context_obj.createGain();
    this.gain_node.gain.value = 0;

    this.panner_node = context_obj.createStereoPanner();
    this.panner_node.pan.value = 0;

    this.meter_analyser_node = context_obj.createAnalyser();
    this.meter_analyser_node.fftSize = CHANNEL_METER_FFT_SIZE_INT;
    this.meter_analyser_node.smoothingTimeConstant =
      CHANNEL_METER_SMOOTHING_FLOAT;
    this.meter_samples_float32array = new Float32Array(
      CHANNEL_METER_FFT_SIZE_INT
    );

    this.gain_node.connect(this.panner_node);
    this.panner_node.connect(this.meter_analyser_node);
    this.meter_analyser_node.connect(this.engine_obj.channel_bus_node);
  }

  /* ===================================================================
     Transport
     =================================================================== */

  /**
   * Start, or restart, this channel's oscillator.
   *
   * Arguments:
   *   when_seconds_float (number): Context time to start at, or null for
   *     immediately.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   *
   * Warning:
   *   Calling this on a running channel discards the current oscillator and
   *   builds a new one. The start is rounded up to a whole sample frame,
   *   which the phase definition needs, so it can land up to one sample
   *   after the time asked for.
   */
  start(when_seconds_float = null) {
    const context_obj = this.engine_obj.context_obj;
    const now_seconds_float = context_obj.currentTime;
    const start_frame_int = computeStartFrame(
      when_seconds_float ?? now_seconds_float,
      now_seconds_float,
      context_obj.sampleRate
    );
    const start_seconds_float = convertFrameToStartSeconds(
      start_frame_int, context_obj.sampleRate
    );

    if (this.voice_obj) {
      this.#discardVoices();
    }

    this.voice_obj = this.#buildVoice(start_frame_int);
    this.is_enabled_bool = true;
    this.#rampGainIn(start_seconds_float);
    this.#markRetuned(start_seconds_float);

    this.emit('start', this);
    this.emit('change', this);
    return this;
  }

  /**
   * Rebuild the running voice on a given frame, crossfading to it.
   *
   * Brief:
   *   Called by the rack once this channel's frequency has settled. The new
   *   voice is rotated to agree with the audio clock at that frame, so any
   *   phase drift picked up while retuning is gone once the crossfade ends.
   *
   * Arguments:
   *   start_frame_int (number): Sample frame the new voice starts on. It
   *     must still be in the future when the audio thread reaches it.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   *
   * Warning:
   *   If the old voice had drifted by nearly 180°, the crossfade passes
   *   through a brief dip in level. That is the cost of relocking, and it
   *   is paid once, just after a retune.
   */
  relockPhase(start_frame_int) {
    if (!this.voice_obj) {
      return this;
    }

    const incoming_voice_obj = this.#buildVoice(start_frame_int);
    const start_seconds_float = incoming_voice_obj.start_seconds_float;
    const end_seconds_float =
      start_seconds_float + RELOCK_CROSSFADE_SECONDS_FLOAT;

    const incoming_gain_param = incoming_voice_obj.voice_gain_node.gain;
    incoming_gain_param.setValueAtTime(0, start_seconds_float);
    incoming_gain_param.linearRampToValueAtTime(1, end_seconds_float);

    if (this.outgoing_voice_obj) {
      this.#releaseVoice(this.outgoing_voice_obj, start_seconds_float);
    }
    const outgoing_gain_param = this.voice_obj.voice_gain_node.gain;
    outgoing_gain_param.cancelScheduledValues(start_seconds_float);
    outgoing_gain_param.setValueAtTime(1, start_seconds_float);
    outgoing_gain_param.linearRampToValueAtTime(0, end_seconds_float);
    this.#releaseVoice(
      this.voice_obj, end_seconds_float + TEARDOWN_SECONDS_FLOAT
    );

    this.outgoing_voice_obj = this.voice_obj;
    this.voice_obj = incoming_voice_obj;
    this.needs_phase_relock_bool = false;
    return this;
  }

  /** Build an oscillator and its voice gain, locked to the audio clock. */
  #buildVoice(start_frame_int) {
    const context_obj = this.engine_obj.context_obj;
    const start_seconds_float = convertFrameToStartSeconds(
      start_frame_int, context_obj.sampleRate
    );
    const frequency_hertz_float =
      this.#clampFrequency(this.frequency_hertz_float);
    const anchor_degrees_float = computeClockPhaseDegrees(
      frequency_hertz_float,
      this.detune_cents_float,
      start_frame_int,
      context_obj.sampleRate
    );

    const oscillator_node = context_obj.createOscillator();
    applyRotatedWaveform(
      oscillator_node,
      this.waveform_name_str,
      anchor_degrees_float + this.phase_degrees_int
    );
    oscillator_node.frequency.setValueAtTime(
      frequency_hertz_float, start_seconds_float
    );
    oscillator_node.detune.setValueAtTime(
      this.detune_cents_float, start_seconds_float
    );

    const voice_gain_node = context_obj.createGain();
    oscillator_node.connect(voice_gain_node);
    voice_gain_node.connect(this.gain_node);
    oscillator_node.start(start_seconds_float);

    return {
      oscillator_node,
      voice_gain_node,
      anchor_degrees_float,
      start_seconds_float,
    };
  }

  /** Every voice still producing sound: the current one and any fading. */
  #listLiveVoices() {
    return [this.voice_obj, this.outgoing_voice_obj].filter(Boolean);
  }

  /** Record that a retune finishes at a time, and tell the rack. */
  #markRetuned(settle_seconds_float) {
    this.phase_settle_seconds_float = settle_seconds_float;
    this.needs_phase_relock_bool = true;
    this.emit('retune', this);
  }

  /** Ramp the gain up from silence, avoiding a start click. */
  #rampGainIn(start_seconds_float) {
    const gain_param = this.gain_node.gain;
    gain_param.cancelScheduledValues(start_seconds_float);
    gain_param.setValueAtTime(0, start_seconds_float);
    gain_param.linearRampToValueAtTime(
      this.effectiveGainLinear,
      start_seconds_float + ATTACK_SECONDS_FLOAT
    );
  }

  /**
   * Stop this channel with a short release, then tear the oscillator down.
   *
   * Arguments:
   *   when_seconds_float (number): Context time to stop at, or null.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   */
  stop(when_seconds_float = null) {
    if (!this.voice_obj) {
      this.is_enabled_bool = false;
      this.emit('change', this);
      return this;
    }

    const stop_seconds_float =
      when_seconds_float ?? this.engine_obj.context_obj.currentTime;
    const gain_param = this.gain_node.gain;
    gain_param.cancelScheduledValues(stop_seconds_float);
    gain_param.setValueAtTime(gain_param.value, stop_seconds_float);
    gain_param.linearRampToValueAtTime(
      0,
      stop_seconds_float + RELEASE_SECONDS_FLOAT
    );

    for (const voice_obj of this.#listLiveVoices()) {
      this.#releaseVoice(
        voice_obj, stop_seconds_float + TEARDOWN_SECONDS_FLOAT
      );
    }
    this.voice_obj = null;
    this.outgoing_voice_obj = null;
    this.needs_phase_relock_bool = false;

    this.is_enabled_bool = false;
    this.emit('stop', this);
    this.emit('change', this);
    return this;
  }

  /** Stop a voice at a time, and disconnect it once it has ended. */
  #releaseVoice(voice_obj, stop_seconds_float) {
    const { oscillator_node, voice_gain_node } = voice_obj;
    const disconnectVoice = () => {
      if (this.outgoing_voice_obj === voice_obj) {
        this.outgoing_voice_obj = null;
      }
      try {
        oscillator_node.disconnect();
        voice_gain_node.disconnect();
      } catch {
        // Already torn down by a context close; nothing to do.
      }
    };

    try {
      oscillator_node.stop(stop_seconds_float);
      oscillator_node.onended = disconnectVoice;
    } catch {
      disconnectVoice();
    }
  }

  /** Discard every voice immediately, without a release. */
  #discardVoices() {
    for (const voice_obj of this.#listLiveVoices()) {
      try {
        voice_obj.oscillator_node.stop();
      } catch {
        // The node may already have ended; either way it is finished with.
      }
      try {
        voice_obj.oscillator_node.disconnect();
        voice_obj.voice_gain_node.disconnect();
      } catch {
        // Already disconnected.
      }
    }
    this.voice_obj = null;
    this.outgoing_voice_obj = null;
  }

  /**
   * Toggle the channel between running and stopped.
   *
   * Arguments:
   *   should_run_bool (boolean): Desired state; defaults to the inverse.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   */
  toggle(should_run_bool = !this.is_enabled_bool) {
    return should_run_bool ? this.start() : this.stop();
  }

  /* ===================================================================
     Parameters
     =================================================================== */

  /** Linear gain this channel should produce, accounting for mute and solo. */
  get effectiveGainLinear() {
    if (this.is_muted_bool || this.is_silenced_by_solo_bool) {
      return 0;
    }
    return convertDbToLinear(this.gain_db_float);
  }

  /** Constrain a frequency to what the current context can represent. */
  #clampFrequency(frequency_hertz_float) {
    return clampToRange(
      Number(frequency_hertz_float) || 0,
      MIN_FREQUENCY_HERTZ_FLOAT,
      this.engine_obj.maxFrequencyHertz
    );
  }

  /**
   * Set the channel frequency, optionally gliding to it.
   *
   * Arguments:
   *   frequency_hertz_float (number): Target frequency.
   *   options_obj (Object): Optional glide_ms_float and when_seconds_float.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   *
   * Warning:
   *   Glide uses an exponential ramp, which cannot pass through or reach
   *   zero. The frequency is therefore floored just above it. A running
   *   channel leaves the audio clock's phase while it moves, and the rack
   *   relocks it once the move has settled.
   */
  setFrequencyHertz(frequency_hertz_float, options_obj = {}) {
    const {
      glide_ms_float = this.glide_ms_float,
      when_seconds_float = null,
    } = options_obj;

    this.frequency_hertz_float = this.#clampFrequency(frequency_hertz_float);

    if (this.voice_obj) {
      const at_seconds_float =
        when_seconds_float ?? this.engine_obj.context_obj.currentTime;
      for (const voice_obj of this.#listLiveVoices()) {
        this.#scheduleFrequencyMove(
          voice_obj.oscillator_node.frequency,
          at_seconds_float,
          glide_ms_float
        );
      }
      this.#markRetuned(
        glide_ms_float > 0
          ? at_seconds_float + glide_ms_float / 1000
          : at_seconds_float +
            SETTLE_TIME_CONSTANTS_FLOAT * FREQUENCY_SMOOTHING_SECONDS_FLOAT
      );
    }

    this.emit('change', this);
    return this;
  }

  /** Move one oscillator's frequency to the channel's, gliding or not. */
  #scheduleFrequencyMove(frequency_param, at_seconds_float, glide_ms_float) {
    frequency_param.cancelScheduledValues(at_seconds_float);

    if (glide_ms_float > 0) {
      frequency_param.setValueAtTime(
        Math.max(frequency_param.value, MIN_FREQUENCY_HERTZ_FLOAT),
        at_seconds_float
      );
      frequency_param.exponentialRampToValueAtTime(
        this.frequency_hertz_float,
        at_seconds_float + glide_ms_float / 1000
      );
    } else {
      frequency_param.setTargetAtTime(
        this.frequency_hertz_float,
        at_seconds_float,
        FREQUENCY_SMOOTHING_SECONDS_FLOAT
      );
    }
  }

  /**
   * Schedule a frequency sweep to a target.
   *
   * Brief:
   *   Exponential is the perceptually correct curve, giving constant
   *   octaves per second; linear is what measurement standards specify.
   *   Both are offered because the right answer depends on the task.
   *
   * Arguments:
   *   target_hertz_float (number): Frequency to arrive at.
   *   duration_ms_float (number): Sweep duration.
   *   curve_name_str (string): 'exponential' or 'linear'.
   *   when_seconds_float (number): Context time to begin, or null.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   */
  sweepToFrequency(target_hertz_float, duration_ms_float,
                   curve_name_str = 'exponential',
                   when_seconds_float = null) {
    const at_seconds_float =
      when_seconds_float ?? this.engine_obj.context_obj.currentTime;
    const target_float = this.#clampFrequency(target_hertz_float);
    const duration_seconds_float = Math.max(0.001, duration_ms_float / 1000);
    const end_seconds_float = at_seconds_float + duration_seconds_float;

    for (const voice_obj of this.#listLiveVoices()) {
      const frequency_param = voice_obj.oscillator_node.frequency;
      frequency_param.cancelScheduledValues(at_seconds_float);
      frequency_param.setValueAtTime(
        Math.max(this.frequency_hertz_float, MIN_FREQUENCY_HERTZ_FLOAT),
        at_seconds_float
      );

      if (curve_name_str === 'linear') {
        frequency_param.linearRampToValueAtTime(
          target_float, end_seconds_float
        );
      } else {
        frequency_param.exponentialRampToValueAtTime(
          Math.max(target_float, MIN_FREQUENCY_HERTZ_FLOAT),
          end_seconds_float
        );
      }
    }

    this.frequency_hertz_float = target_float;
    if (this.voice_obj) {
      this.#markRetuned(end_seconds_float);
    }
    this.emit('change', this);
    return this;
  }

  /**
   * Set the channel level in dBFS.
   *
   * Arguments:
   *   level_db_float (number): Level to set.
   *   options_obj (Object): Optional when_seconds_float and ramp_ms_float.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   */
  setGainDb(level_db_float, options_obj = {}) {
    this.gain_db_float = clampToRange(
      Number(level_db_float) ?? SILENCE_THRESHOLD_DB_FLOAT,
      SILENCE_THRESHOLD_DB_FLOAT,
      0
    );
    this.#applyGain(
      options_obj.when_seconds_float ?? null,
      options_obj.ramp_ms_float ?? null
    );
    this.emit('change', this);
    return this;
  }

  /** Move the gain node to the channel's effective level. */
  #applyGain(when_seconds_float = null, ramp_ms_float = null) {
    const at_seconds_float =
      when_seconds_float ?? this.engine_obj.context_obj.currentTime;
    const gain_param = this.gain_node.gain;
    const target_linear_float = this.oscillator_node
      ? this.effectiveGainLinear
      : 0;

    gain_param.cancelScheduledValues(at_seconds_float);
    if (ramp_ms_float != null) {
      gain_param.setValueAtTime(gain_param.value, at_seconds_float);
      gain_param.linearRampToValueAtTime(
        target_linear_float,
        at_seconds_float + ramp_ms_float / 1000
      );
    } else {
      gain_param.setTargetAtTime(
        target_linear_float,
        at_seconds_float,
        SMOOTHING_TIME_CONSTANT_FLOAT
      );
    }
  }

  /**
   * Set the stereo position of this channel.
   *
   * Arguments:
   *   pan_position_float (number): -1 hard left through +1 hard right.
   *   options_obj (Object): Optional when_seconds_float.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   */
  setPanPosition(pan_position_float, options_obj = {}) {
    this.pan_position_float = clampToRange(
      Number(pan_position_float) || 0,
      -1,
      1
    );
    const at_seconds_float =
      options_obj.when_seconds_float ??
      this.engine_obj.context_obj.currentTime;

    this.panner_node.pan.cancelScheduledValues(at_seconds_float);
    this.panner_node.pan.setTargetAtTime(
      this.pan_position_float,
      at_seconds_float,
      SMOOTHING_TIME_CONSTANT_FLOAT
    );

    this.emit('change', this);
    return this;
  }

  /**
   * Set this channel's phase against the audio clock.
   *
   * Brief:
   *   Phase is baked into the wave table, so changing it on a running
   *   oscillator rotates the output immediately. Each voice keeps the clock
   *   angle it was built with, and the new table is that angle plus the new
   *   phase. A move from 0° to 180° is then exactly half a turn. Small
   *   increments from a slider drag are inaudible; a large jump produces a
   *   deliberate and informative discontinuity.
   *
   * Arguments:
   *   phase_degrees_float (number): Phase, 0 through 360.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   */
  setPhaseDegrees(phase_degrees_float) {
    this.phase_degrees_int = normalisePhaseDegrees(phase_degrees_float);
    this.#applyVoiceTables();
    this.emit('change', this);
    return this;
  }

  /** Rewrite every live voice's table for the current waveform and phase. */
  #applyVoiceTables() {
    for (const voice_obj of this.#listLiveVoices()) {
      applyRotatedWaveform(
        voice_obj.oscillator_node,
        this.waveform_name_str,
        voice_obj.anchor_degrees_float + this.phase_degrees_int
      );
    }
  }

  /**
   * Change the channel's waveform.
   *
   * Brief:
   *   A discrete timbre change gets a brief gain dip so that the harmonic
   *   jump reads as a transition rather than a click.
   *
   * Arguments:
   *   waveform_name_str (string): Key from WAVEFORMS_DICT.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   *
   * Warning:
   *   Throws RangeError for an unknown waveform.
   */
  setWaveformName(waveform_name_str) {
    if (!WAVEFORM_KEYS_LIST.includes(waveform_name_str)) {
      throw new RangeError(`unknown waveform: ${waveform_name_str}`);
    }
    this.waveform_name_str = waveform_name_str;

    if (this.oscillator_node) {
      this.#swapWaveformWithDip();
    }
    this.emit('change', this);
    return this;
  }

  /** Dip the gain, swap the wave table, and restore the gain. */
  #swapWaveformWithDip() {
    const now_seconds_float = this.engine_obj.context_obj.currentTime;
    const gain_param = this.gain_node.gain;
    const target_linear_float = this.effectiveGainLinear;

    gain_param.cancelScheduledValues(now_seconds_float);
    gain_param.setValueAtTime(gain_param.value, now_seconds_float);
    gain_param.linearRampToValueAtTime(
      0,
      now_seconds_float + TIMBRE_DIP_DOWN_SECONDS_FLOAT
    );
    this.#applyVoiceTables();
    gain_param.linearRampToValueAtTime(
      target_linear_float,
      now_seconds_float + TIMBRE_DIP_UP_SECONDS_FLOAT
    );
  }

  /**
   * Detune the channel by a number of cents.
   *
   * Arguments:
   *   detune_cents_float (number): Cents of detune, positive or negative.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   */
  setDetuneCents(detune_cents_float) {
    this.detune_cents_float = clampToRange(
      Number(detune_cents_float) || 0,
      -MAX_DETUNE_CENTS_FLOAT,
      MAX_DETUNE_CENTS_FLOAT
    );

    if (this.voice_obj) {
      const now_seconds_float = this.engine_obj.context_obj.currentTime;
      for (const voice_obj of this.#listLiveVoices()) {
        const detune_param = voice_obj.oscillator_node.detune;
        detune_param.cancelScheduledValues(now_seconds_float);
        detune_param.setTargetAtTime(
          this.detune_cents_float,
          now_seconds_float,
          SMOOTHING_TIME_CONSTANT_FLOAT
        );
      }
      this.#markRetuned(
        now_seconds_float +
          SETTLE_TIME_CONSTANTS_FLOAT * SMOOTHING_TIME_CONSTANT_FLOAT
      );
    }

    this.emit('change', this);
    return this;
  }

  /**
   * Set the portamento time applied to frequency changes.
   *
   * Arguments:
   *   glide_ms_float (number): Glide duration in milliseconds.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   */
  setGlideMs(glide_ms_float) {
    this.glide_ms_float = clampToRange(
      Number(glide_ms_float) || 0,
      0,
      MAX_GLIDE_MS_FLOAT
    );
    this.emit('change', this);
    return this;
  }

  /**
   * Mute or unmute this channel.
   *
   * Arguments:
   *   is_muted_bool (boolean): Whether the channel should be silent.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   */
  setMuted(is_muted_bool) {
    this.is_muted_bool = !!is_muted_bool;
    this.#applyGain();
    this.emit('change', this);
    return this;
  }

  /**
   * Solo or unsolo this channel.
   *
   * Arguments:
   *   is_soloed_bool (boolean): Whether this channel should solo.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   *
   * Warning:
   *   Emits a solo event the rack listens for; the rack, not the channel,
   *   decides what soloing does to everything else.
   */
  setSoloed(is_soloed_bool) {
    this.is_soloed_bool = !!is_soloed_bool;
    this.emit('solo', this);
    this.emit('change', this);
    return this;
  }

  /**
   * Re-apply the gain after the rack changes the solo mask.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  refreshGain() {
    this.#applyGain();
  }

  /* ===================================================================
     Metering and serialisation
     =================================================================== */

  /**
   * Measure this channel's own peak level.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): Peak level in dBFS, or -Infinity when stopped.
   */
  readPeakLevelDb() {
    if (!this.oscillator_node) {
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
    return convertLinearToDb(peak_linear_float);
  }

  /**
   * Capture this channel's state as a plain object.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): Every user-settable parameter of this channel.
   */
  toJSON() {
    return captureChannelState(this);
  }

  /**
   * Restore this channel from a plain object.
   *
   * Arguments:
   *   state_obj (Object): State previously produced by toJSON.
   *
   * Returns:
   *   (ToneChannel): This channel, for chaining.
   *
   * Warning:
   *   Starts or stops the channel, because running state is part of what
   *   was captured.
   */
  fromJSON(state_obj = {}) {
    return restoreChannelState(this, state_obj);
  }
}
