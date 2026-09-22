/**
 * The single animation frame that drives every meter and readout.
 *
 * Brief:
 *   One requestAnimationFrame for the whole application. A loop per panel
 *   would multiply the layout work and make the frame budget impossible to
 *   reason about. The master meter needs every frame; the status fields and
 *   per-channel meters do not, so they run on a slower subdivision.
 */

import { clampToRange } from '../util/numeric.js';
import { findElement } from './dom.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Frames between updates of the slower readouts. */
const SLOW_TICK_DIVISOR_INT = 3;

/** Bottom of the master meter scale, in dBFS. */
const METER_FLOOR_DB_FLOAT = -60;

/** How long the peak marker holds before it falls back, in milliseconds. */
const PEAK_HOLD_MS_INT = 1400;

/** Gain reduction past which the readout is highlighted, in dB. */
const NOTABLE_REDUCTION_DB_FLOAT = -0.5;

/** Frame rate reported for the Canvas2D views, which do not measure it. */
const ASSUMED_CANVAS_FPS_INT = 60;

/* ------------------------------------------------------------------------ */

/**
 * Map a level onto its position along the meter.
 *
 * Arguments:
 *   level_db_float (number): Level in dBFS, possibly -Infinity.
 *
 * Returns:
 *   (number): Position from 0 at the floor to 1 at full scale.
 */
function mapLevelToMeter(level_db_float) {
  if (!Number.isFinite(level_db_float)) {
    return 0;
  }
  return clampToRange(
    (level_db_float - METER_FLOOR_DB_FLOAT) / -METER_FLOOR_DB_FLOAT, 0, 1
  );
}

/**
 * Describe the engine state as a status-dot class.
 *
 * Arguments:
 *   state_str (string): The AudioContext state.
 *
 * Returns:
 *   (string): The full class attribute for the dot.
 */
function describeEngineDot(state_str) {
  if (state_str === 'running') {
    return 'status-dot status-dot--live';
  }
  if (state_str === 'suspended') {
    return 'status-dot status-dot--warn';
  }
  return 'status-dot status-dot--err';
}

/**
 * Build the visualiser HUD line for the active mode.
 *
 * Brief:
 *   Exported so the sign convention below can be asserted directly. The
 *   readout it produces sits in the same panel as the legend the canvas
 *   draws, and the two once contradicted each other; a test that reads the
 *   string is the only thing that keeps them agreeing.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   peak_db_float (number): Current master peak, in dBFS.
 *
 * Returns:
 *   (string): HUD markup.
 *
 * Warning:
 *   Returns markup, not text. Callers assign it to innerHTML, so every
 *   value interpolated into it must be a number this module formatted.
 */
export function buildHudMarkup(app_obj, peak_db_float) {
  if (app_obj.ui.visualiser.mode_str === 'waterfall') {
    const audible_list = app_obj.rack.audibleChannels;
    if (!audible_list.length) {
      return '<span>20 Hz → 20 kHz log</span>';
    }
    const peak_str = Number.isFinite(peak_db_float)
      ? peak_db_float.toFixed(1)
      : '-inf';
    return `<span>VOICES <b>${audible_list.length}</b></span>` +
      `<span>PEAK <b>${peak_str} dB</b></span>` +
      '<span>20 Hz → 20 kHz</span>';
  }

  const stats_obj = app_obj.ui.interference.stats_obj;
  const beat_str = stats_obj.beat_hertz_float > 0
    ? `<span>BEAT <b>${stats_obj.beat_hertz_float.toFixed(2)} Hz</b></span>`
    : '';
  // The legend drawn inside the canvas reports this same quantity as
  // "destructive -99%" or "constructive +41%". The stored ratio is a
  // *shortfall* against an incoherent sum, so it is positive when the sum
  // is quieter -- printing it raw under the label SUM read as though a
  // cancelling pair were at 99% of full level, the exact opposite of what
  // the legend a few pixels above it said. Negating it makes the two agree
  // sign for sign.
  const sum_percent_float = -stats_obj.cancellation_ratio_float * 100;
  let sum_sign_str = '';
  if (sum_percent_float > 0.5) {
    sum_sign_str = '+';
  }
  if (sum_percent_float < -0.5) {
    sum_sign_str = '−';
  }
  const sum_str = stats_obj.voice_count_int > 1
    ? '<span>SUM <b>' +
      `${sum_sign_str}${Math.abs(sum_percent_float).toFixed(0)}%` +
      '</b></span>'
    : '';
  return `<span>VOICES <b>${stats_obj.voice_count_int}</b></span>` +
    beat_str + sum_str;
}

