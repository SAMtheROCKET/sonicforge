/**
 * Application self-test.
 *
 * Brief:
 *   tests.html proves the DSP and the parser. It cannot prove that the
 *   application boots: that the engine initialises, that every panel
 *   constructs, that the visualiser gets a context, that a preset runs
 *   without throwing. Those are exactly the failures a unit suite never
 *   catches.
 *
 *   So this boots the real application and audits it. It is only ever
 *   loaded when ?selftest=1 is present on localhost, so it ships nothing to
 *   a real user: the module is not even fetched otherwise.
 */

import {
  CHECKS_LIST,
  CONSOLE_ERRORS_LIST,
  captureErrors,
  sleep,
  buildReport,
} from './selftest/harness.js';
import { runEngineChecks } from './selftest/engine-checks.js';
import { runBehaviourChecks } from './selftest/behaviour-checks.js';
import { runRenderChecks } from './selftest/render-checks.js';
import { runLayoutChecks } from './selftest/layout-checks.js';
import { runOutputChecks } from './selftest/output-checks.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** How long the interface is given to settle after boot, in milliseconds. */
const SETTLE_MS_INT = 400;

/** Endpoint the development server writes the report to. */
const RESULTS_ENDPOINT_STR = '/__results';

/* ------------------------------------------------------------------------ */

/**
 * Hand the report back to the development server.
 *
 * Brief:
 *   Lets a headless run be asserted on from the command line, which is how
 *   this suite runs in CI. Silently ignored anywhere else.
 *
 * Arguments:
 *   report_obj (Object): The report to post.
 *
 * Returns:
 *   (Promise<void>)
 */
async function postReport(report_obj) {
  try {
    await fetch(RESULTS_ENDPOINT_STR, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report_obj),
    });
  } catch {
    // Not served by the bundled server; the console line is the result.
  }
}

/**
 * Boot the application and run every group of checks.
 *
 * Brief:
 *   Each group is a module, so a failure names the area it came
 *   from and the file to open.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   options_obj (Object): { boot } — the boot function to call.
 *
 * Returns:
 *   (Promise<Object>): The report.
 *
 * Warning:
 *   Order matters: the engine checks must run first, because every later
 *   group assumes a booted application.
 */
export async function runSelfTest(app_obj, options_obj) {
  const { boot } = options_obj;
  captureErrors();
  const started_ms_float = performance.now();

  await boot();
  await sleep(SETTLE_MS_INT);

  runEngineChecks(app_obj);
  await runBehaviourChecks(app_obj);
  await runRenderChecks(app_obj);
  runLayoutChecks(app_obj);
  runOutputChecks(app_obj);

  const report_obj = buildReport(
    app_obj, Math.round(performance.now() - started_ms_float)
  );
  window.__APPTEST__ = report_obj;
  console.log(
    `[SonicForge selftest] ${report_obj.pass} passed, ` +
    `${report_obj.fail} failed`
  );

  await postReport(report_obj);
  return report_obj;
}
