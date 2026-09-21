/**
 * Boot sequence: build the models, then the interface, in that order.
 *
 * Brief:
 *   The engine must exist before anything that needs an AudioContext, and
 *   the sample rate is fixed for that context's lifetime, so the stored
 *   preference has to be read before the engine is constructed rather than
 *   applied to it afterwards.
 */

import { ChannelRack, CHANNEL_COUNT_INT } from '../core/channel-rack.js';
import { NoiseGenerator } from '../core/noise-generator.js';
import { RoomCalibrator } from '../core/room-calibrator.js';
import { ScriptVM } from '../script/vm.js';
import { ConcertMode } from '../sync/concert.js';
import { CalibrationPanel } from '../ui/calibration-panel.js';
import { ConcertPanel } from '../ui/concert-panel.js';
import { findElement } from './dom.js';
import { buildHeaderPanel } from './header-panel.js';
import { buildOscillatorPanel } from './oscillator-panel.js';
import { buildChannelPanel } from './channel-panel.js';
import { buildNoisePanel } from './noise-panel.js';
import { buildVisualiserPanel } from './visualiser-panel.js';
import { buildTerminalPanel } from './terminal-panel.js';
import { buildPresetPanel } from './preset-panel.js';
import { startFrameLoop } from './frame-loop.js';
import { bindShortcuts, bindRailToggle, showHelp } from './shortcuts.js';
import { restoreSession, bindSessionPersistence } from './session.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** localStorage key holding the requested sample rate. */
const RATE_STORAGE_KEY_STR = 'sonicforge.rate';

/** Colours pre-synthesised during idle time, so the first Start is instant. */
const WARM_COLOURS_TUPLE = Object.freeze(['pink', 'brown']);

/** Deadlines for the idle warm-up, in milliseconds. */
const WARM_IDLE_TIMEOUT_MS_INT = 4000;
const WARM_FALLBACK_MS_INT = 2500;

/** How long the unlock overlay takes to fade before removal, in ms. */
const UNLOCK_FADE_MS_INT = 500;

/* ------------------------------------------------------------------------ */

/**
 * Read the stored sample-rate preference.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (number|null): The requested rate, or null to accept the default.
 */
function readRequestedSampleRate() {
  try {
    return Number(localStorage.getItem(RATE_STORAGE_KEY_STR)) || null;
  } catch {
    return null;
  }
}

/**
 * Attach the models that need a live AudioContext.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function buildModels(app_obj) {
  app_obj.rack = new ChannelRack(app_obj.engine, CHANNEL_COUNT_INT);
  app_obj.noise = new NoiseGenerator(app_obj.engine);
  app_obj.vm = new ScriptVM(app_obj);
  app_obj.cal = new RoomCalibrator(app_obj.engine);
  app_obj.concert = new ConcertMode(app_obj);
}

/**
 * Build every panel and bind the global controls.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   Order matters. The terminal is built before anything that logs, the
 *   channel rack before anything that reads the selection, and the
 *   visualiser before the frame loop asks it which mode is active.
 */
function buildInterface(app_obj) {
  buildTerminalPanel(app_obj);
  buildChannelPanel(app_obj);
  app_obj.ui.header = buildHeaderPanel(app_obj);
  app_obj.ui.oscillator = buildOscillatorPanel(app_obj);
  app_obj.ui.noise_panel = buildNoisePanel(app_obj);
  app_obj.ui.visualiser = buildVisualiserPanel(app_obj);
  app_obj.ui.presets = buildPresetPanel(app_obj);

  app_obj.ui.calibration = new CalibrationPanel(app_obj.cal, app_obj);
  app_obj.ui.concert = new ConcertPanel(app_obj.concert, app_obj);

  bindShortcuts(app_obj);
  bindRailToggle();
  bindSessionPersistence(app_obj);
  findElement('btn-help').addEventListener('click', showHelp);
}

/**
 * Pre-synthesise the noise colours the focus presets use.
 *
 * Brief:
 *   During idle time, so the first Start is instant rather than a stall
 *   while a several-second buffer is generated.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function warmNoiseCache(app_obj) {
  const warmCache = () => {
    app_obj.noise.warmColourCache([...WARM_COLOURS_TUPLE]).catch(() => {
      // A cold cache only costs a stall on first use.
    });
  };

  if ('requestIdleCallback' in window) {
    requestIdleCallback(warmCache, { timeout: WARM_IDLE_TIMEOUT_MS_INT });
  } else {
    setTimeout(warmCache, WARM_FALLBACK_MS_INT);
  }
}

/**
 * Replace the unlock overlay with a message explaining a failure.
 *
 * Arguments:
 *   unlock_el (HTMLElement): The overlay.
 *   message_str (string): What went wrong.
 *
 * Returns:
 *   (none)
 */
function showBootFailure(unlock_el, message_str) {
  const title_el = document.createElement('h1');
  title_el.className = 'unlock__title';
  title_el.textContent = 'Audio unavailable';

  const detail_el = document.createElement('p');
  detail_el.className = 'unlock__sub';
  detail_el.textContent = message_str;

  const inner_el = document.createElement('div');
  inner_el.className = 'unlock__inner';
  inner_el.append(title_el, detail_el);

  unlock_el.replaceChildren(inner_el);
}

/**
 * Boot the application.
 *
 * Brief:
 *   Models first, then the interface, then the session, then the frame
 *   loop. Each stage depends on the one before it.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 *
 * Warning:
 *   Idempotent. The unlock overlay can fire more than once, and a second
 *   boot would build a second set of every panel.
 */
export async function bootApplication(app_obj) {
  if (app_obj.booted) {
    return;
  }
  app_obj.booted = true;

  const unlock_el = findElement('unlock');
  try {
    await app_obj.engine.init({ sampleRate: readRequestedSampleRate() });
  } catch (err) {
    showBootFailure(unlock_el, err.message);
    return;
  }

  buildModels(app_obj);

  findElement('app').hidden = false;
  unlock_el.classList.add('is-gone');
  setTimeout(() => unlock_el.remove(), UNLOCK_FADE_MS_INT);

  buildInterface(app_obj);
  restoreSession(app_obj);
  startFrameLoop(app_obj);

  app_obj.log(
    `Engine ready — ${app_obj.engine.sampleRateHertz} Hz, ` +
    `${app_obj.engine.latencyMs.toFixed(1)} ms latency.`,
    'ok'
  );
  warmNoiseCache(app_obj);
}

/**
 * Arm the gesture that boots the application.
 *
 * Brief:
 *   Every browser requires a user gesture before audio, so the overlay is
 *   both the explanation and the gesture target.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function armBootGesture(app_obj) {
  const unlock_el = findElement('unlock');
  const boot = () => bootApplication(app_obj);

  unlock_el.addEventListener('click', boot, { once: true });
  unlock_el.addEventListener('keydown', (keyboard_event) => {
    if (keyboard_event.key === 'Enter' || keyboard_event.key === ' ') {
      boot();
    }
  });
  app_obj.engine.armGestureUnlock();
}
