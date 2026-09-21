/**
 * Fractional-octave smoothing and logarithmic curve resampling.
 *
 * Brief:
 *   A raw FFT of a real room is a comb of reflection artefacts. Inverting it
 *   band-for-band would produce a correction curve that fixes one listening
 *   position and ruins every other. Smoothing to third-octave resolution
 *   keeps the trends a speaker actually has and discards the interference
 *   pattern that belongs to one microphone position.
 */

import { buildLogFrequencyGrid } from '../util/frequency.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Default smoothing width, in fractions of an octave. */
const DEFAULT_OCTAVE_FRACTION_INT = 3;

/** Decibel value reported for a band containing no energy. */
const SILENT_BAND_DB_FLOAT = -200;

/** Default resolution of a standard analysis grid. */
const DEFAULT_GRID_POINT_COUNT_INT = 96;

/* ------------------------------------------------------------------------ */

/**
 * Smooth a magnitude response over fractional-octave bands.
 *
 * Brief:
 *   Each output point is the root-mean-square of every input bin inside its
 *   band. RMS is correct here because power is the additive quantity; a
 *   plain mean of magnitudes would under-report every peak.
 *
 * Arguments:
 *   frequencies_arr (ArrayLike<number>): Ascending bin frequencies.
 *   magnitudes_arr (ArrayLike<number>): Linear magnitudes, same length.
 *   octave_fraction_int (number): Width divisor; 3 gives third-octave.
 *   target_frequencies_arr (ArrayLike<number>): Output grid.
 *
 * Returns:
 *   (Float64Array): Smoothed linear magnitudes on the target grid.
 *
 * Warning:
 *   Where a band is narrower than the bin spacing, the nearest bin is used
 *   instead. That keeps the curve continuous at low frequencies where a
 *   third-octave band may contain no bins at all.
 */
export function smoothOverFractionalOctaves(
  frequencies_arr,
  magnitudes_arr,
  octave_fraction_int = DEFAULT_OCTAVE_FRACTION_INT,
  target_frequencies_arr = frequencies_arr
) {
  const half_width_ratio_float = 2 ** (1 / (2 * octave_fraction_int));
  const smoothed_float64array = new Float64Array(
    target_frequencies_arr.length
  );
  let search_start_int = 0;

  for (
    let output_index_int = 0;
    output_index_int < target_frequencies_arr.length;
    output_index_int += 1
  ) {
    const centre_hertz_float = target_frequencies_arr[output_index_int];
    if (!(centre_hertz_float > 0)) {
      continue;
    }

    const lower_hertz_float = centre_hertz_float / half_width_ratio_float;
    const upper_hertz_float = centre_hertz_float * half_width_ratio_float;

    search_start_int = advanceToBandStart(
      frequencies_arr,
      search_start_int,
      lower_hertz_float
    );

    smoothed_float64array[output_index_int] = computeBandRms(
      frequencies_arr,
      magnitudes_arr,
      search_start_int,
      upper_hertz_float,
      centre_hertz_float
    );
  }
  return smoothed_float64array;
}

/**
 * Move a scan cursor to the first bin at or above a band's lower edge.
 *
 * Arguments:
 *   frequencies_arr (ArrayLike<number>): Ascending bin frequencies.
 *   cursor_int (number): Current scan position.
 *   lower_hertz_float (number): Band lower edge.
 *
 * Returns:
 *   (number): Updated cursor position.
 */
function advanceToBandStart(frequencies_arr, cursor_int, lower_hertz_float) {
  let position_int = cursor_int;

  while (
    position_int > 0 &&
    frequencies_arr[position_int] > lower_hertz_float
  ) {
    position_int -= 1;
  }
  while (
    position_int < frequencies_arr.length &&
    frequencies_arr[position_int] < lower_hertz_float
  ) {
    position_int += 1;
  }
  return position_int;
}

/**
 * Compute the root-mean-square magnitude across one band.
 *
 * Arguments:
 *   frequencies_arr (ArrayLike<number>): Ascending bin frequencies.
 *   magnitudes_arr (ArrayLike<number>): Linear magnitudes.
 *   start_index_int (number): First bin inside the band.
 *   upper_hertz_float (number): Band upper edge.
 *   centre_hertz_float (number): Band centre, for the empty-band fallback.
 *
 * Returns:
 *   (number): Band RMS magnitude, or the nearest bin when the band is empty.
 */
function computeBandRms(frequencies_arr, magnitudes_arr, start_index_int,
                        upper_hertz_float, centre_hertz_float) {
  let squared_total_float = 0;
  let bin_count_int = 0;

  for (
    let bin_index_int = start_index_int;
    bin_index_int < frequencies_arr.length &&
    frequencies_arr[bin_index_int] <= upper_hertz_float;
    bin_index_int += 1
  ) {
    squared_total_float +=
      magnitudes_arr[bin_index_int] * magnitudes_arr[bin_index_int];
    bin_count_int += 1;
  }

  if (bin_count_int) {
    return Math.sqrt(squared_total_float / bin_count_int);
  }
  return findNearestBinMagnitude(
    frequencies_arr,
    magnitudes_arr,
    start_index_int,
    centre_hertz_float
  );
}

/**
 * Find the magnitude of the bin closest to a target frequency.
 *
 * Arguments:
 *   frequencies_arr (ArrayLike<number>): Ascending bin frequencies.
 *   magnitudes_arr (ArrayLike<number>): Linear magnitudes.
 *   around_index_int (number): Index to search around.
 *   target_hertz_float (number): Frequency to match.
 *
 * Returns:
 *   (number): Magnitude of the nearest bin, or 0 when none exists.
 */
