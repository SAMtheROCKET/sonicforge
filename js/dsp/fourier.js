/**
 * Radix-2 fast Fourier transform and real-signal spectral analysis.
 *
 * Brief:
 *   Two parts of SonicForge need a transform the browser does not provide.
 *   Spectral noise synthesis designs a spectrum directly and inverts it into
 *   the time domain, and the test harness must measure the spectrum of a
 *   rendered buffer to prove a noise colour really has the slope it claims.
 *   AnalyserNode cannot do either: it offers no inverse and no access to a
 *   buffer that is not currently playing.
 *
 *   The implementation is iterative Cooley-Tukey, operating in place, with
 *   twiddle factors and the bit-reversal permutation precomputed once per
 *   size and cached.
 */

import { isPowerOfTwo } from '../util/numeric.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Cache of prepared transforms, keyed by size. */
const TRANSFORM_CACHE_MAP = new Map();

/** Magnitude in decibels reported for a bin holding no energy at all. */
const SILENT_BIN_DB_FLOAT = -200;

/** Amplitude correction factor for a real one-sided spectrum. */
const ONE_SIDED_SPECTRUM_SCALE_FLOAT = 2;

/* ------------------------------------------------------------------------ */

/**
 * Perform in-place forward and inverse discrete Fourier transforms.
 *
 * Brief:
 *   An instance owns the precomputed tables for one transform size. Reuse
 *   instances through the cache rather than constructing per call; building
 *   the tables for a 262144-point transform is far more expensive than the
 *   transform itself.
 *
 * Arguments:
 *   size_int (number): Transform length; must be a power of two.
 *
 * Returns:
 *   (FastFourierTransform): A transform prepared for that size.
 *
 * Warning:
 *   Throws RangeError for a non-power-of-two size. Radix-2 has no meaning
 *   for other lengths and silently rounding would corrupt results.
 */
export class FastFourierTransform {
  constructor(size_int) {
    if (!isPowerOfTwo(size_int)) {
      throw new RangeError(
        `FFT size must be a power of two, got ${size_int}`
      );
    }

    this.size_int = size_int;
    this.stage_count_int = Math.log2(size_int) | 0;

    const half_size_int = size_int >> 1;
    this.cosine_table_float64array = new Float64Array(half_size_int);
    this.sine_table_float64array = new Float64Array(half_size_int);

    for (let index_int = 0; index_int < half_size_int; index_int += 1) {
      const angle_radians_float = (2 * Math.PI * index_int) / size_int;
      this.cosine_table_float64array[index_int] =
        Math.cos(angle_radians_float);
      this.sine_table_float64array[index_int] = Math.sin(angle_radians_float);
    }

    this.bit_reversal_uint32array = this.#buildBitReversalTable(size_int);
  }

  /**
   * Precompute the bit-reversal permutation for this transform size.
   *
   * Arguments:
   *   size_int (number): Transform length.
   *
   * Returns:
   *   (Uint32Array): Destination index for each source index.
   */
  #buildBitReversalTable(size_int) {
    const table_uint32array = new Uint32Array(size_int);

