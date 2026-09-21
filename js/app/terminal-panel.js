/**
 * The scripting terminal panel.
 *
 * Brief:
 *   The terminal itself owns the log, the history and the tracker. This
 *   wires its toolbar and relays the VM's lifecycle to the header, so the
 *   transport button reflects a script running as well as a channel.
 */

import { Terminal } from '../ui/terminal.js';
import { findElement } from './dom.js';

/* ------------------------------------------------------------------------ */

/**
 * Build the terminal panel.
 *
 * Brief:
 *   Built early in the boot order, because it owns the log every other
 *   panel writes to.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function buildTerminalPanel(app_obj) {
  app_obj.ui.terminal = new Terminal(
    document.querySelector('[data-term="root"]'), app_obj.vm
  );

  findElement('term-clear').addEventListener(
    'click', () => app_obj.ui.terminal.clearLog()
  );

  findElement('term-stop').addEventListener('click', () => {
    app_obj.vm.stop();
    app_obj.ui.header?.sync();
  });

  findElement('term-multiline').addEventListener('click', (click_event) => {
    const is_multiline_bool = !app_obj.ui.terminal.is_multiline_bool;
    app_obj.ui.terminal.setMultilineMode(is_multiline_bool);
    click_event.target.classList.toggle('is-active', is_multiline_bool);
  });

  const syncHeader = () => app_obj.ui.header?.sync();
  app_obj.vm.on('start', syncHeader);
  app_obj.vm.on('finish', syncHeader);
  app_obj.vm.on('stop', syncHeader);
}
