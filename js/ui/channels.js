/**
 * The 16-channel rack interface.
 *
 * Brief:
 *   One row per channel, built once and then mutated in place. Rebuilding
 *   rows on every state change would destroy focus mid-typing and make the
 *   numeric fields unusable. Every control writes straight to the channel
 *   model; the model's change event writes back to any control the viewer
 *   is not currently editing.
 */

import {
  WAVEFORMS_DICT,
  WAVEFORM_KEYS_LIST,
} from '../core/waveforms.js';
import { SILENCE_THRESHOLD_DB_FLOAT } from '../util/amplitude.js';
import { clampToRange } from '../util/numeric.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Column headings, in display order. */
const HEADER_LABELS_TUPLE = Object.freeze([
  '#', 'ON', 'WAVE', 'FREQUENCY', 'NOTE', 'LEVEL', 'PAN', 'Ø', 'M S',
]);

/** Lowest frequency a row will accept, in hertz. */
const MIN_FREQUENCY_HERTZ_FLOAT = 0.05;

/** Highest level a row will accept, in dBFS. */
const MAX_GAIN_DB_FLOAT = 0;

/** How long an invalid entry stays highlighted, in milliseconds. */
const INVALID_FLASH_MS_INT = 700;

/** Arrow-key step multipliers for the fine and coarse modifiers. */
const ARROW_FINE_STEP_FLOAT = 0.1;
const ARROW_COARSE_STEP_FLOAT = 10;

/** Bottom of the per-channel meter scale, in dBFS. */
const METER_FLOOR_DB_FLOAT = -60;

/** Spellings accepted as "silent" in a level field. */
const SILENCE_INPUT_WORDS_TUPLE = Object.freeze([
  '-inf', '-∞', 'off', 'mute',
]);

/** Matches "1k5" and "1.5k" style shorthand in a frequency field. */
const KILO_SHORTHAND_REGEX = /^([-+]?\d*\.?\d*)k(\d*)$/;

/** Trailing unit letters stripped before parsing, such as "12 dB". */
const TRAILING_UNIT_REGEX = /[a-z°%]+$/i;

/* ------------------------------------------------------------------------ */

/**
 * Parse a numeric field, accepting the shorthands the interface documents.
 *
 * Brief:
 *   Accepts "440", "1.5k", "1k2", "-inf" and "12 dB". Returning null rather
 *   than NaN lets the caller distinguish "nothing usable was typed" from a
 *   legitimate zero.
 *
 * Arguments:
 *   raw_value_str (string): Raw field contents.
 *
 * Returns:
 *   (number|null): The parsed value, or null when unparseable.
 */
function parseNumericInput(raw_value_str) {
  const cleaned_str = String(raw_value_str)
    .trim().toLowerCase().replace(/\s+/g, '');
  if (!cleaned_str) {
    return null;
  }
  if (SILENCE_INPUT_WORDS_TUPLE.includes(cleaned_str)) {
    return SILENCE_THRESHOLD_DB_FLOAT;
  }

  const kilo_match_obj = KILO_SHORTHAND_REGEX.exec(cleaned_str);
  if (kilo_match_obj) {
    const whole_float = Number(kilo_match_obj[1] || 0);
    const fraction_float = kilo_match_obj[2]
      ? Number(`0.${kilo_match_obj[2]}`)
      : 0;
    const value_float = (whole_float + fraction_float) * 1000;
    return Number.isFinite(value_float) ? value_float : null;
  }

  const value_float = parseFloat(
    cleaned_str.replace(TRAILING_UNIT_REGEX, '')
  );
  return Number.isFinite(value_float) ? value_float : null;
}

/**
 * Format a frequency for a row's text field.
 *
 * Brief:
 *   Decimal places shrink as the value grows, so the field shows meaningful
 *   precision at 0.05 Hz without printing five noise digits at 20 kHz.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to format.
 *
 * Returns:
 *   (string): The formatted value, with no trailing zeros below 100 Hz.
 */
