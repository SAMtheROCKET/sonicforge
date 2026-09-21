/**
 * The noise generator panel.
 *
 * Brief:
 *   Two colour slots crossfaded by one ratio, a shaping filter, a level and
 *   a vocal-band emphasis. The two slots are addressed by the model's own
 *   names rather than the interface's A and B labels, because a slot name
 *   the model does not recognise is rejected.
 */

import { SHAPE_FILTER_LABELS_DICT } from '../core/noise-generator.js';
import {
  NOISE_COLOURS_DICT,
  NOISE_COLOUR_KEYS_LIST,
} from '../dsp/noise-colours.js';
import { paintUnipolarRange } from '../ui/channels.js';
import { showToast } from '../ui/feedback.js';
import { formatDb } from '../util/amplitude.js';
import { findElement } from './dom.js';
import { persistSoon } from './session.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Blend ratio above which the mix is worth describing in the hint. */
const AUDIBLE_BLEND_FLOAT = 0.01;

/** Shaping filter frequency used when the field cannot be parsed. */
const FALLBACK_SHAPE_HERTZ_FLOAT = 1000;

/* ------------------------------------------------------------------------ */

/**
 * Describe the current colour, slope and mix in one line.
 *
 * Arguments:
 *   noise_obj (NoiseGenerator): The generator to describe.
 *
 * Returns:
 *   (string): Hint text for the panel.
 */
function describeNoise(noise_obj) {
  const spec_obj = NOISE_COLOURS_DICT[noise_obj.primary_colour_str];

  const slope_str = spec_obj.slope_db_per_octave_float === null
    ? 'shaped spectrum'
    : `${spec_obj.slope_db_per_octave_float > 0 ? '+' : ''}` +
      `${spec_obj.slope_db_per_octave_float} dB/octave`;

  let mix_str = '';
  if (noise_obj.blend_ratio_float > AUDIBLE_BLEND_FLOAT) {
    const primary_percent_int =
      Math.round((1 - noise_obj.blend_ratio_float) * 100);
    const secondary_percent_int =
      Math.round(noise_obj.blend_ratio_float * 100);
    const secondary_label_str =
      NOISE_COLOURS_DICT[noise_obj.secondary_colour_str].label_str;
    mix_str = ` · blended ${primary_percent_int}/${secondary_percent_int}` +
      ` with ${secondary_label_str}`;
  }

  return `${spec_obj.hint_str} (${slope_str})${mix_str}`;
}

/**
 * Wire the two colour selectors.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   controller_obj (Object): This panel's controller.
 *
 * Returns:
 *   (none)
 */
function bindColourSelectors(app_obj, controller_obj) {
  const primary_el = findElement('noise-a');
  primary_el.innerHTML = NOISE_COLOUR_KEYS_LIST
    .map((key_str) =>
      `<button data-color="${key_str}" ` +
      `title="${NOISE_COLOURS_DICT[key_str].hint_str}">` +
      `${NOISE_COLOURS_DICT[key_str].label_str}</button>`)
    .join('');

  primary_el.addEventListener('click', async (click_event) => {
    const colour_str =
      click_event.target.closest('[data-color]')?.dataset.color;
    if (!colour_str) {
      return;
    }
    await app_obj.noise.setColour(colour_str, 'primary');
    controller_obj.sync();
  });

  const secondary_el = findElement('noise-b');
  secondary_el.innerHTML = NOISE_COLOUR_KEYS_LIST
    .map((key_str) =>
      `<option value="${key_str}">` +
      `${NOISE_COLOURS_DICT[key_str].label_str}</option>`)
    .join('');

  secondary_el.addEventListener('change', async () => {
    await app_obj.noise.setColour(secondary_el.value, 'secondary');
    controller_obj.sync();
  });
}

/**
 * Wire the shaping filter controls.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   controller_obj (Object): This panel's controller.
 *
 * Returns:
 *   (none)
 */
function bindShapeControls(app_obj, controller_obj) {
  const shape_el = findElement('noise-shape');
  shape_el.innerHTML = Object.entries(SHAPE_FILTER_LABELS_DICT)
    .map(([key_str, label_str]) =>
      `<option value="${key_str}">${label_str}</option>`)
    .join('');

  shape_el.addEventListener('change', () => {
    app_obj.noise.setShapeFilter({ type: shape_el.value });
    controller_obj.sync();
  });

  findElement('noise-freq').addEventListener('change', (change_event) => {
    app_obj.noise.setShapeFilter({
      freq: parseFloat(change_event.target.value) ||
        FALLBACK_SHAPE_HERTZ_FLOAT,
    });
    controller_obj.sync();
  });
}

