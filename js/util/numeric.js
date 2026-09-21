/**
 * Dimensionless numeric helpers: ranges, interpolation, and statistics.
 *
 * Brief:
 *   Everything here is pure, side-effect free, and independent of audio.
 *   It is separated from the amplitude and frequency helpers because those
 *   carry physical units and these deliberately do not - mixing them is how
 *   a gain ends up being clamped as if it were a frequency.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

export const TAU_FLOAT = Math.PI * 2;

const SMOOTHING_REFERENCE_MS_FLOAT = 1000;

/* ------------------------------------------------------------------------ */

/**
 * Constrain a value to an inclusive range.
 *
 * Brief:
 *   The most-used guard in the codebase. Every user-supplied number reaches
 *   the audio graph through one of these, so that a stray keystroke cannot
 *   ask an oscillator for a negative frequency.
 *
 * Arguments:
 *   value_float (number): Value to constrain.
 *   lower_bound_float (number): Inclusive minimum.
 *   upper_bound_float (number): Inclusive maximum.
 *
 * Returns:
 *   (number): The value, limited to the range.
 *
 * Warning:
 *   Bounds are used as given. Passing them reversed returns the lower
 *   bound for every input rather than throwing.
 */
export function clampToRange(value_float, lower_bound_float,
                             upper_bound_float) {
  if (value_float < lower_bound_float) {
    return lower_bound_float;
  }
  if (value_float > upper_bound_float) {
    return upper_bound_float;
  }
  return value_float;
}

/**
 * Interpolate linearly between two values.
 *
 * Brief:
 *   The building block for every fade, ramp and colour blend.
 *
 * Arguments:
 *   start_float (number): Value returned when position is 0.
 *   end_float (number): Value returned when position is 1.
 *   position_float (number): Interpolation position, normally 0 to 1.
 *
 * Returns:
 *   (number): The interpolated value.
 *
 * Warning:
 *   The position is not clamped, so values outside 0 to 1 extrapolate.
 */
export function interpolateLinear(start_float, end_float, position_float) {
  return start_float + (end_float - start_float) * position_float;
}

/**
 * Find the normalised position of a value within a range.
 *
 * Brief:
 *   The inverse of interpolateLinear, used to turn a value back into the
 *   slider position that represents it.
 *
 * Arguments:
 *   start_float (number): Value mapping to position 0.
 *   end_float (number): Value mapping to position 1.
 *   value_float (number): Value to locate.
 *
 * Returns:
 *   (number): Position clamped to 0 through 1.
 *
 * Warning:
 *   A zero-width range returns 0 rather than dividing by zero.
 */
export function findNormalisedPosition(start_float, end_float, value_float) {
  if (end_float === start_float) {
    return 0;
  }
  return clampToRange(
    (value_float - start_float) / (end_float - start_float),
    0,
    1
  );
}

/**
 * Remap a value from one linear range onto another.
 *
 * Brief:
 *   Used wherever a control range and a parameter range differ, such as a
 *   pixel drag distance driving a decibel value.
 *
 * Arguments:
 *   value_float (number): Value in the input range.
 *   input_start_float (number): Input range minimum.
 *   input_end_float (number): Input range maximum.
 *   output_start_float (number): Output range minimum.
 *   output_end_float (number): Output range maximum.
 *
 * Returns:
 *   (number): The value expressed in the output range.
 *
 * Warning:
 *   The normalised position is clamped, so the result never leaves the
 *   output range even when the input does.
 */
export function remapBetweenRanges(value_float, input_start_float,
                                   input_end_float, output_start_float,
                                   output_end_float) {
  const position_float = findNormalisedPosition(
    input_start_float,
    input_end_float,
    value_float
  );
  return interpolateLinear(
    output_start_float,
    output_end_float,
    position_float
  );
}

/**
 * Round a value to a fixed number of decimal places.
 *
 * Brief:
 *   Display-only rounding. Never round a value that is about to be fed back
 *   into the audio graph; accumulated rounding drifts audibly over time.
 *
 * Arguments:
 *   value_float (number): Value to round.
 *   decimal_places_int (number): Decimal places to keep.
 *
 * Returns:
 *   (number): The rounded value.
 *
 * Warning:
 *   Compensates for binary representation error so that 2.675 rounds to
 *   2.68 rather than 2.67. It is not arbitrary-precision arithmetic.
 */
export function roundToDecimals(value_float, decimal_places_int = 0) {
  const scale_float = 10 ** decimal_places_int;
  const bias_float =
    Number.EPSILON * Math.sign(value_float || 1) * Math.abs(value_float);
  return Math.round((value_float + bias_float) * scale_float) / scale_float;
}

