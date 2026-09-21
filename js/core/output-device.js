/**
 * Routing the audio context to a chosen output device.
 *
 * Brief:
 *   Selecting an output device is useful for measurement work - you want
 *   the sweep going to the speakers under test, not to whatever the system
 *   default happens to be. The capability is Chromium-only at present, so
 *   every function here degrades to a clear "not supported" rather than
 *   throwing, and the interface can simply hide the control.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Device kind reported by enumerateDevices for playback endpoints. */
const OUTPUT_DEVICE_KIND_STR = 'audiooutput';

/* ------------------------------------------------------------------------ */

/**
 * Report whether this context can be routed to a chosen device.
 *
 * Brief:
 *   Chromium exposes setSinkId on AudioContext; other engines do not. The
 *   interface hides the control entirely rather than offering one that
 *   silently does nothing.
 *
 * Arguments:
 *   audio_context_obj (BaseAudioContext): Context to test.
 *
 * Returns:
 *   (boolean): True when setSinkId is available.
 */
export function canSelectOutputDevice(audio_context_obj) {
  return !!(
    audio_context_obj && typeof audio_context_obj.setSinkId === 'function'
  );
}

/**
 * Route an audio context to a specific output device.
 *
 * Brief:
 *   Returns a result object rather than throwing, because a device can
 *   disappear between being listed and being selected - unplugging
 *   headphones mid-measurement is normal, not exceptional.
 *
 * Arguments:
 *   audio_context_obj (BaseAudioContext): Context to reroute.
 *   device_id_str (string): Identifier from enumerateDevices.
 *
 * Returns:
 *   (Promise<Object>): is_success_bool and, on failure, error_message_str.
 *
 * Warning:
 *   Rerouting a running context briefly interrupts playback on some
 *   platforms. Do it between measurements, never during one.
 */
export async function routeContextToDevice(audio_context_obj,
                                           device_id_str) {
  if (!canSelectOutputDevice(audio_context_obj)) {
    return {
      is_success_bool: false,
      error_message_str: 'Output device selection is not supported here.',
    };
  }

  try {
    await audio_context_obj.setSinkId(device_id_str);
    return { is_success_bool: true, error_message_str: '' };
  } catch (error_obj) {
    return {
      is_success_bool: false,
      error_message_str: error_obj?.message ?? 'Could not switch device.',
    };
  }
}

/**
 * List the playback devices the browser will disclose.
 *
 * Brief:
 *   Device labels are hidden until the user has granted microphone
 *   permission at least once; before that every label is an empty string.
 *   Callers should fall back to a generic name rather than showing blanks.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (Promise<Object[]>): device_id_str and label_str per device.
 *
 * Warning:
 *   Returns an empty list when the media devices API is unavailable, which
 *   is the correct outcome for a non-secure origin.
 */
export async function listOutputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return [];
  }

  try {
    const devices_list = await navigator.mediaDevices.enumerateDevices();
    return devices_list
      .filter((device_obj) => device_obj.kind === OUTPUT_DEVICE_KIND_STR)
      .map((device_obj, index_int) => ({
        device_id_str: device_obj.deviceId,
        label_str: device_obj.label || `Output ${index_int + 1}`,
      }));
  } catch {
    return [];
  }
}
