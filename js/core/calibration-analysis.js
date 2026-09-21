/**
 * Turning a captured sweep response into a correction curve.
 *
 * Brief:
 *   The measurement produces accumulated power per frequency-grid point.
 *   Getting from there to a usable correction involves three judgements
 *   that matter more than the arithmetic:
 *
 *   1. Smooth to third-octave first. A raw response of a real room is a
 *      comb of reflection artefacts belonging to one microphone position;
 *      inverting it band-for-band fixes that one spot and ruins every other.
 *   2. Reference to the midband median, not the full-band median, or a
 *      rolled-off sub region drags the reference down and boosts everything.
 *   3. Never try to resurrect a band the hardware does not produce. Below a
 *      threshold the driver simply is not there, and boost only burns
 *      headroom and adds distortion.
 */

import { clampToRange, computeMedian } from '../util/numeric.js';
import { mapFrequencyToPosition } from '../util/frequency.js';
import {
  smoothDecibelsOverFractionalOctaves,
  resampleCurveOntoLogGrid,
} from '../dsp/smoothing.js';
import { EQ_BAND_CENTRES_HERTZ_LIST } from '../dsp/weighting.js';
import {
  SWEEP_START_HERTZ_FLOAT,
  SWEEP_END_HERTZ_FLOAT,
} from './calibration-capture.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Points in the analysis grid spanning the sweep range. */
export const ANALYSIS_GRID_POINTS_INT = 96;

/** Smoothing width, in fractions of an octave. */
const SMOOTHING_OCTAVE_FRACTION_INT = 3;

/** Band used to establish the reference level, in hertz. */
const REFERENCE_BAND_LOW_HERTZ_FLOAT = 200;
const REFERENCE_BAND_HIGH_HERTZ_FLOAT = 8000;

/** Deviation below which a band is treated as absent, in decibels. */
const ABSENT_BAND_THRESHOLD_DB_FLOAT = -18;

/** Largest correction any band may receive, in decibels. */
const MAX_CORRECTION_DB_FLOAT = 12;

/** Signal-to-noise a grid point needs to count as well measured. */
const GOOD_SNR_THRESHOLD_DB_FLOAT = 8;

/** Level assigned to a grid point that was never measured at all. */
const UNMEASURED_LEVEL_DB_FLOAT = -100;

/* ------------------------------------------------------------------------ */

/**
 * Convert a frequency into its index on the analysis grid.
 *
 * Brief:
 *   The grid is logarithmic, so this is a log mapping rather than a simple
 *   division. Used both when accumulating the sweep and when locating the
 *   reference band.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to locate.
 *
 * Returns:
 *   (number): Grid index, clamped to the grid bounds.
 */
export function convertHertzToGridIndex(frequency_hertz_float) {
  const position_float = mapFrequencyToPosition(
    frequency_hertz_float,
    SWEEP_START_HERTZ_FLOAT,
    SWEEP_END_HERTZ_FLOAT
  );
  return clampToRange(
    Math.round(position_float * (ANALYSIS_GRID_POINTS_INT - 1)),
    0,
    ANALYSIS_GRID_POINTS_INT - 1
  );
}

/**
 * Average accumulated power into a decibel response per grid point.
 *
 * Brief:
 *   Power is averaged, not decibels: decibels are logarithmic and averaging
 *   them under-weights the loud frames that carry the real signal.
 *
 * Arguments:
 *   power_float64array (Float64Array): Summed linear power per grid point.
 *   hit_counts_uint32array (Uint32Array): Samples contributing per point.
 *
 * Returns:
 *   (Object): response_db_float64array with NaN where nothing was measured,
 *   and covered_point_count_int.
 */
