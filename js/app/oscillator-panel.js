/**
 * The oscillator panel: waveform, dial, frequency entry and channel trim.
 *
 * Brief:
 *   Everything here acts on whichever channel is selected. The dial owns the
 *   value while it is being dragged and pushes changes out; every other
 *   control writes to the channel and then asks this panel to re-read it.
 */

import { TUNING_OBJ } from '../core/tuning.js';
import {
  WAVEFORMS_DICT,
  WAVEFORM_KEYS_LIST,
} from '../core/waveforms.js';
import { FrequencyDial } from '../ui/dial.js';
import { paintUnipolarRange, paintBipolarRange } from '../ui/channels.js';
import { showToast } from '../ui/feedback.js';
import { formatDb } from '../util/amplitude.js';
import { clampToRange } from '../util/numeric.js';
import { findElement } from './dom.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Lowest frequency the numeric field accepts, in hertz. */
const MIN_FREQUENCY_HERTZ_FLOAT = 0.05;

/** Band edges of human hearing, in hertz. */
const AUDIBLE_LOW_HERTZ_FLOAT = 20;
const AUDIBLE_HIGH_HERTZ_FLOAT = 20000;

/** How long an invalid entry stays highlighted, in milliseconds. */
const INVALID_FLASH_MS_INT = 700;

/** Pan positions closer to centre than this read as centred. */
const CENTRE_PAN_EPSILON_FLOAT = 0.005;

/** Cent deviation past which the readout is marked sharp or flat. */
const CENTS_TOLERANCE_INT = 3;

/** Interval a newly added tone sits above the selected one. */
const ADDED_TONE_RATIO_FLOAT = 1.5;

/** Level a newly added tone starts at, in dBFS. */
const ADDED_TONE_GAIN_DB_FLOAT = -18;

/** Copy explaining why an inaudible band may produce no sound. */
const INFRASONIC_HINT_STR =
  'Below the hearing threshold. Most speakers cannot reproduce this at ' +
  'all — use am() to deliver the envelope on an audible carrier.';
const ULTRASONIC_HINT_STR =
  'Above the hearing threshold. Needs a piezo tweeter; ordinary drivers ' +
  'roll off by ~22 kHz.';

/* ------------------------------------------------------------------------ */

/**
 * Describe a pan position the way a mixer would.
 *
 * Arguments:
 *   pan_position_float (number): -1 hard left to +1 hard right.
 *
 * Returns:
 *   (string): 'C', or a side letter and a percentage.
 */
function formatPanPosition(pan_position_float) {
  if (Math.abs(pan_position_float) < CENTRE_PAN_EPSILON_FLOAT) {
    return 'C';
  }
  const percent_int = Math.round(Math.abs(pan_position_float) * 100);
  return `${pan_position_float < 0 ? 'L' : 'R'}${percent_int}`;
}

/**
 * Format a frequency for the numeric field.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to format.
 *
 * Returns:
 *   (string): Decimal places chosen to suit the magnitude.
 */
function formatFrequencyField(frequency_hertz_float) {
  if (frequency_hertz_float >= 1000) {
    return frequency_hertz_float.toFixed(1);
  }
  if (frequency_hertz_float >= 100) {
    return frequency_hertz_float.toFixed(2);
  }
  return frequency_hertz_float.toFixed(3);
}

/**
 * Name the band a frequency falls outside of, if any.
 *
 * Brief:
 *   Said plainly, because "I hear nothing" is otherwise read as a broken
 *   application rather than as physics.
 *
 * Arguments:
 *   frequency_hertz_float (number): The channel's frequency.
 *
 * Returns:
 *   (string|null): 'infrasonic', 'ultrasonic', or null when audible.
 */
function describeBand(frequency_hertz_float) {
  if (frequency_hertz_float < AUDIBLE_LOW_HERTZ_FLOAT) {
    return 'infrasonic';
  }
  if (frequency_hertz_float > AUDIBLE_HIGH_HERTZ_FLOAT) {
    return 'ultrasonic';
  }
  return null;
}

/**
 * Parse the frequency field, accepting a note name or a kilohertz suffix.
 *
 * Arguments:
 *   raw_value_str (string): The field contents.
 *
 * Returns:
 *   (number): Frequency in hertz, or NaN when unparseable.
 */
function parseFrequencyField(raw_value_str) {
  const cleaned_str = raw_value_str.trim().toLowerCase();

  // A note name is faster to type than a number: "A4" beats 440.
  const note_hertz_float =
    TUNING_OBJ.resolveNoteNameToHertz(cleaned_str.toUpperCase());
  if (Number.isFinite(note_hertz_float)) {
    return note_hertz_float;
  }
  if (/k$/.test(cleaned_str)) {
    return parseFloat(cleaned_str) * 1000;
  }
  return parseFloat(cleaned_str);
}

/* ------------------------------------------------------------------------ */

/**
 * Build the oscillator panel.
 *
 * Brief:
 *   The controller is created first because every binding below needs to
 *   call back into sync() once it has written to the channel.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (Object): A controller exposing sync().
 */
