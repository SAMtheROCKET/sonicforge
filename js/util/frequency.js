/**
 * Logarithmic frequency mapping and human-readable time formatting.
 *
 * Brief:
 *   Pitch is a ratio scale, so every frequency control, axis and analysis
 *   grid in SonicForge is logarithmic. Centralising the mapping here means
 *   the dial, the spectrogram axis and the calibration grid cannot drift
 *   apart, which they would immediately if each computed its own.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Lowest frequency conventionally treated as audible. */
export const AUDIBLE_FLOOR_HERTZ_FLOAT = 20;

/** Highest frequency conventionally treated as audible. */
export const AUDIBLE_CEILING_HERTZ_FLOAT = 20000;

/** Threshold above which a frequency is displayed in kilohertz. */
const KILOHERTZ_DISPLAY_THRESHOLD_FLOAT = 1000;

/** Threshold above which a duration is displayed in seconds. */
const SECONDS_DISPLAY_THRESHOLD_MS_FLOAT = 1000;

/** Threshold above which a duration is displayed as minutes and seconds. */
const MINUTES_DISPLAY_THRESHOLD_MS_FLOAT = 60000;

/* ------------------------------------------------------------------------ */

/**
 * Convert a normalised position into a frequency on a logarithmic scale.
 *
 * Brief:
 *   Equal movements in position produce equal musical intervals, which is
 *   what makes a frequency control feel correct across the whole band.
 *
 * Arguments:
 *   position_float (number): Position from 0 to 1, clamped internally.
 *   lower_hertz_float (number): Frequency at position 0.
 *   upper_hertz_float (number): Frequency at position 1.
 *
 * Returns:
 *   (number): The frequency in hertz at that position.
 *
 * Warning:
 *   The lower bound must be greater than zero; a logarithmic scale has no
 *   meaningful zero point.
 */
export function mapPositionToFrequency(position_float, lower_hertz_float,
                                       upper_hertz_float) {
  const clamped_position_float = Math.min(Math.max(position_float, 0), 1);
  const span_ratio_float = upper_hertz_float / lower_hertz_float;
  return lower_hertz_float * span_ratio_float ** clamped_position_float;
}

/**
 * Convert a frequency into its normalised position on a logarithmic scale.
 *
 * Brief:
 *   The inverse of mapPositionToFrequency. Used to place a measured tone on
 *   a log axis and to locate a frequency within an analysis grid.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to locate.
 *   lower_hertz_float (number): Frequency at position 0.
 *   upper_hertz_float (number): Frequency at position 1.
 *
 * Returns:
 *   (number): Position from 0 to 1, clamped to the range.
 */
export function mapFrequencyToPosition(frequency_hertz_float,
                                       lower_hertz_float,
                                       upper_hertz_float) {
  const position_float =
    Math.log(frequency_hertz_float / lower_hertz_float) /
    Math.log(upper_hertz_float / lower_hertz_float);
  return Math.min(Math.max(position_float, 0), 1);
}

/**
 * Measure the interval between two frequencies in octaves.
 *
 * Brief:
 *   Octaves are the natural unit for spectral slope, which is quoted in
 *   decibels per octave throughout the noise synthesis code.
 *
 * Arguments:
 *   from_hertz_float (number): Reference frequency.
 *   to_hertz_float (number): Target frequency.
 *
 * Returns:
 *   (number): Signed octave distance; 1.0 means exactly double.
 */
export function measureOctavesBetween(from_hertz_float, to_hertz_float) {
  return Math.log2(to_hertz_float / from_hertz_float);
}

/**
 * Build a logarithmically spaced frequency grid.
 *
 * Brief:
 *   Used as the analysis grid for room calibration and as the display grid
 *   for the spectrogram, so that low frequencies receive the resolution
 *   they need instead of being crushed into the first few points.
 *
 * Arguments:
 *   lower_hertz_float (number): First grid frequency, inclusive.
 *   upper_hertz_float (number): Last grid frequency, inclusive.
 *   point_count_int (number): Number of grid points to produce.
 *
 * Returns:
 *   (Float64Array): Ascending frequencies with a constant ratio between
 *   consecutive entries.
 *
 * Warning:
 *   A point count of one returns only the lower bound.
 */
export function buildLogFrequencyGrid(lower_hertz_float, upper_hertz_float,
                                      point_count_int) {
  const grid_float64array = new Float64Array(point_count_int);
  if (point_count_int === 1) {
    grid_float64array[0] = lower_hertz_float;
    return grid_float64array;
  }

  const log_step_float =
    Math.log(upper_hertz_float / lower_hertz_float) / (point_count_int - 1);

  for (let index_int = 0; index_int < point_count_int; index_int += 1) {
    grid_float64array[index_int] =
      lower_hertz_float * Math.exp(log_step_float * index_int);
  }
  return grid_float64array;
}

/**
 * Format a frequency for display, switching to kilohertz where sensible.
 *
 * Brief:
 *   Precision is traded for readability as frequency rises, because a tenth
 *   of a hertz matters at 40 Hz and is meaningless at 18 kHz.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to format.
 *   decimal_places_int (number): Decimals for sub-kilohertz values.
 *
 * Returns:
 *   (string): A value with its unit, such as "440 Hz" or "1.25 kHz".
 */
export function formatFrequency(frequency_hertz_float,
                                decimal_places_int = 2) {
  if (!Number.isFinite(frequency_hertz_float)) {
    return '--';
  }

  if (frequency_hertz_float >= KILOHERTZ_DISPLAY_THRESHOLD_FLOAT) {
    const kilohertz_float =
      frequency_hertz_float / KILOHERTZ_DISPLAY_THRESHOLD_FLOAT;
    const decimals_int = frequency_hertz_float >= 10000 ? 1 : 2;
    return `${kilohertz_float.toFixed(decimals_int)} kHz`;
  }

  const scale_float = 10 ** decimal_places_int;
  const rounded_float =
    Math.round(frequency_hertz_float * scale_float) / scale_float;
  return `${rounded_float} Hz`;
}

/**
 * Format a duration compactly, scaling the unit to the magnitude.
 *
 * Brief:
 *   Drives the script terminal's live countdown, so it must stay legible
 *   across four orders of magnitude, from a 5 ms blip to a 20 minute run.
 *
 * Arguments:
 *   duration_ms_float (number): Duration in milliseconds.
 *
 * Returns:
 *   (string): A duration such as "750ms", "1.2s", or "2:05.0".
 *
 * Warning:
 *   Negative or non-finite durations render as "--" rather than throwing,
 *   because this is used inside a live countdown that must never break.
 */
export function formatDuration(duration_ms_float) {
  if (!Number.isFinite(duration_ms_float) || duration_ms_float < 0) {
    return '--';
  }

  if (duration_ms_float < SECONDS_DISPLAY_THRESHOLD_MS_FLOAT) {
    return `${Math.round(duration_ms_float)}ms`;
  }

  if (duration_ms_float < MINUTES_DISPLAY_THRESHOLD_MS_FLOAT) {
    return `${(duration_ms_float / SECONDS_DISPLAY_THRESHOLD_MS_FLOAT)
      .toFixed(1)}s`;
  }

  const minutes_int = Math.floor(
    duration_ms_float / MINUTES_DISPLAY_THRESHOLD_MS_FLOAT
  );
  const seconds_float =
    (duration_ms_float % MINUTES_DISPLAY_THRESHOLD_MS_FLOAT) /
    SECONDS_DISPLAY_THRESHOLD_MS_FLOAT;
  return `${minutes_int}:${seconds_float.toFixed(1).padStart(4, '0')}`;
}
