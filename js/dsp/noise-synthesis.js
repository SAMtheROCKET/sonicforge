/**
 * Noise colour synthesis in both the time and frequency domains.
 *
 * Brief:
 *   Two techniques are used deliberately rather than one.
 *
 *   Pink and brown are generated in the TIME domain with their classical
 *   algorithms - Voss-McCartney and leaky Brownian integration - because
 *   those are the textbook definitions and the ones users come here to find.
 *
 *   Blue, violet, grey and green are generated in the FREQUENCY domain: a
 *   spectrum is designed directly, given uniformly random phase, and
 *   inverse-transformed. That gives exact control of the spectral slope and,
 *   because the result is one period of a periodic signal, a buffer that
 *   loops with no seam whatsoever.
 *
 *   Every generator is deterministic given a seeded source, which is what
 *   makes the spectral-slope assertions in the test suite reproducible.
 */

import { FastFourierTransform } from './fourier.js';
import { roundUpToPowerOfTwo } from '../util/numeric.js';
import { sampleGaussian } from '../util/random.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Independent random rows summed by the Voss-McCartney generator. */
const VOSS_ROW_COUNT_INT = 16;

/** Sample counter mask; wraps at the highest Voss row's update period. */
const VOSS_COUNTER_MASK_INT = 0xffff;

/** Leak factor pinning the Brownian integrator's DC wander. */
const BROWNIAN_STEP_SCALE_FLOAT = 0.02;
const BROWNIAN_LEAK_DIVISOR_FLOAT = 1.02;
const BROWNIAN_OUTPUT_GAIN_FLOAT = 3.5;

/** Amplitude scale applied to raw Gaussian white noise. */
const WHITE_NOISE_SCALE_FLOAT = 0.25;

/** Protective band limits applied to every spectrally designed colour. */
const SUB_BASS_ROLLOFF_HERTZ_FLOAT = 22;
const HIGH_ROLLOFF_CEILING_HERTZ_FLOAT = 18000;
const HIGH_ROLLOFF_NYQUIST_FRACTION_FLOAT = 0.92;

/** Reference frequency for the sloped colour shaping functions. */
const SLOPE_REFERENCE_HERTZ_FLOAT = 1000;

/** Default cross-fade length used to make a buffer loop without a click. */
const DEFAULT_SEAM_FADE_SAMPLES_INT = 2048;

/* ------------------------------------------------------------------------ */

/**
 * Generate white noise with a flat power spectral density.
 *
 * Brief:
 *   Gaussian rather than uniform. A uniform generator has a subtly
 *   non-Gaussian amplitude distribution that is audible as a faint buzz at
 *   high gain, and real thermal noise is Gaussian.
 *
 * Arguments:
 *   sample_count_int (number): Samples to generate.
 *   random_source_fn (Function): Source returning floats in [0, 1).
 *
 * Returns:
 *   (Float32Array): Uncorrelated samples with a 0 dB per octave slope.
 */
export function generateWhiteNoise(sample_count_int,
                                   random_source_fn = Math.random) {
  const samples_float32array = new Float32Array(sample_count_int);

  for (
    let index_int = 0;
    index_int < sample_count_int;
    index_int += 1
  ) {
    samples_float32array[index_int] =
      sampleGaussian(random_source_fn) * WHITE_NOISE_SCALE_FLOAT;
  }
  return samples_float32array;
}

/**
 * Generate pink noise using the Voss-McCartney algorithm.
 *
 * Brief:
 *   Independent random rows are re-rolled at octave-spaced rates: row r
 *   updates whenever bit r of the sample counter flips. Summing them
 *   produces the characteristic one-over-f spectrum. A full-rate white term
 *   is added on top, because plain Voss under-fills the highest octave and
 *   would otherwise measure shallower than the true -3 dB per octave.
 *
 * Arguments:
 *   sample_count_int (number): Samples to generate.
 *   random_source_fn (Function): Source returning floats in [0, 1).
 *   row_count_int (number): Independent rows to sum.
 *
 * Returns:
 *   (Float32Array): Samples with a -3 dB per octave slope.
 *
 * Warning:
 *   The result is not periodic and will click if looped without seam
 *   conditioning. Use buildNoiseBuffer rather than calling this directly.
 */
