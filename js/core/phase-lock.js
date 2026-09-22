/**
 * Phase-lock every channel oscillator to the audio clock.
 *
 * Brief:
 *   A PeriodicWave fixes the phase an oscillator *starts* at. From then on
 *   its phase depends on when it started and on every frequency it has
 *   passed through. Two channels set to 0° and 180° therefore cancel only if
 *   they started together and were never retuned. Retune one while it plays
 *   - 660 Hz, then 444, then 440 - and the pair settles an arbitrary angle
 *   apart while both controls still read what they did.
 *
 *   This module defines phase against the audio clock instead. A channel at
 *   f hertz and phase p outputs wave(2*pi*f*t + p), where t is the context's
 *   own time. An oscillator started on sample frame k meets that definition
 *   when its table is rotated by p plus the angle the clock has swept by
 *   frame k, which is 360 * frac(f * k / rate).
 *
 *   Two channels built on the same frame at the same frequency then differ
 *   by exactly their phase settings. That holds even after the wave cache
 *   rounds to whole degrees, because rounding both angles shifts them by
 *   the same amount. So after any change settles, the scheduler here
 *   rebuilds every settled channel on one shared frame.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Time from now to the frame a relock builds on, in seconds. */
const RELOCK_LOOKAHEAD_SECONDS_FLOAT = 0.03;

/**
 * How far before its frame an oscillator is asked to start, in samples.
 *
 * Starting a hair early makes both kinds of implementation agree: one that
 * starts on the next whole frame starts exactly on it, and one that honours
 * sub-sample start times is off by a thousandth of a sample.
 */
const START_BIAS_SAMPLES_FLOAT = 0.001;

/** Quiet period after a change settles before relocking, in milliseconds. */
const RELOCK_DEBOUNCE_MS_INT = 40;

/** How often to look again while the context is suspended, in ms. */
const SUSPENDED_POLL_MS_INT = 250;

/** Cents in one octave, for converting detune to a frequency ratio. */
const CENTS_PER_OCTAVE_FLOAT = 1200;

/** Degrees in a full rotation. */
const FULL_ROTATION_DEGREES_FLOAT = 360;

/* ------------------------------------------------------------------------ */

/**
 * Choose the sample frame an oscillator should start on.
 *
 * Brief:
 *   A start time is only meaningful to the phase definition once it lands
 *   on a whole frame, so every start is rounded up to one. A requested time
 *   already in the past starts on the current frame instead.
 *
 * Arguments:
 *   requested_seconds_float (number): Context time the caller asked for.
 *   now_seconds_float (number): The context's current time.
 *   sample_rate_hertz_float (number): The context's sample rate.
 *
 * Returns:
 *   (number): A whole sample frame index.
 */
export function computeStartFrame(requested_seconds_float, now_seconds_float,
                                  sample_rate_hertz_float) {
  const earliest_seconds_float =
    Math.max(requested_seconds_float, now_seconds_float);
  return Math.ceil(earliest_seconds_float * sample_rate_hertz_float);
}

/**
 * Convert a start frame into the time to pass to start().
 *
 * Brief:
 *   The time asked for sits a thousandth of a sample before the frame, so
 *   the oscillator's first sample falls on that frame whether or not the
 *   engine honours sub-sample start times.
 *
 * Arguments:
 *   frame_int (number): Sample frame the oscillator should start on.
 *   sample_rate_hertz_float (number): The context's sample rate.
 *
 * Returns:
 *   (number): Context time in seconds, never negative.
 */
export function convertFrameToStartSeconds(frame_int,
                                           sample_rate_hertz_float) {
  return Math.max(
    0,
    (frame_int - START_BIAS_SAMPLES_FLOAT) / sample_rate_hertz_float
  );
}

/**
 * Measure the angle the audio clock has swept at a frame.
 *
 * Brief:
 *   This is the rotation an oscillator starting on that frame needs, on top
 *   of the channel's own phase, to agree with every other locked channel.
 *
 * Arguments:
 *   frequency_hertz_float (number): The channel's frequency.
 *   detune_cents_float (number): The channel's detune.
 *   frame_int (number): Sample frame the oscillator starts on.
 *   sample_rate_hertz_float (number): The context's sample rate.
 *
 * Returns:
 *   (number): An angle from 0 up to, but not including, 360 degrees.
 *
 * Warning:
 *   The frequency is rounded to single precision first, because that is
 *   what an AudioParam actually holds. Channels with equal settings get
 *   bit-identical angles, which is what makes cancellation exact.
 */
