/**
 * The room-calibration panel.
 *
 * Brief:
 *   A stateful view over one RoomCalibrator: runs the measurement, draws
 *   the measured deviation against the correction curve, and persists the
 *   result so a saved curve survives a reload.
 */

import { showToast, requestConfirmation } from './feedback.js';
import { EQ_BAND_CENTRES_HERTZ_LIST } from '../dsp/weighting.js';
import { mapFrequencyToPosition } from '../util/frequency.js';
import { clampToRange } from '../util/numeric.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** localStorage key holding the last measurement. */
const CALIBRATION_STORAGE_KEY_STR = 'sonicforge.calibration';

/** Upper bound on the device pixel ratio honoured when resizing. */
const MAX_PIXEL_RATIO_FLOAT = 2;

/** Padding inside the chart, in CSS pixels before scaling. */
const CHART_PAD_PX_FLOAT = 6;

/** Half-height of the chart's decibel scale. */
const CHART_RANGE_DB_FLOAT = 24;

/** Frequency limits of the chart's horizontal axis, in hertz. */
const CHART_LOW_HERTZ_FLOAT = 20;
const CHART_HIGH_HERTZ_FLOAT = 20000;

/** Vertical gridlines, in hertz, at the standard octave centres. */
const GRID_HERTZ_TUPLE = Object.freeze([31.5, 100, 315, 1000, 3150, 10000]);

/** Horizontal gridlines, in decibels. */
const GRID_DB_TUPLE = Object.freeze([-12, 0, 12]);

/** Confidence below which the result is reported as unreliable. */
const LOW_CONFIDENCE_FLOAT = 0.35;

/** Confidence above which the badge turns from amber to lime. */
const GOOD_CONFIDENCE_FLOAT = 0.6;

/** Toast dwell times, in milliseconds. */
const LOW_CONFIDENCE_TOAST_MS_INT = 7000;
const MIC_ERROR_TOAST_MS_INT = 8000;
const BRIEF_TOAST_MS_INT = 2200;

/** Delay before an exported object URL is revoked, in milliseconds. */
const OBJECT_URL_LIFETIME_MS_INT = 1000;

/** Monospace stack used for the chart's axis labels. */
const MONO_FONT_STACK_STR = '"JetBrains Mono", ui-monospace, monospace';

/** Copy shown before the viewer agrees to a measurement. */
const MEASUREMENT_CONSENT_HTML_STR =
  'SonicForge will play a 3-second sweep through your <b>speakers</b> and ' +
  'listen back with the <b>microphone</b>, then build a correction curve.' +
  '<br><br><b>Take your headphones off</b> — measuring headphones through ' +
  'a laptop mic tells you nothing. Keep the room quiet and stay still.' +
  '<br><br><span class="text-cyan">The recording never leaves this ' +
  'device.</span> Nothing is stored, nothing is uploaded, and the ' +
  'microphone is released the instant the sweep ends.';

/* ------------------------------------------------------------------------ */

/**
 * Turn a getUserMedia failure into something a person can act on.
 *
 * Brief:
 *   The native messages name the constraint that failed, not the thing the
 *   viewer has to do about it. This names the action instead.
 *
 * Arguments:
 *   err (Error): The rejection from the microphone request.
 *
 * Returns:
 *   (string): A message describing what to do next.
 */
function describeMicrophoneError(err) {
  const error_name_str = err?.name ?? '';

  if (error_name_str === 'NotAllowedError') {
    return 'Microphone permission was denied. Allow it in the address bar ' +
      'and try again.';
  }
  if (error_name_str === 'NotFoundError') {
    return 'No microphone was found on this device.';
  }
  if (error_name_str === 'NotReadableError') {
    return 'The microphone is in use by another application.';
  }
  if (location.protocol === 'http:' && location.hostname !== 'localhost') {
    return 'Microphone access requires HTTPS (or localhost).';
  }
  return err?.message ?? 'Calibration failed.';
}

/**
 * Format a gridline frequency for the chart's axis.
 *
 * Arguments:
 *   frequency_hertz_float (number): Gridline frequency.
 *
 * Returns:
 *   (string): '315' below a kilohertz, '3.15k' above it.
 */
function formatGridLabel(frequency_hertz_float) {
  return frequency_hertz_float >= 1000
    ? `${frequency_hertz_float / 1000}k`
    : String(frequency_hertz_float);
}

/* ------------------------------------------------------------------------ */

