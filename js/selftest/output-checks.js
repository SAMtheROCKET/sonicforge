/**
 * Rendered-output sanity checks.
 *
 * Brief:
 *   The suite once passed 48/48 while the dial displayed "NaN cents",
 *   because no check looked at what the viewer actually sees. A
 *   renamed field silently yields undefined, and undefined formats
 *   as NaN.
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
}