export function buildOscillatorPanel(app_obj) {
  const controller_obj = {
    /**
     * Re-read every control from the selected channel.
     *
     * Arguments:
     *   (none)
     *
     * Returns:
     *   (none)
     */
    sync() {
      syncPanel(app_obj);
    },
  };

  bindWaveformSelector(app_obj, controller_obj);
  bindDial(app_obj, controller_obj);
  bindFrequencyField(app_obj, controller_obj);
  bindTransposeControls(app_obj, controller_obj);
  bindChannelTrim(app_obj);

  return controller_obj;
}

/**
 * Wire the waveform segmented control.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   controller_obj (Object): This panel's controller.
 *
 * Returns:
 *   (none)
 */
function bindWaveformSelector(app_obj, controller_obj) {
  const segment_el = findElement('wave-seg');

  segment_el.innerHTML = WAVEFORM_KEYS_LIST
    .map((key_str) => {
      const spec_obj = WAVEFORMS_DICT[key_str];
      return `<button data-wave="${key_str}" ` +
        `title="${spec_obj.hint_str}">` +
        `${spec_obj.glyph_str} ${spec_obj.label_str}</button>`;
    })
    .join('');

  segment_el.addEventListener('click', (click_event) => {
    const waveform_name_str =
      click_event.target.closest('[data-wave]')?.dataset.wave;
    if (!waveform_name_str) {
      return;
    }
    app_obj.selectedChannel?.setWaveformName(waveform_name_str);
    controller_obj.sync();
  });
}

/**
 * Construct the frequency dial and route its changes.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   controller_obj (Object): This panel's controller.
 *
 * Returns:
 *   (none)
 */
function bindDial(app_obj, controller_obj) {
  app_obj.ui.dial = new FrequencyDial(findElement('dial'), {
    tuning_obj: TUNING_OBJ,
    max_hertz_float: app_obj.engine.maxFrequencyHertz,
    on_change_fn: (frequency_hertz_float) => {
      app_obj.selectedChannel?.setFrequencyHertz(frequency_hertz_float);
      controller_obj.sync();
    },
  });
}

/**
 * Wire the numeric frequency field.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   controller_obj (Object): This panel's controller.
 *
 * Returns:
 *   (none)
 */
function bindFrequencyField(app_obj, controller_obj) {
  const field_el = findElement('freq-input');

  const commitFrequency = () => {
    const frequency_hertz_float = parseFrequencyField(field_el.value);

    if (!Number.isFinite(frequency_hertz_float) ||
      frequency_hertz_float <= 0) {
      field_el.classList.add('is-invalid');
      setTimeout(
        () => field_el.classList.remove('is-invalid'), INVALID_FLASH_MS_INT
      );
      controller_obj.sync();
      return;
    }

    const channel_obj = app_obj.selectedChannel;
    channel_obj?.setFrequencyHertz(clampToRange(
      frequency_hertz_float,
      MIN_FREQUENCY_HERTZ_FLOAT,
      app_obj.engine.maxFrequencyHertz
    ));
    controller_obj.sync();
  };

  field_el.addEventListener('keydown', (keyboard_event) => {
    if (keyboard_event.key === 'Enter') {
      commitFrequency();
      field_el.blur();
    } else if (keyboard_event.key === 'Escape') {
      controller_obj.sync();
      field_el.blur();
    }
  });
  field_el.addEventListener('blur', commitFrequency);
  field_el.addEventListener('focus', () => field_el.select());
}

/**
 * Wire the transpose, snap and add-tone buttons.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   controller_obj (Object): This panel's controller.
 *
 * Returns:
 *   (none)
 */
function bindTransposeControls(app_obj, controller_obj) {
  for (const button_el of document.querySelectorAll('[data-freq-step]')) {
    button_el.addEventListener('click', () => {
      const channel_obj = app_obj.selectedChannel;
      if (!channel_obj) {
        return;
      }
      channel_obj.setFrequencyHertz(TUNING_OBJ.transposeBySemitones(
        channel_obj.frequency_hertz_float,
        Number(button_el.dataset.freqStep)
      ));
      controller_obj.sync();
    });
  }

  findElement('btn-snap').addEventListener('click', () => {
    const channel_obj = app_obj.selectedChannel;
    if (!channel_obj) {
      return;
    }
    channel_obj.setFrequencyHertz(
      TUNING_OBJ.snapToNearestSemitone(channel_obj.frequency_hertz_float)
    );
    controller_obj.sync();
  });

  findElement('btn-add-tone').addEventListener('click', () => {
    const free_channel_obj = app_obj.rack.findFirstIdleChannel();
    if (!free_channel_obj) {
      showToast('All 16 channels are already running.', 'warn');
      return;
    }

    const source_channel_obj = app_obj.selectedChannel;
    free_channel_obj.setWaveformName(
      source_channel_obj?.waveform_name_str ?? 'sine'
    );
    // A perfect fifth above whatever is selected.
    free_channel_obj.setFrequencyHertz(source_channel_obj
      ? source_channel_obj.frequency_hertz_float * ADDED_TONE_RATIO_FLOAT
      : 440);
    free_channel_obj.setGainDb(ADDED_TONE_GAIN_DB_FLOAT);
    free_channel_obj.start();

    app_obj.ui.channels.selectChannel(free_channel_obj.index_int);
    app_obj.ui.header?.sync();
  });
}

