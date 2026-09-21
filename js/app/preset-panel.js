/**
 * The preset sidebar and the DTMF keypad it can open.
 *
 * Brief:
 *   Presets that can plausibly damage hearing or hardware carry a safety
 *   block. This is the interlock: the routine does not start until the
 *   viewer confirms, and the master level is capped for its duration.
 */

import { PRESETS, GROUPS, runPreset } from '../presets/presets.js';
import { paintUnipolarRange } from '../ui/channels.js';
import { showToast, requestConfirmation } from '../ui/feedback.js';
import { renderIconSvg } from '../ui/icons.js';
import { formatDb } from '../util/amplitude.js';
import { findElement } from './dom.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Icon size used on a preset button, in pixels. */
const PRESET_ICON_SIZE_PX_INT = 13;

/** Icon size used on the keypad's close button, in pixels. */
const CLOSE_ICON_SIZE_PX_INT = 13;

/** Keypad characters, in the order they are laid out. */
const KEYPAD_DIGITS_TUPLE = Object.freeze([
  '1', '2', '3', 'A',
  '4', '5', '6', 'B',
  '7', '8', '9', 'C',
  '*', '0', '#', 'D',
]);

/** Script run when a keypad button is pressed. */
const KEYPAD_TONE_MS_INT = 160;
const KEYPAD_GAIN_DB_FLOAT = -14;

/* ------------------------------------------------------------------------ */

/**
 * Cap the master level for a routine that asked for one.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   cap_db_float (number): The level to cap at, in dBFS.
 *
 * Returns:
 *   (none)
 */
function applyMasterCap(app_obj, cap_db_float) {
  if (!Number.isFinite(cap_db_float) ||
    app_obj.engine.masterLevelDb <= cap_db_float) {
    return;
  }

  app_obj.engine.masterLevelDb = cap_db_float;
  const gain_el = findElement('master-gain');
  gain_el.value = String(cap_db_float);
  findElement('master-db').textContent = `${formatDb(cap_db_float)} dB`;
  paintUnipolarRange(gain_el);
  app_obj.log(
    `Master capped at ${formatDb(cap_db_float)} dBFS for this routine.`,
    'warn'
  );
}

/**
 * Ask for consent to run a preset carrying a safety block.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   preset_obj (Object): The preset about to run.
 *
 * Returns:
 *   (Promise<boolean>): False when the viewer declined.
 */
async function clearSafetyInterlock(app_obj, preset_obj) {
  if (!preset_obj.safety) {
    return true;
  }

  const is_confirmed_bool = await requestConfirmation({
    title_str: preset_obj.safety.title,
    body_html_str: preset_obj.safety.body,
    confirm_label_str: preset_obj.safety.confirm,
    is_danger_bool: true,
  });
  if (!is_confirmed_bool) {
    return false;
  }

  applyMasterCap(app_obj, preset_obj.safety.capDb);
  return true;
}

/**
 * Run one preset, showing it as running until it finishes.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   preset_obj (Object): The preset to run.
 *   button_el (HTMLElement): The button that launched it.
 *
 * Returns:
 *   (Promise<void>)
 */
async function launchPreset(app_obj, preset_obj, button_el) {
  if (!await clearSafetyInterlock(app_obj, preset_obj)) {
    return;
  }

  const list_el = findElement('preset-list');
  for (const other_el of list_el.querySelectorAll('.preset')) {
    other_el.classList.remove('is-running');
  }
  button_el.classList.add('is-running');

  try {
    await runPreset(app_obj, preset_obj);
    app_obj.log(`Preset: ${preset_obj.name}`, 'ok');
  } catch (err) {
    showToast(`Preset failed: ${err.message}`, 'err');
    button_el.classList.remove('is-running');
  }

  app_obj.syncUi();
  app_obj.ui.header?.sync();

  const clearRunning = () => button_el.classList.remove('is-running');
  app_obj.vm.once('finish', clearRunning);
  app_obj.vm.once('stop', clearRunning);
}

/**
 * Build one preset button.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   preset_obj (Object): The preset to represent.
 *
 * Returns:
 *   (HTMLElement): The button.
 *
 * Warning:
 *   The name and description are assigned as text, not markup: they are
 *   author copy, but they are also the one place a preset definition could
 *   reach the DOM unescaped.
 */