export function generatePinkNoise(sample_count_int,
                                  random_source_fn = Math.random,
                                  row_count_int = VOSS_ROW_COUNT_INT) {
  const samples_float32array = new Float32Array(sample_count_int);
  const row_values_float64array = new Float64Array(row_count_int);
  const bit_index_int8array = buildLowestBitLookup(row_count_int);

  let running_total_float = 0;
  for (let row_int = 0; row_int < row_count_int; row_int += 1) {
    row_values_float64array[row_int] = random_source_fn() * 2 - 1;
    running_total_float += row_values_float64array[row_int];
  }

  const normalise_float = 1 / (row_count_int + 1);
  let counter_int = 0;

  for (
    let index_int = 0;
    index_int < sample_count_int;
    index_int += 1
  ) {
    counter_int = (counter_int + 1) & VOSS_COUNTER_MASK_INT;

    if (counter_int !== 0) {
      const lowest_bit_int = counter_int & -counter_int;
      const row_int = bit_index_int8array[lowest_bit_int];
      if (row_int >= 0 && row_int < row_count_int) {
        running_total_float -= row_values_float64array[row_int];
        row_values_float64array[row_int] = random_source_fn() * 2 - 1;
        running_total_float += row_values_float64array[row_int];
      }
    }

    samples_float32array[index_int] =
      (running_total_float + (random_source_fn() * 2 - 1)) * normalise_float;
  }
  return samples_float32array;
}

/**
 * Build a lookup from an isolated lowest set bit to its row index.
 *
 * Arguments:
 *   row_count_int (number): Number of Voss rows to index.
 *
 * Returns:
 *   (Int8Array): Table mapping a power of two to its bit position.
 */
function buildLowestBitLookup(row_count_int) {
  const usable_rows_int = Math.min(row_count_int, 16);
  const lookup_int8array = new Int8Array(1 << usable_rows_int);

  for (let bit_int = 0; bit_int < usable_rows_int; bit_int += 1) {
    lookup_int8array[1 << bit_int] = bit_int;
  }
  return lookup_int8array;
}

/**
 * Generate brown noise by leaky Brownian integration.
 *
 * Brief:
 *   A pure random walk drifts without bound and would eventually saturate.
 *   The leak makes the integrator a first-order lowpass with a corner far
 *   below the audio band, preserving the -6 dB per octave slope while
 *   pinning DC at zero.
 *
 * Arguments:
 *   sample_count_int (number): Samples to generate.
 *   random_source_fn (Function): Source returning floats in [0, 1).
 *
 * Returns:
 *   (Float32Array): Samples with a -6 dB per octave slope, DC removed.
 */
export function generateBrownNoise(sample_count_int,
                                   random_source_fn = Math.random) {
  const samples_float32array = new Float32Array(sample_count_int);
  let integrator_float = 0;

  for (
    let index_int = 0;
    index_int < sample_count_int;
    index_int += 1
  ) {
    const white_float = random_source_fn() * 2 - 1;
    integrator_float =
      (integrator_float + BROWNIAN_STEP_SCALE_FLOAT * white_float) /
      BROWNIAN_LEAK_DIVISOR_FLOAT;
    samples_float32array[index_int] =
      integrator_float * BROWNIAN_OUTPUT_GAIN_FLOAT;
  }
  return removeDcOffsetInPlace(samples_float32array);
}

/**
 * Compute the protective band-limit multiplier at a frequency.
 *
 * Arguments:
 *   frequency_hertz_float (number): Frequency to evaluate.
 *   nyquist_hertz_float (number): Half the sample rate.
 *
 * Returns:
 *   (number): Multiplier from 0 to 1 attenuating the band extremes.
 */
function computeBandLimitMultiplier(frequency_hertz_float,
                                    nyquist_hertz_float) {
  let multiplier_float = 1;

  if (frequency_hertz_float < SUB_BASS_ROLLOFF_HERTZ_FLOAT) {
    multiplier_float *=
      (frequency_hertz_float / SUB_BASS_ROLLOFF_HERTZ_FLOAT) ** 2;
  }

  const ceiling_hertz_float = Math.min(
    HIGH_ROLLOFF_CEILING_HERTZ_FLOAT,
    nyquist_hertz_float * HIGH_ROLLOFF_NYQUIST_FRACTION_FLOAT
  );

  if (frequency_hertz_float > ceiling_hertz_float) {
    const span_hertz_float =
      nyquist_hertz_float - ceiling_hertz_float || 1;
    multiplier_float *= Math.max(
      0,
      1 - (frequency_hertz_float - ceiling_hertz_float) / span_hertz_float
    );
  }
  return multiplier_float;
}

/**
 * Synthesise noise whose magnitude spectrum follows a shaping function.
 *
 * Brief:
 *   Builds a conjugate-symmetric spectrum with the requested magnitude and
 *   uniformly random phase, then inverse-transforms it. The result is
 *   exactly one period of a periodic signal, so it loops with no seam at
 *   all - no cross-fade required.
 *
 * Arguments:
 *   sample_count_int (number): Requested length; rounded up to a power of
 *     two.
 *   sample_rate_hertz_float (number): Sample rate of the output.
 *   shape_magnitude_fn (Function): Maps a frequency in hertz to a linear
 *     magnitude.
 *   random_source_fn (Function): Source returning floats in [0, 1).
 *
 * Returns:
 *   (Float32Array): Time-domain noise, unnormalised.
 *
 * Warning:
 *   The returned length is the rounded-up power of two, which may exceed
 *   the requested count.
 */