export function averageResponseToDecibels(power_float64array,
                                          hit_counts_uint32array) {
  const response_db_float64array = new Float64Array(
    ANALYSIS_GRID_POINTS_INT
  ).fill(NaN);
  let covered_point_count_int = 0;

  for (
    let index_int = 0;
    index_int < ANALYSIS_GRID_POINTS_INT;
    index_int += 1
  ) {
    if (!hit_counts_uint32array[index_int]) {
      continue;
    }
    response_db_float64array[index_int] =
      10 *
      Math.log10(
        power_float64array[index_int] / hit_counts_uint32array[index_int]
      );
    covered_point_count_int += 1;
  }

  return { response_db_float64array, covered_point_count_int };
}

/**
 * Replace unmeasured grid points with their nearest measured neighbour.
 *
 * Brief:
 *   Smoothing needs a continuous input. Leaving gaps as NaN would poison
 *   every band that overlaps them, turning a few missing points into a
 *   wholly invalid curve.
 *
 * Arguments:
 *   response_db_float64array (Float64Array): Response, modified in place.
 *
 * Returns:
 *   (Float64Array): The same array, with no gaps remaining.
 */
export function fillResponseGaps(response_db_float64array) {
  const length_int = response_db_float64array.length;
  let last_known_db_float = NaN;

  for (let index_int = 0; index_int < length_int; index_int += 1) {
    if (Number.isFinite(response_db_float64array[index_int])) {
      last_known_db_float = response_db_float64array[index_int];
    } else if (Number.isFinite(last_known_db_float)) {
      response_db_float64array[index_int] = last_known_db_float;
    }
  }

  last_known_db_float = NaN;
  for (let index_int = length_int - 1; index_int >= 0; index_int -= 1) {
    if (Number.isFinite(response_db_float64array[index_int])) {
      last_known_db_float = response_db_float64array[index_int];
    } else if (Number.isFinite(last_known_db_float)) {
      response_db_float64array[index_int] = last_known_db_float;
    } else {
      response_db_float64array[index_int] = UNMEASURED_LEVEL_DB_FLOAT;
    }
  }
  return response_db_float64array;
}

/**
 * Express a smoothed response as deviation from its midband reference.
 *
 * Brief:
 *   Referencing to the midband rather than the full band matters. A speaker
 *   rolled off below 80 Hz would drag a full-band median down and cause
 *   every other band to be boosted to match the part that is missing.
 *
 * Arguments:
 *   smoothed_db_float64array (Float64Array): Smoothed response.
 *
 * Returns:
 *   (Float64Array): Deviation in decibels, zero at the reference level.
 */
export function computeDeviationFromReference(smoothed_db_float64array) {
  const reference_low_index_int = convertHertzToGridIndex(
    REFERENCE_BAND_LOW_HERTZ_FLOAT
  );
  const reference_high_index_int = convertHertzToGridIndex(
    REFERENCE_BAND_HIGH_HERTZ_FLOAT
  );

  const reference_db_float = computeMedian(
    Array.from(
      smoothed_db_float64array.subarray(
        reference_low_index_int,
        reference_high_index_int + 1
      )
    )
  );

  const deviation_db_float64array = new Float64Array(
    smoothed_db_float64array.length
  );
  for (
    let index_int = 0;
    index_int < smoothed_db_float64array.length;
    index_int += 1
  ) {
    deviation_db_float64array[index_int] =
      smoothed_db_float64array[index_int] - reference_db_float;
  }
  return deviation_db_float64array;
}

/**
 * Derive per-band correction gains from a deviation curve.
 *
 * Brief:
 *   The correction is simply the inverse of the deviation, resampled onto
 *   the equaliser's band centres and clamped to what is safe to ask for.
 *
 * Arguments:
 *   analysis_grid_float64array (Float64Array): Grid frequencies.
 *   deviation_db_float64array (Float64Array): Deviation per grid point.
 *
 * Returns:
 *   (number[]): One correction gain per equaliser band, in decibels.
 *
 * Warning:
 *   A band measuring far below the reference receives zero correction, not
 *   a large boost. That band is missing because the driver cannot produce
 *   it, and boosting only burns headroom.
 */
