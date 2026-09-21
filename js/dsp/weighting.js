/**
 * Psychoacoustic frequency weighting curves.
 *
 * Brief:
 *   The ear is not a flat measuring instrument: it is roughly 50 dB less
 *   sensitive at 20 Hz than at 1 kHz. Two features depend on modelling that.
 *   Grey noise inverts the sensitivity curve so every octave sounds equally
 *   loud, and the calibration display uses weighting to decide which
 *   deviations are worth correcting.
 *
 *   The A and C curves are the IEC 61672 rational approximations, both
 *   normalised to exactly 0 dB at 1 kHz.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** ISO 266 third-octave nominal centre frequencies across the audio band. */
export const THIRD_OCTAVE_CENTRES_HERTZ_LIST = Object.freeze([
  20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500,
  630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000,
  10000, 12500, 16000, 20000,
]);

/** Centre frequencies of the ten auto-calibration correction bands. */
export const EQ_BAND_CENTRES_HERTZ_LIST = Object.freeze([
  31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000,
]);

/** Band carrying conversational speech intelligibility. */
export const VOCAL_BAND_HERTZ_DICT = Object.freeze({
  lower_hertz_float: 300,
  upper_hertz_float: 3400,
  centre_hertz_float: 1000,
});

/** Pole frequencies of the IEC 61672 weighting networks, in hertz. */
const A_WEIGHT_POLE_LOW_HERTZ_FLOAT = 20.6;
const A_WEIGHT_POLE_MID_LOW_HERTZ_FLOAT = 107.7;
const A_WEIGHT_POLE_MID_HIGH_HERTZ_FLOAT = 737.9;
const A_WEIGHT_POLE_HIGH_HERTZ_FLOAT = 12194;

/** Normalisation offsets making each curve read 0 dB at 1 kHz. */
const A_WEIGHT_OFFSET_DB_FLOAT = 2.0;
const C_WEIGHT_OFFSET_DB_FLOAT = 0.06;

/** Boost ceiling for grey noise, protecting drivers from the raw inverse. */
const GREY_MAX_BOOST_DB_FLOAT = 24;
const GREY_MAX_CUT_DB_FLOAT = -12;

/** Protective shelf frequencies applied to the grey weighting curve. */
const GREY_LOW_SHELF_HERTZ_FLOAT = 25;
const GREY_HIGH_SHELF_HERTZ_FLOAT = 17000;
const GREY_HIGH_SHELF_WIDTH_HERTZ_FLOAT = 5000;

/* ------------------------------------------------------------------------ */

/**
 * Compute the IEC 61672 A-weighting at a frequency, in decibels.
 *
 * Brief:
 *   A-weighting approximates the ear's sensitivity at conversational
 *   levels. Reference values: 0 dB at 1 kHz, about -19.1 dB at 100 Hz,
 *   about -50.4 dB at 20 Hz, and about -2.5 dB at 10 kHz.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to evaluate.
 *
 * Returns:
 *   (number): Weighting in decibels, relative to 1 kHz.
 *
 * Warning:
 *   Returns -Infinity at or below zero hertz, which has no defined
 *   weighting.
 */
export function computeAWeightingDb(frequency_hertz_float) {
  if (frequency_hertz_float <= 0) {
    return -Infinity;
  }

  const squared_float = frequency_hertz_float * frequency_hertz_float;
  const fourth_power_float = squared_float * squared_float;

  const numerator_float =
    A_WEIGHT_POLE_HIGH_HERTZ_FLOAT ** 2 * fourth_power_float;

  const denominator_float =
    (squared_float + A_WEIGHT_POLE_LOW_HERTZ_FLOAT ** 2) *
    Math.sqrt(
      (squared_float + A_WEIGHT_POLE_MID_LOW_HERTZ_FLOAT ** 2) *
        (squared_float + A_WEIGHT_POLE_MID_HIGH_HERTZ_FLOAT ** 2)
    ) *
    (squared_float + A_WEIGHT_POLE_HIGH_HERTZ_FLOAT ** 2);

  return (
    20 * Math.log10(numerator_float / denominator_float) +
    A_WEIGHT_OFFSET_DB_FLOAT
  );
}

