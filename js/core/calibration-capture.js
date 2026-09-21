/**
 * Microphone capture and stimulus playback for room calibration.
 *
 * Brief:
 *   Everything that touches hardware during a measurement: acquiring the
 *   microphone with every "helpful" processing stage disabled, running the
 *   frame-accurate capture loop, probing the round-trip latency, and playing
 *   the sweep itself.
 *
 *   PRIVACY: the microphone stream is opened only for the duration of a
 *   measurement and the caller is responsible for stopping its tracks. No
 *   audio is recorded, buffered to disk, or transmitted - only a magnitude
 *   curve ever leaves the analyser.
 */

import { clampToRange } from '../util/numeric.js';
import { convertDbToLinear } from '../util/amplitude.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Lowest frequency of the measurement sweep, in hertz. */
export const SWEEP_START_HERTZ_FLOAT = 20;

/** Highest frequency of the measurement sweep, in hertz. */
export const SWEEP_END_HERTZ_FLOAT = 20000;

/** Analyser size used for capture; 8192 gives ~5.9 Hz bins at 48 kHz. */
const CAPTURE_FFT_SIZE_INT = 8192;

/** Decibel window the capture analyser reports over. */
const CAPTURE_MIN_DB_FLOAT = -140;
const CAPTURE_MAX_DB_FLOAT = 0;

/** Frequency of the latency sync burst, in hertz. */
const SYNC_BURST_HERTZ_FLOAT = 1000;

/** Envelope of the sync burst, in seconds. */
const SYNC_BURST_ATTACK_SECONDS_FLOAT = 0.005;
const SYNC_BURST_HOLD_SECONDS_FLOAT = 0.045;
const SYNC_BURST_RELEASE_SECONDS_FLOAT = 0.05;
const SYNC_BURST_TOTAL_SECONDS_FLOAT = 0.08;

/** How long to listen for the sync burst, in milliseconds. */
const SYNC_LISTEN_MS_FLOAT = 450;

/** Rise above baseline that counts as detecting the burst, in decibels. */
const SYNC_DETECT_THRESHOLD_DB_FLOAT = 12;

/** Plausible bounds on a round trip, in milliseconds. */
const MIN_LATENCY_MS_FLOAT = 0;
const MAX_LATENCY_MS_FLOAT = 400;

/** Fallback latency added to the browser's own estimate, in milliseconds. */
const FALLBACK_LATENCY_MARGIN_MS_FLOAT = 30;

/** Fade applied at each end of the sweep, in seconds. */
const SWEEP_FADE_SECONDS_FLOAT = 0.02;

/* ------------------------------------------------------------------------ */

/**
 * Compute the instantaneous frequency of an exponential sweep.
 *
 * Brief:
 *   An exponential sweep spends equal time in each octave, which is what
 *   gives a measurement usable resolution at the bottom of the band where
 *   speakers actually misbehave.
 *
 * Arguments:
 *   progress_float (number): Position through the sweep, 0 through 1.
 *   start_hertz_float (number): Frequency at the beginning.
 *   end_hertz_float (number): Frequency at the end.
 *
 * Returns:
 *   (number): Instantaneous frequency in hertz.
 */
export function computeSweepFrequencyAt(progress_float,
                                        start_hertz_float =
                                          SWEEP_START_HERTZ_FLOAT,
                                        end_hertz_float =
                                          SWEEP_END_HERTZ_FLOAT) {
  const clamped_float = clampToRange(progress_float, 0, 1);
  return (
    start_hertz_float *
    (end_hertz_float / start_hertz_float) ** clamped_float
  );
}

/**
 * Open the microphone with all automatic processing disabled.
 *
 * Brief:
 *   Echo cancellation would cancel the very signal being measured, noise
 *   suppression would flatten the noise-floor estimate, and automatic gain
 *   control would destroy the amplitude relationship the whole measurement
 *   depends on. All three must be off or the result is meaningless.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (Promise<MediaStream>): The live capture stream.
 *
 * Warning:
 *   The caller must stop every track when finished. This function does not
 *   own the stream's lifetime.
 */
export async function openMeasurementMicrophone() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    },
  });
}

