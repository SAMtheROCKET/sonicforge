/**
 * The SonicForge script virtual machine.
 *
 * Brief:
 *   Execution must never block the interface thread and must never drift.
 *   Those two goals conflict if you chain setTimeout calls, because timer
 *   jitter accumulates until a sixteen-step loop sounds audibly ragged.
 *
 *   So the VM runs on two clocks. A coarse wall-clock tick walks the
 *   instruction list ahead of real time, scheduling audio events against the
 *   AudioContext's sample clock up to a fixed lookahead horizon. The audio
 *   is therefore sample-accurate, while the JavaScript that produced it is
 *   only ever doing a few milliseconds of work per tick.
 *
 *   The interface reads a separate timeline mapping scheduled events back to
 *   wall time, which is how the terminal shows a live millisecond countdown
 *   for a block that was actually scheduled a third of a second ago.
 */

import { Emitter } from '../util/events.js';
import { parse, ScriptError } from './parser.js';
import { COMMANDS, makeRuntime } from './commands.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** How far ahead of the sample clock events are scheduled, in seconds. */
const LOOKAHEAD_SECONDS_FLOAT = 0.35;

/** Wall-clock interval between scheduling passes, in milliseconds. */
const TICK_MS_INT = 25;

/** Instructions walked per tick before yielding back to the browser. */
const MAX_STEPS_PER_TICK_INT = 400;

/** Total instruction budget, so a runaway loop cannot hang the tab. */
const MAX_TOTAL_STEPS_INT = 500000;

/** Delay before the first scheduled event, so it is never already late. */
const START_OFFSET_SECONDS_FLOAT = 0.08;

/** Default fade applied when releasing a held voice, in seconds. */
const DEFAULT_RELEASE_FADE_SECONDS_FLOAT = 0.02;

/** Extra time after the fade before a node is stopped, in seconds. */
const RELEASE_TAIL_SECONDS_FLOAT = 0.005;

/** Timeline entries kept before old ones are pruned. */
const MAX_TIMELINE_ENTRIES_INT = 512;

/** Seconds of finished timeline kept so the interface can render it. */
const TIMELINE_TAIL_SECONDS_FLOAT = 2;

/** Edit distance within which an unknown command is worth suggesting. */
const MAX_SUGGESTION_DISTANCE_INT = 3;

/** Suggestions offered, and the fallback list length when none are near. */
const MAX_SUGGESTIONS_INT = 3;
const FALLBACK_SUGGESTIONS_INT = 5;

/** Lifecycle states the machine moves through. */
export const VM_STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  DRAINING: 'draining',
  STOPPED: 'stopped',
  ERROR: 'error',
});

/* ------------------------------------------------------------------------ */

/**
 * Measure the Levenshtein distance between two words.
 *
 * Brief:
 *   Two rolling rows rather than a full matrix, because command names are
 *   short and this runs on every unknown-command error.
 *
 * Arguments:
 *   first_str (string): First word.
 *   second_str (string): Second word.
 *
 * Returns:
 *   (number): Minimum single-character edits between them.
 */
function measureEditDistance(first_str, second_str) {
  const first_length_int = first_str.length;
  const second_length_int = second_str.length;

  let previous_row_list = Array.from(
    { length: second_length_int + 1 }, (_, index_int) => index_int
  );

  for (let row_int = 1; row_int <= first_length_int; row_int++) {
    const current_row_list = [row_int];
    for (let column_int = 1; column_int <= second_length_int; column_int++) {
      const is_same_bool =
        first_str[row_int - 1] === second_str[column_int - 1];
      current_row_list[column_int] = Math.min(
        previous_row_list[column_int] + 1,
        current_row_list[column_int - 1] + 1,
        previous_row_list[column_int - 1] + (is_same_bool ? 0 : 1)
      );
    }
    previous_row_list = current_row_list;
  }
  return previous_row_list[second_length_int];
}

/**
 * Suggest command names close to one that was not recognised.
 *
 * Arguments:
 *   unknown_name_str (string): The name the script used.
 *
 * Returns:
 *   (string): Comma-separated suggestions, or the first few commands.
 */