/**
 * Update the readouts that do not need every frame.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   peak_db_float (number): Current master peak, in dBFS.
 *
 * Returns:
 *   (none)
 */
function updateSlowReadouts(app_obj, peak_db_float) {
  app_obj.ui.channels.updateMeters();

  const state_str = app_obj.engine.state;
  findElement('st-engine').textContent = state_str;
  findElement('dot-engine').className = describeEngineDot(state_str);

  const voice_count_int = app_obj.rack.activeChannelCount +
    (app_obj.noise.is_running_bool ? 1 : 0);
  findElement('st-voices').textContent = String(voice_count_int);

  const reduction_db_float = app_obj.engine.gainReductionDb;
  const reduction_el = findElement('st-gr');
  reduction_el.textContent = `${reduction_db_float.toFixed(1)} dB`;
  reduction_el.style.color =
    reduction_db_float < NOTABLE_REDUCTION_DB_FLOAT ? 'var(--amber)' : '';

  const frames_per_second_float =
    app_obj.ui.visualiser.mode_str === 'waterfall'
      ? app_obj.ui.waterfall.frames_per_second_float
      : ASSUMED_CANVAS_FPS_INT;
  findElement('st-fps').textContent =
    String(Math.round(frames_per_second_float));

  findElement('viz-hud').innerHTML = buildHudMarkup(app_obj, peak_db_float);
  app_obj.ui.visualiser.syncHint();
}

/**
 * Start the application's single animation frame loop.
 *
 * Brief:
 *   The master meter updates every frame; everything else runs on a
 *   slower subdivision, because no readout below it changes fast enough
 *   to be worth sixty updates a second.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   The next frame is requested before the work, so a throw in a readout
 *   cannot silently end every meter in the application.
 */
export function startFrameLoop(app_obj) {
  const meter_fill_el = findElement('meter-fill');
  const meter_peak_el = findElement('meter-peak');
  const meter_value_el = findElement('meter-val');

  findElement('st-rate').textContent =
    `${(app_obj.engine.sampleRateHertz / 1000).toFixed(1)} kHz`;
  findElement('st-latency').textContent =
    `${app_obj.engine.latencyMs.toFixed(1)} ms`;

  let peak_hold_db_float = -Infinity;
  let peak_hold_at_ms_float = 0;
  let slow_tick_int = 0;

  const drawFrame = (now_ms_float) => {
    requestAnimationFrame(drawFrame);

    const levels_obj = app_obj.engine.meter.readLevels();
    const peak_db_float = levels_obj.peak_db_float;

    meter_fill_el.style.right =
      `${(1 - mapLevelToMeter(peak_db_float)) * 100}%`;

    const is_hold_expired_bool =
      now_ms_float - peak_hold_at_ms_float > PEAK_HOLD_MS_INT;
    if (peak_db_float > peak_hold_db_float || is_hold_expired_bool) {
      peak_hold_db_float = peak_db_float;
      peak_hold_at_ms_float = now_ms_float;
    }
    meter_peak_el.style.left =
      `${mapLevelToMeter(peak_hold_db_float) * 100}%`;

    meter_value_el.textContent = Number.isFinite(peak_db_float)
      ? `${peak_db_float.toFixed(1)}`
      : '-∞';
    meter_value_el.classList.toggle('is-clip', levels_obj.is_clipping_bool);

    if (++slow_tick_int % SLOW_TICK_DIVISOR_INT === 0) {
      updateSlowReadouts(app_obj, peak_db_float);
    }
  };

  requestAnimationFrame(drawFrame);
}