function buildPresetButton(app_obj, preset_obj) {
  const button_el = document.createElement('button');
  button_el.className = `preset preset--${preset_obj.tone ?? 'cyan'}`;
  button_el.dataset.preset = preset_obj.id;
  button_el.innerHTML = `
    <span class="preset__glyph">${renderIconSvg(
    preset_obj.icon, { size_px_int: PRESET_ICON_SIZE_PX_INT }
  )}</span>
    <span class="preset__text">
      <span class="preset__name"></span>
      <span class="preset__desc"></span>
    </span>`;

  button_el.querySelector('.preset__name').textContent = preset_obj.name;
  button_el.querySelector('.preset__desc').textContent = preset_obj.desc;
  button_el.addEventListener(
    'click', () => launchPreset(app_obj, preset_obj, button_el)
  );
  return button_el;
}

/**
 * Open the DTMF keypad, if it is not already open.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function openKeypad(app_obj) {
  if (findElement('dtmf-pad-host')) {
    return;
  }

  const host_el = document.createElement('div');
  host_el.id = 'dtmf-pad-host';
  host_el.className = 'panel';
  host_el.style.cssText =
    'position:fixed;right:16px;bottom:52px;z-index:120;width:206px';
  host_el.innerHTML = `
    <div class="panel__head">
      <span class="panel__title">DTMF Keypad</span>
      <span class="panel__spacer"></span>
      <button class="iconbtn" data-close aria-label="Close">${
  renderIconSvg('x', { size_px_int: CLOSE_ICON_SIZE_PX_INT })
}</button>
    </div>
    <div class="panel__body panel__body--tight">
      <div class="dtmf-pad">
        ${KEYPAD_DIGITS_TUPLE
    .map((digit_str) => `<button data-digit="${digit_str}">` +
          `${digit_str}</button>`)
    .join('')}
      </div>
    </div>`;

  host_el.querySelector('[data-close]').addEventListener(
    'click', () => host_el.remove()
  );
  host_el.addEventListener('click', (click_event) => {
    const digit_str =
      click_event.target.closest('[data-digit]')?.dataset.digit;
    if (!digit_str) {
      return;
    }
    app_obj.runScript(
      `dtmf("${digit_str}", ${KEYPAD_TONE_MS_INT}ms, 0ms, ` +
      `${KEYPAD_GAIN_DB_FLOAT}db)`,
      { label_str: 'dtmf-key' }
    );
  });

  document.body.appendChild(host_el);
}

/**
 * Build the preset sidebar.
 *
 * Brief:
 *   One section per group, in the order GROUPS declares them, so the
 *   sidebar reads the same way the catalogue is written.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (Object): A controller exposing openKeypad().
 */
export function buildPresetPanel(app_obj) {
  const list_el = findElement('preset-list');
  const fragment_obj = document.createDocumentFragment();

  for (const group_obj of GROUPS) {
    const section_el = document.createElement('div');
    section_el.className = 'preset-group';

    const title_el = document.createElement('div');
    title_el.className = 'preset-group__title';
    title_el.textContent = group_obj.label;
    section_el.appendChild(title_el);

    const group_presets_list =
      PRESETS.filter((preset_obj) => preset_obj.group === group_obj.id);
    for (const preset_obj of group_presets_list) {
      section_el.appendChild(buildPresetButton(app_obj, preset_obj));
    }
    fragment_obj.appendChild(section_el);
  }
  list_el.appendChild(fragment_obj);

  findElement('preset-stop').addEventListener('click', () => {
    app_obj.vm.stop();
    app_obj.rack.stopAllChannels();
    app_obj.noise.stop();
    for (const button_el of list_el.querySelectorAll('.preset')) {
      button_el.classList.remove('is-running');
    }
    app_obj.ui.header?.sync();
  });

  return {
    /**
     * Open the DTMF keypad.
     *
     * Arguments:
     *   (none)
     *
     * Returns:
     *   (none)
     */
    openKeypad() {
      openKeypad(app_obj);
    },
  };
}
