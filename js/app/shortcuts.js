/**
 * Global keyboard shortcuts, the mobile rail toggle, and the help dialog.
 *
 * Brief:
 *   Shortcuts are suppressed while a field has focus, with one exception:
 *   Escape always panics. Someone reaching for Escape mid-type is reaching
 *   for silence, not for a cancelled edit.
 */

import { CHANNEL_COUNT_INT } from '../core/channel-rack.js';
import { requestConfirmation } from '../ui/feedback.js';
import { findElement } from './dom.js';
import { panic } from './header-panel.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Elements whose focus suppresses single-key shortcuts. */
const TYPING_TAG_REGEX = /^(INPUT|TEXTAREA|SELECT)$/;

/** Keys 1 to 9 toggle the corresponding channel. */
const CHANNEL_KEY_REGEX = /^[1-9]$/;

/** Body copy for the help dialog. */
const HELP_BODY_HTML_STR = `
  <p style="margin-bottom:12px">Sixteen independent tone channels, seven
  noise colours, microphone room calibration, a scripting terminal and a
  WebGL spectrogram. Everything runs locally.</p>
  <table style="width:100%;font-size:11.5px;border-collapse:collapse">
    <tr><td style="padding:3px 0"><span class="kbd">Space</span></td>
      <td>Play / stop everything</td></tr>
    <tr><td style="padding:3px 0"><span class="kbd">Esc</span></td>
      <td>Panic — immediate silence</td></tr>
    <tr><td style="padding:3px 0"><span class="kbd">/</span></td>
      <td>Focus the script terminal</td></tr>
    <tr><td style="padding:3px 0"><span class="kbd">1</span>–<span
      class="kbd">9</span></td><td>Toggle that channel</td></tr>
    <tr><td style="padding:3px 0"><span class="kbd">↑</span><span
      class="kbd">↓</span></td><td>Select previous / next channel</td></tr>
    <tr><td style="padding:3px 0"><span class="kbd">M</span> <span
      class="kbd">S</span></td><td>Mute / solo the selected channel</td></tr>
    <tr><td style="padding:3px 0"><span class="kbd">N</span></td>
      <td>Toggle the noise generator</td></tr>
    <tr><td style="padding:3px 0"><span class="kbd">V</span></td>
      <td>Cycle the visualiser</td></tr>
  </table>
  <p style="margin-top:12px;opacity:.75">On the dial: <b>Shift</b> for fine,
  <b>Alt</b> for coarse, <b>Ctrl</b> to snap to semitones. In the terminal,
  <b>Tab</b> completes and <b>↑</b> recalls history.</p>`;

/* ------------------------------------------------------------------------ */

/**
 * Move the rack selection by one channel, wrapping at both ends.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   direction_int (number): -1 for previous, 1 for next.
 *
 * Returns:
 *   (none)
 */
function stepSelection(app_obj, direction_int) {
  const current_index_int = app_obj.ui.channels.selected_index_int;
  const next_index_int =
    (current_index_int + direction_int + CHANNEL_COUNT_INT) %
    CHANNEL_COUNT_INT;
  app_obj.ui.channels.selectChannel(next_index_int);
}

/**
 * Toggle the channel a number key names.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   key_str (string): A digit from 1 to 9.
 *
 * Returns:
 *   (none)
 */
function toggleNumberedChannel(app_obj, key_str) {
  const channel_obj = app_obj.rack.getChannel(Number(key_str) - 1);
  if (!channel_obj) {
    return;
  }
  channel_obj.toggle();
  app_obj.ui.channels.selectChannel(channel_obj.index_int);
  app_obj.ui.header?.sync();
}

/**
 * Act on one shortcut key.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   keyboard_event (KeyboardEvent): The key press.
 *
 * Returns:
 *   (none)
 */
function handleShortcut(app_obj, keyboard_event) {
  switch (keyboard_event.key) {
    case ' ':
      keyboard_event.preventDefault();
      findElement('master-play').click();
      break;

    case '/':
      keyboard_event.preventDefault();
      app_obj.ui.terminal.input_el.focus();
      break;

    case 'm':
      app_obj.selectedChannel?.setMuted(
        !app_obj.selectedChannel.is_muted_bool
      );
      break;

    case 's':
      app_obj.selectedChannel?.setSoloed(
        !app_obj.selectedChannel.is_soloed_bool
      );
      break;

    case 'n':
      findElement('noise-toggle').click();
      break;

    case 'v':
      app_obj.ui.visualiser.cycleMode();
      break;

    case 'ArrowUp':
      keyboard_event.preventDefault();
      stepSelection(app_obj, -1);
      break;

    case 'ArrowDown':
      keyboard_event.preventDefault();
      stepSelection(app_obj, 1);
      break;

    default:
      if (CHANNEL_KEY_REGEX.test(keyboard_event.key)) {
        toggleNumberedChannel(app_obj, keyboard_event.key);
      }
  }
}

/**
 * Bind the global keyboard shortcuts.
 *
 * Brief:
 *   One document-level listener rather than one per control, so a
 *   shortcut works wherever focus happens to be.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function bindShortcuts(app_obj) {
  document.addEventListener('keydown', (keyboard_event) => {
    const is_typing_bool =
      TYPING_TAG_REGEX.test(keyboard_event.target.tagName);

    // Escape always panics, even from inside a field.
    if (keyboard_event.key === 'Escape' && !is_typing_bool) {
      keyboard_event.preventDefault();
      panic(app_obj);
      return;
    }
    if (is_typing_bool) {
      return;
    }
    handleShortcut(app_obj, keyboard_event);
  });
}

/**
 * Bind the narrow-screen rail toggle.
 *
 * Brief:
 *   Choosing a preset also closes the rail, because on a phone it
 *   covers the thing the preset just changed. The rail opens just below
 *   the header's actual bottom edge, measured each time, because the
 *   header wraps onto extra rows on narrow screens and a fixed offset
 *   would slide the rail underneath it.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (none)
 */
export function bindRailToggle() {
  const toggle_el = findElement('rail-toggle');
  const rail_el = findElement('rail-left');
  const header_el = document.querySelector('.topbar');

  toggle_el.addEventListener('click', () => {
    const header_bottom_px_float = header_el.getBoundingClientRect().bottom;
    rail_el.style.top = `${Math.max(0, header_bottom_px_float)}px`;
    rail_el.classList.toggle('is-open');
  });
  rail_el.addEventListener('click', (click_event) => {
    if (click_event.target.closest('.preset')) {
      rail_el.classList.remove('is-open');
    }
  });
}

/**
 * Show the help dialog.
 *
 * Brief:
 *   Built on the confirmation dialog so it shares one focus trap; the
 *   result is ignored.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (none)
 */
export function showHelp() {
  requestConfirmation({
    title_str: 'SonicForge',
    body_html_str: HELP_BODY_HTML_STR,
    confirm_label_str: 'Close',
    cancel_label_str: 'Dismiss',
  });
}