function formatFrequencyInput(frequency_hertz_float) {
  if (frequency_hertz_float >= 10000) {
    return frequency_hertz_float.toFixed(0);
  }
  if (frequency_hertz_float >= 1000) {
    return frequency_hertz_float.toFixed(1);
  }
  if (frequency_hertz_float >= 100) {
    return frequency_hertz_float.toFixed(2);
  }
  return frequency_hertz_float.toFixed(3)
    .replace(/0+$/, '').replace(/\.$/, '');
}

/**
 * Format a level for a row's text field.
 *
 * Arguments:
 *   gain_db_float (number): Level in dBFS.
 *
 * Returns:
 *   (string): One decimal place, or '-inf' at or below the silence floor.
 */
function formatGainInput(gain_db_float) {
  return gain_db_float <= SILENCE_THRESHOLD_DB_FLOAT
    ? '-inf'
    : gain_db_float.toFixed(1);
}

/**
 * Paint the centre-anchored fill on a bipolar range input.
 *
 * Brief:
 *   Native range inputs cannot show a fill that grows outward from the
 *   centre, so the track is drawn from two custom properties the stylesheet
 *   reads.
 *
 * Arguments:
 *   range_el (HTMLInputElement): A range input spanning a signed interval.
 *
 * Returns:
 *   (none)
 */
export function paintBipolarRange(range_el) {
  const min_float = Number(range_el.min);
  const max_float = Number(range_el.max);
  const value_float = Number(range_el.value);
  const centre_percent_float =
    ((0 - min_float) / (max_float - min_float)) * 100;
  const value_percent_float =
    ((value_float - min_float) / (max_float - min_float)) * 100;
  range_el.style.setProperty(
    '--lo', `${Math.min(centre_percent_float, value_percent_float)}%`
  );
  range_el.style.setProperty(
    '--hi', `${Math.max(centre_percent_float, value_percent_float)}%`
  );
}

/**
 * Paint the left-anchored fill on a unipolar range input.
 *
 * Brief:
 *   The counterpart to the bipolar painter, for tracks that fill from the
 *   left edge rather than from the centre.
 *
 * Arguments:
 *   range_el (HTMLInputElement): A range input spanning one direction.
 *
 * Returns:
 *   (none)
 */
export function paintUnipolarRange(range_el) {
  const min_float = Number(range_el.min);
  const max_float = Number(range_el.max);
  const value_float = Number(range_el.value);
  const fill_percent_float =
    ((value_float - min_float) / (max_float - min_float)) * 100;
  range_el.style.setProperty('--fill', `${fill_percent_float}%`);
}

/**
 * Build the inner markup for one channel row.
 *
 * Arguments:
 *   channel_index_int (number): Zero-based channel index.
 *   wave_options_html_str (string): Pre-rendered <option> list.
 *
 * Returns:
 *   (string): Row markup.
 *
 * Warning:
 *   Only the index and the pre-rendered option list are interpolated, and
 *   both are generated here rather than supplied by the viewer.
 */
function buildRowMarkup(channel_index_int, wave_options_html_str) {
  const display_number_str = String(channel_index_int + 1);
  const padded_number_str = display_number_str.padStart(2, '0');

  return `
    <button class="chan__idx" data-role="idx"
            title="Select channel ${display_number_str}"
      >${padded_number_str}</button>
    <button class="chan__power" data-role="power"
            aria-label="Enable channel ${display_number_str}"></button>
    <select class="input input--xs" data-role="wave"
            aria-label="Waveform">${wave_options_html_str}</select>
    <input class="input input--xs mono" data-role="freq" type="text"
           inputmode="decimal" aria-label="Frequency in hertz">
    <span class="mono" data-role="note"
          style="font-size:10px;color:var(--ink-low);text-align:center"></span>
    <input class="input input--xs mono" data-role="gain" type="text"
           inputmode="decimal" aria-label="Level in dBFS">
    <input class="range range--bipolar" data-role="pan" type="range"
           min="-1" max="1" step="0.01" aria-label="Pan">
    <input class="input input--xs mono" data-role="phase" type="text"
           inputmode="numeric" aria-label="Phase in degrees">
    <span class="chan__flags">
      <button class="flag" data-flag="m" title="Mute">M</button>
      <button class="flag" data-flag="s" title="Solo">S</button>
    </span>
    <span class="chan__meter"
          style="position:absolute;left:8px;right:8px;bottom:0"><i></i></span>
  `;
}