/**
 * Build an analyser suitable for measurement capture.
 *
 * Brief:
 *   Bundles the analyser with its scratch buffer and a bin lookup, so every
 *   capture stage shares one consistent view of the spectrum instead of
 *   each deriving its own bin width.
 *
 * Arguments:
 *   audio_context_obj (BaseAudioContext): Context to build in.
 *   source_node (AudioNode): Node to analyse, normally the microphone.
 *
 * Returns:
 *   (Object): analyser_node, spectrum_float32array, bin_count_int and
 *   convertHertzToBin_fn.
 *
 * Warning:
 *   Smoothing is disabled. Any smoothing would blur the sweep across time
 *   and misattribute energy to the wrong frequency.
 */
export function buildCaptureAnalyser(audio_context_obj, source_node) {
  const analyser_node = audio_context_obj.createAnalyser();
  analyser_node.fftSize = CAPTURE_FFT_SIZE_INT;
  analyser_node.smoothingTimeConstant = 0;
  analyser_node.minDecibels = CAPTURE_MIN_DB_FLOAT;
  analyser_node.maxDecibels = CAPTURE_MAX_DB_FLOAT;
  source_node.connect(analyser_node);

  const bin_count_int = analyser_node.frequencyBinCount;
  const bin_width_hertz_float =
    audio_context_obj.sampleRate / analyser_node.fftSize;

  return {
    analyser_node,
    spectrum_float32array: new Float32Array(bin_count_int),
    bin_count_int,
    convertHertzToBin_fn: (frequency_hertz_float) =>
      clampToRange(
        Math.round(frequency_hertz_float / bin_width_hertz_float),
        0,
        bin_count_int - 1
      ),
  };
}

/**
 * Drive a callback once per animation frame for a fixed duration.
 *
 * Brief:
 *   Animation frames are used rather than an interval because they are
 *   synchronised to the compositor and never fire a catch-up burst after a
 *   stall - a burst would attribute several frames of audio to one instant.
 *
 * Arguments:
 *   duration_ms_float (number): How long to capture for.
 *   on_frame_fn (Function): Receives progress 0-1 and elapsed milliseconds.
 *   abort_signal (AbortSignal): Optional signal to cancel the capture.
 *
 * Returns:
 *   (Promise<number>): The number of frames captured.
 *
 * Warning:
 *   Rejects with an AbortError if the signal fires, and stops immediately.
 */
export function captureForDuration(duration_ms_float, on_frame_fn,
                                   abort_signal = null) {
  return new Promise((resolve_fn, reject_fn) => {
    const start_ms_float = performance.now();
    let frame_count_int = 0;

    const step_fn = () => {
      if (abort_signal?.aborted) {
        reject_fn(new DOMException('Calibration cancelled', 'AbortError'));
        return;
      }

      const elapsed_ms_float = performance.now() - start_ms_float;
      frame_count_int += 1;

      try {
        on_frame_fn(
          clampToRange(elapsed_ms_float / duration_ms_float, 0, 1),
          elapsed_ms_float
        );
      } catch (error_obj) {
        reject_fn(error_obj);
        return;
      }

      if (elapsed_ms_float >= duration_ms_float) {
        resolve_fn(frame_count_int);
        return;
      }
      requestAnimationFrame(step_fn);
    };

    requestAnimationFrame(step_fn);
  });
}

/**
 * Measure the output-to-input round-trip latency with a 1 kHz burst.
 *
 * Brief:
 *   This is the step naive implementations skip, and skipping it invalidates
 *   everything downstream. There is a 20-150 ms delay between scheduling a
 *   sample and hearing it back; during an exponential sweep that offset maps
 *   the measurement onto the wrong frequencies, and at the top of the sweep
 *   100 ms is more than an octave of error.
 *
 * Arguments:
 *   options_obj (Object): engine_obj, analyser_node, spectrum_float32array,
 *     convertHertzToBin_fn, level_db_float and abort_signal.
 *
 * Returns:
 *   (Promise<Object>): latency_ms_float and was_detected_bool.
 *
 * Warning:
 *   If nothing comes back - muted microphone, silent speakers, headphones
 *   in - the browser's own latency estimate is used instead and
 *   was_detected_bool is false. Treat such a measurement with suspicion.
 */