/**
 * Wire the per-channel level, pan and phase sliders.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function bindChannelTrim(app_obj) {
  const gain_el = findElement('ch-gain');
  gain_el.addEventListener('input', () => {
    app_obj.selectedChannel?.setGainDb(Number(gain_el.value));
    findElement('ch-gain-val').textContent = formatDb(Number(gain_el.value));
    paintUnipolarRange(gain_el);
  });

  const pan_el = findElement('ch-pan');
  pan_el.addEventListener('input', () => {
    const pan_position_float = Number(pan_el.value);
    app_obj.selectedChannel?.setPanPosition(pan_position_float);
    findElement('ch-pan-val').textContent =
      formatPanPosition(pan_position_float);
    paintBipolarRange(pan_el);
  });
  pan_el.addEventListener('dblclick', () => {
    pan_el.value = '0';
    pan_el.dispatchEvent(new Event('input'));
  });

  const phase_el = findElement('ch-phase');
  phase_el.addEventListener('input', () => {
    const phase_degrees_int = Number(phase_el.value);
    app_obj.selectedChannel?.setPhaseDegrees(phase_degrees_int);
    findElement('ch-phase-val').textContent = `${phase_degrees_int}°`;
    paintUnipolarRange(phase_el);
  });
}

/**
 * Update the dial readout: note name, cent deviation and band.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   channel_obj (ToneChannel): The selected channel.
 *
 * Returns:
 *   (none)
 */
function syncDialReadout(app_obj, channel_obj) {
  const described_obj =
    TUNING_OBJ.describeFrequency(channel_obj.frequency_hertz_float);
  const cents_int = Math.round(described_obj.cents_float);

  findElement('dial-note').textContent = described_obj.label_str;
  const cents_el = findElement('dial-cents');
  cents_el.textContent = `${cents_int > 0 ? '+' : ''}${cents_int} ¢`;
  let cents_class_str = '';
  if (cents_int > CENTS_TOLERANCE_INT) {
    cents_class_str = 'is-sharp';
  } else if (cents_int < -CENTS_TOLERANCE_INT) {
    cents_class_str = 'is-flat';
  }
  cents_el.className = `dial__cents ${cents_class_str}`;

  const number_str = String(channel_obj.index_int + 1).padStart(2, '0');
  findElement('dial-ch').textContent = `CH ${number_str}`;

  const band_str = describeBand(channel_obj.frequency_hertz_float);
  const target_el = findElement('osc-target');
  target_el.textContent =
    `Channel ${number_str}${band_str ? ` · ${band_str}` : ''}`;
  target_el.className = `badge ${band_str ? 'badge--violet' : 'badge--cyan'}`;
  if (band_str === 'infrasonic') {
    target_el.title = INFRASONIC_HINT_STR;
  } else if (band_str === 'ultrasonic') {
    target_el.title = ULTRASONIC_HINT_STR;
  } else {
    target_el.title = '';
  }
}

/**
 * Update the level, pan and phase sliders from the channel.
 *
 * Arguments:
 *   channel_obj (ToneChannel): The selected channel.
 *
 * Returns:
 *   (none)
 */
function syncChannelTrim(channel_obj) {
  const gain_el = findElement('ch-gain');
  gain_el.value = String(channel_obj.gain_db_float);
  findElement('ch-gain-val').textContent =
    formatDb(channel_obj.gain_db_float);
  paintUnipolarRange(gain_el);

  const pan_el = findElement('ch-pan');
  pan_el.value = String(channel_obj.pan_position_float);
  findElement('ch-pan-val').textContent =
    formatPanPosition(channel_obj.pan_position_float);
  paintBipolarRange(pan_el);

  const phase_el = findElement('ch-phase');
  phase_el.value = String(channel_obj.phase_degrees_int);
  findElement('ch-phase-val').textContent =
    `${channel_obj.phase_degrees_int}°`;
  paintUnipolarRange(phase_el);
}

/**
 * Re-read the whole panel from the selected channel.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function syncPanel(app_obj) {
  const channel_obj = app_obj.selectedChannel;
  if (!channel_obj) {
    return;
  }

  findElement('freq-input').value =
    formatFrequencyField(channel_obj.frequency_hertz_float);
  syncDialReadout(app_obj, channel_obj);

  for (const button_el of
    findElement('wave-seg').querySelectorAll('[data-wave]')) {
    button_el.classList.toggle(
      'is-active', button_el.dataset.wave === channel_obj.waveform_name_str
    );
  }

  syncChannelTrim(channel_obj);
  app_obj.ui.dial?.setFrequencyHertz(
    channel_obj.frequency_hertz_float, { is_silent_bool: true }
  );
}