function suggestCommandNames(unknown_name_str) {
  const command_names_list = Object.keys(COMMANDS);
  const ranked_list = command_names_list
    .map((name_str) => [
      name_str, measureEditDistance(unknown_name_str, name_str),
    ])
    .sort((first_pair, second_pair) => first_pair[1] - second_pair[1]);

  const near_list = ranked_list
    .filter(([, distance_int]) => distance_int <= MAX_SUGGESTION_DISTANCE_INT)
    .slice(0, MAX_SUGGESTIONS_INT)
    .map(([name_str]) => name_str);

  const chosen_list = near_list.length
    ? near_list
    : command_names_list.slice(0, FALLBACK_SUGGESTIONS_INT);
  return chosen_list.join(', ');
}

/* ------------------------------------------------------------------------ */

/**
 * Two-clock virtual machine for the SonicForge scripting language.
 *
 * Brief:
 *   Compiles a program to a flat instruction list, then walks it ahead of
 *   real time, scheduling audio on the sample clock and recording a wall
 *   clock timeline for the interface to read.
 *
 * Arguments:
 *   app_obj (Object): The application facade, for the engine and logging.
 *
 * Returns:
 *   (ScriptVM): The constructed machine.
 *
 * Warning:
 *   Emits 'start', 'tick', 'finish', 'stop', 'error' and 'log'. A caller
 *   that holds a reference must call stop() before discarding it, or the
 *   scheduling interval keeps running.
 */
export class ScriptVM extends Emitter {
  state_str = VM_STATE.IDLE;
  instructions_list = [];
  timeline_list = [];
  label_str = 'script';

  #program_counter_int = 0;
  #loop_frames_list = [];
  #cursor_seconds_float = 0;
  #step_count_int = 0;
  #interval_id_int = null;
  #held_set = new Set();
  #timeout_ids_set = new Set();
  #runtime_obj = null;
  #ends_at_seconds_float = 0;

  constructor(app_obj) {
    super();
    this.app_obj = app_obj;
  }

  /** True while instructions are being walked or audio is still draining. */
  get is_running_bool() {
    return this.state_str === VM_STATE.RUNNING ||
      this.state_str === VM_STATE.DRAINING;
  }

  /* ===================================================================
     Compilation
     =================================================================== */

  /**
   * Flatten one parsed node into the instruction list.
   *
   * Arguments:
   *   node_obj (Object): A parsed call or loop node.
   *   instructions_list (Array): Output list, appended in place.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Throws ScriptError for an unknown command, before anything sounds.
   */
  #emitNode(node_obj, instructions_list) {
    if (node_obj.kind_str === 'call') {
      const spec_obj = COMMANDS[node_obj.name_str];
      if (!spec_obj) {
        throw new ScriptError(
          `Unknown command '${node_obj.name_str}'. ` +
          `Try: ${suggestCommandNames(node_obj.name_str)}`,
          { line_int: node_obj.line_int, column_int: node_obj.column_int }
        );
      }
      instructions_list.push({
        op_str: 'CALL',
        name_str: node_obj.name_str,
        arguments_list: node_obj.arguments_list,
        spec_obj,
        line_int: node_obj.line_int,
      });
      return;
    }

