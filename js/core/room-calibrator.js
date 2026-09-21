/**
 * Acoustic auto-calibration: orchestration, application and storage.
 *
 * Brief:
 *   Plays a logarithmic sweep through the speakers, captures it back through
 *   the microphone, and derives a compensation curve that flattens whatever
 *   the speaker and the room did to it. The capture hardware lives in
 *   calibration-capture.js and the curve mathematics in
 *   calibration-analysis.js; this module runs the stages in order and owns
 *   the result.
 *
 *   PRIVACY: the microphone is opened only for the duration of a run and is
 *   released in a finally block, so it is let go even when a measurement
 *   fails or is cancelled. No audio is recorded, stored, or transmitted -
 *   only a 96-point magnitude curve ever leaves the analyser.
 */

import { Emitter } from '../util/events.js';
import { clampToRange, computeMedian } from '../util/numeric.js';
import { buildLogFrequencyGrid } from '../util/frequency.js';
import { EQ_BAND_CENTRES_HERTZ_LIST } from '../dsp/weighting.js';
import {
  SWEEP_START_HERTZ_FLOAT,
  SWEEP_END_HERTZ_FLOAT,
  buildCaptureAnalyser,
  captureForDuration,
  computeSweepFrequencyAt,
  openMeasurementMicrophone,
  playMeasurementSweep,
  probeRoundTripLatency,
} from './calibration-capture.js';
import {
  ANALYSIS_GRID_POINTS_INT,
  analyseSweepResponse,
  convertHertzToGridIndex,
} from './calibration-analysis.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Default sweep duration, in milliseconds. */
const DEFAULT_SWEEP_MS_FLOAT = 3000;

/** Default sweep level, in dBFS. */
const DEFAULT_SWEEP_LEVEL_DB_FLOAT = -20;

/** Duration of the noise-floor measurement, in milliseconds. */
const NOISE_FLOOR_MS_FLOAT = 600;

/** Band used to summarise the noise floor, in hertz. */
const FLOOR_BAND_LOW_HERTZ_FLOAT = 100;
const FLOOR_BAND_HIGH_HERTZ_FLOAT = 8000;

/** Lead-in before the sweep begins, in seconds. */
const SWEEP_LEAD_IN_SECONDS_FLOAT = 0.12;

/** Extra capture time after the sweep ends, in milliseconds. */
const SWEEP_TAIL_MS_FLOAT = 160;

/** Level reported for a bin that has never seen signal. */
const SILENT_BIN_DB_FLOAT = -140;

/** Progress checkpoints, as fractions of the whole run. */
const PROGRESS_MIC_FLOAT = 0;
const PROGRESS_FLOOR_FLOAT = 0.05;
const PROGRESS_FLOOR_SPAN_FLOAT = 0.08;
const PROGRESS_SYNC_FLOAT = 0.14;
const PROGRESS_SWEEP_FLOAT = 0.22;
const PROGRESS_SWEEP_SPAN_FLOAT = 0.55;
const PROGRESS_ANALYSE_FLOAT = 0.82;

/* ------------------------------------------------------------------------ */

/**
 * Measure a room, derive a correction curve, and apply it.
 *
 * Brief:
 *   Emits progress throughout a run so the interface can show which stage
 *   is active, and emits the finished result for any view to render.
 *
 * Arguments:
 *   engine_obj (AudioEngine): Engine supplying the context and equaliser.
 *
 * Returns:
 *   (RoomCalibrator): A calibrator with no result yet.
 *
 * Warning:
 *   Only one run may be in flight at a time; a second call throws.
 */
export class RoomCalibrator extends Emitter {
  result_obj = null;
  is_applied_bool = false;
  is_running_bool = false;

  constructor(engine_obj) {
    super();
    this.engine_obj = engine_obj;
    this.analysis_grid_float64array = buildLogFrequencyGrid(
      SWEEP_START_HERTZ_FLOAT,
      SWEEP_END_HERTZ_FLOAT,
      ANALYSIS_GRID_POINTS_INT
    );
  }

