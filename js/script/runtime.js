/**
 * The runtime handed to every command invocation.
 *
 * Brief:
 *   Because the VM schedules ahead of real time, a command must never act
 *   "now". Audio is scheduled against when_seconds_float, the AudioContext
 *   timestamp the command is supposed to take effect at, and any side effect
 *   that cannot be expressed as an AudioParam event is deferred through
 *   scheduleAt so it lands at the right moment rather than up to a
 *   lookahead early.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/**
 * Delay below which a deferred call is simply run inline, in milliseconds.
 *
 * Going through setTimeout for a sub-millisecond delay costs a task and
 * gains nothing, and the timer's own resolution is coarser than the delay
 * being asked for.
 */
const IMMEDIATE_THRESHOLD_MS_FLOAT = 2;

/* ------------------------------------------------------------------------ */

/**
 * Build the object handed to every command invocation.
 *
 * Brief:
 *   The scheduling fields are rewritten by the VM before each call, so the
 *   object is created once per run rather than once per command.
 *
 * Arguments:
 *   app_obj (Object): The SonicForge application facade.
 *   vm_obj (ScriptVM): The machine executing the program.
 *
 * Returns:
 *   (Object): The runtime, with scheduling helpers bound to this run.
 *
 * Warning:
 *   when_seconds_float, line_int and program_counter_int are overwritten by
 *   the VM immediately before each command runs. A command that stores the
 *   runtime and reads them later will see another command's values.
 */
export function makeRuntime(app_obj, vm_obj) {
  return {
    app_obj,
    vm_obj,

    get engine_obj() {
      return app_obj.engine;
    },

    get ctx() {
      return app_obj.engine.context_obj;
    },

    when_seconds_float: 0,
    line_int: 0,
    program_counter_int: 0,
    last_label_str: null,

    /**
     * Write a line to the terminal when this command actually happens.
     *
     * Arguments:
     *   text_str (string): Line to log.
     *   level_str (string): Terminal log level.
     *
     * Returns:
     *   (none)
     */
    logAt(text_str, level_str = 'exec') {
      this.scheduleAt(() => app_obj.log?.(text_str, level_str));
    },

    /**
     * Write a line to the terminal now, at schedule time.
     *
     * Brief:
     *   For parameter echoes that describe what was queued rather than what
     *   is sounding, so they appear in the order the script reads.
     *
     * Arguments:
     *   text_str (string): Line to log.
     *   level_str (string): Terminal log level.
     *
     * Returns:
     *   (none)
     */
    logImmediately(text_str, level_str = 'dim') {
      app_obj.log?.(text_str, level_str);
    },

    /**
     * Defer a side effect until its moment arrives in wall-clock terms.
     *
     * Arguments:
     *   callback_fn (Function): The side effect.
     *   when_seconds_float (number): Sample-clock time it belongs at.
     *
     * Returns:
     *   (number|null): The timeout id, or null if it ran inline.
     *
     * Warning:
     *   Anything that is not an AudioParam event must go through this, or
     *   the VM's lookahead makes it happen early.
     */
    scheduleAt(callback_fn, when_seconds_float = this.when_seconds_float) {
      const delay_ms_float = Math.max(
        0,
        (when_seconds_float - app_obj.engine.currentTimeSeconds) * 1000
      );

      if (delay_ms_float < IMMEDIATE_THRESHOLD_MS_FLOAT) {
        try {
          callback_fn();
        } catch (err) {
          console.error('[SonicForge] command error', err);
        }
        return null;
      }
      return vm_obj.deferCall(callback_fn, delay_ms_float);
    },

    /**
     * Register a node so the VM can silence it when the run is stopped.
     *
     * Arguments:
     *   source_node (AudioScheduledSourceNode): The voice.
     *   gain_node (GainNode|null): Its envelope.
     *
     * Returns:
     *   (Object): The VM's registry entry.
     */
    holdNode(source_node, gain_node) {
      return vm_obj.holdNode(source_node, gain_node);
    },

    /**
     * Name this command for the execution tracker.
     *
     * Arguments:
     *   label_str (string): Short description of what is sounding.
     *
     * Returns:
     *   (none)
     */
    setLabel(label_str) {
      this.last_label_str = label_str;
    },
  };
}
