/**
 * The visualiser panel: mode tabs, the two views, and the idle hint.
 *
 * Brief:
 *   Only one view runs at a time. Switching stops the other rather than
 *   hiding it, because a stopped view costs nothing and a hidden one still
 *   burns a frame budget on a canvas nobody can see.
 */

import { Waterfall } from '../viz/waterfall.js';
import { InterferenceView } from '../viz/interference.js';
import { findElement } from './dom.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** The modes, in the order the V shortcut cycles them. */
export const VIZ_MODES_TUPLE = Object.freeze([
  'waterfall', 'interference', 'gonio',
]);

/** Hint shown under each mode when nothing is sounding. */
const MODE_HINTS_DICT = Object.freeze({
  waterfall: 'Drag to orbit · scroll to zoom',
  gonio: 'Vertical = mono · horizontal = out of phase',
  interference:
    'Cyan = left sum · violet = right sum · red dots = nulls',
});

/* ------------------------------------------------------------------------ */

/**
 * Name the renderer behind a mode, for the badge.
 *
 * Arguments:
 *   mode_str (string): The active visualiser mode.
 *   render_mode_str (string): The waterfall's renderer, 'webgl' or not.
 *
 * Returns:
 *   (string): Badge text.
 */
function describeRenderer(mode_str, render_mode_str) {
  if (mode_str === 'waterfall') {
    return render_mode_str === 'webgl' ? 'WebGL2' : 'Canvas2D';
  }
  return mode_str === 'gonio' ? 'Goniometer' : 'Interference';
}

/**
 * Build the visualiser panel.
 *
 * Brief:
 *   Constructs both views up front. They are cheap while stopped, and
 *   building one lazily would put a GPU context creation in the middle of a
 *   mode switch.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (Object): A controller exposing setMode(), syncHint() and mode_str.
 *
 * Warning:
 *   Reports the active renderer to the log when WebGL2 is unavailable, so a
 *   viewer on the Canvas2D fallback knows why the surface looks different.
 */
export function buildVisualiserPanel(app_obj) {
  app_obj.ui.waterfall = new Waterfall(
    findElement('viz-waterfall'), app_obj.engine
  );
  app_obj.ui.interference = new InterferenceView(
    findElement('viz-interference'), app_obj.engine, app_obj.rack
  );

  if (app_obj.ui.waterfall.render_mode_str !== 'webgl') {
    app_obj.log(
      'WebGL2 is unavailable - the visualiser is running its Canvas2D ' +
      'fallback.',
      'warn'
    );
  }

  const controller_obj = createVisualiserController(app_obj);

  findElement('viz-tabs').addEventListener('click', (click_event) => {
    const mode_str = click_event.target.closest('[data-viz]')?.dataset.viz;
    if (mode_str) {
      controller_obj.setMode(mode_str);
    }
  });

  controller_obj.setMode(VIZ_MODES_TUPLE[0]);
  return controller_obj;
}

/**
 * Build the controller that owns the active mode.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (Object): The controller, before any mode has been applied.
 */
function createVisualiserController(app_obj) {
  return {
    mode_str: VIZ_MODES_TUPLE[0],

    /**
     * Show or hide the idle hint according to what is sounding.
     *
     * Brief:
     *   Driven by state changes rather than only by the frame loop, so the
     *   hint never lingers over a live waveform waiting for a slow tick.
     *
     * Arguments:
     *   (none)
     *
     * Returns:
     *   (none)
     */
    syncHint() {
      const hint_el = findElement('viz-empty');
      if (!hint_el) {
        return;
      }
      const is_silent_bool = app_obj.rack.activeChannelCount === 0 &&
        !app_obj.noise.is_running_bool;
      hint_el.style.opacity = is_silent_bool ? '1' : '0';
    },

    /**
     * Switch to one visualiser mode.
     *
     * Arguments:
     *   mode_str (string): A member of VIZ_MODES_TUPLE.
     *
     * Returns:
     *   (none)
     */
    setMode(mode_str) {
      this.mode_str = mode_str;
      const waterfall_obj = app_obj.ui.waterfall;
      const interference_obj = app_obj.ui.interference;
      const is_waterfall_bool = mode_str === 'waterfall';

      findElement('viz-waterfall').hidden = !is_waterfall_bool;
      findElement('viz-interference').hidden = is_waterfall_bool;

      if (is_waterfall_bool) {
        interference_obj.stop();
        waterfall_obj.start();
      } else {
        waterfall_obj.stop();
        interference_obj
          .setDisplayMode(mode_str === 'gonio' ? 'gonio' : 'both')
          .start();
      }

      for (const tab_el of
        findElement('viz-tabs').querySelectorAll('[data-viz]')) {
        tab_el.classList.toggle('is-active', tab_el.dataset.viz === mode_str);
      }

      findElement('viz-empty').textContent = MODE_HINTS_DICT[mode_str] ?? '';
      this.syncHint();
      findElement('viz-badge').textContent =
        describeRenderer(mode_str, waterfall_obj.render_mode_str);
    },

    /**
     * Advance to the next mode in the cycle.
     *
     * Arguments:
     *   (none)
     *
     * Returns:
     *   (none)
     */
    cycleMode() {
      const current_index_int = VIZ_MODES_TUPLE.indexOf(this.mode_str);
      const next_index_int =
        (current_index_int + 1) % VIZ_MODES_TUPLE.length;
      this.setMode(VIZ_MODES_TUPLE[next_index_int]);
    },
  };
}
