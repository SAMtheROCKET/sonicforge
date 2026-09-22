/**
 * Rendered-output sanity checks.
 *
 * Brief:
 *   The suite once passed 48/48 while the dial displayed "NaN cents",
 *   because no check looked at what the viewer actually sees. A
 *   renamed field silently yields undefined, and undefined formats
 *   as NaN.
 */

import { buildHudMarkup } from '../app/frame-loop.js';
import { describeVerdict } from '../viz/interference.js';
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
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */

/**
 * Rendered text sanity.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runTextSanityChecks(app) {
  // --- rendered output sanity -------------------------------------------
  // The suite once passed 48/48 while the dial displayed "NaN cents",
  // because no check looked at what the user actually sees. A renamed
  // field silently yields undefined, and undefined formats as NaN.

  check('no visible text contains NaN or undefined', () => {
    const offenders_list = [];

    for (const element of document.querySelectorAll('#app *')) {
      if (element.children.length > 0) {
        continue;
      }
      const text_str = (element.textContent ?? '').trim();
      if (!text_str) {
        continue;
      }
      if (/NaN|undefined|\[object Object\]/.test(text_str)) {
        const label_str = element.id || element.className || element.tagName;
        offenders_list.push(`${label_str}: "${text_str.slice(0, 40)}"`);
      }
    }

    return verdict(
      offenders_list.length === 0,
      offenders_list.length === 0
        ? 'all readouts render real values'
        : offenders_list.slice(0, 6).join(' | ')
    );
  });

  check('no form control holds NaN', () => {
    const offenders_list = [];

    for (const control of document.querySelectorAll('input, select')) {
      const value_str = String(control.value ?? '');
      if (/NaN|undefined/.test(value_str)) {
        offenders_list.push(`${control.id || control.name}: "${value_str}"`);
      }
    }

    return verdict(
      offenders_list.length === 0,
      offenders_list.length === 0
        ? 'all inputs hold real values'
        : offenders_list.slice(0, 6).join(' | ')
    );
  });
}


/**
 * Readout correctness.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runReadoutChecks(app) {
  check('the dial reports a real note and cent deviation', () => {
    const note_str = document.getElementById('dial-note')?.textContent ?? '';
    const cents_str = document.getElementById('dial-cents')?.textContent ?? '';
    const is_valid_bool =
      /^[A-G]#?-?\d+$/.test(note_str.trim()) && /\d/.test(cents_str);

    return verdict(is_valid_bool, `${note_str} / ${cents_str}`);
  });

  check('every channel row shows a note name', () => {
    const cells_list = [
      ...document.querySelectorAll('#chan-list [data-role="note"]'),
    ];
    const blank_count_int = cells_list.filter(
      (cell) => !/^[A-G]/.test((cell.textContent ?? '').trim())
    ).length;

    return verdict(
      cells_list.length === 16 && blank_count_int === 0,
      `${cells_list.length - blank_count_int}/${cells_list.length} rows ` +
        'show a note'
    );
  });

  check('the visualiser hint hides while audio is playing', () => {
    const channel_obj = app.rack.getChannel(0);
    channel_obj.start();
    app.syncUi();

    const hint_el = document.getElementById('viz-empty');
    const opacity_str = hint_el?.style.opacity ?? '';
    channel_obj.stop();
    app.syncUi();

    return verdict(
      opacity_str === '0',
      `opacity was "${opacity_str}" with a channel running`
    );
  });
}


/**
 * The HUD sum readout agrees in sign with the canvas legend.
 *
 * Brief:
 *   The stored ratio is a shortfall, so it is positive when the sum is
 *   *quieter*. Printed raw under the label SUM, a pair cancelling to
 *   silence read "SUM 99%" while the legend a few pixels above it read
 *   "destructive -99%". Both numbers were correct; only one of them was
 *   readable. These assertions pin the direction.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (none)
 */
function buildInterferenceStub(cancellation_ratio_float) {
  return {
    ui: {
      visualiser: { mode_str: 'interference' },
      interference: {
        stats_obj: {
          voice_count_int: 2,
          beat_hertz_float: 0,
          cancellation_ratio_float,
        },
      },
    },
  };
}


/**
 * Read the signed percentage out of a readout string.
 *
 * Arguments:
 *   text_str (string): Legend verdict or HUD markup.
 *
 * Returns:
 *   (string): The signed number, or '' when there is none.
 */
function extractSignedPercent(text_str) {
  return text_str.match(/([+−-]?\d+)%/)?.[1] ?? '';
}


/**
 * The legend and the status HUD report the sum identically.
 *
 * Brief:
 *   These two strings sit in the same panel a few pixels apart and are
 *   built by different modules from the same number. Asserting them
 *   against each other, across all three verdict bands, is what stops one
 *   of them drifting again.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (none)
 */
function runLegendAgreementChecks() {
  check('the legend and the HUD agree on sign in every band', () => {
    const mismatches_list = [];

    for (const ratio_float of [0.99, 0.4, 0.02, -0.02, -0.41, -0.9]) {
      const legend_str = extractSignedPercent(
        describeVerdict(ratio_float).verdict_str
      );
      const hud_str = extractSignedPercent(
        buildHudMarkup(buildInterferenceStub(ratio_float), -12)
      );
      if (legend_str !== hud_str) {
        mismatches_list.push(
          `ratio ${ratio_float}: legend ${legend_str}, hud ${hud_str}`
        );
      }
    }

    return verdict(
      mismatches_list.length === 0,
      mismatches_list.join('; ') || 'all six ratios agree'
    );
  });
}


/**
 * The HUD sum readout points the way the legend points.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (none)
 */
function runHudSignChecks() {
  check('a cancelling pair reports the sum as down, not up', () => {
    const markup_str = buildHudMarkup(buildInterferenceStub(0.99), -20);

    return verdict(markup_str.includes('−99%'), markup_str);
  });

  check('a reinforcing pair reports the sum as up', () => {
    const markup_str = buildHudMarkup(buildInterferenceStub(-0.41), -6);

    return verdict(markup_str.includes('+41%'), markup_str);
  });

  check('a single voice reports no sum at all', () => {
    const app_stub_obj = buildInterferenceStub(0);
    app_stub_obj.ui.interference.stats_obj.voice_count_int = 1;
    const markup_str = buildHudMarkup(app_stub_obj, -12);

    return verdict(!markup_str.includes('SUM'), markup_str);
  });
}


/**
 * Run this group of checks.
 *
 * Brief:
 *   Reads what is actually rendered. A renamed field yields undefined,
 *   and undefined formats as NaN in a readout that still looks fine
 *   to every model-level check.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function runOutputChecks(app) {
  runTextSanityChecks(app);
  runReadoutChecks(app);
  runHudSignChecks();
  runLegendAgreementChecks();
}
