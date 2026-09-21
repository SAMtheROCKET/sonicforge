/**
 * Toasts and modal dialogs.
 *
 * Brief:
 *   Deliberately not window.confirm(). A native dialog blocks the main
 *   thread, and blocking the main thread while sixteen oscillators and a
 *   WebGL loop are running produces an audible stall.
 */

import { renderIconSvg } from './icons.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Icon shown beside a toast, by severity level. */
const TOAST_ICON_NAMES_OBJ = Object.freeze({
  ok: 'check',
  err: 'alert',
  warn: 'alert',
  info: 'info',
});

/** Default dwell time before a toast dismisses itself, in milliseconds. */
const DEFAULT_TOAST_MS_INT = 4200;

/** Icon size used inside a toast, in pixels. */
const TOAST_ICON_SIZE_PX_INT = 14;

/** Most toasts allowed on screen at once. */
const MAX_VISIBLE_TOASTS_INT = 4;

/**
 * Fallback removal delay, in milliseconds.
 *
 * The exit animation normally removes the node on animationend. This covers
 * the case where the animation never fires, which is what happens when the
 * viewer has reduced motion enabled.
 */
const TOAST_REMOVE_FALLBACK_MS_INT = 400;

/* ------------------------------------------------------------------------ */

/** Lazily resolved toast container; the DOM is not ready at import time. */
let toast_host_el = null;

/**
 * Resolve the toast container element.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (HTMLElement|null): The container, or null before the DOM exists.
 */
function findToastHost() {
  if (!toast_host_el) {
    toast_host_el = document.getElementById('toasts');
  }
  return toast_host_el;
}

/**
 * Show a transient notification.
 *
 * Brief:
 *   The message is assigned as textContent rather than markup, because some
 *   callers pass an error message straight through from a failed operation.
 *
 * Arguments:
 *   message_str (string): Text to display; inserted as text, not HTML.
 *   level_str (string): 'info', 'ok', 'warn' or 'err'.
 *   dismiss_after_ms_int (number): Dwell time; 0 keeps it until clicked.
 *
 * Returns:
 *   (HTMLElement|null): The toast element, or null if there is no host.
 *
 * Warning:
 *   Falls back to console output when the container is missing, so a toast
 *   raised before the interface exists is never silently lost.
 */
export function showToast(
  message_str,
  level_str = 'info',
  dismiss_after_ms_int = DEFAULT_TOAST_MS_INT
) {
  const host_el = findToastHost();
  if (!host_el) {
    console.log(`[SonicForge] ${level_str}: ${message_str}`);
    return null;
  }

  const toast_el = document.createElement('div');
  toast_el.className = `toast toast--${level_str}`;
  const icon_name_str = TOAST_ICON_NAMES_OBJ[level_str] ?? 'info';
  toast_el.innerHTML =
    renderIconSvg(icon_name_str, { size_px_int: TOAST_ICON_SIZE_PX_INT }) +
    '<span></span>';
  toast_el.querySelector('span').textContent = message_str;

  const dismissToast = () => {
    toast_el.classList.add('is-out');
    toast_el.addEventListener(
      'animationend', () => toast_el.remove(), { once: true }
    );
    setTimeout(() => toast_el.remove(), TOAST_REMOVE_FALLBACK_MS_INT);
  };

  toast_el.addEventListener('click', dismissToast);
  host_el.appendChild(toast_el);
  if (dismiss_after_ms_int > 0) {
    setTimeout(dismissToast, dismiss_after_ms_int);
  }

  // Never let a runaway loop fill the screen with toasts.
  while (host_el.childElementCount > MAX_VISIBLE_TOASTS_INT) {
    host_el.firstElementChild.remove();
  }
  return toast_el;
}

/**
 * Build the backdrop and dialog markup for a confirmation.
 *
 * Arguments:
 *   options_obj (Object): Title, body and button labels.
 *
 * Returns:
 *   (HTMLElement): The detached backdrop element.
 *
 * Warning:
 *   body_html_str is assigned as innerHTML because the callers pass
 *   formatted safety copy. It is author-controlled and never user input.
 */