    if (node_obj.kind_str === 'loop') {
      const head_index_int = instructions_list.length;
      instructions_list.push({
        op_str: 'LOOP',
        repeat_count_int: node_obj.repeat_count_int,
        end_index_int: -1,
        line_int: node_obj.line_int,
      });
      for (const child_obj of node_obj.body_list) {
        this.#emitNode(child_obj, instructions_list);
      }
      instructions_list.push({
        op_str: 'ENDLOOP',
        head_index_int,
        line_int: node_obj.line_int,
      });
      instructions_list[head_index_int].end_index_int =
        instructions_list.length;
    }
  }

  /**
   * Parse and flatten a program into a linear instruction list.
   *
   * Arguments:
   *   source_any (string|Array|Object): Script text or JSON program form.
   *
   * Returns:
   *   (Array): The flattened instruction list.
   *
   * Warning:
   *   Unknown commands and malformed loops fail here, before a single note
   *   plays. That is the point of compiling separately from running.
   */
  compile(source_any) {
    const program_obj = parse(source_any);
    const instructions_list = [];
    for (const node_obj of program_obj.body_list) {
      this.#emitNode(node_obj, instructions_list);
    }
    return instructions_list;
  }

  /**
   * Compile without running, for live validation in the terminal.
   *
   * Arguments:
   *   source_any (string|Array|Object): Script to check.
   *
   * Returns:
   *   (Object): { is_valid_bool, call_count_int } or { is_valid_bool, err }.
   */
  validate(source_any) {
    try {
      const instructions_list = this.compile(source_any);
      return {
        is_valid_bool: true,
        call_count_int: countCalls(instructions_list),
      };
    } catch (err) {
      return { is_valid_bool: false, err };
    }
  }

  /* ===================================================================
     Execution
     =================================================================== */

  /**
   * Compile a program and begin executing it.
   *
   * Arguments:
   *   source_any (string|Array|Object): Script text or JSON program form.
   *   options_obj (Object): { label_str } naming the run in the log.
   *
   * Returns:
   *   (ScriptVM): This instance, for chaining.
   *
   * Warning:
   *   Stops any run already in progress. A compile error is both emitted
   *   and rethrown, so the terminal can show it inline.
   */
  run(source_any, options_obj = {}) {
    const { label_str = 'script' } = options_obj;
    this.stop({ is_silent_bool: true });

    let instructions_list;
    try {
      instructions_list = this.compile(source_any);
    } catch (err) {
      this.state_str = VM_STATE.ERROR;
      this.emit('error', err);
      throw err;
    }

    if (!instructions_list.length) {
      this.emit('log', { level: 'dim', text: 'Nothing to run.' });
      return this;
    }

    this.instructions_list = instructions_list;
    this.timeline_list = [];
    this.label_str = label_str;
    this.#program_counter_int = 0;
    this.#loop_frames_list = [];
    this.#step_count_int = 0;
    this.#held_set.clear();
    this.#runtime_obj = makeRuntime(this.app_obj, this);

    this.#cursor_seconds_float =
      this.app_obj.engine.currentTimeSeconds + START_OFFSET_SECONDS_FLOAT;
    this.#ends_at_seconds_float = this.#cursor_seconds_float;
    this.state_str = VM_STATE.RUNNING;

    this.emit('start', {
      label: label_str,
      count: countCalls(instructions_list),
    });
    this.#tick();
    this.#interval_id_int = setInterval(() => this.#tick(), TICK_MS_INT);
    return this;
  }

  /**
   * Walk instructions up to the lookahead horizon, then report progress.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #tick() {
    if (!this.is_running_bool) {
      return;
    }

    const now_seconds_float = this.app_obj.engine.currentTimeSeconds;
    const horizon_seconds_float =
      now_seconds_float + LOOKAHEAD_SECONDS_FLOAT;

    try {
      this.#walkToHorizon(horizon_seconds_float);
    } catch (err) {
      this.#fail(err);
      return;
    }

    this.#pruneTimeline(now_seconds_float);
    this.emit('tick', this.takeSnapshot(now_seconds_float));

    if (this.state_str === VM_STATE.DRAINING &&
      now_seconds_float >= this.#ends_at_seconds_float) {
      this.#finish();
    }
  }

  /**
   * Step instructions until the cursor reaches the scheduling horizon.
   *
   * Arguments:
   *   horizon_seconds_float (number): Sample-clock time to schedule up to.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Throws ScriptError once the total step budget is exhausted, which is
   *   what stops a mistyped loop count from hanging the tab.
   */
  #walkToHorizon(horizon_seconds_float) {
    let steps_this_tick_int = 0;

    while (
      this.state_str === VM_STATE.RUNNING &&
      this.#cursor_seconds_float < horizon_seconds_float &&
      steps_this_tick_int < MAX_STEPS_PER_TICK_INT
    ) {
      if (this.#program_counter_int >= this.instructions_list.length) {
        this.state_str = VM_STATE.DRAINING;
        return;
      }
      this.#step();
      steps_this_tick_int++;

      if (++this.#step_count_int > MAX_TOTAL_STEPS_INT) {
        throw new ScriptError(
          'Execution budget exhausted after ' +
          `${MAX_TOTAL_STEPS_INT.toLocaleString()} steps - ` +
          'is a loop count too large?'
        );
      }
    }
  }

  /**
   * Execute the LOOP instruction at the program counter.
   *
   * Arguments:
   *   instruction_obj (Object): The LOOP instruction.
   *
   * Returns:
   *   (none)
   */
  #stepLoop(instruction_obj) {
    if (instruction_obj.repeat_count_int <= 0) {
      this.#program_counter_int = instruction_obj.end_index_int;
      return;
    }
    this.#loop_frames_list.push({
      head_index_int: this.#program_counter_int,
      remaining_int: instruction_obj.repeat_count_int,
      total_int: instruction_obj.repeat_count_int,
      iteration_int: 1,
    });
    this.#program_counter_int++;
  }

  /**
   * Execute the ENDLOOP instruction at the program counter.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #stepEndLoop() {
    const frame_obj =
      this.#loop_frames_list[this.#loop_frames_list.length - 1];
    if (!frame_obj) {
      this.#program_counter_int++;
      return;
    }

    frame_obj.remaining_int--;
    if (frame_obj.remaining_int > 0) {
      frame_obj.iteration_int++;
      this.#program_counter_int = frame_obj.head_index_int + 1;
      return;
    }
    this.#loop_frames_list.pop();
    this.#program_counter_int++;
  }

  /**
   * Execute the CALL instruction at the program counter.
   *
   * Brief:
   *   The command schedules its own audio against the sample clock and
   *   returns how long it occupies, which is what advances the cursor.
   *
   * Arguments:
   *   instruction_obj (Object): The CALL instruction.
   *
   * Returns:
   *   (none)
   */
  #stepCall(instruction_obj) {
    const runtime_obj = this.#runtime_obj;
    runtime_obj.when_seconds_float = this.#cursor_seconds_float;
    runtime_obj.line_int = instruction_obj.line_int;
    runtime_obj.program_counter_int = this.#program_counter_int;

    const duration_ms_float =
      instruction_obj.spec_obj.run(runtime_obj, instruction_obj.arguments_list)
      || 0;
    const duration_seconds_float = Math.max(0, duration_ms_float) / 1000;
    const innermost_frame_obj =
      this.#loop_frames_list[this.#loop_frames_list.length - 1];

    this.timeline_list.push({
      program_counter_int: this.#program_counter_int,
      command_name_str: instruction_obj.name_str,
      label_str: runtime_obj.last_label_str || instruction_obj.name_str,
      line_int: instruction_obj.line_int,
      start_seconds_float: this.#cursor_seconds_float,
      end_seconds_float:
        this.#cursor_seconds_float + duration_seconds_float,
      depth_int: this.#loop_frames_list.length,
      iteration_int: innermost_frame_obj?.iteration_int ?? 0,
      iteration_count_int: innermost_frame_obj?.total_int ?? 0,
    });
    runtime_obj.last_label_str = null;

    this.#cursor_seconds_float += duration_seconds_float;
    if (this.#cursor_seconds_float > this.#ends_at_seconds_float) {
      this.#ends_at_seconds_float = this.#cursor_seconds_float;
    }
    this.#program_counter_int++;
  }

  /**
   * Execute one instruction.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #step() {
    const instruction_obj = this.instructions_list[this.#program_counter_int];

    switch (instruction_obj.op_str) {
      case 'LOOP':
        this.#stepLoop(instruction_obj);
        break;
      case 'ENDLOOP':
        this.#stepEndLoop();
        break;
      case 'CALL':
        this.#stepCall(instruction_obj);
        break;
      default:
        this.#program_counter_int++;
    }
  }

  /**
   * Discard timeline entries the interface can no longer show.
   *
   * Arguments:
   *   now_seconds_float (number): Current sample-clock time.
   *
   * Returns:
   *   (none)
   */
  #pruneTimeline(now_seconds_float) {
    if (this.timeline_list.length <= MAX_TIMELINE_ENTRIES_INT) {
      return;
    }
    const cutoff_seconds_float =
      now_seconds_float - TIMELINE_TAIL_SECONDS_FLOAT;
    this.timeline_list = this.timeline_list.filter(
      (entry_obj) => entry_obj.end_seconds_float > cutoff_seconds_float
    );
  }

  /**
   * Find the timeline entry the interface should be showing.
   *
   * Brief:
   *   Zero-duration commands never span the current instant, so when no
   *   entry contains it the most recent one that has started is used
   *   instead. Otherwise the tracker would blink empty on every print().
   *
   * Arguments:
   *   now_seconds_float (number): Current sample-clock time.
   *
   * Returns:
   *   (Object|null): The entry to display, or null when none have started.
   */
  #findCurrentEntry(now_seconds_float) {
    for (let index_int = this.timeline_list.length - 1;
      index_int >= 0; index_int--) {
      const entry_obj = this.timeline_list[index_int];
      if (entry_obj.start_seconds_float <= now_seconds_float &&
        now_seconds_float < entry_obj.end_seconds_float) {
        return entry_obj;
      }
    }
    for (let index_int = this.timeline_list.length - 1;
      index_int >= 0; index_int--) {
      if (this.timeline_list[index_int].start_seconds_float <=
        now_seconds_float) {
        return this.timeline_list[index_int];
      }
    }
    return null;
  }

  /**
   * Describe what the interface should be showing right now.
   *
   * Arguments:
   *   now_seconds_float (number): Current sample-clock time.
   *
   * Returns:
   *   (Object): State, current entry, remaining and total time, progress.
   */
  takeSnapshot(now_seconds_float = this.app_obj.engine.currentTimeSeconds) {
    const current_obj = this.#findCurrentEntry(now_seconds_float);
    const innermost_frame_obj =
      this.#loop_frames_list[this.#loop_frames_list.length - 1];

    const remaining_ms_float = current_obj
      ? Math.max(0, (current_obj.end_seconds_float - now_seconds_float) * 1000)
      : 0;
    const span_seconds_float = current_obj
      ? current_obj.end_seconds_float - current_obj.start_seconds_float
      : 0;

    return {
      state_str: this.state_str,
      current_obj,
      remaining_ms_float,
      total_ms_float: Math.max(
        0, (this.#ends_at_seconds_float - now_seconds_float) * 1000
      ),
      progress_float: span_seconds_float > 0
        ? (now_seconds_float - current_obj.start_seconds_float) /
          span_seconds_float
        : 0,
      depth_int: this.#loop_frames_list.length,
      iteration_int: innermost_frame_obj?.iteration_int ?? 0,
      iteration_count_int: innermost_frame_obj?.total_int ?? 0,
      scheduled_count_int: this.#program_counter_int,
      instruction_count_int: this.instructions_list.length,
    };
  }

  /* ===================================================================
     Resource ownership
     =================================================================== */

  /**
   * Register a node the VM created so stop() can silence it.
   *
   * Brief:
   *   Lookahead means a node may be scheduled to start well in the future.
   *   Without this register, stopping would leave those voices to sound
   *   after the run was cancelled.
   *
   * Arguments:
   *   source_node (AudioScheduledSourceNode): The voice.
   *   gain_node (GainNode|null): Its envelope, faded out on release.
   *
   * Returns:
   *   (Object): The registry entry.
   */
  holdNode(source_node, gain_node = null) {
    const entry_obj = { source_node, gain_node };
    this.#held_set.add(entry_obj);

    if (source_node && 'onended' in source_node) {
      source_node.onended = () => {
        this.#held_set.delete(entry_obj);
        try {
          source_node.disconnect();
        } catch {
          // Already disconnected.
        }
        try {
          gain_node?.disconnect();
        } catch {
          // Already disconnected.
        }
      };
    }
    return entry_obj;
  }

  /**
   * Queue a deferred side effect owned by the VM.
   *
   * Arguments:
   *   callback_fn (Function): Work to run when the moment arrives.
   *   delay_ms_float (number): Wall-clock delay.
   *
   * Returns:
   *   (number): The timeout id.
   *
   * Warning:
   *   Owned by the VM so stop() can cancel work scheduled during lookahead
   *   that has not fired yet.
   */
  deferCall(callback_fn, delay_ms_float) {
    const timeout_id_int = setTimeout(() => {
      this.#timeout_ids_set.delete(timeout_id_int);
      try {
        callback_fn();
      } catch (err) {
        console.error('[SonicForge] deferred command error', err);
      }
    }, delay_ms_float);

    this.#timeout_ids_set.add(timeout_id_int);
    return timeout_id_int;
  }

  /**
   * Silence every in-flight voice the VM owns.
   *
   * Arguments:
   *   fade_seconds_float (number): Fade-out length before stopping.
   *
   * Returns:
   *   (none)
   */
  releaseHeldNodes(fade_seconds_float = DEFAULT_RELEASE_FADE_SECONDS_FLOAT) {
    const now_seconds_float = this.app_obj.engine.currentTimeSeconds;

    for (const timeout_id_int of this.#timeout_ids_set) {
      clearTimeout(timeout_id_int);
    }
    this.#timeout_ids_set.clear();

    for (const { source_node, gain_node } of this.#held_set) {
      try {
        if (gain_node) {
          gain_node.gain.cancelScheduledValues(now_seconds_float);
          gain_node.gain.setValueAtTime(
            gain_node.gain.value, now_seconds_float
          );
          gain_node.gain.linearRampToValueAtTime(
            0, now_seconds_float + fade_seconds_float
          );
        }
        source_node?.stop?.(
          now_seconds_float + fade_seconds_float +
          RELEASE_TAIL_SECONDS_FLOAT
        );
      } catch {
        try {
          source_node?.disconnect?.();
        } catch {
          // Already disconnected.
        }
      }
    }
    this.#held_set.clear();
  }

  /* ===================================================================
     Termination
     =================================================================== */

  /**
   * Halt execution and silence anything still sounding.
   *
   * Arguments:
   *   options_obj (Object): { is_silent_bool } to suppress the stop event.
   *
   * Returns:
   *   (ScriptVM): This instance, for chaining.
   */
  stop(options_obj = {}) {
    const { is_silent_bool = false } = options_obj;
    this.#clearInterval();

    const was_running_bool = this.is_running_bool;
    this.releaseHeldNodes();
    this.state_str = VM_STATE.STOPPED;
    this.#loop_frames_list = [];

    if (was_running_bool && !is_silent_bool) {
      this.emit('stop', this.takeSnapshot());
    }
    return this;
  }

  /**
   * Cancel the scheduling interval, if one is running.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #clearInterval() {
    if (this.#interval_id_int) {
      clearInterval(this.#interval_id_int);
      this.#interval_id_int = null;
    }
  }

  /**
   * Complete a run whose audio has finished playing out.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #finish() {
    this.#clearInterval();
    this.#held_set.clear();
    this.state_str = VM_STATE.IDLE;
    this.emit('finish', {
      label: this.label_str,
      steps: this.#step_count_int,
    });
  }

  /**
   * Abandon a run after an error, silencing anything already scheduled.
   *
   * Arguments:
   *   err (Error): The failure to report.
   *
   * Returns:
   *   (none)
   */
  #fail(err) {
    this.#clearInterval();
    this.releaseHeldNodes();
    this.state_str = VM_STATE.ERROR;
    this.emit('error', err);
  }
}

/**
 * Count the CALL instructions in a compiled program.
 *
 * Arguments:
 *   instructions_list (Array): A compiled instruction list.
 *
 * Returns:
 *   (number): How many commands will actually run.
 */
function countCalls(instructions_list) {
  return instructions_list.filter(
    (instruction_obj) => instruction_obj.op_str === 'CALL'
  ).length;
}