/**
 * Collect the element references for one built row.
 *
 * Arguments:
 *   row_el (HTMLElement): The row container.
 *
 * Returns:
 *   (Object): Named references to every control in the row.
 */
function collectRowRefs(row_el) {
  const findByRole = (role_str) =>
    row_el.querySelector(`[data-role="${role_str}"]`);

  return {
    row_el,
    index_button_el: findByRole('idx'),
    power_button_el: findByRole('power'),
    wave_select_el: findByRole('wave'),
    frequency_input_el: findByRole('freq'),
    note_el: findByRole('note'),
    gain_input_el: findByRole('gain'),
    pan_input_el: findByRole('pan'),
    phase_input_el: findByRole('phase'),
    mute_button_el: row_el.querySelector('[data-flag="m"]'),
    solo_button_el: row_el.querySelector('[data-flag="s"]'),
    meter_el: row_el.querySelector('.chan__meter i'),
  };
}

/* ------------------------------------------------------------------------ */

/**
 * Interface for the sixteen-channel rack.
 *
 * Brief:
 *   Owns the row elements and keeps them in step with the model, in both
 *   directions: controls write to the channel, and the channel's change
 *   event writes back to every control that does not currently have focus.
 *
 * Arguments:
 *   container_el (HTMLElement): Element the rows are appended to.
 *   rack_obj (ChannelRack): The channel model.
 *   tuning_obj (Tuning): Concert-pitch reference for the note column.
 *   hooks_obj (Object): { on_select_fn } called when the selection moves.
 *
 * Returns:
 *   (ChannelRackUI): The constructed interface.
 */
export class ChannelRackUI {
  selected_index_int = 0;

  #row_refs_map = new Map();

  constructor(container_el, rack_obj, tuning_obj, hooks_obj = {}) {
    this.container_el = container_el;
    this.rack_obj = rack_obj;
    this.tuning_obj = tuning_obj;
    this.hooks_obj = hooks_obj;

    this.#buildRows();

    for (const channel_obj of rack_obj.channels_list) {
      channel_obj.on('change', () => this.sync(channel_obj.index_int));
    }
    tuning_obj.on('change', () => this.syncAll());
  }

  /* =================================================================== */

  /**
   * Build the header and every channel row, then select the first.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #buildRows() {
    const fragment_obj = document.createDocumentFragment();

    const header_el = document.createElement('div');
    header_el.className = 'chan-head';
    header_el.innerHTML = HEADER_LABELS_TUPLE
      .map((label_str) => `<span>${label_str}</span>`)
      .join('');
    fragment_obj.appendChild(header_el);

    const wave_options_html_str = WAVEFORM_KEYS_LIST
      .map((key_str) =>
        `<option value="${key_str}">${WAVEFORMS_DICT[key_str].label_str}` +
        '</option>')
      .join('');

    for (const channel_obj of this.rack_obj.channels_list) {
      const row_el = document.createElement('div');
      row_el.className = 'chan';
      row_el.dataset.index = String(channel_obj.index_int);
      row_el.style.position = 'relative';
      row_el.innerHTML = buildRowMarkup(
        channel_obj.index_int, wave_options_html_str
      );

      const refs_obj = collectRowRefs(row_el);
      this.#row_refs_map.set(channel_obj.index_int, refs_obj);
      this.#wireRow(channel_obj, refs_obj);
      fragment_obj.appendChild(row_el);
    }

    this.container_el.appendChild(fragment_obj);
    this.syncAll();
    this.selectChannel(0);
  }

  /**
   * Wire one numeric text field to its model setter.
   *
   * Brief:
   *   Fields commit on Enter or blur, never on every keystroke. Typing
   *   "1200" must not briefly play 1 Hz, then 12 Hz, then 120 Hz.
   *
   * Arguments:
   *   input_el (HTMLInputElement): The field to wire.
   *   apply_fn (Function): Receives the parsed number.
   *   format_fn (Function): Rewrites the field from the model.
   *   select_fn (Function): Moves the rack selection to this row.
   *
   * Returns:
   *   (none)
   */
  #wireNumericInput(input_el, apply_fn, format_fn, select_fn) {
    const commitValue = () => {
      const parsed_float = parseNumericInput(input_el.value.trim());
      if (parsed_float === null) {
        input_el.classList.add('is-invalid');
        setTimeout(
          () => input_el.classList.remove('is-invalid'), INVALID_FLASH_MS_INT
        );
        format_fn();
        return;
      }
      apply_fn(parsed_float);
      format_fn();
    };