export async function probeRoundTripLatency(options_obj) {
  const {
    engine_obj,
    analyser_node,
    spectrum_float32array,
    convertHertzToBin_fn,
    level_db_float,
    abort_signal = null,
  } = options_obj;

  const context_obj = engine_obj.context_obj;
  const burst_bin_int = convertHertzToBin_fn(SYNC_BURST_HERTZ_FLOAT);
  const start_seconds_float = context_obj.currentTime + 0.1;

  const { oscillator_node, gain_node } = playSyncBurst(
    engine_obj,
    start_seconds_float,
    level_db_float
  );

  const baseline_db_float = readBandPeakDb(
    analyser_node,
    spectrum_float32array,
    burst_bin_int
  );
  const emitted_at_ms_float =
    performance.now() +
    (start_seconds_float - context_obj.currentTime) * 1000;

  const detected_at_ms_float = await listenForBurstArrival({
    analyser_node,
    spectrum_float32array,
    burst_bin_int,
    baseline_db_float,
    abort_signal,
  });

  try {
    oscillator_node.disconnect();
    gain_node.disconnect();
  } catch {
    // Already released.
  }

  return summariseLatency(
    engine_obj,
    detected_at_ms_float,
    emitted_at_ms_float
  );
}

/**
 * Turn a burst arrival time into a usable latency figure.
 *
 * Arguments:
 *   engine_obj (AudioEngine): Engine, for its own latency estimate.
 *   detected_at_ms_float (number): Arrival time, or NaN if never heard.
 *   emitted_at_ms_float (number): Time the burst was scheduled for.
 *
 * Returns:
 *   (Object): latency_ms_float and was_detected_bool.
 *
 * Warning:
 *   When the burst was never heard the browser's own estimate is used, and
 *   was_detected_bool is false. Such a measurement should be distrusted.
 */
function summariseLatency(engine_obj, detected_at_ms_float,
                          emitted_at_ms_float) {
  if (!Number.isFinite(detected_at_ms_float)) {
    return {
      latency_ms_float: clampToRange(
        engine_obj.latencyMs + FALLBACK_LATENCY_MARGIN_MS_FLOAT,
        10,
        MAX_LATENCY_MS_FLOAT
      ),
      was_detected_bool: false,
    };
  }

  return {
    latency_ms_float: clampToRange(
      detected_at_ms_float - emitted_at_ms_float,
      MIN_LATENCY_MS_FLOAT,
      MAX_LATENCY_MS_FLOAT
    ),
    was_detected_bool: true,
  };
}

/**
 * Watch the capture stream until the sync burst appears.
 *
 * Arguments:
 *   options_obj (Object): analyser_node, spectrum_float32array,
 *     burst_bin_int, baseline_db_float and abort_signal.
 *
 * Returns:
 *   (Promise<number>): Arrival time in performance-clock milliseconds, or
 *   NaN when the burst was never heard.
 */
async function listenForBurstArrival(options_obj) {
  const {
    analyser_node,
    spectrum_float32array,
    burst_bin_int,
    baseline_db_float,
    abort_signal,
  } = options_obj;

  let detected_at_ms_float = NaN;

  await captureForDuration(
    SYNC_LISTEN_MS_FLOAT,
    () => {
      if (Number.isFinite(detected_at_ms_float)) {
        return;
      }
      const level_db_now_float = readBandPeakDb(
        analyser_node,
        spectrum_float32array,
        burst_bin_int
      );
      if (
        level_db_now_float >
        baseline_db_float + SYNC_DETECT_THRESHOLD_DB_FLOAT
      ) {
        detected_at_ms_float = performance.now();
      }
    },
    abort_signal
  );

  return detected_at_ms_float;
}

/**
 * Read the peak level across a small band of bins.
 *
 * Arguments:
 *   analyser_node (AnalyserNode): Analyser to read.
 *   spectrum_float32array (Float32Array): Scratch buffer to fill.
 *   centre_bin_int (number): Bin at the centre of the band.
 *
 * Returns:
 *   (number): Peak level in decibels across the band.
 */
function readBandPeakDb(analyser_node, spectrum_float32array,
                        centre_bin_int) {
  analyser_node.getFloatFrequencyData(spectrum_float32array);

  let peak_db_float = CAPTURE_MIN_DB_FLOAT;
  for (
    let bin_index_int = centre_bin_int - 2;
    bin_index_int <= centre_bin_int + 2;
    bin_index_int += 1
  ) {
    const value_db_float =
      spectrum_float32array[bin_index_int] ?? CAPTURE_MIN_DB_FLOAT;
    if (value_db_float > peak_db_float) {
      peak_db_float = value_db_float;
    }
  }
  return peak_db_float;
}

