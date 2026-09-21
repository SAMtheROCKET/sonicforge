/**
 * Amplitude conversion and formatting in the decibel full-scale domain.
 *
 * Brief:
 *   Every fader in SonicForge is calibrated in dBFS because that is the unit
 *   audio engineers reason in, while every Web Audio GainNode wants a linear
 *   multiplier. This module is the only place that conversion happens, so the
 *   silence floor is defined once and behaves identically everywhere.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Levels at or below this collapse to true silence rather than a denormal. */
export const SILENCE_THRESHOLD_DB_FLOAT = -90;

/** Decibels per amplitude decade, fixed by the definition of dBFS. */
const DECIBELS_PER_DECADE_FLOAT = 20;

/** Rendered in place of a numeric level when a channel is fully silent. */
const NEGATIVE_INFINITY_GLYPH_STR = '-∞';

/* ------------------------------------------------------------------------ */

/**
 * Convert a decibel full-scale level into a linear amplitude multiplier.
 *
 * Brief:
 *   Levels at or below the silence threshold return exactly zero. That
 *   matters for more than tidiness: a gain node held at a denormal value
 *   can cost real CPU on some platforms, and an exact zero lets the audio
 *   graph skip the branch entirely.
 *
 * Arguments:
 *   level_db_float (number): Level in dBFS. May be -Infinity or NaN.
 *
 * Returns:
 *   (number): Linear amplitude, where 0 dBFS returns exactly 1.0.
 *
 * Warning:
 *   Levels above 0 dBFS return a multiplier greater than one and will clip
 *   unless the master limiter is engaged.
 */
export function convertDbToLinear(level_db_float) {
  const is_silent_bool =
    !Number.isFinite(level_db_float) ||
    level_db_float <= SILENCE_THRESHOLD_DB_FLOAT;

  if (is_silent_bool) {
    return 0;
  }
  return 10 ** (level_db_float / DECIBELS_PER_DECADE_FLOAT);
}

/**
 * Convert a linear amplitude into a decibel full-scale level.
 *
 * Brief:
 *   The inverse of convertDbToLinear, used by every meter. Silence maps to
 *   negative infinity rather than to the silence threshold, so that a meter
 *   can distinguish "nothing at all" from "very quiet".
 *
 * Arguments:
 *   amplitude_linear_float (number): Linear amplitude, sign ignored.
 *
 * Returns:
 *   (number): Level in dBFS, or -Infinity for an amplitude of zero.
 *
 * Warning:
 *   Returns -Infinity rather than a large negative number for silence, so
 *   callers must guard before formatting or arithmetic.
 */
export function convertLinearToDb(amplitude_linear_float) {
  const magnitude_float = Math.abs(amplitude_linear_float);
  if (magnitude_float <= 0) {
    return -Infinity;
  }
  return DECIBELS_PER_DECADE_FLOAT * Math.log10(magnitude_float);
}

/**
 * Format a decibel level for display, rendering silence conventionally.
 *
 * Brief:
 *   Meters must never print "-Infinity" or "NaN" at a user. Anything at or
 *   below the silence threshold becomes the minus-infinity glyph that audio
 *   hardware has used for decades.
 *
 * Arguments:
 *   level_db_float (number): Level in dBFS.
 *   decimal_places_int (number): Decimals to show for finite levels.
 *
 * Returns:
 *   (string): Signed level such as "+1.5" or "-18.0", or the minus-infinity
 *   glyph when the level is at or below the silence threshold.
 */
export function formatDb(level_db_float, decimal_places_int = 1) {
  const is_silent_bool =
    !Number.isFinite(level_db_float) ||
    level_db_float <= SILENCE_THRESHOLD_DB_FLOAT;

  if (is_silent_bool) {
    return NEGATIVE_INFINITY_GLYPH_STR;
  }

  const sign_str = level_db_float > 0 ? '+' : '';
  return sign_str + level_db_float.toFixed(decimal_places_int);
}

/**
 * Scale a sample buffer in place so its loudest sample hits a ceiling.
 *
 * Brief:
 *   Used where headroom is the binding constraint rather than perceived
 *   loudness. Operates in place because these buffers are megabytes and
 *   copying them would stall the audio thread.
 *
 * Arguments:
 *   samples_float32array (Float32Array): Buffer modified in place.
 *   ceiling_linear_float (number): Target peak amplitude.
 *
 * Returns:
 *   (number): The peak amplitude found before scaling.
 *
 * Warning:
 *   A buffer of pure silence is left untouched and returns 0, because
 *   scaling it would amplify nothing into nothing.
 */
export function normalisePeakInPlace(samples_float32array,
                                     ceiling_linear_float = 0.95) {
  let peak_linear_float = 0;
  for (
    let index_int = 0;
    index_int < samples_float32array.length;
    index_int += 1
  ) {
    const magnitude_float = Math.abs(samples_float32array[index_int]);
    if (magnitude_float > peak_linear_float) {
      peak_linear_float = magnitude_float;
    }
  }

  if (peak_linear_float === 0) {
    return 0;
  }

  const scale_float = ceiling_linear_float / peak_linear_float;
  for (
    let index_int = 0;
    index_int < samples_float32array.length;
    index_int += 1
  ) {
    samples_float32array[index_int] *= scale_float;
  }
  return peak_linear_float;
}

/**
 * Scale a sample buffer in place to a target root-mean-square level.
 *
 * Brief:
 *   RMS is the correct target when matching noise colours, because peak
 *   normalisation would make violet noise sound far quieter than brown at
 *   the same nominal setting. The scale factor is then reduced if needed so
 *   that no individual sample is driven past full scale.
 *
 * Arguments:
 *   samples_float32array (Float32Array): Buffer modified in place.
 *   target_rms_linear_float (number): Desired RMS amplitude.
 *
 * Returns:
 *   (number): The RMS amplitude measured before scaling.
 *
 * Warning:
 *   The peak guard means the achieved RMS can fall short of the target for
 *   very peaky material, which is the correct trade against clipping.
 */
export function normaliseRmsInPlace(samples_float32array,
                                    target_rms_linear_float = 0.2) {
  let squared_total_float = 0;
  for (
    let index_int = 0;
    index_int < samples_float32array.length;
    index_int += 1
  ) {
    squared_total_float +=
      samples_float32array[index_int] * samples_float32array[index_int];
  }

  const measured_rms_float = Math.sqrt(
    squared_total_float / samples_float32array.length
  );
  if (measured_rms_float === 0) {
    return 0;
  }

  let scale_float = target_rms_linear_float / measured_rms_float;
  let peak_linear_float = 0;
  for (
    let index_int = 0;
    index_int < samples_float32array.length;
    index_int += 1
  ) {
    const magnitude_float = Math.abs(samples_float32array[index_int]);
    if (magnitude_float > peak_linear_float) {
      peak_linear_float = magnitude_float;
    }
  }

  if (peak_linear_float * scale_float > 0.999) {
    scale_float = 0.999 / peak_linear_float;
  }

  for (
    let index_int = 0;
    index_int < samples_float32array.length;
    index_int += 1
  ) {
    samples_float32array[index_int] *= scale_float;
  }
  return measured_rms_float;
}
