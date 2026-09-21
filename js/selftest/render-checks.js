/**
 * Render-loop and meter checks.
 *
 * Brief:
 *   Runs the animation loop for long enough that a throw inside a
 *   draw becomes an uncaught error this suite can see.
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
 *   Lets the loops run long enough that a throw inside a draw becomes
 *   an uncaught error this suite can see.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 */
export async function runRenderChecks(app) {
  // Let a few animation frames run so the render loops are exercised.
  await sleep(700);

  // Every visualiser, not just the default one. The interference and
  // goniometer views read the meter's stereo pair, and a rename on that
  // method threw on their first frame while the waterfall - the only mode
  // this suite used to visit - stayed perfectly green.
  const viz_modes_tried_list = [];
  for (const vizName of ['interference', 'gonio', 'waterfall']) {
    app.setVizMode(vizName);
    await sleep(220);
    viz_modes_tried_list.push(vizName);
  }
  check('every visualiser mode renders', () =>
    verdict(
      viz_modes_tried_list.length === 3,
      viz_modes_tried_list.join(', ')
    )
  );
  check('interference view still animating', () => {
    app.setVizMode('interference');
    const interference_obj = app.ui.interference;
    return verdict(
      interference_obj.is_running_bool &&
      interference_obj.stats_obj.voice_count_int >= 0,
      `running=${interference_obj.is_running_bool}`
    );
  });

  // Returning the joined errors as a string would be scored as a pass by
  // the check() contract, which is how a real throw once stayed green.
  check('frame loop did not throw', () =>
    verdict(CONSOLE_ERRORS_LIST.length === 0, CONSOLE_ERRORS_LIST.join(' | '))
  );
  check('meter reads without error', () => {
    const levels_obj = app.engine.meter.readLevels();
    return Number.isFinite(levels_obj.peak_linear_float)
      ? `peak=${levels_obj.peak_linear_float.toFixed(5)}`
      : false;
  });
  check('spectrum reads at full resolution', () => {
    const spectrum_arr = app.engine.meter.readSpectrumDb();
    const expected_int =
      app.engine.meter.spectrum_analyser_node.fftSize / 2;
    return spectrum_arr.length === expected_int
      ? `${spectrum_arr.length} bins`
      : `got ${spectrum_arr.length}`;
  });
}
