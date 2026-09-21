/**
 * The scripting terminal.
 *
 * Brief:
 *   A command palette with a rolling log, history, inline signature hints
 *   and a live execution tracker. The tracker is the part that earns its
 *   place: because the VM schedules ahead of real time, it can say exactly
 *   which block is sounding right now and how many milliseconds remain in
 *   it, which a setTimeout-chained sequencer fundamentally cannot report.
 */

import { COMMANDS, COMMAND_NAMES } from '../script/commands.js';
import { VM_STATE } from '../script/vm.js';
import { formatDuration } from '../util/frequency.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Log lines kept before the oldest are discarded. */
const MAX_LOG_LINES_INT = 400;

/** localStorage key holding the command history. */
const HISTORY_STORAGE_KEY_STR = 'sonicforge.history';

/** Entries held in memory, and the smaller number persisted. */
const MAX_HISTORY_ENTRIES_INT = 100;
const PERSISTED_HISTORY_ENTRIES_INT = 60;

/** Entries listed by the `history` built-in. */
const LISTED_HISTORY_ENTRIES_INT = 20;

/** Distance from the bottom, in pixels, that still counts as "at the end". */
const AUTOSCROLL_THRESHOLD_PX_INT = 48;

/** Rows given to the multi-line script pad. */
const MULTILINE_ROW_COUNT_INT = 6;