/**
 * Schedule the 1 kHz synchronisation burst.
 *
 * Arguments:
 *   engine_obj (AudioEngine): Engine supplying the context and master gain.
 *   start_seconds_float (number): Context time to begin.
 *   level_db_float (number): Sweep level; the burst runs slightly hotter.
 *
 * Returns:
 *   (Object): oscillator_node and gain_node, for disconnection.
 */
function playSyncBurst(engine_obj, start_seconds_float, level_db_float) {
  const context_obj = engine_obj.context_obj;
  const oscillator_node = context_obj.createOscillator();
  const gain_node = context_obj.createGain();
  const amplitude_float = convertDbToLinear(level_db_float + 6);

  oscillator_node.type = 'sine';
  oscillator_node.frequency.value = SYNC_BURST_HERTZ_FLOAT;

  gain_node.gain.setValueAtTime(0, start_seconds_float);
  gain_node.gain.linearRampToValueAtTime(
    amplitude_float,
    start_seconds_float + SYNC_BURST_ATTACK_SECONDS_FLOAT
  );
  gain_node.gain.setValueAtTime(
    amplitude_float,
    start_seconds_float + SYNC_BURST_HOLD_SECONDS_FLOAT
  );
  gain_node.gain.linearRampToValueAtTime(
    0,
    start_seconds_float + SYNC_BURST_RELEASE_SECONDS_FLOAT
  );

  oscillator_node.connect(gain_node);
  gain_node.connect(engine_obj.master_gain_node);
  oscillator_node.start(start_seconds_float);
  oscillator_node.stop(start_seconds_float + SYNC_BURST_TOTAL_SECONDS_FLOAT);

  return { oscillator_node, gain_node };
}

/**
 * Schedule the measurement sweep.
 *
 * Brief:
 *   Routed into the master gain rather than the channel bus, which places
 *   it after the correction equaliser. The measurement must see the raw
 *   hardware, not the hardware plus a previous correction.
 *
 * Arguments:
 *   engine_obj (AudioEngine): Engine supplying the context and master gain.
 *   start_seconds_float (number): Context time to begin.
 *   duration_seconds_float (number): Sweep duration.
 *   level_db_float (number): Sweep level in dBFS.
 *
 * Returns:
 *   (Object): stop_fn, which halts and releases the sweep early.
 */
export function playMeasurementSweep(engine_obj, start_seconds_float,
                                     duration_seconds_float,
                                     level_db_float) {
  const context_obj = engine_obj.context_obj;
  const oscillator_node = context_obj.createOscillator();
  const gain_node = context_obj.createGain();
  const amplitude_float = convertDbToLinear(level_db_float);

  oscillator_node.type = 'sine';
  oscillator_node.frequency.setValueAtTime(
    SWEEP_START_HERTZ_FLOAT,
    start_seconds_float
  );
  oscillator_node.frequency.exponentialRampToValueAtTime(
    SWEEP_END_HERTZ_FLOAT,
    start_seconds_float + duration_seconds_float
  );

  gain_node.gain.setValueAtTime(0, start_seconds_float);
  gain_node.gain.linearRampToValueAtTime(
    amplitude_float,
    start_seconds_float + SWEEP_FADE_SECONDS_FLOAT
  );
  gain_node.gain.setValueAtTime(
    amplitude_float,
    start_seconds_float + duration_seconds_float - SWEEP_FADE_SECONDS_FLOAT
  );
  gain_node.gain.linearRampToValueAtTime(
    0,
    start_seconds_float + duration_seconds_float
  );

  oscillator_node.connect(gain_node);
  gain_node.connect(engine_obj.master_gain_node);
  oscillator_node.start(start_seconds_float);
  oscillator_node.stop(start_seconds_float + duration_seconds_float + 0.05);

  return {
    stop_fn: () => {
      try {
        oscillator_node.stop();
      } catch {
        // Already stopped.
      }
      try {
        oscillator_node.disconnect();
        gain_node.disconnect();
      } catch {
        // Already released.
      }
    },
  };
}