    for (let index_int = 0; index_int < size_int; index_int += 1) {
      let remaining_int = index_int;
      let reversed_int = 0;
      for (
        let bit_int = 0;
        bit_int < this.stage_count_int;
        bit_int += 1
      ) {
        reversed_int = (reversed_int << 1) | (remaining_int & 1);
        remaining_int >>>= 1;
      }
      table_uint32array[index_int] = reversed_int;
    }
    return table_uint32array;
  }

  /**
   * Fetch a cached transform of the requested size, building it if needed.
   *
   * Arguments:
   *   size_int (number): Transform length; must be a power of two.
   *
   * Returns:
   *   (FastFourierTransform): A shared, prepared transform.
   *
   * Warning:
   *   Instances are shared and the cache is never evicted. That is safe
   *   only because the tables are read-only during a transform.
   */
  static getCached(size_int) {
    let transform_obj = TRANSFORM_CACHE_MAP.get(size_int);
    if (!transform_obj) {
      transform_obj = new FastFourierTransform(size_int);
      TRANSFORM_CACHE_MAP.set(size_int, transform_obj);
    }
    return transform_obj;
  }

  /**
   * Reorder both halves of a complex signal into bit-reversed order.
   *
   * Arguments:
   *   real_float64array (Float64Array): Real components, modified in place.
   *   imaginary_float64array (Float64Array): Imaginary components.
   *
   * Returns:
   *   (none)
   */
  #permuteIntoBitReversedOrder(real_float64array, imaginary_float64array) {
    for (
      let source_index_int = 0;
      source_index_int < this.size_int;
      source_index_int += 1
    ) {
      const target_index_int = this.bit_reversal_uint32array[
        source_index_int
      ];
      if (target_index_int <= source_index_int) {
        continue;
      }

      const swap_real_float = real_float64array[source_index_int];
      real_float64array[source_index_int] =
        real_float64array[target_index_int];
      real_float64array[target_index_int] = swap_real_float;

      const swap_imaginary_float = imaginary_float64array[source_index_int];
      imaginary_float64array[source_index_int] =
        imaginary_float64array[target_index_int];
      imaginary_float64array[target_index_int] = swap_imaginary_float;
    }
  }

  /**
   * Transform a complex signal from the time domain to the frequency domain.
   *
   * Arguments:
   *   real_float64array (Float64Array): Real components, modified in place.
   *   imaginary_float64array (Float64Array): Imaginary components, in place.
   *
   * Returns:
   *   (FastFourierTransform): This instance, for chaining.
   *
   * Warning:
   *   Both buffers are overwritten. Copy anything you still need first.
   */
  forward(real_float64array, imaginary_float64array) {
    const is_long_enough_bool =
      real_float64array.length >= this.size_int &&
      imaginary_float64array.length >= this.size_int;
    if (!is_long_enough_bool) {
      throw new RangeError('buffers are shorter than the FFT size');
    }

    this.#permuteIntoBitReversedOrder(
      real_float64array,
      imaginary_float64array
    );

    for (
      let block_size_int = 2;
      block_size_int <= this.size_int;
      block_size_int <<= 1
    ) {
      this.#applyButterflyStage(
        real_float64array,
        imaginary_float64array,
        block_size_int
      );
    }
    return this;
  }

  /**
   * Apply one butterfly stage across the whole buffer.
   *
   * Arguments:
   *   real_float64array (Float64Array): Real components, modified in place.
   *   imaginary_float64array (Float64Array): Imaginary components.
   *   block_size_int (number): Butterfly span for this stage.
   *
   * Returns:
   *   (none)
   */
  #applyButterflyStage(real_float64array, imaginary_float64array,
                       block_size_int) {
    const half_block_int = block_size_int >> 1;
    const table_step_int = this.size_int / block_size_int;

    for (
      let block_start_int = 0;
      block_start_int < this.size_int;
      block_start_int += block_size_int
    ) {
      let table_index_int = 0;

      for (
        let lower_index_int = block_start_int;
        lower_index_int < block_start_int + half_block_int;
        lower_index_int += 1
      ) {
        const upper_index_int = lower_index_int + half_block_int;
        const cosine_float = this.cosine_table_float64array[table_index_int];
        const sine_float = this.sine_table_float64array[table_index_int];

        const rotated_real_float =
          real_float64array[upper_index_int] * cosine_float +
          imaginary_float64array[upper_index_int] * sine_float;
        const rotated_imaginary_float =
          -real_float64array[upper_index_int] * sine_float +
          imaginary_float64array[upper_index_int] * cosine_float;

        real_float64array[upper_index_int] =
          real_float64array[lower_index_int] - rotated_real_float;
        imaginary_float64array[upper_index_int] =
          imaginary_float64array[lower_index_int] - rotated_imaginary_float;
        real_float64array[lower_index_int] += rotated_real_float;
        imaginary_float64array[lower_index_int] += rotated_imaginary_float;

        table_index_int += table_step_int;
      }
    }
  }

  /**
   * Transform a complex signal from the frequency domain back to time.
   *
   * Brief:
   *   Implemented with the real/imaginary swap identity, which reuses the
   *   forward pass rather than duplicating the butterfly network, then
   *   applies the one-over-size scale the inverse requires.
   *
   * Arguments:
   *   real_float64array (Float64Array): Real components, modified in place.
   *   imaginary_float64array (Float64Array): Imaginary components, in place.
   *
   * Returns:
   *   (FastFourierTransform): This instance, for chaining.
   *
   * Warning:
   *   The imaginary output is only negligible when the input spectrum was
   *   conjugate-symmetric. Otherwise the result is genuinely complex.
   */
  inverse(real_float64array, imaginary_float64array) {
    this.forward(imaginary_float64array, real_float64array);

    const inverse_scale_float = 1 / this.size_int;
    for (
      let index_int = 0;
      index_int < this.size_int;
      index_int += 1
    ) {
      real_float64array[index_int] *= inverse_scale_float;
      imaginary_float64array[index_int] *= inverse_scale_float;
    }
    return this;
  }

  /**
   * Compute magnitudes for the lower half of a transformed spectrum.
   *
   * Arguments:
   *   real_float64array (Float64Array): Real components of the spectrum.
   *   imaginary_float64array (Float64Array): Imaginary components.
   *   output_float64array (Float64Array): Optional destination buffer.
   *
   * Returns:
   *   (Float64Array): Linear magnitudes, unnormalised.
   */
  computeMagnitudes(real_float64array, imaginary_float64array,
                    output_float64array = new Float64Array(
                      this.size_int >> 1
                    )) {
    for (
      let index_int = 0;
      index_int < output_float64array.length;
      index_int += 1
    ) {
      output_float64array[index_int] = Math.hypot(
        real_float64array[index_int],
        imaginary_float64array[index_int]
      );
    }
    return output_float64array;
  }
}