/**
 * Wire the blend, level and shield sliders.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   controller_obj (Object): This panel's controller.
 *
 * Returns:
 *   (none)
 */
function bindLevelControls(app_obj, controller_obj) {
  const blend_el = findElement('noise-blend');
  blend_el.addEventListener('input', async () => {
    await app_obj.noise.setBlendRatio(Number(blend_el.value));
    paintUnipolarRange(blend_el);
    controller_obj.sync();
  });

  const gain_el = findElement('noise-gain');
  gain_el.addEventListener('input', () => {
    app_obj.noise.setGainDb(Number(gain_el.value));
    findElement('noise-gain-val').textContent =
      formatDb(Number(gain_el.value), 0);
    paintUnipolarRange(gain_el);
  });

  const shield_el = findElement('noise-shield');
  shield_el.addEventListener('input', () => {
    app_obj.noise.setShieldDb(Number(shield_el.value));
    findElement('noise-shield-val').textContent =
      Number(shield_el.value).toFixed(1);
    paintUnipolarRange(shield_el);
  });
}

/**
 * Wire the start and stop button.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   controller_obj (Object): This panel's controller.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   Starting may have to synthesise a buffer, which takes long enough to
 *   need a spinner. The button is disabled meanwhile so a second press
 *   cannot start a second synthesis.
 */
function bindToggle(app_obj, controller_obj) {
  const toggle_el = findElement('noise-toggle');

  toggle_el.addEventListener('click', async () => {
    toggle_el.disabled = true;
    toggle_el.innerHTML = '<span class="spinner"></span>';
    try {
      await app_obj.noise.toggle();
    } catch (err) {
      showToast(`Noise failed: ${err.message}`, 'err');
    } finally {
      toggle_el.disabled = false;
      controller_obj.sync();
      app_obj.ui.header?.sync();
    }
  });
}

/**
 * Re-read every control from the generator.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function syncPanel(app_obj) {
  const noise_obj = app_obj.noise;

  for (const button_el of
    findElement('noise-a').querySelectorAll('[data-color]')) {
    button_el.classList.toggle(
      'is-active', button_el.dataset.color === noise_obj.primary_colour_str
    );
  }
  findElement('noise-b').value = noise_obj.secondary_colour_str;

  const blend_el = findElement('noise-blend');
  blend_el.value = String(noise_obj.blend_ratio_float);
  paintUnipolarRange(blend_el);

  const gain_el = findElement('noise-gain');
  gain_el.value = String(noise_obj.gain_db_float);
  findElement('noise-gain-val').textContent =
    formatDb(noise_obj.gain_db_float, 0);
  paintUnipolarRange(gain_el);

  const shield_el = findElement('noise-shield');
  shield_el.value = String(noise_obj.shield_db_float);
  findElement('noise-shield-val').textContent =
    noise_obj.shield_db_float.toFixed(1);
  paintUnipolarRange(shield_el);

  findElement('noise-shape').value = noise_obj.shape_type_str;
  findElement('noise-freq').value =
    String(Math.round(noise_obj.shape_frequency_hertz_float));
  findElement('noise-freq').disabled = noise_obj.shape_type_str === 'off';

  const state_el = findElement('noise-state');
  state_el.textContent = noise_obj.is_running_bool ? 'running' : 'idle';
  state_el.className =
    `badge ${noise_obj.is_running_bool ? 'badge--lime' : ''}`;
  findElement('noise-toggle').textContent =
    noise_obj.is_running_bool ? 'Stop' : 'Start';

  findElement('noise-hint').textContent = describeNoise(noise_obj);
}

/**
 * Build the noise panel.
 *
 * Brief:
 *   Syncs once at the end of construction, so the controls show the
 *   generator's real state rather than the markup's defaults.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (Object): A controller exposing sync().
 */
export function buildNoisePanel(app_obj) {
  const controller_obj = {
    /**
     * Re-read every control from the generator.
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

  bindColourSelectors(app_obj, controller_obj);
  bindShapeControls(app_obj, controller_obj);
  bindLevelControls(app_obj, controller_obj);
  bindToggle(app_obj, controller_obj);

  app_obj.noise.on('change', () => {
    controller_obj.sync();
    persistSoon(app_obj);
  });
  app_obj.noise.on('building', (colour_str) =>
    app_obj.log(
      `Synthesising ${NOISE_COLOURS_DICT[colour_str].label_str} ` +
      'noise buffer…',
      'dim'
    )
  );

  controller_obj.sync();
  return controller_obj;
}