    const nudgeValue = (keyboard_event) => {
      const direction_int = keyboard_event.key === 'ArrowUp' ? 1 : -1;
      let step_float = 1;
      if (keyboard_event.shiftKey) {
        step_float = ARROW_FINE_STEP_FLOAT;
      } else if (keyboard_event.altKey) {
        step_float = ARROW_COARSE_STEP_FLOAT;
      }
      const current_float = parseNumericInput(input_el.value) ?? 0;
      apply_fn(current_float + direction_int * step_float);
      format_fn();
    };

    input_el.addEventListener('keydown', (keyboard_event) => {
      if (keyboard_event.key === 'Enter') {
        commitValue();
        input_el.blur();
      } else if (keyboard_event.key === 'Escape') {
        format_fn();
        input_el.blur();
      } else if (keyboard_event.key === 'ArrowUp' ||
        keyboard_event.key === 'ArrowDown') {
        keyboard_event.preventDefault();
        nudgeValue(keyboard_event);
      }
    });
    input_el.addEventListener('blur', commitValue);
    input_el.addEventListener('focus', () => {
      select_fn();
      input_el.select();
    });
  }

  /**
   * Wire the three numeric fields of one row.
   *
   * Arguments:
   *   channel_obj (ToneChannel): The channel this row drives.
   *   refs_obj (Object): The row's element references.
   *   select_fn (Function): Moves the rack selection to this row.
   *
   * Returns:
   *   (none)
   */
  #wireRowNumbers(channel_obj, refs_obj, select_fn) {
    // The real ceiling is Nyquist, which moves when the sample rate does.
    const max_hertz_float = this.rack_obj.engine_obj.maxFrequencyHertz;

    this.#wireNumericInput(
      refs_obj.frequency_input_el,
      (value_float) => channel_obj.setFrequencyHertz(
        clampToRange(value_float, MIN_FREQUENCY_HERTZ_FLOAT, max_hertz_float)
      ),
      () => {
        refs_obj.frequency_input_el.value =
          formatFrequencyInput(channel_obj.frequency_hertz_float);
      },
      select_fn
    );

    this.#wireNumericInput(
      refs_obj.gain_input_el,
      (value_float) => channel_obj.setGainDb(
        clampToRange(
          value_float, SILENCE_THRESHOLD_DB_FLOAT, MAX_GAIN_DB_FLOAT
        )
      ),
      () => {
        refs_obj.gain_input_el.value =
          formatGainInput(channel_obj.gain_db_float);
      },
      select_fn
    );

    this.#wireNumericInput(
      refs_obj.phase_input_el,
      (value_float) => channel_obj.setPhaseDegrees(value_float),
      () => {
        refs_obj.phase_input_el.value = String(channel_obj.phase_degrees_int);
      },
      select_fn
    );
  }

  /**
   * Wire every control in one row to the channel it drives.
   *
   * Arguments:
   *   channel_obj (ToneChannel): The channel this row drives.
   *   refs_obj (Object): The row's element references.
   *
   * Returns:
   *   (none)
   */
  #wireRow(channel_obj, refs_obj) {
    const selectThisRow = () => this.selectChannel(channel_obj.index_int);

    refs_obj.row_el.addEventListener('pointerdown', (pointer_event) => {
      // Clicking anywhere on the row focuses it, but must not steal the
      // click from the control the viewer actually aimed at.
      if (pointer_event.target.closest('input, select, button')) {
        return;
      }
      selectThisRow();
    });

    refs_obj.index_button_el.addEventListener('click', selectThisRow);

    refs_obj.power_button_el.addEventListener('click', () => {
      channel_obj.toggle();
      selectThisRow();
    });

    refs_obj.wave_select_el.addEventListener('change', () =>
      channel_obj.setWaveformName(refs_obj.wave_select_el.value)
    );

    this.#wireRowNumbers(channel_obj, refs_obj, selectThisRow);

    refs_obj.pan_input_el.addEventListener('input', () => {
      channel_obj.setPanPosition(Number(refs_obj.pan_input_el.value));
      paintBipolarRange(refs_obj.pan_input_el);
    });
    refs_obj.pan_input_el.addEventListener('pointerdown', selectThisRow);
    refs_obj.pan_input_el.addEventListener('dblclick', () => {
      channel_obj.setPanPosition(0);
      this.sync(channel_obj.index_int);
    });

    refs_obj.mute_button_el.addEventListener('click', () =>
      channel_obj.setMuted(!channel_obj.is_muted_bool)
    );
    refs_obj.solo_button_el.addEventListener('click', () =>
      channel_obj.setSoloed(!channel_obj.is_soloed_bool)
    );
  }

  /* =================================================================== */

  /**
   * Move the rack selection to one channel.
   *
   * Arguments:
   *   index_int (number): Channel index, clamped into range.
   *
   * Returns:
   *   (ChannelRackUI): This instance, for chaining.
   */
  selectChannel(index_int) {
    this.selected_index_int = clampToRange(
      index_int, 0, this.rack_obj.channels_list.length - 1
    );
    for (const [row_index_int, refs_obj] of this.#row_refs_map) {
      refs_obj.row_el.classList.toggle(
        'is-selected', row_index_int === this.selected_index_int
      );
    }
    this.hooks_obj.on_select_fn?.(this.selected_index_int);
    return this;
  }

  /** The currently selected channel model. */
  get selectedChannel() {
    return this.rack_obj.getChannel(this.selected_index_int);
  }

  /**
   * Rewrite every row from its channel.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  syncAll() {
    for (const channel_obj of this.rack_obj.channels_list) {
      this.sync(channel_obj.index_int);
    }
  }

  /**
   * Apply the enabled, muted and soloed classes to one row.
   *
   * Arguments:
   *   channel_obj (ToneChannel): The channel this row shows.
   *   refs_obj (Object): The row's element references.
   *
   * Returns:
   *   (none)
   */
  #syncRowState(channel_obj, refs_obj) {
    const is_silenced_bool =
      channel_obj.is_muted_bool || channel_obj.is_silenced_by_solo_bool;
    const is_live_bool = channel_obj.is_enabled_bool && !is_silenced_bool;

    refs_obj.row_el.classList.toggle('is-on', channel_obj.is_enabled_bool);
    refs_obj.row_el.classList.toggle('is-live', is_live_bool);
    refs_obj.row_el.classList.toggle('is-muted', is_silenced_bool);
    refs_obj.mute_button_el.classList.toggle(
      'is-on', channel_obj.is_muted_bool
    );
    refs_obj.solo_button_el.classList.toggle(
      'is-on', channel_obj.is_soloed_bool
    );
  }

  /**
   * Rewrite the controls of one row, skipping whichever has focus.
   *
   * Brief:
   *   Writing to a focused field would move the caret and discard a
   *   half-typed value, so the field the viewer is editing is left alone.
   *
   * Arguments:
   *   channel_obj (ToneChannel): The channel this row shows.
   *   refs_obj (Object): The row's element references.
   *
   * Returns:
   *   (none)
   */
  #syncRowControls(channel_obj, refs_obj) {
    const active_el = document.activeElement;

    if (active_el !== refs_obj.wave_select_el) {
      refs_obj.wave_select_el.value = channel_obj.waveform_name_str;
    }
    if (active_el !== refs_obj.frequency_input_el) {
      refs_obj.frequency_input_el.value =
        formatFrequencyInput(channel_obj.frequency_hertz_float);
    }
    if (active_el !== refs_obj.gain_input_el) {
      refs_obj.gain_input_el.value =
        formatGainInput(channel_obj.gain_db_float);
    }
    if (active_el !== refs_obj.phase_input_el) {
      refs_obj.phase_input_el.value = String(channel_obj.phase_degrees_int);
    }
    if (active_el !== refs_obj.pan_input_el) {
      refs_obj.pan_input_el.value = String(channel_obj.pan_position_float);
      paintBipolarRange(refs_obj.pan_input_el);
    }
  }

  /**
   * Rewrite the note column of one row.
   *
   * Arguments:
   *   channel_obj (ToneChannel): The channel this row shows.
   *   refs_obj (Object): The row's element references.
   *
   * Returns:
   *   (none)
   */
  #syncRowNote(channel_obj, refs_obj) {
    const described_obj =
      this.tuning_obj.describeFrequency(channel_obj.frequency_hertz_float);
    const is_pitched_bool = Number.isFinite(described_obj.midi_number_int);

    if (!is_pitched_bool) {
      refs_obj.note_el.textContent = '--';
      refs_obj.note_el.title = '';
      return;
    }

    const cents_int = Math.round(described_obj.cents_float);
    let cents_str = '';
    if (cents_int > 0) {
      cents_str = `+${cents_int}`;
    } else if (cents_int < 0) {
      cents_str = String(cents_int);
    }

    refs_obj.note_el.textContent = `${described_obj.label_str}${cents_str}`;
    refs_obj.note_el.title =
      `${described_obj.label_str} ` +
      `(${described_obj.exact_hertz_float.toFixed(2)} Hz ` +
      `at A4=${this.tuning_obj.referenceHertz})`;
  }

  /**
   * Rewrite one row from its channel.
   *
   * Arguments:
   *   index_int (number): Channel index.
   *
   * Returns:
   *   (none)
   */
  sync(index_int) {
    const channel_obj = this.rack_obj.getChannel(index_int);
    const refs_obj = this.#row_refs_map.get(index_int);
    if (!channel_obj || !refs_obj) {
      return;
    }

    this.#syncRowState(channel_obj, refs_obj);
    this.#syncRowControls(channel_obj, refs_obj);
    this.#syncRowNote(channel_obj, refs_obj);
  }

  /**
   * Drive the per-channel level meters.
   *
   * Brief:
   *   Called once per animation frame, so it does no allocation and reads
   *   each channel's cached peak rather than re-analysing.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  updateMeters() {
    for (const [index_int, refs_obj] of this.#row_refs_map) {
      const channel_obj = this.rack_obj.getChannel(index_int);
      const peak_db_float = channel_obj.is_enabled_bool
        ? channel_obj.readPeakLevelDb()
        : -Infinity;
      const filled_ratio_float = Number.isFinite(peak_db_float)
        ? clampToRange(
          (peak_db_float - METER_FLOOR_DB_FLOAT) / -METER_FLOOR_DB_FLOAT, 0, 1
        )
        : 0;
      refs_obj.meter_el.style.right = `${(1 - filled_ratio_float) * 100}%`;
    }
  }
}