/**
 * Panel driving a microphone room measurement and its correction curve.
 *
 * Brief:
 *   Owns the chart canvas and the run, apply and export controls. The
 *   measurement itself belongs to the calibrator; this decides what to show
 *   and when to ask permission.
 *
 * Arguments:
 *   calibrator_obj (RoomCalibrator): The measurement engine.
 *   app_obj (Object): The application shell, for engine state and logging.
 *
 * Returns:
 *   (CalibrationPanel): The constructed panel.
 */
export class CalibrationPanel {
  #abort_controller_obj = null;

  constructor(calibrator_obj, app_obj) {
    this.calibrator_obj = calibrator_obj;
    this.app_obj = app_obj;

    this.canvas = document.getElementById('cal-curve');
    this.canvas_ctx = this.canvas.getContext('2d');
    this.state_el = document.getElementById('cal-state');
    this.run_button_el = document.getElementById('cal-run');
    this.apply_button_el = document.getElementById('cal-apply');
    this.export_button_el = document.getElementById('cal-export');
    this.stats_el = document.getElementById('cal-stats');
    this.note_el = document.getElementById('cal-note');

    this.#bind();
    this.#drawChart();
    this.#restore();
  }

  /**
   * Wire the controls, the calibrator's events and the drop target.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bind() {
    this.run_button_el.addEventListener('click', () => {
      if (this.calibrator_obj.is_running_bool) {
        this.cancel();
      } else {
        this.run();
      }
    });
    this.apply_button_el.addEventListener('click', () => this.toggleApply());
    this.export_button_el.addEventListener('click', () => this.download());

    this.calibrator_obj.on(
      'progress', (progress_obj) => this.#showProgress(progress_obj)
    );
    this.calibrator_obj.on(
      'warn', (message_str) => showToast(message_str, 'warn')
    );
    this.calibrator_obj.on('result', () => {
      this.#drawChart();
      this.#showStats();
    });

    this.#bindDropTarget();
    window.addEventListener('resize', () => this.#drawChart());
  }

  /**
   * Allow a previously exported curve to be dropped onto the chart.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   The dropped file is untrusted. importMeasurement validates it, and a
   *   parse failure is reported rather than thrown.
   */
  #bindDropTarget() {
    this.canvas.addEventListener('dragover', (drag_event) => {
      drag_event.preventDefault();
      this.canvas.style.borderColor = 'var(--cyan)';
    });
    this.canvas.addEventListener('dragleave', () => {
      this.canvas.style.borderColor = '';
    });

