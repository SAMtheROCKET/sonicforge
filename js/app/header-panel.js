/**
 * The header: transport, master level, concert pitch and sample rate.
 *
 * Brief:
 *   Everything that applies to the whole instrument rather than to one
 *   channel. The sample-rate control is the odd one out: an AudioContext's
 *   rate is fixed for its lifetime, so changing it means reloading, and the
 *   control exists mainly to explain that.
 */

import { SAMPLE_RATE_OPTIONS_LIST } from '../core/audio-engine.js';
import { CHANNEL_COUNT_INT } from '../core/channel-rack.js';
import { TUNING_OBJ, PITCH_STANDARDS_LIST } from '../core/tuning.js';
import { paintUnipolarRange } from '../ui/channels.js';
import { showToast, requestConfirmation } from '../ui/feedback.js';
import { formatDb } from '../util/amplitude.js';
import { findElement } from './dom.js';
import { persist } from './session.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** localStorage key holding the requested sample rate. */
const RATE_STORAGE_KEY_STR = 'sonicforge.rate';

/** Concert-pitch bounds the A4 field accepts, in hertz. */
const MIN_REFERENCE_HERTZ_FLOAT = 380;
const MAX_REFERENCE_HERTZ_FLOAT = 500;

/** How close a value must be to a standard to count as that standard. */
const STANDARD_MATCH_HERTZ_FLOAT = 0.05;

/** Cent deviation below which the A4 badge stays neutral. */
const NEUTRAL_CENTS_FLOAT = 0.1;

/** How long an invalid entry stays highlighted, in milliseconds. */
const INVALID_FLASH_MS_INT = 700;

/** Sample rate above which the Nyquist badge is highlighted, in hertz. */
const HIGH_NYQUIST_HERTZ_FLOAT = 24000;

/** Rate at or above which the ultrasonic caveat is worth stating. */
const ULTRASONIC_RATE_HERTZ_INT = 96000;

/** Delay before the master level is restored after a panic, in ms. */
const PANIC_RECOVER_MS_INT = 120;

/* ------------------------------------------------------------------------ */

/**
 * Silence everything immediately.
 *
 * Brief:
 *   Separate from the transport button because it must work from anywhere,
 *   including from inside a text field, and must not depend on the header
 *   having been built.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function panic(app_obj) {
  app_obj.vm.stop();
  app_obj.rack.stopAllChannels();
  app_obj.noise.stop();
  app_obj.engine.panic();

  // Restore the master gain a beat later so the app is usable again.
  setTimeout(() => {
    app_obj.engine.masterLevelDb = app_obj.engine.masterLevelDb;
  }, PANIC_RECOVER_MS_INT);

  app_obj.ui.header?.sync();
  showToast('Panic - everything silenced.', 'warn', 2200);
  app_obj.log('PANIC: all sources stopped.', 'warn');
}

/**
 * Report the Nyquist ceiling of the running context.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function updateNyquistBadge(app_obj) {
  const badge_el = findElement('nyquist-badge');
  const nyquist_hertz_float = app_obj.engine.nyquistHertz;

  badge_el.textContent = `${(nyquist_hertz_float / 1000).toFixed(1)} kHz`;
  badge_el.title = 'Nyquist limit - the highest frequency this context ' +
    `can represent is ${nyquist_hertz_float.toFixed(0)} Hz`;
  badge_el.className = `badge ${
    nyquist_hertz_float > HIGH_NYQUIST_HERTZ_FLOAT ? 'badge--violet' : ''
  }`;
}

/**
 * Wire the play and panic controls.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function bindTransport(app_obj) {
  findElement('master-play').addEventListener('click', () => {
    const is_live_bool = app_obj.rack.activeChannelCount > 0 ||
      app_obj.noise.is_running_bool || app_obj.vm.is_running_bool;

    if (is_live_bool) {
      app_obj.rack.stopAllChannels();
      app_obj.noise.stop();
      app_obj.vm.stop();
    } else {
      // Nothing is running: start whatever is selected, or the first
      // channel if the rack is entirely idle.
      const channel_obj =
        app_obj.selectedChannel ?? app_obj.rack.getChannel(0);
      channel_obj.start();
    }
    app_obj.ui.header?.sync();
  });

  findElement('panic').addEventListener('click', () => panic(app_obj));
}

/**
 * Wire the master level slider and the limiter switch.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function bindMasterLevel(app_obj) {
  const gain_el = findElement('master-gain');

  gain_el.addEventListener('input', () => {
    app_obj.engine.masterLevelDb = Number(gain_el.value);
    findElement('master-db').textContent =
      `${formatDb(app_obj.engine.masterLevelDb)} dB`;
    paintUnipolarRange(gain_el);
  });
  gain_el.value = String(app_obj.engine.masterLevelDb);
  paintUnipolarRange(gain_el);

  app_obj.engine.on('warn', (message_str) =>
    showToast(message_str, 'warn', 6000)
  );

  findElement('limiter').addEventListener('change', (change_event) => {
    app_obj.engine.isLimiterEnabled = change_event.target.checked;
    if (!change_event.target.checked) {
      showToast(
        'Limiter bypassed - the output path is now provably linear, and ' +
        'clipping is possible.',
        'warn',
        6000
      );
    }
  });
}

/**
 * Reflect a concert-pitch change in the header controls.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   reference_hertz_float (number): The new A4 reference.
 *
 * Returns:
 *   (none)
 */