/* ------------------------------------------------------------------------ */

/**
 * Fill a buffer with a Hann window and report its coherent gain.
 *
 * Arguments:
 *   windowed_float64array (Float64Array): Destination for windowed samples.
 *   samples_arr (ArrayLike<number>): Source samples.
 *   size_int (number): Number of samples to window.
 *
 * Returns:
 *   (number): Coherent gain, the mean window value, used to undo the
 *   amplitude loss the window introduces.
 */
function applyHannWindow(windowed_float64array, samples_arr, size_int) {
  let window_total_float = 0;

  for (let index_int = 0; index_int < size_int; index_int += 1) {
    const window_value_float =
      0.5 - 0.5 * Math.cos((2 * Math.PI * index_int) / size_int);
    windowed_float64array[index_int] =
      samples_arr[index_int] * window_value_float;
    window_total_float += window_value_float;
  }
  return window_total_float / size_int;
}

/**
 * Measure the one-sided amplitude spectrum of a real signal.
 *
 * Brief:
 *   Windowing suppresses the spectral leakage that would otherwise smear a
 *   tone across every bin, and the returned magnitudes are corrected for
 *   both the window's coherent gain and the one-sided folding, so a
 *   full-scale sine reads 1.0 rather than some implementation artefact.
 *
 * Arguments:
 *   samples_arr (ArrayLike<number>): Real time-domain samples.
 *   sample_rate_hertz_float (number): Sample rate of those samples.
 *   options_obj (Object): Optional settings.
 *   options_obj.size_int (number): Transform size; defaults to the largest
 *     power of two that fits the input.
 *   options_obj.use_window_bool (boolean): Apply a Hann window.
 *
 * Returns:
 *   (Object): An object with frequencies_float64array,
 *   magnitudes_float64array, magnitudes_db_float64array, size_int and
 *   bin_width_hertz_float.
 *
 * Warning:
 *   A tone falling between bins loses up to 1.42 dB to Hann scalloping.
 *   Compare band powers rather than single bins when that matters.
 */
export function analyseRealSignalSpectrum(samples_arr,
                                          sample_rate_hertz_float,
                                          options_obj = {}) {
  const { size_int = 0, use_window_bool = true } = options_obj;
  const transform_size_int =
    size_int || 1 << Math.floor(Math.log2(samples_arr.length));

  const transform_obj = FastFourierTransform.getCached(transform_size_int);
  const real_float64array = new Float64Array(transform_size_int);
  const imaginary_float64array = new Float64Array(transform_size_int);

  let coherent_gain_float = 1;
  if (use_window_bool) {
    coherent_gain_float = applyHannWindow(
      real_float64array,
      samples_arr,
      transform_size_int
    );
  } else {
    for (
      let index_int = 0;
      index_int < transform_size_int;
      index_int += 1
    ) {
      real_float64array[index_int] = samples_arr[index_int];
    }
  }

  transform_obj.forward(real_float64array, imaginary_float64array);

  return buildOneSidedSpectrum(
    real_float64array,
    imaginary_float64array,
    transform_size_int,
    sample_rate_hertz_float,
    coherent_gain_float
  );
}

