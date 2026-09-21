/**
 * Synchronous event emitter shared by every stateful SonicForge object.
 *
 * Brief:
 *   Audio state changes originate in many places - the UI, the scripting VM,
 *   an incoming Concert Mode message - and several views must react to each
 *   one. This is the single notification primitive they all use. Listener
 *   exceptions are isolated so one broken subscriber cannot stop the others
 *   from being notified, which matters because a thrown error inside a meter
 *   redraw must never silence an audio engine.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

const LISTENER_ERROR_PREFIX_STR = '[SonicForge] listener error on';

/* ------------------------------------------------------------------------ */

/**
 * Register, remove, and dispatch named events to subscriber callbacks.
 *
 * Brief:
 *   A deliberately small observer implementation. It keeps listeners in a
 *   Set per event name so that registering the same callback twice is a
 *   no-op, and it dispatches over a copy of that Set so a listener may
 *   unsubscribe itself while being called.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (Emitter): An emitter with no registered listeners.
 *
 * Warning:
 *   Dispatch is synchronous. A slow listener blocks the caller, so never do
 *   heavy work inside one that fires on every animation frame.
 */
export class Emitter {
  /** @type {Map<string, Set<Function>>} */
  #listeners_map = new Map();

  /**
   * Subscribe a callback to an event name.
   *
   * Arguments:
   *   event_name_str (string): Event to listen for.
   *   listener_fn (Function): Callback invoked with the emitted arguments.
   *
   * Returns:
   *   (Function): Unsubscribe function; calling it removes this listener.
   *
   * Warning:
   *   Throws TypeError when listener_fn is not callable, because a silent
   *   no-op subscription is far harder to diagnose later.
   */
  on(event_name_str, listener_fn) {
    if (typeof listener_fn !== 'function') {
      throw new TypeError('listener must be a function');
    }

    let listener_set = this.#listeners_map.get(event_name_str);
    if (!listener_set) {
      listener_set = new Set();
      this.#listeners_map.set(event_name_str, listener_set);
    }
    listener_set.add(listener_fn);

    return () => this.off(event_name_str, listener_fn);
  }

  /**
   * Subscribe a callback that removes itself after its first invocation.
   *
   * Arguments:
   *   event_name_str (string): Event to listen for.
   *   listener_fn (Function): Callback invoked at most once.
   *
   * Returns:
   *   (Function): Unsubscribe function, usable before the event fires.
   */
  once(event_name_str, listener_fn) {
    const unsubscribe_fn = this.on(event_name_str, (...emitted_args_list) => {
      unsubscribe_fn();
      listener_fn(...emitted_args_list);
    });
    return unsubscribe_fn;
  }

  /**
   * Remove one previously registered callback.
   *
   * Arguments:
   *   event_name_str (string): Event the callback was registered against.
   *   listener_fn (Function): The exact callback reference to remove.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Removal is by reference. A wrapped or bound copy of the original
   *   function will not match and will stay subscribed.
   */
  off(event_name_str, listener_fn) {
    const listener_set = this.#listeners_map.get(event_name_str);
    if (!listener_set) {
      return;
    }

    listener_set.delete(listener_fn);
    if (listener_set.size === 0) {
      this.#listeners_map.delete(event_name_str);
    }
  }

  /**
   * Dispatch an event to every subscriber of that name.
   *
   * Brief:
   *   Iterates a snapshot of the listener set so that a listener may
   *   subscribe or unsubscribe during dispatch without corrupting it.
   *
   * Arguments:
   *   event_name_str (string): Event to dispatch.
   *   ...emitted_args_list (*): Arguments forwarded to each listener.
   *
   * Returns:
   *   (boolean): True when at least one listener was registered.
   *
   * Warning:
   *   Listener exceptions are caught and logged, never rethrown. Check the
   *   console when a subscriber appears not to have run.
   */
  emit(event_name_str, ...emitted_args_list) {
    const listener_set = this.#listeners_map.get(event_name_str);
    if (!listener_set) {
      return false;
    }

    for (const listener_fn of [...listener_set]) {
      try {
        listener_fn(...emitted_args_list);
      } catch (error_obj) {
        console.error(
          `${LISTENER_ERROR_PREFIX_STR} "${event_name_str}"`,
          error_obj
        );
      }
    }
    return true;
  }

  /**
   * Count the listeners currently registered for an event name.
   *
   * Arguments:
   *   event_name_str (string): Event to count.
   *
   * Returns:
   *   (number): Listener count, zero when the name is unknown.
   */
  listenerCount(event_name_str) {
    return this.#listeners_map.get(event_name_str)?.size ?? 0;
  }

  /**
   * Remove every listener for every event.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Call this during teardown only. Clearing a live emitter silently
   *   detaches views that are still on screen.
   */
  clear() {
    this.#listeners_map.clear();
  }
}