  /** Whether this browser can capture a microphone at all. */
  static get isSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  /**
   * Run a complete measurement.
   *
   * Arguments:
   *   options_obj (Object): Optional sweep_ms_float, level_db_float and
   *     abort_signal.
   *
   * Returns:
   *   (Promise<Object>): The measurement result.
   *
   * Warning:
   *   Flattens the correction equaliser for the duration, because the
   *   measurement must see raw hardware. A previous correction is restored
   *   if the run fails.
   */
  async run(options_obj = {}) {
    const {
      sweep_ms_float = DEFAULT_SWEEP_MS_FLOAT,
      level_db_float = DEFAULT_SWEEP_LEVEL_DB_FLOAT,
      abort_signal = null,
    } = options_obj;

    this.#assertCanRun();
    this.is_running_bool = true;

    const restore_obj = this.#suspendCorrection();
    let stream_obj = null;
    let microphone_source_node = null;

    try {
      this.#emitProgress('mic', PROGRESS_MIC_FLOAT, 'Requesting microphone');
      stream_obj = await openMeasurementMicrophone();
      this.#assertNotAborted(abort_signal);

      microphone_source_node =
        this.engine_obj.context_obj.createMediaStreamSource(stream_obj);
      const capture_obj = buildCaptureAnalyser(
        this.engine_obj.context_obj,
        microphone_source_node
      );

      const floor_obj = await this.#measureNoiseFloor(
        capture_obj,
        abort_signal
      );
      const latency_obj = await this.#measureLatency(
        capture_obj,
        level_db_float,
        abort_signal
      );
      const sweep_obj = await this.#runSweep(
        capture_obj,
        floor_obj,
        latency_obj.latency_ms_float,
        sweep_ms_float,
        level_db_float,
        abort_signal
      );

      return this.#buildResult(floor_obj, latency_obj, sweep_obj);
    } catch (error_obj) {
      restore_obj.restore_fn();
      this.emit('error', error_obj);
      throw error_obj;
    } finally {
      this.is_running_bool = false;
      this.#releaseMicrophone(microphone_source_node, stream_obj);
    }
  }

  /**
   * Flatten any engaged correction and return a way to put it back.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): restore_fn, which reinstates the previous correction.
   */
  #suspendCorrection() {
    const prior_gains_db_list = this.engine_obj.equaliser
      .readCurve()
      .map((band_obj) => band_obj.gain_db_float);
    const was_applied_bool = this.is_applied_bool;

    this.engine_obj.equaliser.resetCurve();

    return {
      restore_fn: () => {
        if (was_applied_bool) {
          this.engine_obj.equaliser.applyCurve(prior_gains_db_list);
        }
      },
    };
  }

  /** Reject a run that cannot possibly succeed, with a specific reason. */
  #assertCanRun() {
    if (this.is_running_bool) {
      throw new Error('A calibration run is already in progress.');
    }
    if (!RoomCalibrator.isSupported) {
      throw new Error('Microphone capture is not available here.');
    }
    if (!this.engine_obj.is_ready_bool) {
      throw new Error('Audio engine is not initialised.');
    }
  }

  /** Throw if the caller has cancelled the run. */
  #assertNotAborted(abort_signal) {
    if (abort_signal?.aborted) {
      throw new DOMException('Calibration cancelled', 'AbortError');
    }
  }

  /** Release the capture device the moment a run finishes. */
  #releaseMicrophone(microphone_source_node, stream_obj) {
    try {
      microphone_source_node?.disconnect();
    } catch {
      // Context already torn down.
    }
    if (stream_obj) {
      for (const track_obj of stream_obj.getTracks()) {
        track_obj.stop();
      }
    }
    this.emit('micreleased');
  }

  /**
   * Measure the per-bin noise floor before any stimulus is played.
   *
   * Arguments:
   *   capture_obj (Object): Analyser bundle from buildCaptureAnalyser.
   *   abort_signal (AbortSignal): Optional cancellation signal.
   *
   * Returns:
   *   (Promise<Object>): floor_db_float64array and median_db_float.
   */
  async #measureNoiseFloor(capture_obj, abort_signal) {
    this.#emitProgress(
      'floor',
      PROGRESS_FLOOR_FLOAT,
      'Measuring noise floor'
    );

    const floor_db_float64array = new Float64Array(
      capture_obj.bin_count_int
    ).fill(SILENT_BIN_DB_FLOAT);

    await captureForDuration(
      NOISE_FLOOR_MS_FLOAT,
      (progress_float) => {
        capture_obj.analyser_node.getFloatFrequencyData(
          capture_obj.spectrum_float32array
        );
        for (
          let bin_index_int = 0;
          bin_index_int < capture_obj.bin_count_int;
          bin_index_int += 1
        ) {
          const level_db_float =
            capture_obj.spectrum_float32array[bin_index_int];
          if (level_db_float > floor_db_float64array[bin_index_int]) {
            floor_db_float64array[bin_index_int] = level_db_float;
          }
        }
        this.#emitProgress(
          'floor',
          PROGRESS_FLOOR_FLOAT + PROGRESS_FLOOR_SPAN_FLOAT * progress_float,
          null
        );
      },
      abort_signal
    );

    const median_db_float = computeMedian(
      Array.from(
        floor_db_float64array.subarray(
          capture_obj.convertHertzToBin_fn(FLOOR_BAND_LOW_HERTZ_FLOAT),
          capture_obj.convertHertzToBin_fn(FLOOR_BAND_HIGH_HERTZ_FLOAT)
        )
      )
    );

    return { floor_db_float64array, median_db_float };
  }

  /** Probe the round trip and report it to the interface. */
  async #measureLatency(capture_obj, level_db_float, abort_signal) {
    this.#emitProgress(
      'sync',
      PROGRESS_SYNC_FLOAT,
      'Probing round-trip latency'
    );

    const latency_obj = await probeRoundTripLatency({
      engine_obj: this.engine_obj,
      analyser_node: capture_obj.analyser_node,
      spectrum_float32array: capture_obj.spectrum_float32array,
      convertHertzToBin_fn: capture_obj.convertHertzToBin_fn,
      level_db_float,
      abort_signal,
    });

    if (!latency_obj.was_detected_bool) {
      this.emit(
        'warn',
        'Sync burst was not detected; using the estimated latency instead.'
      );
    }
    this.#emitProgress(
      'sync',
      PROGRESS_SWEEP_FLOAT,
      `Round trip is about ${latency_obj.latency_ms_float.toFixed(0)} ms`
    );
    return latency_obj;
  }

  /**
   * Play the sweep and accumulate its response onto the analysis grid.
   *
   * Arguments:
   *   capture_obj (Object): Analyser bundle from buildCaptureAnalyser.
   *   floor_obj (Object): Noise floor measurement.
   *   latency_ms_float (number): Measured round-trip latency.
   *   sweep_ms_float (number): Sweep duration.
   *   level_db_float (number): Sweep level.
   *   abort_signal (AbortSignal): Optional cancellation signal.
   *
   * Returns:
   *   (Promise<Object>): power_float64array and hit_counts_uint32array.
   */
  async #runSweep(capture_obj, floor_obj, latency_ms_float, sweep_ms_float,
                  level_db_float, abort_signal) {
    this.#emitProgress(
      'sweep',
      PROGRESS_SWEEP_FLOAT,
      'Sweeping 20 Hz to 20 kHz'
    );

    const power_float64array = new Float64Array(ANALYSIS_GRID_POINTS_INT);
    const hit_counts_uint32array = new Uint32Array(
      ANALYSIS_GRID_POINTS_INT
    );

    const start_seconds_float =
      this.engine_obj.context_obj.currentTime + SWEEP_LEAD_IN_SECONDS_FLOAT;
    const { stop_fn } = playMeasurementSweep(
      this.engine_obj,
      start_seconds_float,
      sweep_ms_float / 1000,
      level_db_float
    );

    const tracker_obj = {
      previous_hertz_float: SWEEP_START_HERTZ_FLOAT,
      latency_seconds_float: latency_ms_float / 1000,
      sweep_seconds_float: sweep_ms_float / 1000,
    };

    await captureForDuration(
      sweep_ms_float + SWEEP_TAIL_MS_FLOAT,
      (progress_float, elapsed_ms_float) => {
        this.#accumulateSweepFrame({
          capture_obj,
          floor_obj,
          tracker_obj,
          power_float64array,
          hit_counts_uint32array,
          elapsed_ms_float,
        });
        this.#emitProgress(
          'sweep',
          PROGRESS_SWEEP_FLOAT + PROGRESS_SWEEP_SPAN_FLOAT * progress_float,
          null
        );
      },
      abort_signal
    );

    stop_fn();
    this.#assertNotAborted(abort_signal);
    return { power_float64array, hit_counts_uint32array };
  }

  /**
   * Attribute one captured frame to its grid point.
   *
   * Brief:
   *   Capture time is mapped back through the measured latency to emission
   *   time, and then to the sweep's instantaneous frequency. The peak is
   *   taken across every bin the sweep crossed since the previous frame,
   *   because fast high-frequency traversal otherwise falls between bins.
   *
   * Arguments:
   *   frame_obj (Object): capture_obj, floor_obj, tracker_obj,
   *     power_float64array, hit_counts_uint32array and elapsed_ms_float.
   *
   * Returns:
   *   (none)
   */
  #accumulateSweepFrame(frame_obj) {
    const {
      capture_obj,
      floor_obj,
      tracker_obj,
      power_float64array,
      hit_counts_uint32array,
      elapsed_ms_float,
    } = frame_obj;

    capture_obj.analyser_node.getFloatFrequencyData(
      capture_obj.spectrum_float32array
    );

    const emitted_seconds_float =
      elapsed_ms_float / 1000 -
      tracker_obj.latency_seconds_float -
      SWEEP_LEAD_IN_SECONDS_FLOAT;
    const progress_float =
      emitted_seconds_float / tracker_obj.sweep_seconds_float;

    if (progress_float < 0 || progress_float > 1) {
      return;
    }

    const frequency_hertz_float = computeSweepFrequencyAt(progress_float);
    const low_bin_int = capture_obj.convertHertzToBin_fn(
      Math.min(tracker_obj.previous_hertz_float, frequency_hertz_float) * 0.97
    );
    const high_bin_int = capture_obj.convertHertzToBin_fn(
      Math.max(tracker_obj.previous_hertz_float, frequency_hertz_float) * 1.03
    );
    tracker_obj.previous_hertz_float = frequency_hertz_float;

    const net_power_float = this.#measureNetPower(
      capture_obj,
      floor_obj,
      low_bin_int,
      high_bin_int
    );
    if (net_power_float <= 0) {
      return;
    }

    const grid_index_int = convertHertzToGridIndex(frequency_hertz_float);
    power_float64array[grid_index_int] += net_power_float;
    hit_counts_uint32array[grid_index_int] += 1;
  }

  /**
   * Measure band power above the noise floor, in the power domain.
   *
   * Arguments:
   *   capture_obj (Object): Analyser bundle.
   *   floor_obj (Object): Noise floor measurement.
   *   low_bin_int (number): First bin of the band.
   *   high_bin_int (number): Last bin of the band.
   *
   * Returns:
   *   (number): Net linear power, or zero when below the floor.
   */
  #measureNetPower(capture_obj, floor_obj, low_bin_int, high_bin_int) {
    let peak_db_float = -Infinity;
    let peak_floor_db_float = SILENT_BIN_DB_FLOAT;

    for (
      let bin_index_int = low_bin_int;
      bin_index_int <= high_bin_int;
      bin_index_int += 1
    ) {
      const level_db_float =
        capture_obj.spectrum_float32array[bin_index_int];
      if (level_db_float > peak_db_float) {
        peak_db_float = level_db_float;
        peak_floor_db_float = floor_obj.floor_db_float64array[bin_index_int];
      }
    }

    if (!Number.isFinite(peak_db_float)) {
      return 0;
    }
    return 10 ** (peak_db_float / 10) - 10 ** (peak_floor_db_float / 10);
  }

  /** Analyse the accumulated sweep and store the finished result. */
  #buildResult(floor_obj, latency_obj, sweep_obj) {
    this.#emitProgress(
      'analyze',
      PROGRESS_ANALYSE_FLOAT,
      'Computing compensation curve'
    );

    const analysis_obj = analyseSweepResponse({
      analysis_grid_float64array: this.analysis_grid_float64array,
      power_float64array: sweep_obj.power_float64array,
      hit_counts_uint32array: sweep_obj.hit_counts_uint32array,
      noise_floor_db_float: floor_obj.median_db_float,
    });

    this.result_obj = {
      grid_float64array: this.analysis_grid_float64array,
      ...analysis_obj,
      latency_ms_float: latency_obj.latency_ms_float,
      noise_floor_db_float: floor_obj.median_db_float,
      taken_at_ms_int: Date.now(),
      sample_rate_hertz_float: this.engine_obj.sampleRateHertz,
    };

    this.#emitProgress('done', 1, 'Calibration complete.');
    this.emit('result', this.result_obj);
    return this.result_obj;
  }

  /** Emit a progress update for the interface. */
  #emitProgress(phase_str, progress_float, message_str) {
    this.emit('progress', {
      phase_str,
      progress_float: clampToRange(progress_float, 0, 1),
      message_str,
    });
  }

  /* ===================================================================
     Applying and storing a correction
     =================================================================== */

  /**
   * Engage the measured correction.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (boolean): True when a correction was available to apply.
   */
  applyCorrection() {
    if (!this.result_obj) {
      return false;
    }
    this.engine_obj.equaliser.applyCurve(this.result_obj.correction_db_list);
    this.is_applied_bool = true;
    this.emit('applied', this.result_obj.correction_db_list);
    return true;
  }

  /**
   * Bypass the correction, returning the equaliser to flat.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (boolean): Always true.
   */
  bypassCorrection() {
    this.engine_obj.equaliser.resetCurve();
    this.is_applied_bool = false;
    this.emit('applied', null);
    return true;
  }

  /**
   * Toggle the correction between engaged and bypassed.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (boolean): True when a correction is now engaged.
   */
  toggleCorrection() {
    if (this.is_applied_bool) {
      this.bypassCorrection();
      return false;
    }
    return this.applyCorrection();
  }

  /**
   * Discard the stored measurement entirely.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  clearMeasurement() {
    this.bypassCorrection();
    this.result_obj = null;
    this.emit('cleared');
  }

  /**
   * Serialise the measurement for export or storage.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): A portable record, or null when nothing is measured.
   */
  exportMeasurement() {
    if (!this.result_obj) {
      return null;
    }
    const result_obj = this.result_obj;

    return {
      app_str: 'SonicForge',
      kind_str: 'calibration',
      version_int: 1,
      taken_at_str: new Date(result_obj.taken_at_ms_int).toISOString(),
      sample_rate_hertz_float: result_obj.sample_rate_hertz_float,
      latency_ms_float: Math.round(result_obj.latency_ms_float * 10) / 10,
      confidence_float: Math.round(result_obj.confidence_float * 1000) / 1000,
      noise_floor_db_float:
        Math.round(result_obj.noise_floor_db_float * 10) / 10,
      bands_list: EQ_BAND_CENTRES_HERTZ_LIST.map(
        (centre_hertz_float, band_index_int) => ({
          centre_hertz_float,
          gain_db_float:
            Math.round(result_obj.correction_db_list[band_index_int] * 100) /
            100,
        })
      ),
      curve_list: Array.from(
        result_obj.grid_float64array,
        (frequency_hertz_float, index_int) => [
          Math.round(frequency_hertz_float * 10) / 10,
          Math.round(result_obj.response_db_float64array[index_int] * 10) / 10,
        ]
      ),
    };
  }

  /**
   * Restore a measurement previously produced by exportMeasurement.
   *
   * Arguments:
   *   record_obj (Object): The exported record.
   *
   * Returns:
   *   (Object): The restored result.
   *
   * Warning:
   *   Throws when the record is not a SonicForge calibration or its band
   *   count does not match this build's equaliser.
   */
  importMeasurement(record_obj) {
    const bands_list = record_obj?.bands_list;
    const is_valid_bool =
      Array.isArray(bands_list) &&
      bands_list.length === EQ_BAND_CENTRES_HERTZ_LIST.length;

    if (!is_valid_bool) {
      throw new Error('Not a SonicForge calibration file.');
    }

    const grid_float64array = record_obj.curve_list
      ? Float64Array.from(record_obj.curve_list, (point_list) => point_list[0])
      : this.analysis_grid_float64array;
    const response_db_float64array = record_obj.curve_list
      ? Float64Array.from(record_obj.curve_list, (point_list) => point_list[1])
      : new Float64Array(grid_float64array.length);

    this.result_obj = {
      grid_float64array,
      response_db_float64array,
      raw_response_db_float64array: response_db_float64array,
      deviation_db_float64array: response_db_float64array,
      correction_db_list: bands_list.map((band_obj) =>
        clampToRange(Number(band_obj.gain_db_float) || 0, -12, 12)
      ),
      confidence_float: Number(record_obj.confidence_float) || 0,
      coverage_ratio_float: 1,
      latency_ms_float: Number(record_obj.latency_ms_float) || 0,
      noise_floor_db_float: Number(record_obj.noise_floor_db_float) || -90,
      taken_at_ms_int: Date.parse(record_obj.taken_at_str) || Date.now(),
      sample_rate_hertz_float:
        Number(record_obj.sample_rate_hertz_float) ||
        this.engine_obj.sampleRateHertz,
    };

    this.emit('result', this.result_obj);
    return this.result_obj;
  }
}
