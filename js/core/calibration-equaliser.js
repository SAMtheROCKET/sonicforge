/**
 * The ten-band correction equaliser sitting in the master chain.
 *
 * Brief:
 *   Always in circuit and neutral until a room measurement is applied, so
 *   engaging a correction never requires rewiring the graph mid-playback.
 *   The outermost bands are shelves rather than peaks, because a peaking
 *   filter centred at 31.5 Hz leaves everything below it uncorrected -
 *   exactly the region a small speaker gets most wrong.
 */

import { clampToRange } from '../util/numeric.js';
import { EQ_BAND_CENTRES_HERTZ_LIST } from '../dsp/weighting.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Quality factor of each band; about two thirds of an octave wide. */
const BAND_Q_FLOAT = 1.4;

/** Largest correction any single band may apply, in decibels. */
const MAX_BAND_GAIN_DB_FLOAT = 15;

/** Time constant used when moving a band, in seconds. */
const BAND_RAMP_SECONDS_FLOAT = 0.05;

/* ------------------------------------------------------------------------ */

/**
 * Build and drive a chain of biquad filters forming a correction curve.
 *
 * Brief:
 *   Constructs its filters immediately and chains them internally. Connect
 *   a source into `inputNode` and take the result from `outputNode`.
 *
 * Arguments:
 *   audio_context_obj (BaseAudioContext): Context to build filters in.
 *   band_centres_hertz_list (number[]): Centre frequency of each band.
 *
 * Returns:
 *   (CalibrationEqualiser): A neutral equaliser ready to be inserted.
 *
 * Warning:
 *   Band count is fixed at construction. Applying a curve of a different
 *   length silently ignores the extra entries.
 */
export class CalibrationEqualiser {
  constructor(audio_context_obj,
              band_centres_hertz_list = EQ_BAND_CENTRES_HERTZ_LIST) {
    this.context_obj = audio_context_obj;
    this.band_centres_hertz_list = band_centres_hertz_list;

    const last_index_int = band_centres_hertz_list.length - 1;
    let previous_node = null;

    this.filters_list = band_centres_hertz_list.map(
      (centre_hertz_float, band_index_int) => {
        const filter_node = audio_context_obj.createBiquadFilter();
        filter_node.type = this.#chooseFilterType(
          band_index_int,
          last_index_int
        );
        filter_node.frequency.value = centre_hertz_float;
        filter_node.Q.value = BAND_Q_FLOAT;
        filter_node.gain.value = 0;

        if (previous_node) {
          previous_node.connect(filter_node);
        }
        previous_node = filter_node;
        return filter_node;
      }
    );

    this.input_node = this.filters_list[0];
    this.output_node = previous_node;
  }

  /**
   * Choose the filter type appropriate to a band's position in the chain.
   *
   * Arguments:
   *   band_index_int (number): Index of this band.
   *   last_index_int (number): Index of the final band.
   *
   * Returns:
   *   (string): A BiquadFilterNode type name.
   */
  #chooseFilterType(band_index_int, last_index_int) {
    if (band_index_int === 0) {
      return 'lowshelf';
    }
    if (band_index_int === last_index_int) {
      return 'highshelf';
    }
    return 'peaking';
  }

  /** The node a source should connect into. */
  get inputNode() {
    return this.input_node;
  }

  /** The node carrying the corrected signal onward. */
  get outputNode() {
    return this.output_node;
  }

  /**
   * Apply a correction curve across every band.
   *
   * Arguments:
   *   gains_db_list (number[]): One gain per band, in decibels.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Each band is clamped. A measurement asking for more than the clamp is
   *   telling you the driver cannot reproduce that band at all, and further
   *   boost only burns headroom and adds distortion.
   */
  applyCurve(gains_db_list) {
    const now_seconds_float = this.context_obj.currentTime;

    this.filters_list.forEach((filter_node, band_index_int) => {
      const gain_db_float = clampToRange(
        Number(gains_db_list?.[band_index_int]) || 0,
        -MAX_BAND_GAIN_DB_FLOAT,
        MAX_BAND_GAIN_DB_FLOAT
      );
      filter_node.gain.cancelScheduledValues(now_seconds_float);
      filter_node.gain.setTargetAtTime(
        gain_db_float,
        now_seconds_float,
        BAND_RAMP_SECONDS_FLOAT
      );
    });
  }

  /**
   * Flatten every band back to unity gain.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  resetCurve() {
    this.applyCurve(this.band_centres_hertz_list.map(() => 0));
  }

  /**
   * Read the equaliser's current shape.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object[]): centre_hertz_float and gain_db_float per band.
   */
  readCurve() {
    return this.filters_list.map((filter_node, band_index_int) => ({
      centre_hertz_float: this.band_centres_hertz_list[band_index_int],
      gain_db_float: filter_node.gain.value,
    }));
  }

  /**
   * Read just the gain of every band.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number[]): Gain in decibels per band.
   */
  readGainsDb() {
    return this.filters_list.map((filter_node) => filter_node.gain.value);
  }
}
