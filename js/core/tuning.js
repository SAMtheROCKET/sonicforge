/**
 * Concert-pitch calibration and note-to-frequency mathematics.
 *
 * Brief:
 *   Every note selector in SonicForge derives its frequency from one shared
 *   tuning object, so changing the A4 reference from 440 Hz to 432, 442 or
 *   415 recalibrates the entire application in a single pass. The
 *   alternative - each control holding its own conversion table - guarantees
 *   that some corner of the interface eventually disagrees with the rest.
 */

import { Emitter } from '../util/events.js';
import { clampToRange } from '../util/numeric.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Note names using sharps, indexed by semitone within an octave. */
export const SHARP_NOTE_NAMES_LIST = Object.freeze([
  'C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B',
]);

/** Note names using flats, indexed by semitone within an octave. */
export const FLAT_NOTE_NAMES_LIST = Object.freeze([
  'C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B',
]);

/** MIDI note number of A4, the anchor the whole system pivots on. */
export const A4_MIDI_NUMBER_INT = 69;

/** Historically and musically meaningful reference pitches. */
export const PITCH_STANDARDS_LIST = Object.freeze([
  { hertz_float: 415.3, label_str: '415.3', note_str: 'Baroque' },
  { hertz_float: 432, label_str: '432', note_str: 'Verdi' },
  { hertz_float: 435, label_str: '435', note_str: 'Diapason normal' },
  { hertz_float: 440, label_str: '440', note_str: 'ISO 16 standard' },
  { hertz_float: 442, label_str: '442', note_str: 'European orchestral' },
  { hertz_float: 444, label_str: '444', note_str: 'Bright ensemble' },
]);

/** Plausible bounds for a concert-pitch reference. */
const MIN_REFERENCE_HERTZ_FLOAT = 380;
const MAX_REFERENCE_HERTZ_FLOAT = 500;

/** The ISO reference, against which deviations are reported. */
const ISO_REFERENCE_HERTZ_FLOAT = 440;

/** Semitones per octave in twelve-tone equal temperament. */
const SEMITONES_PER_OCTAVE_INT = 12;

/** Cents per octave. */
const CENTS_PER_OCTAVE_INT = 1200;

/** Highest valid MIDI note number. */
const MAX_MIDI_NUMBER_INT = 127;

/** Semitone offset of each natural note letter from C. */
const LETTER_SEMITONE_OFFSETS_DICT = Object.freeze({
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
});

