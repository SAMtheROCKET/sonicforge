/**
 * The channel rack panel and its bulk controls.
 *
 * Brief:
 *   Thin: the rack interface owns the rows. This wires the all-on, all-off
 *   and reset buttons, and connects the model's change event to the header
 *   and to session persistence.
 */

import { TUNING_OBJ } from '../core/tuning.js';
import { ChannelRackUI } from '../ui/channels.js';
import { requestConfirmation } from '../ui/feedback.js';
import { findElement } from './dom.js';
import { persistSoon } from './session.js';

/* ------------------------------------------------------------------------ */

/**
 * Build the channel rack panel.
 *
 * Brief:
 *   The rows belong to the rack interface; this adds the bulk controls
 *   and connects the model's change event to the rest of the shell.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   Registers the rack interface on app.ui.channels, which the facade and
 *   several panels read. It must be built before anything that syncs.
 */
export function buildChannelPanel(app_obj) {
  app_obj.ui.channels = new ChannelRackUI(
    findElement('chan-list'),
    app_obj.rack,
    TUNING_OBJ,
    { on_select_fn: () => app_obj.ui.oscillator?.sync() }
  );

  app_obj.rack.on('change', (channel_obj) => {
    app_obj.ui.header?.sync();
    // A change can come from a row field, a script or a preset, not only
    // from the oscillator panel itself. Without this the big readout kept
    // showing a frequency the selected channel had already left.
    if (!channel_obj || channel_obj === app_obj.selectedChannel) {
      app_obj.ui.oscillator?.sync({ is_typing_kept_bool: true });
    }
    persistSoon(app_obj);
  });

  findElement('chan-all-on').addEventListener('click', () => {
    app_obj.rack.startAllChannels();
    app_obj.ui.header?.sync();
  });

  findElement('chan-all-off').addEventListener('click', () => {
    app_obj.rack.stopAllChannels();
    app_obj.ui.header?.sync();
  });

  findElement('chan-reset').addEventListener('click', async () => {
    const is_confirmed_bool = await requestConfirmation({
      title_str: 'Reset all channels?',
      body_html_str: 'Every channel returns to 440 Hz, sine, −18 dBFS, ' +
        'centred, 0°. This cannot be undone.',
      confirm_label_str: 'Reset',
      is_danger_bool: true,
    });
    if (!is_confirmed_bool) {
      return;
    }

    app_obj.rack.resetAllChannels();
    app_obj.ui.channels.syncAll();
    app_obj.ui.oscillator?.sync();
    app_obj.ui.header?.sync();
  });
}