    this.canvas.addEventListener('drop', async (drop_event) => {
      drop_event.preventDefault();
      this.canvas.style.borderColor = '';

      const dropped_file_obj = drop_event.dataTransfer?.files?.[0];
      if (!dropped_file_obj) {
        return;
      }
      try {
        this.calibrator_obj.importMeasurement(
          JSON.parse(await dropped_file_obj.text())
        );
        this.#drawChart();
        this.#showStats();
        this.apply_button_el.disabled = false;
        this.export_button_el.disabled = false;
        showToast(`Loaded calibration from ${dropped_file_obj.name}`, 'ok');
      } catch (err) {
        showToast(`Could not read that file: ${err.message}`, 'err');
      }
    });
  }

  /* =================================================================== */

  /**
   * Put the panel into its measuring state.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #enterMeasuringState() {
    this.run_button_el.textContent = 'Cancel';
    this.run_button_el.classList.remove('btn--primary');
    this.state_el.textContent = 'measuring';
    this.state_el.className = 'badge badge--amber';
  }

  /**
   * Report a finished measurement in the badge and a toast.
   *
   * Arguments:
   *   result_obj (Object): The calibrator's result.
   *
   * Returns:
   *   (none)
   */
  #reportResult(result_obj) {
    const confidence_percent_int =
      Math.round(result_obj.confidence_float * 100);

    this.apply_button_el.disabled = false;
    this.export_button_el.disabled = false;
    this.state_el.textContent = `${confidence_percent_int}% confidence`;
    this.state_el.className =
      result_obj.confidence_float > GOOD_CONFIDENCE_FLOAT
        ? 'badge badge--lime'
        : 'badge badge--amber';

    if (result_obj.confidence_float < LOW_CONFIDENCE_FLOAT) {
      showToast(
        'Low confidence — check that the speakers are audible and the ' +
        'room is quiet.',
        'warn',
        LOW_CONFIDENCE_TOAST_MS_INT
      );
    } else {
      showToast(
        'Measurement complete. Press Apply to engage the correction.', 'ok'
      );
    }
  }

  /**
   * Ask permission, then run one measurement.
   *
   * Brief:
   *   Consent is asked every time rather than remembered, because the copy
   *   also carries the instruction to take headphones off.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<void>)
   *
   * Warning:
   *   Cancellation arrives as an AbortError and is reported as cancelled,
   *   not as a failure.
   */
  async run() {
    if (!this.app_obj.engine.is_ready_bool) {
      showToast('Start the audio engine first.', 'warn');
      return;
    }

    const is_confirmed_bool = await requestConfirmation({
      title_str: 'Measure your speakers and room',
      body_html_str: MEASUREMENT_CONSENT_HTML_STR,
      confirm_label_str: 'Start measurement',
    });
    if (!is_confirmed_bool) {
      return;
    }

    this.#abort_controller_obj = new AbortController();
    this.#enterMeasuringState();

    try {
      const result_obj = await this.calibrator_obj.run({
        signal: this.#abort_controller_obj.signal,
      });
      this.#reportResult(result_obj);
      this.#persist();
    } catch (err) {
      if (err.name === 'AbortError') {
        this.state_el.textContent = 'cancelled';
        this.state_el.className = 'badge';
      } else {
        this.state_el.textContent = 'failed';
        this.state_el.className = 'badge badge--rose';
        showToast(
          describeMicrophoneError(err), 'err', MIC_ERROR_TOAST_MS_INT
        );
      }
    } finally {
      this.#abort_controller_obj = null;
      this.run_button_el.textContent = 'Measure room';
      this.run_button_el.classList.add('btn--primary');
      this.#drawChart();
    }
  }

  /**
   * Abort a measurement in progress.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  cancel() {
    this.#abort_controller_obj?.abort();
  }

  /**
   * Engage or bypass the correction filters.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (boolean): True when the correction is now engaged.
   */
  toggleApply() {
    const is_applied_bool = this.calibrator_obj.toggleCorrection();

    this.apply_button_el.textContent =
      this.calibrator_obj.is_applied_bool ? 'Bypass' : 'Apply';
    this.apply_button_el.classList.toggle(
      'is-active', this.calibrator_obj.is_applied_bool
    );
    showToast(
      this.calibrator_obj.is_applied_bool
        ? 'Correction engaged.'
        : 'Correction bypassed.',
      'ok',
      BRIEF_TOAST_MS_INT
    );
    this.#drawChart();
    return is_applied_bool;
  }

  /**
   * Save the measurement to a JSON file.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   The object URL is revoked on a timer rather than immediately, because
   *   revoking it in the same task cancels the download in some browsers.
   */
  download() {
    const measurement_obj = this.calibrator_obj.exportMeasurement();
    if (!measurement_obj) {
      return;
    }

    const file_blob = new Blob(
      [JSON.stringify(measurement_obj, null, 2)],
      { type: 'application/json' }
    );
    const date_str = new Date().toISOString().slice(0, 10);
    const link_el = document.createElement('a');
    link_el.href = URL.createObjectURL(file_blob);
    link_el.download = `sonicforge-calibration-${date_str}.json`;
    link_el.click();

    setTimeout(
      () => URL.revokeObjectURL(link_el.href), OBJECT_URL_LIFETIME_MS_INT
    );
    showToast('Calibration curve exported.', 'ok');
  }

  /**
   * Mirror a progress event into the log and the state badge.
   *
   * Arguments:
   *   progress_obj (Object): { phase_str, progress_float, message_str }.
   *
   * Returns:
   *   (none)
   */
  #showProgress(progress_obj) {
    const { phase_str, progress_float, message_str } = progress_obj;

    if (message_str) {
      this.app_obj.log(
        `[calibrate] ${message_str}`, phase_str === 'done' ? 'ok' : 'dim'
      );
    }
    this.state_el.textContent =
      `${phase_str} ${Math.round(progress_float * 100)}%`;
  }

  /**
   * Fill the latency, noise floor and confidence readouts.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #showStats() {
    const result_obj = this.calibrator_obj.result_obj;
    if (!result_obj) {
      return;
    }

    this.stats_el.hidden = false;
    document.getElementById('cal-latency').textContent =
      `${result_obj.latency_ms_float.toFixed(0)} ms`;
    document.getElementById('cal-floor').textContent =
      `${result_obj.noise_floor_db_float.toFixed(1)} dB`;
    document.getElementById('cal-confidence').textContent =
      `${Math.round(result_obj.confidence_float * 100)} %`;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Build the chart's coordinate mapping for this frame.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): Size, padding and the two axis mapping functions.
   */
  #measureChart() {
    const pixel_ratio_float = Math.min(
      window.devicePixelRatio || 1, MAX_PIXEL_RATIO_FLOAT
    );
    const bounds_obj = this.canvas.getBoundingClientRect();
    if (bounds_obj.width) {
      this.canvas.width = Math.round(bounds_obj.width * pixel_ratio_float);
      this.canvas.height = Math.round(bounds_obj.height * pixel_ratio_float);
    }

    const width_px_int = this.canvas.width;
    const height_px_int = this.canvas.height;
    const pad_px_float = CHART_PAD_PX_FLOAT * pixel_ratio_float;

    return {
      pixel_ratio_float,
      width_px_int,
      height_px_int,
      pad_px_float,
      yOfDb: (decibels_float) => height_px_int / 2 -
        (clampToRange(
          decibels_float, -CHART_RANGE_DB_FLOAT, CHART_RANGE_DB_FLOAT
        ) / CHART_RANGE_DB_FLOAT) * (height_px_int / 2 - pad_px_float),
      xOfHertz: (frequency_hertz_float) => pad_px_float +
        mapFrequencyToPosition(
          frequency_hertz_float, CHART_LOW_HERTZ_FLOAT, CHART_HIGH_HERTZ_FLOAT
        ) * (width_px_int - pad_px_float * 2),
    };
  }

  /**
   * Draw the chart's frequency and decibel gridlines.
   *
   * Arguments:
   *   chart_obj (Object): The chart mapping for this frame.
   *
   * Returns:
   *   (none)
   */
  #drawChartGrid(chart_obj) {
    const canvas_ctx = this.canvas_ctx;
    const { pad_px_float, width_px_int, height_px_int } = chart_obj;

    canvas_ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    canvas_ctx.lineWidth = 1;
    canvas_ctx.font =
      `${8 * chart_obj.pixel_ratio_float}px ${MONO_FONT_STACK_STR}`;
    canvas_ctx.fillStyle = 'rgba(125,137,166,0.55)';
    canvas_ctx.textBaseline = 'top';

    for (const frequency_hertz_float of GRID_HERTZ_TUPLE) {
      const x_px_float = chart_obj.xOfHertz(frequency_hertz_float);
      canvas_ctx.beginPath();
      canvas_ctx.moveTo(x_px_float, pad_px_float);
      canvas_ctx.lineTo(x_px_float, height_px_int - pad_px_float);
      canvas_ctx.stroke();
      canvas_ctx.fillText(
        formatGridLabel(frequency_hertz_float),
        x_px_float + 2 * chart_obj.pixel_ratio_float,
        height_px_int - 11 * chart_obj.pixel_ratio_float
      );
    }

    for (const decibels_float of GRID_DB_TUPLE) {
      const y_px_float = chart_obj.yOfDb(decibels_float);
      canvas_ctx.beginPath();
      canvas_ctx.moveTo(pad_px_float, y_px_float);
      canvas_ctx.lineTo(width_px_int - pad_px_float, y_px_float);
      canvas_ctx.strokeStyle = decibels_float === 0
        ? 'rgba(255,255,255,0.14)'
        : 'rgba(255,255,255,0.055)';
      canvas_ctx.stroke();
      if (decibels_float !== 0) {
        const sign_str = decibels_float > 0 ? '+' : '';
        canvas_ctx.fillText(
          `${sign_str}${decibels_float}`,
          pad_px_float + 2 * chart_obj.pixel_ratio_float,
          y_px_float + 2 * chart_obj.pixel_ratio_float
        );
      }
    }
  }

  /**
   * Draw the measured deviation trace.
   *
   * Arguments:
   *   chart_obj (Object): The chart mapping for this frame.
   *   result_obj (Object): The calibrator's result.
   *
   * Returns:
   *   (none)
   */
  #drawDeviation(chart_obj, result_obj) {
    const canvas_ctx = this.canvas_ctx;
    canvas_ctx.beginPath();

    for (let point_int = 0;
      point_int < result_obj.grid_float64array.length; point_int++) {
      const x_px_float =
        chart_obj.xOfHertz(result_obj.grid_float64array[point_int]);
      const y_px_float =
        chart_obj.yOfDb(result_obj.deviation_db_float64array[point_int]);
      if (point_int === 0) {
        canvas_ctx.moveTo(x_px_float, y_px_float);
      } else {
        canvas_ctx.lineTo(x_px_float, y_px_float);
      }
    }

    canvas_ctx.strokeStyle = 'rgba(125,137,166,0.75)';
    canvas_ctx.lineWidth = 1.4 * chart_obj.pixel_ratio_float;
    canvas_ctx.stroke();
  }

  /**
   * Draw the ten correction bands and their handles.
   *
   * Arguments:
   *   chart_obj (Object): The chart mapping for this frame.
   *   result_obj (Object): The calibrator's result.
   *
   * Returns:
   *   (none)
   */
  #drawCorrection(chart_obj, result_obj) {
    const canvas_ctx = this.canvas_ctx;
    const pixel_ratio_float = chart_obj.pixel_ratio_float;
    const is_applied_bool = this.calibrator_obj.is_applied_bool;

    canvas_ctx.beginPath();
    EQ_BAND_CENTRES_HERTZ_LIST.forEach((band_hertz_float, band_int) => {
      const x_px_float = chart_obj.xOfHertz(band_hertz_float);
      const y_px_float =
        chart_obj.yOfDb(result_obj.correction_db_list[band_int]);
      if (band_int === 0) {
        canvas_ctx.moveTo(x_px_float, y_px_float);
      } else {
        canvas_ctx.lineTo(x_px_float, y_px_float);
      }
    });
    canvas_ctx.strokeStyle = is_applied_bool
      ? 'rgba(0,242,254,0.95)'
      : 'rgba(0,242,254,0.4)';
    canvas_ctx.lineWidth = 2 * pixel_ratio_float;
    canvas_ctx.shadowBlur = is_applied_bool ? 10 * pixel_ratio_float : 0;
    canvas_ctx.shadowColor = 'rgba(0,242,254,0.6)';
    canvas_ctx.stroke();
    canvas_ctx.shadowBlur = 0;

    EQ_BAND_CENTRES_HERTZ_LIST.forEach((band_hertz_float, band_int) => {
      canvas_ctx.beginPath();
      canvas_ctx.arc(
        chart_obj.xOfHertz(band_hertz_float),
        chart_obj.yOfDb(result_obj.correction_db_list[band_int]),
        2.6 * pixel_ratio_float,
        0,
        Math.PI * 2
      );
      canvas_ctx.fillStyle =
        is_applied_bool ? '#00f2fe' : 'rgba(0,242,254,0.5)';
      canvas_ctx.fill();
    });

    canvas_ctx.fillStyle = 'rgba(125,137,166,0.8)';
    canvas_ctx.textBaseline = 'top';
    canvas_ctx.fillText(
      is_applied_bool ? 'correction ENGAGED' : 'correction ready',
      chart_obj.pad_px_float + 2 * pixel_ratio_float,
      chart_obj.pad_px_float
    );
  }

  /**
   * Draw the placeholder shown before any measurement exists.
   *
   * Arguments:
   *   chart_obj (Object): The chart mapping for this frame.
   *
   * Returns:
   *   (none)
   */
  #drawEmptyChart(chart_obj) {
    const canvas_ctx = this.canvas_ctx;
    canvas_ctx.fillStyle = 'rgba(125,137,166,0.6)';
    canvas_ctx.textAlign = 'center';
    canvas_ctx.textBaseline = 'middle';
    canvas_ctx.font = `${10 * chart_obj.pixel_ratio_float}px system-ui`;
    canvas_ctx.fillText(
      'No measurement yet — or drop a saved curve here',
      chart_obj.width_px_int / 2,
      chart_obj.height_px_int / 2
    );
    canvas_ctx.textAlign = 'left';
  }

  /**
   * Redraw the whole chart.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #drawChart() {
    const chart_obj = this.#measureChart();
    this.canvas_ctx.clearRect(
      0, 0, chart_obj.width_px_int, chart_obj.height_px_int
    );
    this.#drawChartGrid(chart_obj);

    const result_obj = this.calibrator_obj.result_obj;
    if (!result_obj) {
      this.#drawEmptyChart(chart_obj);
      return;
    }

    this.#drawDeviation(chart_obj, result_obj);
    this.#drawCorrection(chart_obj, result_obj);
  }

  /* ------------------------------------------------------------------ */

  /**
   * Save the current measurement to local storage.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #persist() {
    try {
      localStorage.setItem(
        CALIBRATION_STORAGE_KEY_STR,
        JSON.stringify(this.calibrator_obj.exportMeasurement())
      );
    } catch {
      // Storage unavailable; the measurement is still live in memory.
    }
  }

  /**
   * Restore a saved measurement, if one exists.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   The stored value is untrusted. A parse or validation failure leaves
   *   the panel in its empty state rather than propagating.
   */
  #restore() {
    try {
      const raw_str = localStorage.getItem(CALIBRATION_STORAGE_KEY_STR);
      if (!raw_str) {
        return;
      }
      this.calibrator_obj.importMeasurement(JSON.parse(raw_str));
      this.apply_button_el.disabled = false;
      this.export_button_el.disabled = false;
      this.state_el.textContent = 'saved curve';
      this.state_el.className = 'badge badge--cyan';
      this.#drawChart();
      this.#showStats();
    } catch {
      // No usable saved curve; the panel stays empty.
    }
  }
}