/** Matches the command name at the head of a line. */
const COMMAND_HEAD_REGEX = /^\s*([a-z_][\w]*)\s*\(?/i;

/** Matches a partial command name at the caret for completion. */
const COMMAND_TAIL_REGEX = /([a-z_][\w]*)$/i;

/** Matches a bare call with empty parentheses, such as `help()`. */
const EMPTY_CALL_REGEX = /\(\s*\)\s*$/;

/** Built-in words handled here rather than sent to the VM. */
const CLEAR_WORDS_TUPLE = Object.freeze(['clear', 'cls']);

/* ------------------------------------------------------------------------ */

/**
 * Format the current wall-clock time for a log line.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (string): Zero-padded HH:MM:SS.
 */
function formatLogTimestamp() {
  const now_date = new Date();
  const pad = (value_int) => String(value_int).padStart(2, '0');
  return `${pad(now_date.getHours())}:${pad(now_date.getMinutes())}:` +
    `${pad(now_date.getSeconds())}`;
}

/**
 * Find the longest prefix shared by every candidate.
 *
 * Brief:
 *   Used so a second Tab still makes progress when several commands share a
 *   prefix, rather than doing nothing until the name is unambiguous.
 *
 * Arguments:
 *   candidates_list (Array<string>): Matching command names.
 *
 * Returns:
 *   (string): The longest common prefix.
 */
function findLongestCommonPrefix(candidates_list) {
  let prefix_str = candidates_list[0];
  for (const candidate_str of candidates_list) {
    while (!candidate_str.startsWith(prefix_str)) {
      prefix_str = prefix_str.slice(0, -1);
    }
  }
  return prefix_str;
}

/* ------------------------------------------------------------------------ */

/**
 * Scripting terminal with history, completion and an execution tracker.
 *
 * Brief:
 *   Owns the log, the input field and the tracker readout. Scripts go to
 *   the VM; only the three built-ins that act on the terminal itself are
 *   handled here.
 *
 * Arguments:
 *   root_el (HTMLElement): The .term container.
 *   vm_obj (ScriptVM): The virtual machine to submit scripts to.
 *
 * Returns:
 *   (Terminal): The constructed terminal.
 */
export class Terminal {
  #history_list = [];
  #history_index_int = -1;
  #draft_str = '';
  #is_multiline_bool = false;

  constructor(root_el, vm_obj) {
    this.root_el = root_el;
    this.vm_obj = vm_obj;

    // Selectors are spelled out rather than built from a variable, so
    // check_wiring.py can still prove every one of them exists in the
    // markup. A template literal here would silently defeat that check.
    this.log_el = root_el.querySelector('[data-term="log"]');
    this.input_el = root_el.querySelector('[data-term="input"]');
    this.ghost_el = root_el.querySelector('[data-term="ghost"]');
    this.tracker_el = root_el.querySelector('[data-term="tracker"]');
    this.program_counter_el = root_el.querySelector('[data-term="pc"]');
    this.progress_bar_el = root_el.querySelector('[data-term="bar"]');
    this.countdown_el = root_el.querySelector('[data-term="count"]');

    this.#loadHistory();
    this.#bindInput();
    this.#bindVm();
    this.showBanner();
  }

  /* ===================================================================
     Logging
     =================================================================== */

  /**
   * Append one line to the rolling log.
   *
   * Brief:
   *   Autoscrolls only when the viewer is already at the bottom, because
   *   yanking the view down mid-read makes a long run impossible to follow.
   *
   * Arguments:
   *   text_str (string): Line body; inserted as text, never as markup.
   *   level_str (string): 'in', 'ok', 'exec', 'warn', 'err' or 'dim'.
   *
   * Returns:
   *   (HTMLElement): The appended line.
   */
  appendLogLine(text_str, level_str = 'dim') {
    const line_el = document.createElement('div');
    line_el.className = `term__line term__line--${level_str}`;

    const timestamp_el = document.createElement('span');
    timestamp_el.className = 'term__ts';
    timestamp_el.textContent = formatLogTimestamp();

    const message_el = document.createElement('span');
    message_el.className = 'term__msg';
    message_el.textContent = String(text_str);

    line_el.append(timestamp_el, message_el);
    this.log_el.appendChild(line_el);

    while (this.log_el.childElementCount > MAX_LOG_LINES_INT) {
      this.log_el.firstElementChild.remove();
    }

    const distance_from_end_px_float = this.log_el.scrollHeight -
      this.log_el.scrollTop - this.log_el.clientHeight;
    if (distance_from_end_px_float < AUTOSCROLL_THRESHOLD_PX_INT) {
      this.log_el.scrollTop = this.log_el.scrollHeight;
    }
    return line_el;
  }

  /**
   * Empty the log.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  clearLog() {
    this.log_el.replaceChildren();
  }

  /**
   * Print the opening hint lines.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  showBanner() {
    this.appendLogLine(
      'SonicForge script terminal — type help() for the command list.', 'dim'
    );
    this.appendLogLine(
      'play(440hz, 1s, sine)      loop(4, [ play(880,100), wait(150) ])', 'dim'
    );
  }

  /* ===================================================================
     Input
     =================================================================== */

  /**
   * Handle one key press in the input field.
   *
   * Arguments:
   *   keyboard_event (KeyboardEvent): The key press.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   In multi-line mode a bare Enter inserts a newline, so submitting
   *   requires Ctrl or Cmd.
   */
  #handleInputKey(keyboard_event) {
    const is_modified_bool =
      keyboard_event.ctrlKey || keyboard_event.metaKey;

    switch (keyboard_event.key) {
      case 'Enter':
        if (this.#is_multiline_bool && !is_modified_bool) {
          return;
        }
        keyboard_event.preventDefault();
        this.submit();
        break;

      case 'Tab':
        keyboard_event.preventDefault();
        this.#completeCommand();
        break;

      case 'ArrowUp':
      case 'ArrowDown':
        if (this.#is_multiline_bool) {
          return;
        }
        keyboard_event.preventDefault();
        this.#recallHistory(keyboard_event.key === 'ArrowUp' ? -1 : 1);
        break;

      case 'Escape':
        keyboard_event.preventDefault();
        if (this.input_el.value) {
          this.input_el.value = '';
          this.#updateGhost();
        } else {
          this.input_el.blur();
        }
        break;

      case 'c':
        if (is_modified_bool) {
          keyboard_event.preventDefault();
          this.vm_obj.stop();
          this.appendLogLine('^C  execution halted', 'warn');
        }
        break;

      default:
        break;
    }
  }

  /**
   * Wire the input field's listeners.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bindInput() {
    this.input_el.addEventListener('input', () => this.#updateGhost());
    this.input_el.addEventListener(
      'keydown', (keyboard_event) => this.#handleInputKey(keyboard_event)
    );
  }

  /**
   * Show the signature of the command currently being typed.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #updateGhost() {
    if (!this.ghost_el) {
      return;
    }
    const value_str = this.input_el.value;
    const head_match_obj = COMMAND_HEAD_REGEX.exec(value_str);
    if (!head_match_obj) {
      this.ghost_el.textContent = '';
      return;
    }

    const name_str = head_match_obj[1].toLowerCase();
    const spec_obj = COMMANDS[name_str];

    if (spec_obj && value_str.length >= head_match_obj[0].length) {
      // Render the rest of the signature as an inline ghost.
      this.ghost_el.textContent =
        ' '.repeat(value_str.length) + '  ' + spec_obj.signature;
      return;
    }

    const completion_str = COMMAND_NAMES.find(
      (key_str) => key_str.startsWith(name_str) && key_str !== name_str
    );
    this.ghost_el.textContent = completion_str
      ? value_str + completion_str.slice(name_str.length)
      : '';
  }

  /**
   * Complete the partial command name at the caret.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #completeCommand() {
    const value_str = this.input_el.value;
    const tail_match_obj = COMMAND_TAIL_REGEX.exec(value_str);
    if (!tail_match_obj) {
      return;
    }

    const partial_str = tail_match_obj[1].toLowerCase();
    const matches_list = COMMAND_NAMES.filter(
      (key_str) => key_str.startsWith(partial_str)
    );
    if (!matches_list.length) {
      return;
    }

    const head_str = value_str.slice(0, tail_match_obj.index);
    if (matches_list.length === 1) {
      this.input_el.value = `${head_str}${matches_list[0]}(`;
    } else {
      this.appendLogLine(matches_list.join('   '), 'dim');
      this.input_el.value =
        head_str + findLongestCommonPrefix(matches_list);
    }
    this.#updateGhost();
  }

  /**
   * Step through the command history.
   *
   * Arguments:
   *   direction_int (number): -1 for older, 1 for newer.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   The caret is moved to the end on the next frame, because setting
   *   value during the key event resets the selection afterwards.
   */
  #recallHistory(direction_int) {
    if (!this.#history_list.length) {
      return;
    }
    if (this.#history_index_int === -1 && direction_int === -1) {
      this.#draft_str = this.input_el.value;
    }

    this.#history_index_int += direction_int === -1 ? 1 : -1;
    this.#history_index_int = Math.max(
      -1,
      Math.min(this.#history_list.length - 1, this.#history_index_int)
    );

    this.input_el.value = this.#history_index_int === -1
      ? this.#draft_str
      : this.#history_list[
        this.#history_list.length - 1 - this.#history_index_int
      ];

    this.#updateGhost();
    requestAnimationFrame(() => {
      const end_int = this.input_el.value.length;
      this.input_el.selectionStart = end_int;
      this.input_el.selectionEnd = end_int;
    });
  }

  /**
   * Run whatever is in the input field.
   *
   * Brief:
   *   `help`, `clear` and `history` are handled here rather than in the VM,
   *   because they act on the terminal itself and have no audio meaning.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  submit() {
    const source_str = this.input_el.value.trim();
    if (!source_str) {
      return;
    }

    this.appendLogLine(source_str, 'in');
    this.#pushHistory(source_str);
    this.input_el.value = '';
    this.#updateGhost();
    this.#history_index_int = -1;

    const bare_str = source_str.replace(EMPTY_CALL_REGEX, '').toLowerCase();
    if (bare_str === 'help') {
      this.showHelp();
      return;
    }
    if (CLEAR_WORDS_TUPLE.includes(bare_str)) {
      this.clearLog();
      return;
    }
    if (bare_str === 'history') {
      this.#listHistory();
      return;
    }

    try {
      this.vm_obj.run(source_str, { label_str: 'terminal' });
    } catch (err) {
      this.appendLogLine(err.format ? err.format() : err.message, 'err');
    }
  }

  /**
   * Print the command list, or one command's detail.
   *
   * Arguments:
   *   command_name_str (string|null): A single command, or null for all.
   *
   * Returns:
   *   (none)
   */
  showHelp(command_name_str = null) {
    if (command_name_str && COMMANDS[command_name_str]) {
      const spec_obj = COMMANDS[command_name_str];
      this.appendLogLine(spec_obj.signature, 'ok');
      this.appendLogLine(`  ${spec_obj.help}`, 'dim');
      this.appendLogLine(`  e.g. ${spec_obj.example}`, 'dim');
      return;
    }

    this.appendLogLine('Commands', 'ok');
    for (const key_str of COMMAND_NAMES) {
      const spec_obj = COMMANDS[key_str];
      this.appendLogLine(`  ${spec_obj.signature}`, 'exec');
      this.appendLogLine(`      ${spec_obj.help}`, 'dim');
    }
    this.appendLogLine(
      '  help  clear  history                 built-ins', 'exec'
    );
    this.appendLogLine(
      'Units: 440hz 1.5khz 250ms 2s -12db 180deg. Notes work too: play(A4).',
      'dim'
    );
  }

  /**
   * Print the most recent history entries.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #listHistory() {
    const recent_list =
      this.#history_list.slice(-LISTED_HISTORY_ENTRIES_INT);
    recent_list.forEach((entry_str, index_int) => {
      this.appendLogLine(`${index_int + 1}. ${entry_str}`, 'dim');
    });
  }

  /**
   * Record one submitted script in the history.
   *
   * Arguments:
   *   source_str (string): The submitted script.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Persisting is wrapped because localStorage throws outright in some
   *   private-browsing modes rather than merely failing to store.
   */
  #pushHistory(source_str) {
    if (this.#history_list[this.#history_list.length - 1] === source_str) {
      return;
    }
    this.#history_list.push(source_str);
    if (this.#history_list.length > MAX_HISTORY_ENTRIES_INT) {
      this.#history_list.shift();
    }
    try {
      localStorage.setItem(
        HISTORY_STORAGE_KEY_STR,
        JSON.stringify(
          this.#history_list.slice(-PERSISTED_HISTORY_ENTRIES_INT)
        )
      );
    } catch {
      // Storage unavailable; the in-memory history still works.
    }
  }

  /**
   * Restore the persisted command history.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   The stored value is untrusted, so non-string entries are discarded
   *   rather than assumed away.
   */
  #loadHistory() {
    try {
      const raw_str = localStorage.getItem(HISTORY_STORAGE_KEY_STR);
      if (raw_str) {
        this.#history_list = JSON.parse(raw_str).filter(
          (entry_str) => typeof entry_str === 'string'
        );
      }
    } catch {
      this.#history_list = [];
    }
  }

  /**
   * Switch between the single-line palette and the multi-line script pad.
   *
   * Arguments:
   *   is_multiline_bool (boolean): True for the multi-line pad.
   *
   * Returns:
   *   (Terminal): This instance, for chaining.
   *
   * Warning:
   *   The field is replaced rather than retyped, because an input cannot
   *   become a textarea. Listeners are rebound onto the new element.
   */
  setMultilineMode(is_multiline_bool) {
    this.#is_multiline_bool = Boolean(is_multiline_bool);

    const previous_el = this.input_el;
    const next_el = document.createElement(
      this.#is_multiline_bool ? 'textarea' : 'input'
    );
    next_el.className = 'term__input';
    next_el.dataset.term = 'input';
    next_el.value = previous_el.value;

    const prompt_el = previous_el.closest('.term__prompt');
    if (this.#is_multiline_bool) {
      next_el.rows = MULTILINE_ROW_COUNT_INT;
      next_el.style.resize = 'vertical';
      next_el.style.padding = '8px 0';
      next_el.placeholder = 'Multi-line script — Ctrl+Enter to run';
      prompt_el.style.height = 'auto';
      prompt_el.style.alignItems = 'flex-start';
      prompt_el.style.paddingTop = '8px';
    } else {
      next_el.type = 'text';
      next_el.placeholder = 'play(440hz, 1s, sine)';
      prompt_el.style.height = '';
      prompt_el.style.alignItems = '';
      prompt_el.style.paddingTop = '';
    }

    previous_el.replaceWith(next_el);
    this.input_el = next_el;
    this.#bindInput();
    next_el.focus();
    if (this.ghost_el) {
      this.ghost_el.textContent = '';
    }
    return this;
  }

  /** True while the multi-line script pad is shown. */
  get is_multiline_bool() {
    return this.#is_multiline_bool;
  }

  /**
   * Load text into the input without running it.
   *
   * Arguments:
   *   source_str (string): Script to place in the field.
   *
   * Returns:
   *   (Terminal): This instance, for chaining.
   */
  loadScript(source_str) {
    if (!this.#is_multiline_bool && /\n/.test(source_str.trim())) {
      this.setMultilineMode(true);
    }
    this.input_el.value = source_str.trim();
    this.input_el.focus();
    return this;
  }

  /* ===================================================================
     Execution tracker
     =================================================================== */

  /**
   * Mirror the VM's lifecycle into the log and the tracker.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bindVm() {
    const vm_obj = this.vm_obj;

    vm_obj.on('start', ({ label, count }) => {
      const plural_str = count === 1 ? '' : 's';
      this.appendLogLine(
        `▸ running ${label} — ${count} command${plural_str}`, 'ok'
      );
      this.tracker_el.hidden = false;
    });

    vm_obj.on('tick', (snapshot_obj) => this.#renderTracker(snapshot_obj));

    vm_obj.on('finish', ({ label }) => {
      this.tracker_el.hidden = true;
      this.appendLogLine(`▪ ${label} finished`, 'ok');
    });

    vm_obj.on('stop', () => {
      this.tracker_el.hidden = true;
      this.appendLogLine('▪ stopped', 'warn');
    });

    vm_obj.on('error', (err) => {
      this.tracker_el.hidden = true;
      this.appendLogLine(err.format ? err.format() : err.message, 'err');
    });

    vm_obj.on('log', ({ level, text }) => this.appendLogLine(text, level));
  }

  /**
   * Redraw the execution tracker from one VM snapshot.
   *
   * Arguments:
   *   snapshot_obj (Object): The VM's per-tick state.
   *
   * Returns:
   *   (none)
   */
  #renderTracker(snapshot_obj) {
    if (!snapshot_obj.current_obj) {
      this.program_counter_el.textContent =
        snapshot_obj.state_str === VM_STATE.DRAINING ? 'draining' : '—';
      this.progress_bar_el.style.width = '0%';
      this.countdown_el.textContent = '';
      return;
    }

    const current_obj = snapshot_obj.current_obj;
    const loop_str = current_obj.iteration_count_int > 1
      ? `  ↻ ${current_obj.iteration_int}/${current_obj.iteration_count_int}`
      : '';
    const depth_str = current_obj.depth_int > 0
      ? '│'.repeat(current_obj.depth_int) + ' '
      : '';

    this.program_counter_el.textContent =
      `${depth_str}${current_obj.label_str}${loop_str}`;
    this.progress_bar_el.style.width =
      `${Math.round(snapshot_obj.progress_float * 100)}%`;
    this.countdown_el.textContent = snapshot_obj.remaining_ms_float > 0
      ? `${formatDuration(snapshot_obj.remaining_ms_float)} │ ` +
        `${formatDuration(snapshot_obj.total_ms_float)}`
      : formatDuration(snapshot_obj.total_ms_float);
  }
}