export function computeClockPhaseDegrees(frequency_hertz_float,
                                         detune_cents_float, frame_int,
                                         sample_rate_hertz_float) {
  const effective_hertz_float = Math.fround(frequency_hertz_float) *
    2 ** (detune_cents_float / CENTS_PER_OCTAVE_FLOAT);
  const elapsed_seconds_float = frame_int / sample_rate_hertz_float;
  const cycles_float = effective_hertz_float * elapsed_seconds_float;
  const fraction_float = cycles_float - Math.floor(cycles_float);
  return FULL_ROTATION_DEGREES_FLOAT * fraction_float;
}

/**
 * Report whether a context renders offline.
 *
 * Arguments:
 *   context_obj (BaseAudioContext): The context to inspect.
 *
 * Returns:
 *   (boolean): True for an OfflineAudioContext.
 */
function isOfflineContext(context_obj) {
  return typeof OfflineAudioContext !== 'undefined' &&
    context_obj instanceof OfflineAudioContext;
}

/* ------------------------------------------------------------------------ */

/**
 * Relock channel phases once their frequencies have settled.
 *
 * Brief:
 *   A channel reports a retune together with the time its frequency
 *   automation finishes. Relocking any earlier would lock onto a frequency
 *   still in motion. So the scheduler waits for the earliest pending
 *   channel to settle, then rebuilds every settled channel on one shared
 *   frame. Rebuilding the channels that were already locked costs an
 *   inaudible crossfade between two copies of the same wave. It also
 *   removes the slow drift between an old oscillator and a new one, since
 *   no engine advances phase at exactly the nominal frequency.
 *
 * Arguments:
 *   engine_obj (AudioEngine): Engine supplying the current context.
 *   channels_list (ToneChannel[]): The rack's channels, shared by reference.
 *
 * Returns:
 *   (PhaseRelockScheduler): An idle scheduler.
 *
 * Warning:
 *   Timers never drive an OfflineAudioContext, whose clock only moves while
 *   it renders. Tests call relockSettledChannels directly instead.
 */
export class PhaseRelockScheduler {
  constructor(engine_obj, channels_list) {
    this.engine_obj = engine_obj;
    this.channels_list = channels_list;
    this.relock_timer_id_int = null;
  }

  /**
   * Note that a channel changed, and re-plan the next relock.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  requestRelock() {
    if (this.relock_timer_id_int !== null) {
      clearTimeout(this.relock_timer_id_int);
      this.relock_timer_id_int = null;
    }
    this.#armTimer();
  }

  /**
   * Rebuild every settled, running channel on one shared frame.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): How many channels were rebuilt; zero when none needed it.
   */
  relockSettledChannels() {
    const context_obj = this.engine_obj.context_obj;
    const frame_int = computeStartFrame(
      context_obj.currentTime + RELOCK_LOOKAHEAD_SECONDS_FLOAT,
      context_obj.currentTime,
      context_obj.sampleRate
    );
    const frame_seconds_float = frame_int / context_obj.sampleRate;

    const settled_channels_list = this.channels_list.filter(
      (channel_obj) =>
        channel_obj.oscillator_node &&
        channel_obj.phase_settle_seconds_float <= frame_seconds_float
    );
    const is_needed_bool = settled_channels_list.some(
      (channel_obj) => channel_obj.needs_phase_relock_bool
    );
    if (!is_needed_bool) {
      return 0;
    }

    for (const channel_obj of settled_channels_list) {
      channel_obj.relockPhase(frame_int);
    }
    return settled_channels_list.length;
  }

  /** Find when the earliest channel still awaiting a relock settles. */
  #findEarliestPendingSeconds() {
    let earliest_seconds_float = Infinity;
    for (const channel_obj of this.channels_list) {
      if (channel_obj.oscillator_node && channel_obj.needs_phase_relock_bool) {
        earliest_seconds_float = Math.min(
          earliest_seconds_float,
          channel_obj.phase_settle_seconds_float
        );
      }
    }
    return earliest_seconds_float;
  }

  /** Arm a timer for just after the earliest pending channel settles. */
  #armTimer() {
    const pending_seconds_float = this.#findEarliestPendingSeconds();
    if (pending_seconds_float === Infinity) {
      return;
    }

    const now_seconds_float = this.engine_obj.context_obj.currentTime;
    const wait_ms_float =
      Math.max(0, (pending_seconds_float - now_seconds_float) * 1000) +
      RELOCK_DEBOUNCE_MS_INT;
    this.relock_timer_id_int =
      setTimeout(() => this.#handleTimer(), wait_ms_float);
  }

  /** Relock whatever has settled, then plan for whatever has not. */
  #handleTimer() {
    this.relock_timer_id_int = null;
    const context_obj = this.engine_obj.context_obj;
    if (isOfflineContext(context_obj)) {
      return;
    }

    if (context_obj.state !== 'running') {
      this.relock_timer_id_int =
        setTimeout(() => this.#handleTimer(), SUSPENDED_POLL_MS_INT);
      return;
    }

    this.relockSettledChannels();
    this.#armTimer();
  }
}