function showReferencePitch(app_obj, reference_hertz_float) {
  const hertz_el = findElement('a4-hz');
  const select_el = findElement('a4-preset');

  hertz_el.value =
    reference_hertz_float.toFixed(2).replace(/\.00$/, '');
  const match_obj = PITCH_STANDARDS_LIST.find(
    (standard_obj) =>
      Math.abs(standard_obj.hertz_float - reference_hertz_float) <
      STANDARD_MATCH_HERTZ_FLOAT
  );
  select_el.value = match_obj ? String(match_obj.hertz_float) : 'custom';

  const cents_float = TUNING_OBJ.centsFromIsoReference;
  const sign_str = cents_float >= 0 ? '+' : '';
  const badge_el = findElement('a4-cents');
  badge_el.textContent = `${sign_str}${cents_float.toFixed(1)} ¢`;
  badge_el.className = `badge ${
    Math.abs(cents_float) < NEUTRAL_CENTS_FLOAT ? '' : 'badge--violet'
  }`;

  app_obj.ui.oscillator?.sync();
  app_obj.log(
    `Concert pitch → A4 = ${reference_hertz_float} Hz ` +
    `(${sign_str}${cents_float.toFixed(1)} cents from ISO).`,
    'ok'
  );
}

/**
 * Wire the concert-pitch selector and its numeric field.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function bindConcertPitch(app_obj) {
  const select_el = findElement('a4-preset');
  const hertz_el = findElement('a4-hz');

  select_el.innerHTML = PITCH_STANDARDS_LIST
    .map((standard_obj) =>
      `<option value="${standard_obj.hertz_float}">` +
      `${standard_obj.label_str} Hz - ${standard_obj.note_str}</option>`)
    .join('') + '<option value="custom">Custom…</option>';
  select_el.value = '440';

  select_el.addEventListener('change', () => {
    if (select_el.value === 'custom') {
      hertz_el.focus();
      hertz_el.select();
      return;
    }
    TUNING_OBJ.referenceHertz = Number(select_el.value);
  });

  const commitReference = () => {
    const value_float = parseFloat(hertz_el.value);
    const is_valid_bool = Number.isFinite(value_float) &&
      value_float >= MIN_REFERENCE_HERTZ_FLOAT &&
      value_float <= MAX_REFERENCE_HERTZ_FLOAT;

    if (!is_valid_bool) {
      hertz_el.classList.add('is-invalid');
      setTimeout(
        () => hertz_el.classList.remove('is-invalid'), INVALID_FLASH_MS_INT
      );
      hertz_el.value =
        TUNING_OBJ.referenceHertz.toFixed(2).replace(/\.00$/, '');
      return;
    }
    TUNING_OBJ.referenceHertz = value_float;
  };

  hertz_el.addEventListener('keydown', (keyboard_event) => {
    if (keyboard_event.key === 'Enter') {
      commitReference();
      hertz_el.blur();
    }
  });
  hertz_el.addEventListener('blur', commitReference);

  TUNING_OBJ.on(
    'change', (reference_hertz_float) =>
      showReferencePitch(app_obj, reference_hertz_float)
  );
}

/**
 * Describe what changing the sample rate will do.
 *
 * Arguments:
 *   wanted_rate_int (number): The requested sample rate, in hertz.
 *
 * Returns:
 *   (string): Body copy for the confirmation dialog.
 */
