/**
 * Layout audit.
 *
 * Brief:
 *   Screenshots caught overlapping terminal lines and clipped panel
 *   copy. These assertions make that class of regression
 *   machine-detectable.
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
 * Page and panel overflow.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runOverflowChecks(app) {
  // --- layout audit -----------------------------------------------------
  // Screenshots caught overlapping terminal lines and clipped panel copy.
  // These assertions make that class of regression machine-detectable.

  check('page does not scroll horizontally', () => {
    const overflow_px_int =
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth;
    return verdict(
      overflow_px_int <= 1,
      overflow_px_int <= 1
        ? 'no overflow'
        : `${overflow_px_int}px of horizontal overflow`
    );
  });

  check('terminal log lines do not overlap', () => {
    const lines_list =
      [...document.querySelectorAll('.term__log .term__line')];
    if (lines_list.length < 2) return 'too few lines to test';
    const rects_list = lines_list.map((el) => el.getBoundingClientRect());
    for (let index_int = 1; index_int < rects_list.length; index_int++) {
      const previous_obj = rects_list[index_int - 1];
      const current_rect_obj = rects_list[index_int];
      if (current_rect_obj.top < previous_obj.bottom - 1) {
        return verdict(false,
          `line ${index_int} starts at ` +
          `${current_rect_obj.top.toFixed(1)} but line ` +
          `${index_int - 1} ends at ` +
          `${previous_obj.bottom.toFixed(1)}`);
      }
    }
    return `${lines_list.length} lines stacked cleanly`;
  });
}


/**
 * Panel and rail fit.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runPanelFitChecks(app) {
  check('no panel clips its own content', () => {
    const bad_list = [];
    for (const body_el of document.querySelectorAll('.panel__body')) {
      // A scrollable body is fine; a body whose content is cut with no way
      // to reach it is not.
      const style_obj = getComputedStyle(body_el);
      const is_hidden_bool =
        style_obj.overflowY === 'hidden' || style_obj.overflow === 'hidden';
      const is_clipped_bool = body_el.scrollHeight - body_el.clientHeight > 2;
      // A body may delegate scrolling to a child (the channel rack does), in
      // which case the content is still reachable and this is not a defect.
      const has_inner_scroller_bool =
        [...body_el.querySelectorAll('*')].some((el) => {
        const computed_style_obj = getComputedStyle(el);
        const scrolls_bool =
          computed_style_obj.overflowY === 'auto' ||
          computed_style_obj.overflowY === 'scroll';
        return scrolls_bool && el.scrollHeight > el.clientHeight;
      });
      if (is_clipped_bool && is_hidden_bool && !has_inner_scroller_bool) {
        const title_str =
          body_el.closest('.panel')
            ?.querySelector('.panel__title')?.textContent ?? '?';
        bad_list.push(
          `${title_str} ` +
          `(+${body_el.scrollHeight - body_el.clientHeight}px)`
        );
      }
    }
    return verdict(
      bad_list.length === 0,
      bad_list.length === 0
        ? 'all panel content reachable'
        : bad_list.join(', ')
    );
  });

}

/**
 * Rail panel heights.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runRailHeightChecks(app) {
  check('rail panels keep their natural height', () => {
    const bad_list = [];
    for (const rail of document.querySelectorAll('.rail')) {
      for (const panel of rail.children) {
        // .panel--flush is explicitly meant to absorb slack and scroll.
        if (panel.classList.contains('panel--flush')) continue;
        const body_el = panel.querySelector('.panel__body');
        if (!body_el) continue;
        if (body_el.scrollHeight - body_el.clientHeight > 2) {
          const title_str =
            panel.querySelector('.panel__title')?.textContent ?? '?';
          bad_list.push(
            `${title_str} squeezed by ` +
            `${body_el.scrollHeight - body_el.clientHeight}px`
          );
        }
      }
    }
    return verdict(
      bad_list.length === 0,
      bad_list.length === 0
        ? 'no squeezed panels'
        : bad_list.join(', ')
    );
  });
}


/**
 * Control and row fit.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runControlFitChecks(app) {
  check('no text is truncated in a select', () => {
    const bad_list = [];
    for (const sel of document.querySelectorAll('select.input')) {
      if (sel.scrollWidth > sel.clientWidth + 2) {
        bad_list.push(
          `#${sel.id || sel.className} needs ` +
          `${sel.scrollWidth - sel.clientWidth}px more`
        );
      }
    }
    return verdict(
      bad_list.length === 0,
      bad_list.length === 0
        ? 'all selects fit'
        : bad_list.join(', ')
    );
  });

  check('channel rows are all rendered and reachable', () => {
    const list_el = document.getElementById('chan-list');
    const row_count_int = list_el.querySelectorAll('.chan').length;
    const is_scrollable_bool = list_el.scrollHeight > list_el.clientHeight;
    const can_scroll_bool = getComputedStyle(list_el).overflowY !== 'hidden';
    const is_good_bool =
      row_count_int === 16 && (!is_scrollable_bool || can_scroll_bool);
    return verdict(is_good_bool, is_good_bool
      ? `${row_count_int} rows, ` +
        `${is_scrollable_bool ? 'scrollable' : 'fully visible'}`
      : `${row_count_int} rows, ` +
        `scrollable=${is_scrollable_bool}, ` +
        `canScroll=${can_scroll_bool}`);
  });
}


/**
 * Run this group of checks.
 *
 * Brief:
 *   Makes clipped and overlapping layout machine-detectable, which
 *   screenshots caught and no assertion did.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function runLayoutChecks(app) {
  runOverflowChecks(app);
  runPanelFitChecks(app);
  runRailHeightChecks(app);
  runControlFitChecks(app);
}