function buildConfirmBackdrop(options_obj) {
  const {
    title_str,
    body_html_str,
    confirm_label_str,
    cancel_label_str,
    is_danger_bool,
  } = options_obj;

  const confirm_class_str = is_danger_bool ? 'btn--danger' : 'btn--primary';
  const backdrop_el = document.createElement('div');
  backdrop_el.className = 'modal-backdrop';
  backdrop_el.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true"
           aria-labelledby="modal-title">
        <div class="modal__title" id="modal-title"></div>
        <div class="modal__body"></div>
        <div class="modal__actions">
          <button class="btn" data-act="cancel"></button>
          <button class="btn ${confirm_class_str}" data-act="ok"></button>
        </div>
      </div>`;

  backdrop_el.querySelector('.modal__title').textContent = title_str;
  backdrop_el.querySelector('.modal__body').innerHTML = body_html_str;
  backdrop_el.querySelector('[data-act="cancel"]').textContent =
    cancel_label_str;
  backdrop_el.querySelector('[data-act="ok"]').textContent = confirm_label_str;
  return backdrop_el;
}

/**
 * Ask the viewer to confirm an action.
 *
 * Brief:
 *   Resolves true only on an explicit confirmation. Escape, the cancel
 *   button and a click on the backdrop all resolve false, so dismissing the
 *   dialog by any route is the safe outcome.
 *
 * Arguments:
 *   options_obj (Object): { title_str, body_html_str, confirm_label_str,
 *     cancel_label_str, is_danger_bool }.
 *
 * Returns:
 *   (Promise<boolean>): True when confirmed.
 *
 * Warning:
 *   The key listener is registered in the capture phase so the application's
 *   own global shortcuts do not act on keys aimed at the dialog.
 */
export function requestConfirmation(options_obj) {
  const {
    title_str,
    body_html_str,
    confirm_label_str = 'Continue',
    cancel_label_str = 'Cancel',
    is_danger_bool = false,
  } = options_obj;

  return new Promise((resolve_fn) => {
    const host_el = document.getElementById('modal-root');
    const backdrop_el = buildConfirmBackdrop({
      title_str,
      body_html_str,
      confirm_label_str,
      cancel_label_str,
      is_danger_bool,
    });

    const closeDialog = (result_bool) => {
      document.removeEventListener('keydown', handleKeyDown, true);
      backdrop_el.remove();
      resolve_fn(result_bool);
    };

    const handleKeyDown = (keyboard_event) => {
      if (keyboard_event.key === 'Escape') {
        keyboard_event.stopPropagation();
        closeDialog(false);
      } else if (keyboard_event.key === 'Enter') {
        keyboard_event.stopPropagation();
        closeDialog(true);
      }
    };

    backdrop_el.addEventListener('click', (mouse_event) => {
      if (mouse_event.target === backdrop_el) {
        closeDialog(false);
        return;
      }
      const action_str =
        mouse_event.target.closest('[data-act]')?.dataset.act;
      if (action_str === 'ok') {
        closeDialog(true);
      } else if (action_str === 'cancel') {
        closeDialog(false);
      }
    });

    document.addEventListener('keydown', handleKeyDown, true);
    host_el.appendChild(backdrop_el);
    backdrop_el.querySelector('[data-act="ok"]').focus();
  });
}

/**
 * Show an informational modal with a single dismiss button.
 *
 * Brief:
 *   Built on the confirmation dialog so both share one focus trap and one
 *   set of keyboard bindings; the result is simply ignored.
 *
 * Arguments:
 *   options_obj (Object): { title_str, body_html_str, close_label_str }.
 *
 * Returns:
 *   (Promise<boolean>): Resolves once the viewer dismisses it.
 */
export function showInfoDialog(options_obj) {
  const {
    title_str,
    body_html_str,
    close_label_str = 'Got it',
  } = options_obj;

  return requestConfirmation({
    title_str,
    body_html_str,
    confirm_label_str: close_label_str,
    cancel_label_str: 'Close',
  });
}
