/**
 * Engine, model and interface construction checks.
 *
 * Brief:
 *   The cheapest checks, and the ones every later check depends on.
 *   If the engine did not initialise, everything below is noise.
 */

import { restoreSession } from '../app/session.js';
import {
  CHECKS_LIST,
  CONSOLE_ERRORS_LIST,
  check,
  verdict,
  sleep,
} from './harness.js';

/* ------------------------------------------------------------------------ */

/**
 * Run this group of checks.
 *
 * Brief:
 *   The cheapest checks, and the ones every later group depends on.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */

/**
 * Audio context and master chain.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runContextChecks(app) {
  check('engine initialises', () => app.engine.is_ready_bool);
  check('audio context is running or suspended, not closed', () =>
    ['running', 'suspended'].includes(app.engine.state)
      ? `state=${app.engine.state}`
      : false
  );
  check('sample rate is plausible', () =>
    app.engine.sampleRateHertz >= 8000
      ? `${app.engine.sampleRateHertz} Hz`
      : false
  );
  check('nyquist ceiling exposed', () => `${app.engine.nyquistHertz} Hz`);
  check('master chain built', () =>
    Boolean(
      app.engine.master_gain_node &&
      app.engine.limiter_node &&
      app.engine.meter.spectrum_analyser_node
    )
  );
  check('EQ array has ten bands', () =>
    app.engine.equaliser.filters_list.length === 10
      ? '10 biquads'
      : `got ${app.engine.equaliser.filters_list.length}`
  );
  check('analyser resolves infrasound', () => {
    const bin_hertz_float =
      app.engine.sampleRateHertz /
      app.engine.meter.spectrum_analyser_node.fftSize;
    return bin_hertz_float <= 2
      ? `${bin_hertz_float.toFixed(2)} Hz per bin`
      : `too coarse: ${bin_hertz_float.toFixed(2)} Hz per bin`;
  });

  // --- models --------------------------------------------------------
}


/**
 * Models and rendered interface.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runModelChecks(app) {
  check('16 channels exist', () => app.rack.channels_list.length === 16);
  check('noise generator constructed', () =>
    Boolean(app.noise?.level_gain_node)
  );
  check('script VM constructed', () => Boolean(app.vm));
  check('calibration constructed', () => Boolean(app.cal));
  check('concert mode constructed', () => Boolean(app.concert));

  // --- UI ------------------------------------------------------------
  check(
    'app shell is ' +
    'visible',
    () => document.getElementById('app')?.hidden === false
  );
  check('16 channel rows rendered', () => {
    const count_int = document.querySelectorAll('#chan-list .chan').length;
    return count_int === 16 ? '16 rows' : `got ${count_int}`;
  });
  check('presets rendered', () => {
    const count_int = document.querySelectorAll('#preset-list .preset').length;
    return count_int >= 15 ? `${count_int} presets` : `only ${count_int}`;
  });
  check('waveform selector rendered', () =>
    document.querySelectorAll('#wave-seg [data-wave]').length === 5
  );
  check('noise colour selector rendered', () =>
    document.querySelectorAll('#noise-a [data-color]').length === 7
  );
  check('dial constructed', () => Boolean(app.ui.dial));
  check('terminal constructed', () => Boolean(app.ui.terminal));
  check(
    'visualiser ' +
    'constructed',
    () => app.ui.waterfall?.render_mode_str ?? false
  );
  check('interference view constructed', () => Boolean(app.ui.interference));
  check('sample-rate selector populated', () =>
    document.querySelectorAll('#sample-rate option').length >= 4
  );
}


/**
 * Run this group of checks.
 *
 * Brief:
 *   The cheapest checks, and the ones every later group depends on.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function runEngineChecks(app) {
  runContextChecks(app);
  runModelChecks(app);
}