export function synthesiseSpectrallyShapedNoise(sample_count_int,
                                                sample_rate_hertz_float,
                                                shape_magnitude_fn,
                                                random_source_fn =
                                                  Math.random) {
  const size_int = roundUpToPowerOfTwo(sample_count_int);
  const transform_obj = FastFourierTransform.getCached(size_int);
  const real_float64array = new Float64Array(size_int);
  const imaginary_float64array = new Float64Array(size_int);

  const nyquist_hertz_float = sample_rate_hertz_float / 2;
  const bin_width_hertz_float = sample_rate_hertz_float / size_int;
  const half_size_int = size_int >> 1;

  for (
    let bin_index_int = 1;
    bin_index_int < half_size_int;
    bin_index_int += 1
  ) {
    const frequency_hertz_float = bin_index_int * bin_width_hertz_float;
    const magnitude_float =
      shape_magnitude_fn(frequency_hertz_float) *
      computeBandLimitMultiplier(frequency_hertz_float, nyquist_hertz_float);

    if (magnitude_float <= 0) {
      continue;
    }

    const phase_radians_float = random_source_fn() * Math.PI * 2;
    const real_component_float =
      magnitude_float * Math.cos(phase_radians_float);
    const imaginary_component_float =
      magnitude_float * Math.sin(phase_radians_float);

    real_float64array[bin_index_int] = real_component_float;
    imaginary_float64array[bin_index_int] = imaginary_component_float;
    real_float64array[size_int - bin_index_int] = real_component_float;
    imaginary_float64array[size_int - bin_index_int] =
      -imaginary_component_float;
  }

  transform_obj.inverse(real_float64array, imaginary_float64array);

  const samples_float32array = new Float32Array(size_int);
  for (let index_int = 0; index_int < size_int; index_int += 1) {
    samples_float32array[index_int] = real_float64array[index_int];
  }
  return samples_float32array;
}

/**
 * Remove any constant offset from a sample buffer, in place.
 *
 * Brief:
 *   A DC offset wastes headroom and can push a speaker cone off its resting
 *   position without producing any audible sound at all.
 *
 * Arguments:
 *   samples_float32array (Float32Array): Buffer modified in place.
 *
 * Returns:
 *   (Float32Array): The same buffer, for chaining.
 */
export function removeDcOffsetInPlace(samples_float32array) {
  let total_float = 0;
  for (
    let index_int = 0;
    index_int < samples_float32array.length;
    index_int += 1
  ) {
    total_float += samples_float32array[index_int];
  }

  const offset_float = total_float / samples_float32array.length;
  if (offset_float === 0) {
    return samples_float32array;
  }

  for (
    let index_int = 0;
    index_int < samples_float32array.length;
    index_int += 1
  ) {
    samples_float32array[index_int] -= offset_float;
  }
  return samples_float32array;
}

/**
 * Cross-fade a buffer's tail over its head so it loops without a click.
 *
 * Brief:
 *   Uses an equal-power curve rather than a linear one, so the loudness
 *   stays constant through the join instead of dipping in the middle. Only
 *   time-domain colours need this; spectrally designed buffers are already
 *   periodic.
 *
 * Arguments:
 *   samples_float32array (Float32Array): Source buffer, not modified.
 *   fade_sample_count_int (number): Cross-fade length in samples.
 *
 * Returns:
 *   (Float32Array): A new, shorter buffer that loops seamlessly.
 *
 * Warning:
 *   The returned buffer is shorter than the input by the fade length,
 *   because the tail is consumed by the fade.
 */
export function makeBufferSeamless(samples_float32array,
                                   fade_sample_count_int =
                                     DEFAULT_SEAM_FADE_SAMPLES_INT) {
  const total_int = samples_float32array.length;
  const fade_int = Math.min(fade_sample_count_int, total_int >> 2);

  if (fade_int < 8) {
    return samples_float32array;
  }

  const output_float32array = new Float32Array(total_int - fade_int);
  output_float32array.set(
    samples_float32array.subarray(0, total_int - fade_int)
  );

  for (let index_int = 0; index_int < fade_int; index_int += 1) {
    const position_float = index_int / fade_int;
    const tail_gain_float = Math.cos((position_float * Math.PI) / 2);
    const head_gain_float = Math.sin((position_float * Math.PI) / 2);

    output_float32array[index_int] =
      samples_float32array[total_int - fade_int + index_int] *
        tail_gain_float +
      samples_float32array[index_int] * head_gain_float;
  }
  return output_float32array;
}