/** Scientific pitch notation: letter, optional accidental, octave. */
const NOTE_NAME_PATTERN = /^([A-Ga-g])([#b♯♭]?)(-?\d{1,2})$/;

/** Default span of the chromatic table: C0 through B8. */
const DEFAULT_TABLE_FROM_MIDI_INT = 12;
const DEFAULT_TABLE_TO_MIDI_INT = 119;

/* ------------------------------------------------------------------------ */

/**
 * Hold a concert-pitch reference and convert between notes and frequencies.
 *
 * Brief:
 *   Emits a change event whenever the reference moves, which every note
 *   selector listens for. Setting the same value twice emits nothing, so a
 *   control echoing its own value back cannot start a feedback loop.
 *
 * Arguments:
 *   reference_hertz_float (number): Initial A4 frequency.
 *
 * Returns:
 *   (Tuning): A tuning anchored at that reference.
 *
 * Warning:
 *   The reference is clamped to a musically plausible range. A value
 *   outside it is silently corrected rather than throwing, because this is
 *   driven directly by a text field the user is typing into.
 */
export class Tuning extends Emitter {
  #reference_hertz_float = ISO_REFERENCE_HERTZ_FLOAT;

  constructor(reference_hertz_float = ISO_REFERENCE_HERTZ_FLOAT) {
    super();
    this.referenceHertz = reference_hertz_float;
  }

  /**
   * Read the current A4 reference frequency.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): Reference frequency in hertz.
   */
  get referenceHertz() {
    return this.#reference_hertz_float;
  }

  /**
   * Set the A4 reference, re-deriving every note in the application.
   *
   * Arguments:
   *   hertz_float (number): New reference frequency.
   *
   * Returns:
   *   (none)
   */
  set referenceHertz(hertz_float) {
    const next_hertz_float = clampToRange(
      Number(hertz_float) || ISO_REFERENCE_HERTZ_FLOAT,
      MIN_REFERENCE_HERTZ_FLOAT,
      MAX_REFERENCE_HERTZ_FLOAT
    );

    if (next_hertz_float === this.#reference_hertz_float) {
      return;
    }

    const previous_hertz_float = this.#reference_hertz_float;
    this.#reference_hertz_float = next_hertz_float;
    this.emit('change', next_hertz_float, previous_hertz_float);
  }

  /**
   * Report how far the reference sits from ISO 440, in cents.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): Signed cent deviation; negative means flat of 440 Hz.
   */
  get centsFromIsoReference() {
    return (
      CENTS_PER_OCTAVE_INT *
      Math.log2(this.#reference_hertz_float / ISO_REFERENCE_HERTZ_FLOAT)
    );
  }

  /**
   * Convert a MIDI note number into a frequency.
   *
   * Arguments:
   *   midi_number_float (number): MIDI note number; may be fractional.
   *
   * Returns:
   *   (number): Frequency in hertz under the current reference.
   */
  convertMidiToHertz(midi_number_float) {
    const octaves_from_anchor_float =
      (midi_number_float - A4_MIDI_NUMBER_INT) / SEMITONES_PER_OCTAVE_INT;
    return this.#reference_hertz_float * 2 ** octaves_from_anchor_float;
  }

  /**
   * Convert a frequency into a fractional MIDI note number.
   *
   * Arguments:
   *   frequency_hertz_float (number): Frequency to convert.
   *
   * Returns:
   *   (number): Fractional MIDI note number, or -Infinity for zero.
   */
  convertHertzToMidi(frequency_hertz_float) {
    if (!(frequency_hertz_float > 0)) {
      return -Infinity;
    }
    const octaves_float = Math.log2(
      frequency_hertz_float / this.#reference_hertz_float
    );
    return A4_MIDI_NUMBER_INT + SEMITONES_PER_OCTAVE_INT * octaves_float;
  }

  /**
   * Resolve a note name to a frequency under the current reference.
   *
   * Arguments:
   *   note_name_str (string): Scientific pitch notation, such as 'C#3'.
   *
   * Returns:
   *   (number): Frequency in hertz, or NaN when unparseable.
   */
  resolveNoteNameToHertz(note_name_str) {
    const midi_number_int = parseNoteName(note_name_str);
    return Number.isFinite(midi_number_int)
      ? this.convertMidiToHertz(midi_number_int)
      : NaN;
  }

  /**
   * Describe the nearest note to a frequency and its cent deviation.
   *
   * Brief:
   *   Drives the dial readout, which must tell the user both which note
   *   they are near and how far off it they are - the two facts a tuner
   *   exists to provide.
   *
   * Arguments:
   *   frequency_hertz_float (number): Frequency to describe.
   *
   * Returns:
   *   (Object): midi_number_int, name_str, octave_int, label_str,
   *   cents_float and exact_hertz_float.
   *
   * Warning:
   *   A non-positive frequency yields a placeholder description rather than
   *   throwing, because the dial reads this on every frame.
   */
  describeFrequency(frequency_hertz_float) {
    if (!(frequency_hertz_float > 0)) {
      return {
        midi_number_int: NaN,
        name_str: '--',
        octave_int: NaN,
        label_str: '--',
        cents_float: 0,
        exact_hertz_float: NaN,
      };
    }

    const exact_midi_float = this.convertHertzToMidi(frequency_hertz_float);
    const midi_number_int = Math.round(exact_midi_float);
    const cents_float = (exact_midi_float - midi_number_int) * 100;
    const name_str = SHARP_NOTE_NAMES_LIST[wrapSemitone(midi_number_int)];
    const octave_int = computeOctaveNumber(midi_number_int);

    return {
      midi_number_int,
      name_str,
      octave_int,
      label_str: `${name_str}${octave_int}`,
      cents_float,
      exact_hertz_float: this.convertMidiToHertz(midi_number_int),
    };
  }

  /**
   * Snap a frequency to the nearest chromatic step.
   *
   * Arguments:
   *   frequency_hertz_float (number): Frequency to snap.
   *
   * Returns:
   *   (number): The exact frequency of the nearest semitone.
   */
  snapToNearestSemitone(frequency_hertz_float) {
    const description_obj = this.describeFrequency(frequency_hertz_float);
    return Number.isFinite(description_obj.midi_number_int)
      ? description_obj.exact_hertz_float
      : frequency_hertz_float;
  }

  /**
   * Shift a frequency by a number of semitones.
   *
   * Arguments:
   *   frequency_hertz_float (number): Starting frequency.
   *   semitone_count_float (number): Semitones to shift; may be fractional.
   *
   * Returns:
   *   (number): The transposed frequency.
   */
  transposeBySemitones(frequency_hertz_float, semitone_count_float) {
    const octaves_float = semitone_count_float / SEMITONES_PER_OCTAVE_INT;
    return frequency_hertz_float * 2 ** octaves_float;
  }

  /**
   * Shift a frequency by a number of cents.
   *
   * Arguments:
   *   frequency_hertz_float (number): Starting frequency.
   *   cents_float (number): Cents to shift.
   *
   * Returns:
   *   (number): The detuned frequency.
   */
  detuneByCents(frequency_hertz_float, cents_float) {
    return frequency_hertz_float * 2 ** (cents_float / CENTS_PER_OCTAVE_INT);
  }

  /**
   * Build a chromatic note table for populating note selectors.
   *
   * Arguments:
   *   options_obj (Object): Optional from_midi_int, to_midi_int and
   *     use_flats_bool.
   *
   * Returns:
   *   (Object[]): Entries of midi_number_int, label_str and hertz_float.
   */
  buildChromaticTable(options_obj = {}) {
    const {
      from_midi_int = DEFAULT_TABLE_FROM_MIDI_INT,
      to_midi_int = DEFAULT_TABLE_TO_MIDI_INT,
      use_flats_bool = false,
    } = options_obj;

    const names_list = use_flats_bool
      ? FLAT_NOTE_NAMES_LIST
      : SHARP_NOTE_NAMES_LIST;
    const table_list = [];

    for (
      let midi_number_int = from_midi_int;
      midi_number_int <= to_midi_int;
      midi_number_int += 1
    ) {
      const name_str = names_list[wrapSemitone(midi_number_int)];
      table_list.push({
        midi_number_int,
        label_str: `${name_str}${computeOctaveNumber(midi_number_int)}`,
        hertz_float: this.convertMidiToHertz(midi_number_int),
      });
    }
    return table_list;
  }
}

/* ------------------------------------------------------------------------ */

/**
 * Reduce a MIDI note number to its semitone within an octave.
 *
 * Arguments:
 *   midi_number_int (number): MIDI note number, possibly negative.
 *
 * Returns:
 *   (number): Semitone index 0 through 11.
 */
function wrapSemitone(midi_number_int) {
  return (
    ((midi_number_int % SEMITONES_PER_OCTAVE_INT) +
      SEMITONES_PER_OCTAVE_INT) %
    SEMITONES_PER_OCTAVE_INT
  );
}

/**
 * Compute the scientific octave number of a MIDI note.
 *
 * Arguments:
 *   midi_number_int (number): MIDI note number.
 *
 * Returns:
 *   (number): Octave number, where middle C (MIDI 60) is octave 4.
 */
function computeOctaveNumber(midi_number_int) {
  return Math.floor(midi_number_int / SEMITONES_PER_OCTAVE_INT) - 1;
}

/**
 * Parse a scientific-pitch note name into a MIDI note number.
 *
 * Brief:
 *   Accepts 'A4', 'a4', 'C#3', 'Db-1' and the Unicode sharp and flat signs,
 *   so a user can type a note into any frequency field instead of looking
 *   up its frequency.
 *
 * Arguments:
 *   note_name_str (string): Note name to parse.
 *
 * Returns:
 *   (number): MIDI note number 0 to 127, or NaN when unparseable.
 *
 * Warning:
 *   Returns NaN rather than throwing, because this runs against every
 *   keystroke in a frequency field.
 */
export function parseNoteName(note_name_str) {
  if (typeof note_name_str !== 'string') {
    return NaN;
  }

  const match_obj = NOTE_NAME_PATTERN.exec(note_name_str.trim());
  if (!match_obj) {
    return NaN;
  }

  const letter_str = match_obj[1].toUpperCase();
  const accidental_str = match_obj[2];
  const octave_int = parseInt(match_obj[3], 10);

  let semitone_int = LETTER_SEMITONE_OFFSETS_DICT[letter_str];
  if (accidental_str === '#' || accidental_str === '♯') {
    semitone_int += 1;
  } else if (accidental_str === 'b' || accidental_str === '♭') {
    semitone_int -= 1;
  }

  const midi_number_int =
    (octave_int + 1) * SEMITONES_PER_OCTAVE_INT + semitone_int;
  const is_in_range_bool =
    midi_number_int >= 0 && midi_number_int <= MAX_MIDI_NUMBER_INT;
  return is_in_range_bool ? midi_number_int : NaN;
}

/**
 * Measure the interval between two frequencies in cents.
 *
 * Brief:
 *   Cents are the unit musicians use for small pitch differences; one cent
 *   is a hundredth of a semitone and roughly the threshold of perception.
 *
 * Arguments:
 *   from_hertz_float (number): Reference frequency.
 *   to_hertz_float (number): Target frequency.
 *
 * Returns:
 *   (number): Signed interval in cents; 1200 means exactly one octave up.
 */
export function measureCentsBetween(from_hertz_float, to_hertz_float) {
  return CENTS_PER_OCTAVE_INT * Math.log2(to_hertz_float / from_hertz_float);
}

/** The process-wide tuning instance every note selector reads from. */
export const TUNING_OBJ = new Tuning(ISO_REFERENCE_HERTZ_FLOAT);