function findNearestBinMagnitude(frequencies_arr, magnitudes_arr,
                                 around_index_int, target_hertz_float) {
  let best_index_int = 0;
  let best_distance_float = Infinity;

  const first_int = Math.max(0, around_index_int - 1);
  const last_int = Math.min(frequencies_arr.length, around_index_int + 2);

  for (
    let bin_index_int = first_int;
    bin_index_int < last_int;
    bin_index_int += 1
  ) {
    const distance_float = Math.abs(
      frequencies_arr[bin_index_int] - target_hertz_float
    );
    if (distance_float < best_distance_float) {
      best_distance_float = distance_float;
      best_index_int = bin_index_int;
    }
  }
  return magnitudes_arr[best_index_int] ?? 0;
}

/**
 * Smooth a decibel response over fractional-octave bands.
 *
 * Brief:
 *   Converts to linear magnitude, smooths there, and converts back, because
 *   averaging decibels directly would weight quiet bins far too heavily.
 *
 * Arguments:
 *   frequencies_arr (ArrayLike<number>): Ascending bin frequencies.
 *   magnitudes_db_arr (ArrayLike<number>): Magnitudes in decibels.
 *   octave_fraction_int (number): Width divisor; 3 gives third-octave.
 *   target_frequencies_arr (ArrayLike<number>): Output grid.
 *
 * Returns:
 *   (Float64Array): Smoothed magnitudes in decibels.
 */
export function smoothDecibelsOverFractionalOctaves(
  frequencies_arr,
  magnitudes_db_arr,
  octave_fraction_int = DEFAULT_OCTAVE_FRACTION_INT,
  target_frequencies_arr = frequencies_arr
) {
  const linear_float64array = new Float64Array(magnitudes_db_arr.length);
  for (
    let index_int = 0;
    index_int < magnitudes_db_arr.length;
    index_int += 1
  ) {
    linear_float64array[index_int] = 10 ** (magnitudes_db_arr[index_int] / 20);
  }

  const smoothed_float64array = smoothOverFractionalOctaves(
    frequencies_arr,
    linear_float64array,
    octave_fraction_int,
    target_frequencies_arr
  );

  const decibels_float64array = new Float64Array(
    smoothed_float64array.length
  );
  for (
    let index_int = 0;
    index_int < smoothed_float64array.length;
    index_int += 1
  ) {
    decibels_float64array[index_int] =
      smoothed_float64array[index_int] > 0
        ? 20 * Math.log10(smoothed_float64array[index_int])
        : SILENT_BAND_DB_FLOAT;
  }
  return decibels_float64array;
}

/**
 * Resample a curve onto a new frequency grid, interpolating in log-frequency.
 *
 * Brief:
 *   Linear interpolation in log-frequency is the only interpolation that
 *   behaves sensibly across an audio decade. Interpolating linearly in
 *   hertz would place the midpoint between 100 Hz and 10 kHz at 5.05 kHz,
 *   which is musically almost at the top of the range.
 *
 * Arguments:
 *   source_frequencies_arr (ArrayLike<number>): Ascending source grid.
 *   source_values_arr (ArrayLike<number>): Value at each source frequency.
 *   target_frequencies_arr (ArrayLike<number>): Frequencies to sample at.
 *
 * Returns:
 *   (Float64Array): Interpolated values on the target grid.
 *
 * Warning:
 *   Targets outside the source range are clamped to the nearest end value
 *   rather than extrapolated, which would invent response that was never
 *   measured.
 */
export function resampleCurveOntoLogGrid(source_frequencies_arr,
                                         source_values_arr,
                                         target_frequencies_arr) {
  const resampled_float64array = new Float64Array(
    target_frequencies_arr.length
  );
  const last_source_int = source_frequencies_arr.length - 1;

  for (
    let target_index_int = 0;
    target_index_int < target_frequencies_arr.length;
    target_index_int += 1
  ) {
    const target_hertz_float = target_frequencies_arr[target_index_int];

    if (target_hertz_float <= source_frequencies_arr[0]) {
      resampled_float64array[target_index_int] = source_values_arr[0];
      continue;
    }
    if (target_hertz_float >= source_frequencies_arr[last_source_int]) {
      resampled_float64array[target_index_int] =
        source_values_arr[last_source_int];
      continue;
    }

    let upper_index_int = 1;
    while (
      upper_index_int < last_source_int &&
      source_frequencies_arr[upper_index_int] < target_hertz_float
    ) {
      upper_index_int += 1;
    }
    const lower_index_int = upper_index_int - 1;

    const position_float =
      Math.log(
        target_hertz_float / source_frequencies_arr[lower_index_int]
      ) /
      Math.log(
        source_frequencies_arr[upper_index_int] /
          source_frequencies_arr[lower_index_int]
      );

    resampled_float64array[target_index_int] =
      source_values_arr[lower_index_int] +
      (source_values_arr[upper_index_int] -
        source_values_arr[lower_index_int]) *
        position_float;
  }
  return resampled_float64array;
}

/**
 * Build the standard logarithmic analysis grid across the audible band.
 *
 * Brief:
 *   Both the calibration sweep and the spectrogram sample onto this grid, so
 *   defining it once keeps a measured curve and its display perfectly
 *   aligned instead of quietly offset by a fraction of a band.
 *
 * Arguments:
 *   point_count_int (number): Number of grid points.
 *   lower_hertz_float (number): Lowest grid frequency.
 *   upper_hertz_float (number): Highest grid frequency.
 *
 * Returns:
 *   (Float64Array): The analysis grid.
 */
export function buildStandardAnalysisGrid(
  point_count_int = DEFAULT_GRID_POINT_COUNT_INT,
  lower_hertz_float = 20,
  upper_hertz_float = 20000
) {
  return buildLogFrequencyGrid(
    lower_hertz_float,
    upper_hertz_float,
    point_count_int
  );
}
