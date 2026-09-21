/**
 * Capturing and restoring channel state.
 *
 * Brief:
 *   Separated from the channel itself because serialisation has a different
 *   trust model from every other operation on a channel. State arriving here
 *   comes from a saved session or from a Concert Mode peer, and must be
 *   treated as untrusted: a malformed frequency must never reach an
 *   oscillator, and a missing field must leave the channel unchanged rather
 *   than resetting it.
 */

import { clampToRange } from '../util/numeric.js';
import { SILENCE_THRESHOLD_DB_FLOAT } from '../util/amplitude.js';
import {
  normalisePhaseDegrees,
  WAVEFORM_KEYS_LIST,
} from './waveforms.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Lowest frequency any restored channel may hold, in hertz. */
const MIN_FREQUENCY_HERTZ_FLOAT = 0.01;

/** Bounds on restored detuning, in cents. */
const MAX_DETUNE_CENTS_FLOAT = 1200;

/** Bounds on restored portamento, in milliseconds. */
const MAX_GLIDE_MS_FLOAT = 10000;

/* ------------------------------------------------------------------------ */

/**
 * Capture a channel's user-settable state as a plain object.
 *
 * Brief:
 *   Deliberately excludes audio nodes and derived values, so the result is
 *   safe to store, to diff, and to send over a data channel.
 *
 * Arguments:
 *   channel_obj (ToneChannel): Channel to read.
 *
 * Returns:
 *   (Object): Every user-settable parameter of that channel.
 */
export function captureChannelState(channel_obj) {
  return {
    index_int: channel_obj.index_int,
    is_enabled_bool: channel_obj.is_enabled_bool,
    frequency_hertz_float: channel_obj.frequency_hertz_float,
    waveform_name_str: channel_obj.waveform_name_str,
    gain_db_float: channel_obj.gain_db_float,
    pan_position_float: channel_obj.pan_position_float,
    phase_degrees_int: channel_obj.phase_degrees_int,
    detune_cents_float: channel_obj.detune_cents_float,
    glide_ms_float: channel_obj.glide_ms_float,
    is_muted_bool: channel_obj.is_muted_bool,
    is_soloed_bool: channel_obj.is_soloed_bool,
  };
}

/**
 * Validate and clamp one restored numeric field.
 *
 * Arguments:
 *   candidate_float (number): Value from the saved state.
 *   fallback_float (number): Value to keep when the candidate is invalid.
 *   lower_float (number): Inclusive minimum.
 *   upper_float (number): Inclusive maximum.
 *
 * Returns:
 *   (number): A safe value within range.
 */
function restoreNumber(candidate_float, fallback_float, lower_float,
                       upper_float) {
  if (!Number.isFinite(candidate_float)) {
    return fallback_float;
  }
  return clampToRange(candidate_float, lower_float, upper_float);
}

/**
 * Restore a channel from a previously captured state object.
 *
 * Brief:
 *   Applies state directly to the channel's fields and then starts or stops
 *   it, rather than going through the setters. That avoids emitting a dozen
 *   change events for what the user experiences as one action.
 *
 * Arguments:
 *   channel_obj (ToneChannel): Channel to write into.
 *   state_obj (Object): State previously produced by captureChannelState.
 *
 * Returns:
 *   (ToneChannel): The same channel, for chaining.
 *
 * Warning:
 *   Starts or stops the channel as a side effect, because the running state
 *   is part of what was captured.
 */
export function restoreChannelState(channel_obj, state_obj = {}) {
  if (!state_obj || typeof state_obj !== 'object') {
    return channel_obj;
  }

  restoreNumericFields(channel_obj, state_obj);
  restoreDiscreteFields(channel_obj, state_obj);

  if (state_obj.is_enabled_bool) {
    channel_obj.start();
  } else {
    channel_obj.stop();
  }

  channel_obj.emit('change', channel_obj);
  return channel_obj;
}

/**
 * Restore the continuously valued fields of a channel.
 *
 * Arguments:
 *   channel_obj (ToneChannel): Channel to write into.
 *   state_obj (Object): Captured state.
 *
 * Returns:
 *   (none)
 */
function restoreNumericFields(channel_obj, state_obj) {
  channel_obj.frequency_hertz_float = restoreNumber(
    state_obj.frequency_hertz_float,
    channel_obj.frequency_hertz_float,
    MIN_FREQUENCY_HERTZ_FLOAT,
    channel_obj.engine_obj.maxFrequencyHertz
  );
  channel_obj.gain_db_float = restoreNumber(
    state_obj.gain_db_float,
    channel_obj.gain_db_float,
    SILENCE_THRESHOLD_DB_FLOAT,
    0
  );
  channel_obj.pan_position_float = restoreNumber(
    state_obj.pan_position_float,
    channel_obj.pan_position_float,
    -1,
    1
  );
  channel_obj.detune_cents_float = restoreNumber(
    state_obj.detune_cents_float,
    channel_obj.detune_cents_float,
    -MAX_DETUNE_CENTS_FLOAT,
    MAX_DETUNE_CENTS_FLOAT
  );
  channel_obj.glide_ms_float = restoreNumber(
    state_obj.glide_ms_float,
    channel_obj.glide_ms_float,
    0,
    MAX_GLIDE_MS_FLOAT
  );
}

/**
 * Restore the enumerated and boolean fields of a channel.
 *
 * Arguments:
 *   channel_obj (ToneChannel): Channel to write into.
 *   state_obj (Object): Captured state.
 *
 * Returns:
 *   (none)
 */
function restoreDiscreteFields(channel_obj, state_obj) {
  if (WAVEFORM_KEYS_LIST.includes(state_obj.waveform_name_str)) {
    channel_obj.waveform_name_str = state_obj.waveform_name_str;
  }
  if (Number.isFinite(state_obj.phase_degrees_int)) {
    channel_obj.phase_degrees_int = normalisePhaseDegrees(
      state_obj.phase_degrees_int
    );
  }

  channel_obj.is_muted_bool = !!state_obj.is_muted_bool;
  channel_obj.is_soloed_bool = !!state_obj.is_soloed_bool;
  channel_obj.panner_node.pan.value = channel_obj.pan_position_float;
}