/**
 * Compute the arithmetic mean of a numeric sequence.
 *
 * Brief:
 *   The mean is the right summary for well-behaved data. For anything
 *   measured through a microphone, prefer computeMedian - a single
 *   reflection skews a mean badly.
 *
 * Arguments:
 *   values_arr (ArrayLike<number>): Values to average.
 *
 * Returns:
 *   (number): The mean, or 0 for an empty sequence.
 */
export function computeMean(values_arr) {
  if (!values_arr.length) {
    return 0;
  }

  let running_total_float = 0;
  for (let index_int = 0; index_int < values_arr.length; index_int += 1) {
    running_total_float += values_arr[index_int];
  }
  return running_total_float / values_arr.length;
}

/**
 * Compute the median of a numeric sequence.
 *
 * Brief:
 *   Preferred over the mean for acoustic measurements, because a single
 *   reflection or a burst of background noise skews a mean badly while
 *   barely moving a median.
 *
 * Arguments:
 *   values_arr (ArrayLike<number>): Values to reduce.
 *
 * Returns:
 *   (number): The median, or 0 for an empty sequence.
 *
 * Warning:
 *   Copies and sorts the input, so cost is O(n log n) and the original
 *   ordering is preserved.
 */
export function computeMedian(values_arr) {
  if (!values_arr.length) {
    return 0;
  }

  const sorted_float64array = Float64Array.from(values_arr).sort();
  const middle_index_int = sorted_float64array.length >> 1;

  if (sorted_float64array.length % 2) {
    return sorted_float64array[middle_index_int];
  }
  return (
    (sorted_float64array[middle_index_int - 1] +
      sorted_float64array[middle_index_int]) /
    2
  );
}

/**
 * Compute the sample standard deviation of a numeric sequence.
 *
 * Brief:
 *   Used to judge how trustworthy a repeated measurement is: a large spread
 *   across calibration probes means the room or the microphone moved.
 *
 * Arguments:
 *   values_arr (ArrayLike<number>): Values to measure.
 *
 * Returns:
 *   (number): Standard deviation, or 0 for fewer than two values.
 *
 * Warning:
 *   Uses the sample divisor (n - 1), not the population divisor.
 */
export function computeStandardDeviation(values_arr) {
  if (values_arr.length < 2) {
    return 0;
  }

  const mean_float = computeMean(values_arr);
  let squared_error_total_float = 0;
  for (let index_int = 0; index_int < values_arr.length; index_int += 1) {
    squared_error_total_float += (values_arr[index_int] - mean_float) ** 2;
  }
  return Math.sqrt(squared_error_total_float / (values_arr.length - 1));
}

/**
 * Compute the coefficient of a one-pole smoothing filter.
 *
 * Brief:
 *   Meters and readouts need smoothing expressed in time, not in an opaque
 *   coefficient. This converts the intent - 'settle in 120 ms' - into the
 *   number the recurrence actually needs.
 *
 * Arguments:
 *   time_constant_ms_float (number): Time to reach 1/e of a step change.
 *   update_rate_hertz_float (number): How often the filter is evaluated.
 *
 * Returns:
 *   (number): Coefficient in 0 through 1 for the recurrence
 *   smoothed = smoothed * coefficient + input * (1 - coefficient).
 */
export function computeOnePoleCoefficient(time_constant_ms_float,
                                          update_rate_hertz_float) {
  const time_constant_seconds_float =
    time_constant_ms_float / SMOOTHING_REFERENCE_MS_FLOAT;
  return Math.exp(
    -1 / (time_constant_seconds_float * update_rate_hertz_float)
  );
}

/**
 * Round a count up to the next power of two.
 *
 * Brief:
 *   Required wherever a radix-2 FFT is used, since those transforms accept
 *   only power-of-two lengths.
 *
 * Arguments:
 *   count_int (number): Minimum required size.
 *
 * Returns:
 *   (number): The smallest power of two greater than or equal to the count.
 *
 * Warning:
 *   Counts of one or less return 1, not 0 or 2.
 */
export function roundUpToPowerOfTwo(count_int) {
  if (count_int <= 1) {
    return 1;
  }
  return 1 << (32 - Math.clz32(count_int - 1));
}

/**
 * Report whether a count is an exact power of two.
 *
 * Brief:
 *   Guards the FFT constructor, which has no meaning for other lengths.
 *
 * Arguments:
 *   count_int (number): Value to test.
 *
 * Returns:
 *   (boolean): True when the value is a positive power of two.
 */
export function isPowerOfTwo(count_int) {
  return count_int > 0 && (count_int & (count_int - 1)) === 0;
}
