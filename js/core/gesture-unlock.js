/**
 * Autoplay-policy unlocking for the audio context.
 *
 * Brief:
 *   No browser will start an AudioContext outside a user gesture, and the
 *   two families of restriction differ in what satisfies them: Chrome wants
 *   any trusted input event, while Safari additionally wants a buffer to
 *   have actually played. This module handles both with one mechanism so
 *   the engine does not have to carry browser-specific branches.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Input events that count as a gesture for autoplay purposes. */
const UNLOCK_EVENT_NAMES_LIST = Object.freeze([
  'pointerdown',
  'touchstart',
  'keydown',
  'mousedown',
]);

/* ------------------------------------------------------------------------ */

/**
 * Play a one-sample silent buffer to satisfy Safari's unlock requirement.
 *
 * Brief:
 *   Safari treats a context as locked until something has been rendered
 *   through it, regardless of its reported state. One silent sample is the
 *   cheapest thing that counts.
 *
 * Arguments:
 *   audio_context_obj (BaseAudioContext): Context to play through.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   Safe to call repeatedly; the cost is a single discarded buffer source.
 */
export function playSilentUnlockBuffer(audio_context_obj) {
  const buffer_obj = audio_context_obj.createBuffer(
    1,
    1,
    audio_context_obj.sampleRate
  );
  const source_node = audio_context_obj.createBufferSource();
  source_node.buffer = buffer_obj;
  source_node.connect(audio_context_obj.destination);
  source_node.start(0);
}

/**
 * Listen for the first user gesture and unlock audio when it arrives.
 *
 * Brief:
 *   Listeners are installed in the capture phase so they fire even when an
 *   inner handler stops propagation, and are removed the moment the context
 *   reports itself running. Until then every gesture retries, which matters
 *   because the first attempt can legitimately fail while a page is still
 *   loading.
 *
 * Arguments:
 *   target_el (EventTarget): Element to listen on, normally window.
 *   unlock_attempt_fn (Function): Async callback that initialises audio and
 *     resolves to the live context, or null if it could not.
 *   on_unlocked_fn (Function): Called once, after a successful unlock.
 *   on_error_fn (Function): Called with any error raised by the attempt.
 *
 * Returns:
 *   (Function): Detach function that removes every listener early.
 *
 * Warning:
 *   Returns a detach function that must be called if the owner is destroyed
 *   before a gesture arrives, or the listeners outlive it.
 */
export function armGestureUnlock(target_el, unlock_attempt_fn,
                                 on_unlocked_fn, on_error_fn) {
  let is_detached_bool = false;

  const detach_fn = () => {
    if (is_detached_bool) {
      return;
    }
    is_detached_bool = true;
    for (const event_name_str of UNLOCK_EVENT_NAMES_LIST) {
      target_el.removeEventListener(event_name_str, handle_gesture_fn, true);
    }
  };

  const handle_gesture_fn = async () => {
    try {
      const audio_context_obj = await unlock_attempt_fn();
      if (!audio_context_obj) {
        return;
      }

      playSilentUnlockBuffer(audio_context_obj);

      if (audio_context_obj.state === 'running') {
        detach_fn();
        on_unlocked_fn?.();
      }
    } catch (error_obj) {
      on_error_fn?.(error_obj);
    }
  };

  for (const event_name_str of UNLOCK_EVENT_NAMES_LIST) {
    target_el.addEventListener(event_name_str, handle_gesture_fn, true);
  }
  return detach_fn;
}