/**
 * Compute the IEC 61672 C-weighting at a frequency, in decibels.
 *
 * Brief:
 *   C-weighting is nearly flat across the midband and rolls off only at the
 *   extremes, making it the right curve for high-level and peak measurement
 *   where A-weighting would understate low-frequency energy.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to evaluate.
 *
 * Returns:
 *   (number): Weighting in decibels, relative to 1 kHz.
 */
export function computeCWeightingDb(frequency_hertz_float) {
  if (frequency_hertz_float <= 0) {
    return -Infinity;
  }

  const squared_float = frequency_hertz_float * frequency_hertz_float;
  const numerator_float =
    A_WEIGHT_POLE_HIGH_HERTZ_FLOAT ** 2 * squared_float;
  const denominator_float =
    (squared_float + A_WEIGHT_POLE_LOW_HERTZ_FLOAT ** 2) *
    (squared_float + A_WEIGHT_POLE_HIGH_HERTZ_FLOAT ** 2);

  return (
    20 * Math.log10(numerator_float / denominator_float) +
    C_WEIGHT_OFFSET_DB_FLOAT
  );
}

/**
 * Compute the grey-noise shaping multiplier at a frequency.
 *
 * Brief:
 *   Grey noise is white noise shaped by the inverse of the ear's
 *   sensitivity, so it sounds equally loud in every octave even though a
 *   meter reads it as steeply tilted. The raw inverse demands roughly
 *   +50 dB at 20 Hz, which no driver survives and no listener wants, so the
 *   boost is capped and both extremes are shelved off.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to evaluate.
 *   max_boost_db_float (number): Ceiling on the low-frequency boost.
 *
 * Returns:
 *   (number): Linear amplitude multiplier, exactly 1.0 at 1 kHz.
 *
 * Warning:
 *   The capping means grey noise is not perceptually flat below about
 *   40 Hz. That is a deliberate trade against destroying a woofer.
 */
export function computeGreyWeightingMultiplier(frequency_hertz_float,
                                               max_boost_db_float =
                                                 GREY_MAX_BOOST_DB_FLOAT) {
  if (frequency_hertz_float <= 0) {
    return 0;
  }

  const raw_boost_db_float = -computeAWeightingDb(frequency_hertz_float);
  const capped_boost_db_float = Math.min(
    Math.max(raw_boost_db_float, GREY_MAX_CUT_DB_FLOAT),
    max_boost_db_float
  );

  let multiplier_float = 10 ** (capped_boost_db_float / 20);
  multiplier_float *= computeGreyShelfAttenuation(frequency_hertz_float);
  return multiplier_float;
}

/**
 * Compute the protective shelf attenuation for the grey curve.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to evaluate.
 *
 * Returns:
 *   (number): Multiplier from 0 to 1 applied at the band extremes.
 */
function computeGreyShelfAttenuation(frequency_hertz_float) {
  let attenuation_float = 1;

  if (frequency_hertz_float < GREY_LOW_SHELF_HERTZ_FLOAT) {
    attenuation_float *=
      (frequency_hertz_float / GREY_LOW_SHELF_HERTZ_FLOAT) ** 2;
  }

  if (frequency_hertz_float > GREY_HIGH_SHELF_HERTZ_FLOAT) {
    const excess_hertz_float =
      frequency_hertz_float - GREY_HIGH_SHELF_HERTZ_FLOAT;
    attenuation_float *= Math.max(
      0,
      1 - excess_hertz_float / GREY_HIGH_SHELF_WIDTH_HERTZ_FLOAT
    );
  }
  return attenuation_float;
}