function describeRateChange(wanted_rate_int) {
  const kilohertz_str = (wanted_rate_int / 1000).toFixed(1);
  const ceiling_str = (wanted_rate_int / 2000).toFixed(1);
  const caveat_str = wanted_rate_int >= ULTRASONIC_RATE_HERTZ_INT
    ? '<br><br>Note that most speakers produce nothing above ~22 kHz ' +
      'regardless of sample rate - ultrasonic output needs a piezo tweeter.'
    : '';

  return 'An AudioContext’s sample rate is fixed once it is created, so ' +
    `SonicForge has to reload to change it.<br><br>At ${kilohertz_str} kHz ` +
    `the highest synthesisable frequency becomes <b>${ceiling_str} kHz</b>. ` +
    'Your channels and calibration curve are preserved.' + caveat_str;
}

/**
 * Wire the sample-rate selector.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   Changing the rate reloads the page. The session is persisted first, so
 *   the reload restores rather than discards.
 */
function bindSampleRate(app_obj) {
  const select_el = findElement('sample-rate');
  const actual_rate_int = app_obj.engine.sampleRateHertz;
  const is_known_bool = SAMPLE_RATE_OPTIONS_LIST.some(
    (option_obj) => option_obj.rate_hertz_int === actual_rate_int
  );

  select_el.innerHTML = SAMPLE_RATE_OPTIONS_LIST
    .map((option_obj) =>
      `<option value="${option_obj.rate_hertz_int}" ` +
      `title="${option_obj.note_str}">${option_obj.label_str}</option>`)
    .join('') + (is_known_bool
    ? ''
    : `<option value="${actual_rate_int}">` +
      `${(actual_rate_int / 1000).toFixed(1)} kHz</option>`);
  select_el.value = String(actual_rate_int);
  updateNyquistBadge(app_obj);

  select_el.addEventListener('change', async () => {
    const wanted_rate_int = Number(select_el.value);
    if (wanted_rate_int === app_obj.engine.sampleRateHertz) {
      return;
    }

    const is_confirmed_bool = await requestConfirmation({
      title_str: `Switch to ${(wanted_rate_int / 1000).toFixed(1)} kHz?`,
      body_html_str: describeRateChange(wanted_rate_int),
      confirm_label_str: 'Reload',
    });
    if (!is_confirmed_bool) {
      select_el.value = String(app_obj.engine.sampleRateHertz);
      return;
    }

    persist(app_obj);
    try {
      localStorage.setItem(RATE_STORAGE_KEY_STR, String(wanted_rate_int));
    } catch {
      // Storage unavailable; the reload will simply keep the current rate.
    }
    location.reload();
  });
}

/**
 * Build the header panel.
 *
 * Brief:
 *   Four independent groups - transport, master level, concert pitch and
 *   sample rate - wired separately so each reads on its own.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (Object): A controller exposing sync().
 */
export function buildHeaderPanel(app_obj) {
  bindTransport(app_obj);
  bindMasterLevel(app_obj);
  bindConcertPitch(app_obj);
  bindSampleRate(app_obj);

  return {
    /**
     * Refresh the transport state and the live-channel count.
     *
     * Arguments:
     *   (none)
     *
     * Returns:
     *   (none)
     */
    sync() {
      const is_live_bool = app_obj.rack.activeChannelCount > 0 ||
        app_obj.noise.is_running_bool || app_obj.vm.is_running_bool;

      app_obj.ui.visualiser?.syncHint();

      const play_el = findElement('master-play');
      play_el.classList.toggle('is-playing', is_live_bool);
      play_el.setAttribute('aria-pressed', String(is_live_bool));
      findElement('master-play-label').textContent =
        is_live_bool ? 'Stop' : 'Play';
      findElement('chan-count').textContent =
        `${app_obj.rack.activeChannelCount} / ${CHANNEL_COUNT_INT} live`;
    },
  };
}
