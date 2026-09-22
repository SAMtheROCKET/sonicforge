/**
 * The application facade every module receives.
 *
 * Brief:
 *   One object carrying the models and a small set of cross-cutting
 *   operations. Panels register themselves on `ui` and expose a sync()
 *   method; the facade fans out to whichever are present rather than
 *   importing each panel, which is what keeps the wiring acyclic.
 */

import { AudioEngine } from '../core/audio-engine.js';
import { TUNING_OBJ } from '../core/tuning.js';
import { showToast } from '../ui/feedback.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Panels asked to refresh, in the order a full sync applies them. */
const SYNCED_PANEL_KEYS_TUPLE = Object.freeze([
  'oscillator', 'noise_panel', 'header',
]);

/** How long a pressed keypad button stays lit, in milliseconds. */
const KEYPAD_FLASH_MS_INT = 110;

/* ------------------------------------------------------------------------ */

/**
 * Build the application facade.
 *
 * Brief:
 *   The engine is constructed here because everything else needs it to
 *   exist before it can be built; the remaining models are attached during
 *   boot, once the audio context's sample rate is known.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (Object): The facade, with its models still null.
 */
export function createApp() {
  const app_obj = {
    engine: new AudioEngine(),
    tuning: TUNING_OBJ,
    rack: null,
    noise: null,
    vm: null,
    cal: null,
    concert: null,
    ui: {},
    booted: false,
  };

  // Descriptors rather than a spread: spreading an object INVOKES its
  // getters and copies the resulting values, so `selectedChannel` would be
  // evaluated here, against an object that has no `ui` yet, and frozen as
  // whatever that returned.
  return Object.defineProperties(
    app_obj, Object.getOwnPropertyDescriptors(createFacadeOperations())
  );
}

/**
 * Build the facade's cross-cutting operations.
 *
 * Brief:
 *   Separated from the state so each half reads on its own. They are
 *   attached to the facade as property descriptors, so `this` inside them
 *   is the facade and the getter stays a getter.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (Object): The operations, unbound.
 */
function createFacadeOperations() {
  return {
    /**
     * Write a line to the terminal log.
     *
     * Arguments:
     *   text_str (string): Line to log.
     *   level_str (string): Terminal log level.
     *
     * Returns:
     *   (none)
     */
    log(text_str, level_str = 'dim') {
      this.ui.terminal?.appendLogLine(text_str, level_str);
    },

    /**
     * Run a script, reporting a compile error rather than throwing.
     *
     * Arguments:
     *   source_str (string): The script source.
     *   options_obj (Object): { label_str } naming the run.
     *
     * Returns:
     *   (none)
     */
    runScript(source_str, options_obj) {
      try {
        this.vm.run(source_str, options_obj);
      } catch (err) {
        this.log(err.format ? err.format() : err.message, 'err');
        showToast('Script error - see the terminal.', 'err');
      }
    },

    /** The channel the interface is currently pointed at. */
    get selectedChannel() {
      const index_int = this.ui.channels?.selected_index_int ?? 0;
      return this.rack?.getChannel(index_int) ?? null;
    },

    /**
     * Move the rack selection.
     *
     * Arguments:
     *   index_int (number): Channel index.
     *
     * Returns:
     *   (none)
     */
    selectChannel(index_int) {
      this.ui.channels?.selectChannel(index_int);
    },

    /**
     * Switch the visualiser.
     *
     * Arguments:
     *   mode_str (string): 'waterfall', 'interference' or 'gonio'.
     *
     * Returns:
     *   (none)
     */
    setVizMode(mode_str) {
      this.ui.visualiser?.setMode(mode_str);
    },

    /**
     * Open the DTMF keypad.
     *
     * Arguments:
     *   (none)
     *
     * Returns:
     *   (none)
     */
    openDtmf() {
      this.ui.presets?.openKeypad();
    },

    /**
     * Light a keypad button as its tone sounds.
     *
     * Arguments:
     *   digit_str (string): The keypad character.
     *
     * Returns:
     *   (none)
     */
    onDtmfDigit(digit_str) {
      const button_el = document.querySelector(
        `.dtmf-pad [data-digit="${digit_str}"]`
      );
      if (!button_el) {
        return;
      }
      button_el.classList.add('is-lit');
      setTimeout(
        () => button_el.classList.remove('is-lit'), KEYPAD_FLASH_MS_INT
      );
    },

    /**
     * Refresh every panel from the models.
     *
     * Arguments:
     *   (none)
     *
     * Returns:
     *   (none)
     */
    syncUi() {
      for (const panel_key_str of SYNCED_PANEL_KEYS_TUPLE) {
        this.ui[panel_key_str]?.sync();
      }
      this.ui.channels?.syncAll();
    },
  };
}
