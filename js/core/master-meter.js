/**
 * Metering taps on the master output.
 *
 * Brief:
 *   Owns the three analyser nodes every readout and visualiser depends on:
 *   a high-resolution mono analyser for the spectrogram, and a stereo pair
 *   for the goniometer. Separated from the engine because measurement is a
 *   distinct concern from signal routing, and because the analyser sizes are
 *   a real performance trade that deserves to be reasoned about in one
 *   place.
 */

import { convertLinearToDb } from '../util/amplitude.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/**
 * Points in the spectrum analyser.
 *
 * 32768 rather than the usual 2048 is a deliberate trade: at 48 kHz it buys
 * 1.46 Hz of resolution, which is the difference between a 10 Hz infrasonic
 * tone being visible in the spectrogram and being smeared into the DC bin.
 * The cost is one 16384-float read per frame, negligible beside the WebGL
 * pass it feeds.
 */
export const SPECTRUM_FFT_SIZE_INT = 32768;

/** Points in each stereo analyser; the goniometer needs speed, not detail. */
const STEREO_FFT_SIZE_INT = 2048;

/** Smoothing applied to the spectrum analyser between frames. */
const SPECTRUM_SMOOTHING_FLOAT = 0.72;

/** Decibel window the spectrum analyser reports over. */
const SPECTRUM_MIN_DB_FLOAT = -100;
const SPECTRUM_MAX_DB_FLOAT = -6;

/** Sample magnitude at or above which the output is considered clipped. */
const CLIP_THRESHOLD_LINEAR_FLOAT = 0.999;

/* ------------------------------------------------------------------------ */

/**
 * Measure level, spectrum and stereo image at the master output.
 *
 * Brief:
 *   Constructs its own analyser nodes and expects the caller to connect a
 *   source into `inputNode`. Buffers are allocated once and reused on every
 *   read, because allocating typed arrays at frame rate is a reliable way to
 *   provoke garbage-collection pauses that are audible as dropouts.
 *
 * Arguments:
 *   audio_context_obj (BaseAudioContext): Context to build nodes in.
 *   spectrum_fft_size_int (number): Points in the spectrum analyser.
 *
 * Returns:
 *   (MasterMeter): A meter whose inputNode is ready to receive signal.
 *
 * Warning:
 *   Analyser nodes process continuously once connected, whether or not
 *   anything reads from them.
 */
export class MasterMeter {
  constructor(audio_context_obj,
              spectrum_fft_size_int = SPECTRUM_FFT_SIZE_INT) {
    this.context_obj = audio_context_obj;

    this.input_node = audio_context_obj.createGain();

    this.spectrum_analyser_node = audio_context_obj.createAnalyser();
    this.spectrum_analyser_node.fftSize = spectrum_fft_size_int;
    this.spectrum_analyser_node.smoothingTimeConstant =
      SPECTRUM_SMOOTHING_FLOAT;
    this.spectrum_analyser_node.minDecibels = SPECTRUM_MIN_DB_FLOAT;
    this.spectrum_analyser_node.maxDecibels = SPECTRUM_MAX_DB_FLOAT;
    this.input_node.connect(this.spectrum_analyser_node);

    this.channel_splitter_node = audio_context_obj.createChannelSplitter(2);
    this.input_node.connect(this.channel_splitter_node);

    this.left_analyser_node = audio_context_obj.createAnalyser();
    this.right_analyser_node = audio_context_obj.createAnalyser();
    for (const analyser_node of [
      this.left_analyser_node,
      this.right_analyser_node,
    ]) {
      analyser_node.fftSize = STEREO_FFT_SIZE_INT;
      analyser_node.smoothingTimeConstant = 0;
    }
    this.channel_splitter_node.connect(this.left_analyser_node, 0);
    this.channel_splitter_node.connect(this.right_analyser_node, 1);

    this.time_samples_float32array = new Float32Array(
      this.spectrum_analyser_node.fftSize
    );
    this.spectrum_db_float32array = new Float32Array(
      this.spectrum_analyser_node.frequencyBinCount
    );
    this.left_samples_float32array = new Float32Array(STEREO_FFT_SIZE_INT);
    this.right_samples_float32array = new Float32Array(STEREO_FFT_SIZE_INT);
  }

  /**
   * Expose the node a signal source should connect into.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (GainNode): The meter's input node.
   */
  get inputNode() {
    return this.input_node;
  }

  /**
   * Measure the current peak and RMS level of the master output.
   *
   * Brief:
   *   Peak drives the clip indicator and RMS drives the loudness readout;
   *   the two differ by up to 20 dB on transient material, which is exactly
   *   why both are reported rather than one standing in for the other.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): peak_linear_float, rms_linear_float, peak_db_float,
   *   rms_db_float and is_clipping_bool.
   */
  readLevels() {
    const samples_float32array = this.time_samples_float32array;
    this.spectrum_analyser_node.getFloatTimeDomainData(samples_float32array);

    let peak_linear_float = 0;
    let squared_total_float = 0;

    for (
      let index_int = 0;
      index_int < samples_float32array.length;
      index_int += 1
    ) {
      const sample_float = samples_float32array[index_int];
      const magnitude_float = sample_float < 0 ? -sample_float : sample_float;
      if (magnitude_float > peak_linear_float) {
        peak_linear_float = magnitude_float;
      }
      squared_total_float += sample_float * sample_float;
    }

    const rms_linear_float = Math.sqrt(
      squared_total_float / samples_float32array.length
    );

    return {
      peak_linear_float,
      rms_linear_float,
      peak_db_float: convertLinearToDb(peak_linear_float),
      rms_db_float: convertLinearToDb(rms_linear_float),
      is_clipping_bool: peak_linear_float >= CLIP_THRESHOLD_LINEAR_FLOAT,
    };
  }

  /**
   * Read the latest magnitude spectrum in decibels.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Float32Array): One decibel value per frequency bin. The buffer is
   *   reused between calls, so copy it if you need to retain it.
   */
  readSpectrumDb() {
    this.spectrum_analyser_node.getFloatFrequencyData(
      this.spectrum_db_float32array
    );
    return this.spectrum_db_float32array;
  }

  /**
   * Read the latest stereo time-domain pair.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object): left_samples_float32array and right_samples_float32array,
   *   both reused between calls.
   */
  readStereoWaveforms() {
    this.left_analyser_node.getFloatTimeDomainData(
      this.left_samples_float32array
    );
    this.right_analyser_node.getFloatTimeDomainData(
      this.right_samples_float32array
    );
    return {
      left_samples_float32array: this.left_samples_float32array,
      right_samples_float32array: this.right_samples_float32array,
    };
  }

  /**
   * Convert a spectrum bin index into its centre frequency.
   *
   * Arguments:
   *   bin_index_int (number): Index into the spectrum array.
   *
   * Returns:
   *   (number): Centre frequency of that bin, in hertz.
   */
  convertBinIndexToHertz(bin_index_int) {
    return (
      (bin_index_int * this.context_obj.sampleRate) /
      this.spectrum_analyser_node.fftSize
    );
  }

  /**
   * Report the width of one spectrum bin.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): Bin width in hertz; smaller resolves lower frequencies.
   */
  get binWidthHertz() {
    return (
      this.context_obj.sampleRate / this.spectrum_analyser_node.fftSize
    );
  }
}
