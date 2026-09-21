/**
 * The noise colour catalogue: what each colour is and how to build it.
 *
 * Brief:
 *   Separated from noise-synthesis.js so that "how a spectrum is generated"
 *   and "which colours SonicForge offers" can change independently. Adding a
 *   colour touches only this file; changing the Voss row count touches only
 *   the other.
 *
 *   Each entry declares its nominal spectral slope, which the test harness
 *   measures back off a rendered buffer and asserts against. A null slope
 *   means the colour is shaped rather than sloped, and is verified by band
 *   comparison instead.
 */

import {
  generateWhiteNoise,
  generatePinkNoise,
  generateBrownNoise,
  synthesiseSpectrallyShapedNoise,
  removeDcOffsetInPlace,
  makeBufferSeamless,
} from './noise-synthesis.js';
import { computeGreyWeightingMultiplier } from './weighting.js';
import { normaliseRmsInPlace } from '../util/amplitude.js';
import { createSeededRandom } from '../util/random.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Reference frequency for the sloped colour shaping functions. */
const SLOPE_REFERENCE_HERTZ_FLOAT = 1000;

/** Shape parameters of the green-noise mid-frequency bell. */
const GREEN_CENTRE_HERTZ_FLOAT = 500;
const GREEN_BELL_WIDTH_OCTAVES_FLOAT = 1.25;
const GREEN_BELL_HEIGHT_FLOAT = 2.4;
const GREEN_BELL_FLOOR_FLOAT = 0.35;
const GREEN_TOP_ROLLOFF_HERTZ_FLOAT = 4000;

/** Target loudness every colour is normalised to. */
const DEFAULT_TARGET_RMS_FLOAT = 0.18;

/** Colours generated in the time domain, which need seam conditioning. */
const TIME_DOMAIN_COLOURS_SET = new Set(['white', 'pink', 'brown']);

/* ------------------------------------------------------------------------ */

/**
 * Compute the green-noise shaping magnitude at a frequency.
 *
 * Brief:
 *   Green noise is the mid-weighted ambience of natural environments. It is
 *   modelled as a pink backbone with a broad bell centred near 500 Hz and a
 *   firm rolloff above 4 kHz.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to evaluate.
 *
 * Returns:
 *   (number): Linear magnitude for that frequency.
 */
function computeGreenShapeMagnitude(frequency_hertz_float) {
  const octaves_from_centre_float = Math.log2(
    frequency_hertz_float / GREEN_CENTRE_HERTZ_FLOAT
  );
  const bell_float = Math.exp(
    -0.5 *
      (octaves_from_centre_float / GREEN_BELL_WIDTH_OCTAVES_FLOAT) ** 2
  );

  const pink_backbone_float = Math.sqrt(
    SLOPE_REFERENCE_HERTZ_FLOAT / Math.max(frequency_hertz_float, 20)
  );

  const top_rolloff_float =
    frequency_hertz_float > GREEN_TOP_ROLLOFF_HERTZ_FLOAT
      ? Math.max(
          0.06,
          (GREEN_TOP_ROLLOFF_HERTZ_FLOAT / frequency_hertz_float) ** 1.6
        )
      : 1;

  return (
    pink_backbone_float *
    (GREEN_BELL_FLOOR_FLOAT + GREEN_BELL_HEIGHT_FLOAT * bell_float) *
    top_rolloff_float
  );
}

/**
 * Registry of every noise colour with its metadata and generator.
 *
 * Brief:
 *   Each entry declares its nominal spectral slope in decibels per octave,
 *   which the test harness measures back off a rendered buffer and asserts
 *   against. A null slope means the colour is shaped rather than sloped.
 */