/**
 * Convert a transformed buffer into a corrected one-sided spectrum.
 *
 * Arguments:
 *   real_float64array (Float64Array): Real components of the spectrum.
 *   imaginary_float64array (Float64Array): Imaginary components.
 *   transform_size_int (number): Transform length.
 *   sample_rate_hertz_float (number): Sample rate of the source signal.
 *   coherent_gain_float (number): Mean window value applied beforehand.
 *
 * Returns:
 *   (Object): Frequencies, linear magnitudes, decibel magnitudes, the
 *   transform size, and the bin width in hertz.
 */
function buildOneSidedSpectrum(real_float64array, imaginary_float64array,
                               transform_size_int, sample_rate_hertz_float,
                               coherent_gain_float) {
  const bin_count_int = transform_size_int >> 1;
  const frequencies_float64array = new Float64Array(bin_count_int);
  const magnitudes_float64array = new Float64Array(bin_count_int);
  const magnitudes_db_float64array = new Float64Array(bin_count_int);

  const amplitude_scale_float =
    ONE_SIDED_SPECTRUM_SCALE_FLOAT /
    (transform_size_int * coherent_gain_float);

  for (
    let bin_index_int = 0;
    bin_index_int < bin_count_int;
    bin_index_int += 1
  ) {
    frequencies_float64array[bin_index_int] =
      (bin_index_int * sample_rate_hertz_float) / transform_size_int;

    magnitudes_float64array[bin_index_int] =
      Math.hypot(
        real_float64array[bin_index_int],
        imaginary_float64array[bin_index_int]
      ) * amplitude_scale_float;

    magnitudes_db_float64array[bin_index_int] =
      magnitudes_float64array[bin_index_int] > 0
        ? 20 * Math.log10(magnitudes_float64array[bin_index_int])
        : SILENT_BIN_DB_FLOAT;
  }

  return {
    frequencies_float64array,
    magnitudes_float64array,
    magnitudes_db_float64array,
    size_int: transform_size_int,
    bin_width_hertz_float: sample_rate_hertz_float / transform_size_int,
  };
}

/**
 * Measure the mean power inside a frequency band, in decibels.
 *
 * Brief:
 *   Averaging power across a band is far more stable than reading a single
 *   bin, which is why every noise-slope measurement uses it. Power, not
 *   amplitude, is averaged, because power is the additive quantity.
 *
 * Arguments:
 *   frequencies_float64array (Float64Array): Ascending bin frequencies.
 *   magnitudes_float64array (Float64Array): Linear magnitudes per bin.
 *   lower_hertz_float (number): Band lower edge, inclusive.
 *   upper_hertz_float (number): Band upper edge, inclusive.
 *
 * Returns:
 *   (number): Mean band power in decibels, or -Infinity when the band
 *   contains no bins or no energy.
 *
 * Warning:
 *   A band narrower than the bin spacing contains no bins and returns
 *   -Infinity. Widen the band or lengthen the transform.
 */
export function measureBandPowerDb(frequencies_float64array,
                                   magnitudes_float64array,
                                   lower_hertz_float, upper_hertz_float) {
  let power_total_float = 0;
  let bin_count_int = 0;

  for (
    let bin_index_int = 0;
    bin_index_int < frequencies_float64array.length;
    bin_index_int += 1
  ) {
    const frequency_hertz_float = frequencies_float64array[bin_index_int];
    const is_in_band_bool =
      frequency_hertz_float >= lower_hertz_float &&
      frequency_hertz_float <= upper_hertz_float;

    if (is_in_band_bool) {
      power_total_float +=
        magnitudes_float64array[bin_index_int] *
        magnitudes_float64array[bin_index_int];
      bin_count_int += 1;
    }
  }

  if (!bin_count_int) {
    return -Infinity;
  }

  const mean_power_float = power_total_float / bin_count_int;
  return mean_power_float > 0 ? 10 * Math.log10(mean_power_float) : -Infinity;
}
