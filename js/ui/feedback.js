/**
 * Toasts and modal dialogs.
 *
 * Deliberately not using window.confirm(): a native dialog blocks the main
 * thread, and blocking the main thread while sixteen oscillators and a WebGL
 * loop are running produces an audible stall.
 */

import { icon } from './icons.js';

const TOAST_ICONS = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' };

let toastRoot = null;

function root() {
  if (!toastRoot) toastRoot = document.getElementById('toasts');
  return toastRoot;
}

/**
 * @param {string} message
 * @param {'info'|'ok'|'warn'|'err'} [level]
 * @param {number} [ms] auto-dismiss delay; 0 keeps it until clicked
 */
export function toast(message, level = 'info', ms = 4200) {
  const host = root();
  if (!host) {
    console.log(`[SonicForge] ${level}: ${message}`);
    return null;
  }

  const el = document.createElement('div');
  el.className = `toast toast--${level}`;
  el.innerHTML = `${icon(TOAST_ICONS[level] ?? 'info', { size: 14 })}<span></span>`;
  el.querySelector('span').textContent = message;

  const dismiss = () => {
    el.classList.add('is-out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    setTimeout(() => el.remove(), 400);
  };

  el.addEventListener('click', dismiss);
  host.appendChild(el);
  if (ms > 0) setTimeout(dismiss, ms);

  // Never let a runaway loop fill the screen with toasts.
  while (host.childElementCount > 4) host.firstElementChild.remove();
  return el;
}

/**
 * Promise-based confirmation dialog.
 * @param {{title:string, body:string, confirm?:string, cancel?:string, danger?:boolean}} opts
 * @returns {Promise<boolean>}
 */
export function confirmDialog({ title, body, confirm = 'Continue', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const host = document.getElementById('modal-root');
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
        <div class="modal__title" id="modal-title"></div>
        <div class="modal__body"></div>
        <div class="modal__actions">
          <button class="btn" data-act="cancel"></button>
          <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" data-act="ok"></button>
        </div>
      </div>`;

    backdrop.querySelector('.modal__title').textContent = title;
    backdrop.querySelector('.modal__body').innerHTML = body; // author-controlled copy
    backdrop.querySelector('[data-act="cancel"]').textContent = cancel;
    backdrop.querySelector('[data-act="ok"]').textContent = confirm;

    const close = (result) => {
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      resolve(result);
    };

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); close(true); }
    };

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) close(false);
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'ok') close(true);
      else if (act === 'cancel') close(false);
    });

    document.addEventListener('keydown', onKey, true);
    host.appendChild(backdrop);
    backdrop.querySelector('[data-act="ok"]').focus();
  });
}

/** Informational modal with a single dismiss button. */
export function infoDialog({ title, body, close = 'Got it' }) {
  return confirmDialog({ title, body, confirm: close, cancel: 'Close' });
}