export const NOISE_COLOURS_DICT = Object.freeze({
  white: {
    label_str: 'White',
    slope_db_per_octave_float: 0,
    tint_str: '#eef3ff',
    hint_str:
      'Flat power spectrum. Uncorrelated samples - the reference noise.',
    generate_fn: (count_int, rate_float, random_fn) =>
      generateWhiteNoise(count_int, random_fn),
  },

  pink: {
    label_str: 'Pink',
    slope_db_per_octave_float: -3,
    tint_str: '#ff9bb8',
    hint_str:
      'One-over-f via Voss-McCartney. Equal energy per octave; the ' +
      'acoustician’s default.',
    generate_fn: (count_int, rate_float, random_fn) =>
      generatePinkNoise(count_int, random_fn),
  },

  brown: {
    label_str: 'Brown',
    slope_db_per_octave_float: -6,
    tint_str: '#d08b5a',
    hint_str:
      'One-over-f-squared by Brownian integration. Deep and rumbling; ' +
      'masks low-frequency intrusion.',
    generate_fn: (count_int, rate_float, random_fn) =>
      generateBrownNoise(count_int, random_fn),
  },

  blue: {
    label_str: 'Blue',
    slope_db_per_octave_float: 3,
    tint_str: '#5aa8ff',
    hint_str:
      'Plus 3 dB per octave. Rises with frequency; used for ' +
      'high-quality dithering.',
    generate_fn: (count_int, rate_float, random_fn) =>
      synthesiseSpectrallyShapedNoise(
        count_int,
        rate_float,
        (hertz_float) =>
          Math.sqrt(hertz_float / SLOPE_REFERENCE_HERTZ_FLOAT),
        random_fn
      ),
  },

  violet: {
    label_str: 'Violet',
    slope_db_per_octave_float: 6,
    tint_str: '#b07bff',
    hint_str:
      'Plus 6 dB per octave - the derivative of white. Used in ' +
      'tinnitus masking therapy.',
    generate_fn: (count_int, rate_float, random_fn) =>
      synthesiseSpectrallyShapedNoise(
        count_int,
        rate_float,
        (hertz_float) => hertz_float / SLOPE_REFERENCE_HERTZ_FLOAT,
        random_fn
      ),
  },

  grey: {
    label_str: 'Grey',
    slope_db_per_octave_float: null,
    tint_str: '#9aa5bd',
    hint_str:
      'White shaped by inverse equal-loudness. Sounds flat to the ear, ' +
      'not to a meter.',
    generate_fn: (count_int, rate_float, random_fn) =>
      synthesiseSpectrallyShapedNoise(
        count_int,
        rate_float,
        computeGreyWeightingMultiplier,
        random_fn
      ),
  },

  green: {
    label_str: 'Green',
    slope_db_per_octave_float: null,
    tint_str: '#4fd39a',
    hint_str:
      'Mid-weighted ambience centred near 500 Hz - the spectral ' +
      'signature of nature.',
    generate_fn: (count_int, rate_float, random_fn) =>
      synthesiseSpectrallyShapedNoise(
        count_int,
        rate_float,
        computeGreenShapeMagnitude,
        random_fn
      ),
  },
});

/** Colour keys in presentation order. */
export const NOISE_COLOUR_KEYS_LIST = Object.freeze(
  Object.keys(NOISE_COLOURS_DICT)
);

/* ------------------------------------------------------------------------ */



/**
 * Build a fully conditioned, loop-ready buffer for a noise colour.
 *
 * Brief:
 *   Generates the colour, removes DC, applies seam conditioning where the
 *   generator is not inherently periodic, and normalises to a common RMS so
 *   that switching colours live does not jump in loudness.
 *
 * Arguments:
 *   colour_name_str (string): Key from NOISE_COLOURS_DICT.
 *   sample_count_int (number): Requested buffer length.
 *   sample_rate_hertz_float (number): Sample rate of the output.
 *   options_obj (Object): Optional settings.
 *   options_obj.seed_int (number): Seed for reproducible output; null uses
 *     Math.random.
 *   options_obj.target_rms_float (number): Loudness to normalise to.
 *
 * Returns:
 *   (Float32Array): A conditioned buffer ready to loop.
 *
 * Warning:
 *   Throws RangeError for an unknown colour name rather than falling back
 *   to a default, because silently substituting a colour would make a
 *   measurement wrong without any visible sign.
 */
export function buildNoiseBuffer(colour_name_str, sample_count_int,
                                 sample_rate_hertz_float,
                                 options_obj = {}) {
  const { seed_int = null, target_rms_float = DEFAULT_TARGET_RMS_FLOAT } =
    options_obj;

  const colour_spec_obj = NOISE_COLOURS_DICT[colour_name_str];
  if (!colour_spec_obj) {
    throw new RangeError(`unknown noise colour: ${colour_name_str}`);
  }

  const random_source_fn =
    seed_int === null ? Math.random : createSeededRandom(seed_int);

  let samples_float32array = colour_spec_obj.generate_fn(
    sample_count_int,
    sample_rate_hertz_float,
    random_source_fn
  );

  if (TIME_DOMAIN_COLOURS_SET.has(colour_name_str)) {
    samples_float32array = makeBufferSeamless(
      removeDcOffsetInPlace(samples_float32array)
    );
  } else {
    removeDcOffsetInPlace(samples_float32array);
  }

  normaliseRmsInPlace(samples_float32array, target_rms_float);
  return samples_float32array;
}