export function deriveCorrectionGainsDb(analysis_grid_float64array,
                                        deviation_db_float64array) {
  const band_deviation_float64array = resampleCurveOntoLogGrid(
    analysis_grid_float64array,
    deviation_db_float64array,
    EQ_BAND_CENTRES_HERTZ_LIST
  );

  return Array.from(band_deviation_float64array, (deviation_db_float) => {
    if (deviation_db_float < ABSENT_BAND_THRESHOLD_DB_FLOAT) {
      return 0;
    }
    return clampToRange(
      -deviation_db_float,
      -MAX_CORRECTION_DB_FLOAT,
      MAX_CORRECTION_DB_FLOAT
    );
  });
}

/**
 * Score how much a measurement can be trusted.
 *
 * Brief:
 *   Combines coverage - how much of the band was measured at all - with
 *   signal-to-noise, because a curve derived from a quiet or partial
 *   measurement is worse than no curve. A low score should be shown to the
 *   user rather than silently applied.
 *
 * Arguments:
 *   smoothed_db_float64array (Float64Array): Smoothed response.
 *   noise_floor_db_float (number): Median noise floor.
 *   covered_point_count_int (number): Grid points actually measured.
 *
 * Returns:
 *   (number): Confidence from 0 through 1.
 */
export function scoreMeasurementConfidence(smoothed_db_float64array,
                                           noise_floor_db_float,
                                           covered_point_count_int) {
  const good_point_count_int = Array.from(smoothed_db_float64array).filter(
    (level_db_float) =>
      level_db_float - noise_floor_db_float > GOOD_SNR_THRESHOLD_DB_FLOAT
  ).length;

  const coverage_ratio_float =
    covered_point_count_int / ANALYSIS_GRID_POINTS_INT;
  const quality_ratio_float =
    good_point_count_int / ANALYSIS_GRID_POINTS_INT;

  return clampToRange(
    coverage_ratio_float * 0.5 + quality_ratio_float * 0.5,
    0,
    1
  );
}

/**
 * Run the complete analysis from accumulated power to a correction curve.
 *
 * Brief:
 *   The single entry point the calibrator calls. Sequencing the stages here
 *   keeps their order - average, fill, smooth, reference, invert - in one
 *   visible place, because that order is load-bearing.
 *
 * Arguments:
 *   options_obj (Object): analysis_grid_float64array, power_float64array,
 *     hit_counts_uint32array and noise_floor_db_float.
 *
 * Returns:
 *   (Object): raw_response_db_float64array, response_db_float64array,
 *   deviation_db_float64array, correction_db_list, confidence_float and
 *   coverage_ratio_float.
 */
export function analyseSweepResponse(options_obj) {
  const {
    analysis_grid_float64array,
    power_float64array,
    hit_counts_uint32array,
    noise_floor_db_float,
  } = options_obj;

  const { response_db_float64array, covered_point_count_int } =
    averageResponseToDecibels(power_float64array, hit_counts_uint32array);

  fillResponseGaps(response_db_float64array);

  const smoothed_db_float64array = smoothDecibelsOverFractionalOctaves(
    analysis_grid_float64array,
    response_db_float64array,
    SMOOTHING_OCTAVE_FRACTION_INT,
    analysis_grid_float64array
  );

  const deviation_db_float64array = computeDeviationFromReference(
    smoothed_db_float64array
  );

  return {
    raw_response_db_float64array: response_db_float64array,
    response_db_float64array: smoothed_db_float64array,
    deviation_db_float64array,
    correction_db_list: deriveCorrectionGainsDb(
      analysis_grid_float64array,
      deviation_db_float64array
    ),
    confidence_float: scoreMeasurementConfidence(
      smoothed_db_float64array,
      noise_floor_db_float,
      covered_point_count_int
    ),
    coverage_ratio_float:
      covered_point_count_int / ANALYSIS_GRID_POINTS_INT,
  };
}
