/**
 * Argument coercion for the SonicForge command set.
 *
 * Brief:
 *   Script arguments arrive as parsed tokens, not values. Every command
 *   wants the same handful of shapes out of them - a frequency, a duration,
 *   a level, a keyword - and each wants a sensible fallback rather than an
 *   error when the argument is missing. Keeping that in one module means a
 *   command body reads as what it does, not as what it had to unpack.
 */

import { clampToRange } from '../util/numeric.js';
import { WAVEFORM_KEYS_LIST } from '../core/waveforms.js';
import { parseNoteName } from '../core/tuning.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Short forms accepted anywhere a keyword is expected. */
const WORD_ALIASES_DICT = Object.freeze({
  sin: 'sine',
  sine: 'sine',
  sqr: 'square',
  square: 'square',
  tri: 'triangle',
  triangle: 'triangle',
  saw: 'sawtooth',
  sawtooth: 'sawtooth',
  ramp: 'sawtooth',
  imp: 'impulse',
  impulse: 'impulse',
  pulse: 'impulse',
  click: 'impulse',
  lin: 'linear',
  linear: 'linear',
  exp: 'exponential',
  exponential: 'exponential',
  log: 'exponential',
});

/** Frequency bounds a script argument is clamped into, in hertz. */
const MIN_ARGUMENT_HERTZ_FLOAT = 0.01;
const MAX_ARGUMENT_HERTZ_FLOAT = 22050;

/** Longest duration a single command may occupy, in milliseconds. */
const MAX_DURATION_MS_INT = 30 * 60 * 1000;

/** Level bounds a script argument is clamped into, in dBFS. */
const MIN_GAIN_DB_FLOAT = -90;
const MAX_GAIN_DB_FLOAT = 0;

/* ------------------------------------------------------------------------ */

/**
 * Read the plain value out of a parsed argument token.
 *
 * Brief:
 *   Returns undefined rather than throwing for a missing or structural
 *   token, so every reader below can supply its own fallback instead of
 *   each command having to guard first.
 *
 * Arguments:
 *   argument_obj (Object|null): A parsed number, string or word token.
 *
 * Returns:
 *   (number|string|undefined): The value, or undefined if there is none.
 */
export function readArgumentValue(argument_obj) {
  if (argument_obj == null) {
    return undefined;
  }
  if (argument_obj.kind_str === 'number') {
    return argument_obj.value_any;
  }
  if (argument_obj.kind_str === 'string' ||
    argument_obj.kind_str === 'word') {
    return argument_obj.value_any;
  }
  return undefined;
}

/**
 * Read a numeric argument.
 *
 * Brief:
 *   A numeric-looking string is accepted too, because the lexer classes a
 *   bare token as a word until it is asked to be a number.
 *
 * Arguments:
 *   argument_obj (Object|null): The argument token.
 *   fallback_float (number): Value used when the argument is missing.
 *
 * Returns:
 *   (number): The parsed number, or the fallback.
 */
export function readNumber(argument_obj, fallback_float) {
  const value_any = readArgumentValue(argument_obj);

  if (typeof value_any === 'number' && Number.isFinite(value_any)) {
    return value_any;
  }
  if (typeof value_any === 'string') {
    const parsed_float = Number(value_any);
    if (Number.isFinite(parsed_float)) {
      return parsed_float;
    }
  }
  return fallback_float;
}

/**
 * Read a frequency argument.
 *
 * Brief:
 *   A frequency may be a number, a unit-suffixed number, or a note name.
 *   play(A4) and play(440hz) are the same tone, and a note name follows the
 *   current concert-pitch reference rather than assuming 440.
 *
 * Arguments:
 *   runtime_obj (Object): The command runtime, for the tuning reference.
 *   argument_obj (Object|null): The argument token.
 *   fallback_hertz_float (number): Value used when the argument is missing.
 *
 * Returns:
 *   (number): Frequency in hertz, clamped into the synthesisable range.
 */
export function readFrequencyHertz(
  runtime_obj,
  argument_obj,
  fallback_hertz_float = 440
) {
  const value_any = readArgumentValue(argument_obj);

  if (typeof value_any === 'number' && Number.isFinite(value_any)) {
    return clampToRange(
      value_any, MIN_ARGUMENT_HERTZ_FLOAT, MAX_ARGUMENT_HERTZ_FLOAT
    );
  }

  if (typeof value_any === 'string') {
    const midi_number_int = parseNoteName(value_any);
    if (Number.isFinite(midi_number_int)) {
      return runtime_obj.app_obj.tuning.convertMidiToHertz(midi_number_int);
    }
    const parsed_float = Number(value_any);
    if (Number.isFinite(parsed_float)) {
      return clampToRange(
        parsed_float, MIN_ARGUMENT_HERTZ_FLOAT, MAX_ARGUMENT_HERTZ_FLOAT
      );
    }
  }
  return fallback_hertz_float;
}

/**
 * Read a duration argument.
 *
 * Brief:
 *   Clamped to half an hour. A script that asks for longer has almost
 *   certainly confused seconds with milliseconds, and the VM would hold
 *   the voice for the whole time.
 *
 * Arguments:
 *   argument_obj (Object|null): The argument token.
 *   fallback_ms_float (number): Value used when the argument is missing.
 *
 * Returns:
 *   (number): Duration in milliseconds; bare numbers are milliseconds.
 */
export function readDurationMs(argument_obj, fallback_ms_float = 500) {
  return clampToRange(
    readNumber(argument_obj, fallback_ms_float), 0, MAX_DURATION_MS_INT
  );
}

/**
 * Read a keyword argument, resolving any short form.
 *
 * Brief:
 *   Lower-cased before lookup, so SINE and Sine behave as sine.
 *
 * Arguments:
 *   argument_obj (Object|null): The argument token.
 *   fallback_str (string): Value used when the argument is missing.
 *
 * Returns:
 *   (string): The lower-cased keyword, with aliases expanded.
 */
export function readWord(argument_obj, fallback_str = '') {
  const value_any = readArgumentValue(argument_obj);
  if (typeof value_any !== 'string') {
    return fallback_str;
  }
  const key_str = value_any.toLowerCase();
  return WORD_ALIASES_DICT[key_str] ?? key_str;
}

/**
 * Read a waveform-name argument.
 *
 * Brief:
 *   An unrecognised name falls back rather than failing, because a typo
 *   in a waveform should not stop a long script mid-run.
 *
 * Arguments:
 *   argument_obj (Object|null): The argument token.
 *   fallback_str (string): Value used when the name is missing or unknown.
 *
 * Returns:
 *   (string): A key of WAVEFORMS_DICT.
 */
export function readWaveformName(argument_obj, fallback_str = 'sine') {
  const name_str = readWord(argument_obj, fallback_str);
  return WAVEFORM_KEYS_LIST.includes(name_str) ? name_str : fallback_str;
}

/**
 * Read a level argument.
 *
 * Brief:
 *   Clamped at 0 dBFS. Channel levels never add gain; only the master
 *   stage may, and only through gain().
 *
 * Arguments:
 *   argument_obj (Object|null): The argument token.
 *   fallback_db_float (number): Value used when the argument is missing.
 *
 * Returns:
 *   (number): Level in dBFS, clamped so a script cannot ask for gain.
 */
export function readGainDb(argument_obj, fallback_db_float = -12) {
  return clampToRange(
    readNumber(argument_obj, fallback_db_float),
    MIN_GAIN_DB_FLOAT,
    MAX_GAIN_DB_FLOAT
  );
}
