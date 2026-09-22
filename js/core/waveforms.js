/**
 * Waveform synthesis with arbitrary starting phase.
 *
 * Brief:
 *   OscillatorNode has no phase parameter, which is normally a dead end for
 *   interference work: you cannot demonstrate destructive cancellation if
 *   every oscillator necessarily starts at the same phase. SonicForge gets
 *   around it by building each wave from its Fourier coefficients and
 *   rotating every harmonic by k times the requested angle before handing
 *   the table to createPeriodicWave. The oscillator then *starts* at that
 *   phase, exactly and repeatably.
 *
 *   Web Audio evaluates a PeriodicWave as
 *     x(t) = sum over k of [ real[k]*cos(2*pi*k*t) + imag[k]*sin(2*pi*k*t) ]
 *   That sign convention is asserted against the browser's own sine
 *   oscillator in the test suite, because the whole phase feature depends
 *   on it and a silent inversion would be very hard to notice.
 *
 *   Rotating a sine-series term by an angle:
 *     b*sin(k*w*t + k*p) = b*sin(k*p)*cos(k*w*t) + b*cos(k*p)*sin(k*w*t)
 *   and a cosine-series term:
 *     a*cos(k*w*t + k*p) = a*cos(k*p)*cos(k*w*t) - a*sin(k*p)*sin(k*w*t)
 */

import { TAU_FLOAT } from '../util/numeric.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Harmonics per table. PeriodicWave band-limits per octave internally. */
const HARMONIC_COUNT_INT = 512;

/** Harmonics used by the analytic sampler that drives the visualiser. */
const VISUALISER_HARMONIC_COUNT_INT = 24;

/** Samples taken across one period when measuring a series peak. */
const PEAK_SEARCH_STEPS_INT = 2048;

/** Degrees in a full rotation, for phase normalisation. */
const FULL_ROTATION_DEGREES_INT = 360;

/** Available waveforms and how they are presented in the interface. */
export const WAVEFORMS_DICT = Object.freeze({
  sine: {
    label_str: 'Sine',
    glyph_str: '∿',
    hint_str: 'Single partial. The reference tone.',
  },
  square: {
    label_str: 'Square',
    glyph_str: '⊓',
    hint_str: 'Odd harmonics at 1/k. Hollow, penetrating.',
  },
  triangle: {
    label_str: 'Triangle',
    glyph_str: '△',
    hint_str: 'Odd harmonics at 1/k squared. Soft, flute-like.',
  },
  sawtooth: {
    label_str: 'Saw',
    glyph_str: '◢',
    hint_str: 'All harmonics at 1/k. Bright, full spectrum.',
  },
  impulse: {
    label_str: 'Impulse',
    glyph_str: '↑',
    hint_str: 'Band-limited pulse train. Transient and driver testing.',
  },
});

/** Waveform keys in presentation order. */
export const WAVEFORM_KEYS_LIST = Object.freeze(Object.keys(WAVEFORMS_DICT));

/** Cached coefficient tables, keyed by waveform name. */
const COEFFICIENT_CACHE_MAP = new Map();

/** Cached series peaks, keyed by waveform and harmonic count. */
const SERIES_PEAK_CACHE_MAP = new Map();

/** Per-context PeriodicWave cache, keyed by waveform and phase. */
const CONTEXT_WAVE_CACHE_MAP = new WeakMap();

/* ------------------------------------------------------------------------ */

/**
 * Build the Fourier coefficients of one period of a waveform.
 *
 * Brief:
 *   Returns two arrays indexed by harmonic number: cosine weights and sine
 *   weights. Every waveform here is defined analytically rather than
 *   sampled, so the tables are exact and free of aliasing at any pitch.
 *
 * Arguments:
 *   waveform_name_str (string): Key from WAVEFORMS_DICT.
 *   harmonic_count_int (number): Highest harmonic to include.
 *
 * Returns:
 *   (Object): cosine_float32array and sine_float32array, indexed by
 *   harmonic number, with index zero unused.
 *
 * Warning:
 *   Throws RangeError for an unknown waveform rather than defaulting to a
 *   sine, which would hide the mistake behind plausible-sounding output.
 */
function buildCoefficients(waveform_name_str,
                           harmonic_count_int = HARMONIC_COUNT_INT) {
  const cosine_float32array = new Float32Array(harmonic_count_int + 1);
  const sine_float32array = new Float32Array(harmonic_count_int + 1);

  switch (waveform_name_str) {
    case 'sine':
      sine_float32array[1] = 1;
      break;

    case 'square':
      fillSquareHarmonics(sine_float32array, harmonic_count_int);
      break;

    case 'sawtooth':
      fillSawtoothHarmonics(sine_float32array, harmonic_count_int);
      break;

    case 'triangle':
      fillTriangleHarmonics(sine_float32array, harmonic_count_int);
      break;

    case 'impulse':
      fillImpulseHarmonics(cosine_float32array, harmonic_count_int);
      break;

    default:
      throw new RangeError(`unknown waveform: ${waveform_name_str}`);
  }
  return { cosine_float32array, sine_float32array };
}

/**
 * Fill odd harmonics at 4/(pi*k), producing a square wave.
 *
 * Arguments:
 *   sine_float32array (Float32Array): Destination, modified in place.
 *   harmonic_count_int (number): Highest harmonic to write.
 *
 * Returns:
 *   (none)
 */
function fillSquareHarmonics(sine_float32array, harmonic_count_int) {
  for (
    let harmonic_int = 1;
    harmonic_int <= harmonic_count_int;
    harmonic_int += 2
  ) {
    sine_float32array[harmonic_int] = 4 / (Math.PI * harmonic_int);
  }
}

/**
 * Fill every harmonic at 2/(pi*k) with alternating sign, giving a ramp.
 *
 * Arguments:
 *   sine_float32array (Float32Array): Destination, modified in place.
 *   harmonic_count_int (number): Highest harmonic to write.
 *
 * Returns:
 *   (none)
 */
function fillSawtoothHarmonics(sine_float32array, harmonic_count_int) {
  for (
    let harmonic_int = 1;
    harmonic_int <= harmonic_count_int;
    harmonic_int += 1
  ) {
    const sign_int = harmonic_int % 2 ? 1 : -1;
    sine_float32array[harmonic_int] =
      ((2 / Math.PI) * sign_int) / harmonic_int;
  }
}

/**
 * Fill odd harmonics at 8/(pi^2 * k^2) with alternating sign.
 *
 * Arguments:
 *   sine_float32array (Float32Array): Destination, modified in place.
 *   harmonic_count_int (number): Highest harmonic to write.
 *
 * Returns:
 *   (none)
 */
function fillTriangleHarmonics(sine_float32array, harmonic_count_int) {
  for (
    let harmonic_int = 1;
    harmonic_int <= harmonic_count_int;
    harmonic_int += 2
  ) {
    const sign_int = ((harmonic_int - 1) / 2) % 2 === 0 ? 1 : -1;
    sine_float32array[harmonic_int] =
      (8 / (Math.PI * Math.PI)) * (sign_int / (harmonic_int * harmonic_int));
  }
}

/**
 * Fill every harmonic at equal cosine weight, tapered at the band edge.
 *
 * Brief:
 *   An untapered comb rings badly at the top of its band. A half Hann
 *   window across the harmonic index softens the edge while keeping the
 *   pulse sharp enough to excite a transducer's full transient response.
 *
 * Arguments:
 *   cosine_float32array (Float32Array): Destination, modified in place.
 *   harmonic_count_int (number): Highest harmonic to write.
 *
 * Returns:
 *   (none)
 */
function fillImpulseHarmonics(cosine_float32array, harmonic_count_int) {
  for (
    let harmonic_int = 1;
    harmonic_int <= harmonic_count_int;
    harmonic_int += 1
  ) {
    const taper_float =
      0.5 +
      0.5 * Math.cos((Math.PI * (harmonic_int - 1)) / harmonic_count_int);
    cosine_float32array[harmonic_int] = taper_float;
  }
}

/**
 * Fetch the cached coefficient tables for a waveform.
 *
 * Arguments:
 *   waveform_name_str (string): Key from WAVEFORMS_DICT.
 *
 * Returns:
 *   (Object): cosine_float32array and sine_float32array.
 */
function getCoefficients(waveform_name_str) {
  let coefficients_obj = COEFFICIENT_CACHE_MAP.get(waveform_name_str);
  if (!coefficients_obj) {
    coefficients_obj = buildCoefficients(waveform_name_str);
    COEFFICIENT_CACHE_MAP.set(waveform_name_str, coefficients_obj);
  }
  return coefficients_obj;
}

/* ------------------------------------------------------------------------ */

/**
 * Build the real and imaginary tables for a phase-rotated waveform.
 *
 * Brief:
 *   Exported separately from the node factory so the test suite can assert
 *   on the coefficients directly, without needing an AudioContext.
 *
 * Arguments:
 *   waveform_name_str (string): Key from WAVEFORMS_DICT.
 *   phase_degrees_float (number): Starting phase, 0 to 360.
 *
 * Returns:
 *   (Object): real_float32array and imaginary_float32array, ready for
 *   createPeriodicWave.
 *
 * Warning:
 *   Rotation preserves each harmonic's magnitude exactly; only the split
 *   between the cosine and sine terms changes.
 */
export function buildPhaseRotatedWaveTables(waveform_name_str,
                                            phase_degrees_float = 0) {
  const { cosine_float32array, sine_float32array } =
    getCoefficients(waveform_name_str);

  const table_length_int = cosine_float32array.length;
  const real_float32array = new Float32Array(table_length_int);
  const imaginary_float32array = new Float32Array(table_length_int);
  const phase_radians_float =
    (phase_degrees_float * TAU_FLOAT) / FULL_ROTATION_DEGREES_INT;

  if (phase_radians_float === 0) {
    real_float32array.set(cosine_float32array);
    imaginary_float32array.set(sine_float32array);
    return { real_float32array, imaginary_float32array };
  }

  for (
    let harmonic_int = 1;
    harmonic_int < table_length_int;
    harmonic_int += 1
  ) {
    const cosine_weight_float = cosine_float32array[harmonic_int];
    const sine_weight_float = sine_float32array[harmonic_int];
    if (cosine_weight_float === 0 && sine_weight_float === 0) {
      continue;
    }

    const rotation_float = harmonic_int * phase_radians_float;
    const cos_float = Math.cos(rotation_float);
    const sin_float = Math.sin(rotation_float);

    real_float32array[harmonic_int] =
      sine_weight_float * sin_float + cosine_weight_float * cos_float;
    imaginary_float32array[harmonic_int] =
      sine_weight_float * cos_float - cosine_weight_float * sin_float;
  }
  return { real_float32array, imaginary_float32array };
}

/**
 * Fetch a cached PeriodicWave for a context, waveform and phase.
 *
 * Brief:
 *   Phase is quantised to whole degrees, which is finer than any listener
 *   can detect on a start transient and keeps the cache to at most 360
 *   entries per waveform per context.
 *
 * Arguments:
 *   audio_context_obj (BaseAudioContext): Context that will own the wave.
 *   waveform_name_str (string): Key from WAVEFORMS_DICT.
 *   phase_degrees_float (number): Starting phase in degrees.
 *
 * Returns:
 *   (PeriodicWave): A wave usable only with the given context.
 *
 * Warning:
 *   Throws RangeError for an unknown waveform.
 */
export function getPeriodicWave(audio_context_obj, waveform_name_str,
                                phase_degrees_float = 0) {
  if (!WAVEFORMS_DICT[waveform_name_str]) {
    throw new RangeError(`unknown waveform: ${waveform_name_str}`);
  }

  let context_cache_map = CONTEXT_WAVE_CACHE_MAP.get(audio_context_obj);
  if (!context_cache_map) {
    context_cache_map = new Map();
    CONTEXT_WAVE_CACHE_MAP.set(audio_context_obj, context_cache_map);
  }

  const phase_int = normalisePhaseDegrees(phase_degrees_float);
  const cache_key_str = `${waveform_name_str}:${phase_int}`;

  let wave_obj = context_cache_map.get(cache_key_str);
  if (!wave_obj) {
    const { real_float32array, imaginary_float32array } =
      buildPhaseRotatedWaveTables(waveform_name_str, phase_int);
    wave_obj = audio_context_obj.createPeriodicWave(
      real_float32array,
      imaginary_float32array,
      { disableNormalization: false }
    );
    context_cache_map.set(cache_key_str, wave_obj);
  }
  return wave_obj;
}

/**
 * Normalise a phase angle into whole degrees within one rotation.
 *
 * Brief:
 *   Phase arrives from sliders, scripts and remote peers, any of which may
 *   send a negative angle or one past a full turn. Normalising in one place
 *   keeps the wave cache keyed consistently.
 *
 * Arguments:
 *   phase_degrees_float (number): Any angle, positive or negative.
 *
 * Returns:
 *   (number): An integer from 0 through 359.
 */
export function normalisePhaseDegrees(phase_degrees_float) {
  const rounded_int = Math.round(Number(phase_degrees_float) || 0);
  return (
    ((rounded_int % FULL_ROTATION_DEGREES_INT) +
      FULL_ROTATION_DEGREES_INT) %
    FULL_ROTATION_DEGREES_INT
  );
}

/**
 * Apply a waveform and starting phase to an oscillator node.
 *
 * Brief:
 *   At zero phase a plain waveform uses the browser's native type, which is
 *   both cheaper and guaranteed band-limited by the implementation. Any
 *   non-zero phase, or the impulse waveform, routes through a custom
 *   PeriodicWave instead.
 *
 * Arguments:
 *   oscillator_node (OscillatorNode): Node to configure.
 *   waveform_name_str (string): Key from WAVEFORMS_DICT.
 *   phase_degrees_float (number): Starting phase in degrees.
 *
 * Returns:
 *   (OscillatorNode): The same node, for chaining.
 *
 * Warning:
 *   Applying this to a running oscillator rotates its output immediately.
 *   Small increments are inaudible; a large jump produces an audible and
 *   deliberate discontinuity.
 */
export function applyWaveform(oscillator_node, waveform_name_str,
                              phase_degrees_float = 0) {
  const phase_int = normalisePhaseDegrees(phase_degrees_float);

  if (phase_int === 0 && waveform_name_str !== 'impulse') {
    oscillator_node.type = waveform_name_str;
    return oscillator_node;
  }

  oscillator_node.setPeriodicWave(
    getPeriodicWave(oscillator_node.context, waveform_name_str, phase_int)
  );
  return oscillator_node;
}

/**
 * Apply a waveform through a rotated wave table, whatever the phase.
 *
 * Brief:
 *   applyWaveform hands a zero-phase wave to the browser's native type.
 *   A phase-locked channel cannot take that shortcut. Its table angle
 *   depends on the frame it started on, so the same channel lands on zero
 *   one time and on another angle the next. The browser builds its native
 *   square, saw and triangle from its own tables, which need not match
 *   these harmonic for harmonic. Mixing the two would let a channel's
 *   timbre shift between starts, and would leave a residue where two
 *   opposed channels should cancel.
 *
 * Arguments:
 *   oscillator_node (OscillatorNode): Node to configure.
 *   waveform_name_str (string): Key from WAVEFORMS_DICT.
 *   phase_degrees_float (number): Table rotation in degrees.
 *
 * Returns:
 *   (OscillatorNode): The same node, for chaining.
 *
 * Warning:
 *   Applying this to a running oscillator rotates its output immediately.
 */
export function applyRotatedWaveform(oscillator_node, waveform_name_str,
                                     phase_degrees_float = 0) {
  oscillator_node.setPeriodicWave(
    getPeriodicWave(
      oscillator_node.context, waveform_name_str, phase_degrees_float
    )
  );
  return oscillator_node;
}

/* ------------------------------------------------------------------------ */

/**
 * Measure the true peak of a waveform's harmonic series.
 *
 * Brief:
 *   createPeriodicWave normalises its output to roughly unit peak, so the
 *   visualiser must do the same or an impulse - whose harmonics all align
 *   at t = 0 - would tower over every other waveform. No closed form exists
 *   for an arbitrary series, so one period is densely sampled and cached.
 *
 * Arguments:
 *   waveform_name_str (string): Key from WAVEFORMS_DICT.
 *   harmonic_count_int (number): Harmonics included in the sum.
 *
 * Returns:
 *   (number): The largest absolute value the series reaches.
 *
 * Warning:
 *   Phase rotation is a pure time shift and cannot change the peak, so the
 *   unrotated measurement is valid for every phase.
 */
export function measureSeriesPeak(waveform_name_str, harmonic_count_int) {
  const cache_key_str = `${waveform_name_str}:${harmonic_count_int}`;
  const cached_float = SERIES_PEAK_CACHE_MAP.get(cache_key_str);
  if (cached_float !== undefined) {
    return cached_float;
  }

  let peak_float = 0;
  for (
    let step_int = 0;
    step_int < PEAK_SEARCH_STEPS_INT;
    step_int += 1
  ) {
    const magnitude_float = Math.abs(
      sumHarmonicSeries(
        waveform_name_str,
        step_int / PEAK_SEARCH_STEPS_INT,
        0,
        harmonic_count_int
      )
    );
    if (magnitude_float > peak_float) {
      peak_float = magnitude_float;
    }
  }

  const result_float = peak_float || 1;
  SERIES_PEAK_CACHE_MAP.set(cache_key_str, result_float);
  return result_float;
}

/**
 * Sum a waveform's harmonic series at one point in its period.
 *
 * Arguments:
 *   waveform_name_str (string): Key from WAVEFORMS_DICT.
 *   position_float (number): Position within the period, 0 to 1.
 *   phase_degrees_float (number): Starting phase in degrees.
 *   harmonic_count_int (number): Harmonics to include.
 *
 * Returns:
 *   (number): The unnormalised series value at that position.
 */
function sumHarmonicSeries(waveform_name_str, position_float,
                           phase_degrees_float, harmonic_count_int) {
  const { cosine_float32array, sine_float32array } =
    getCoefficients(waveform_name_str);

  const phase_radians_float =
    (phase_degrees_float * TAU_FLOAT) / FULL_ROTATION_DEGREES_INT;
  const highest_int = Math.min(
    harmonic_count_int,
    cosine_float32array.length - 1
  );
  let total_float = 0;

  for (
    let harmonic_int = 1;
    harmonic_int <= highest_int;
    harmonic_int += 1
  ) {
    const cosine_weight_float = cosine_float32array[harmonic_int];
    const sine_weight_float = sine_float32array[harmonic_int];
    if (cosine_weight_float === 0 && sine_weight_float === 0) {
      continue;
    }

    const angle_float =
      TAU_FLOAT * harmonic_int * position_float +
      harmonic_int * phase_radians_float;
    total_float +=
      cosine_weight_float * Math.cos(angle_float) +
      sine_weight_float * Math.sin(angle_float);
  }
  return total_float;
}

/**
 * Sample a waveform analytically at unit peak amplitude.
 *
 * Brief:
 *   Drives the interference visualiser, which must predict the summed
 *   waveform of several channels without routing audio through an analyser.
 *   An FFT can show you that the result is quiet; only the analytic sum
 *   shows you that two tones are cancelling.
 *
 * Arguments:
 *   waveform_name_str (string): Key from WAVEFORMS_DICT.
 *   position_float (number): Position within the period, 0 to 1.
 *   phase_degrees_float (number): Starting phase in degrees.
 *   harmonic_count_int (number): Harmonics to include.
 *
 * Returns:
 *   (number): Sample value, scaled so the waveform peaks near unity.
 */
export function sampleWaveform(waveform_name_str, position_float,
                               phase_degrees_float = 0,
                               harmonic_count_int =
                                 VISUALISER_HARMONIC_COUNT_INT) {
  const { cosine_float32array } = getCoefficients(waveform_name_str);
  const highest_int = Math.min(
    harmonic_count_int,
    cosine_float32array.length - 1
  );

  const total_float = sumHarmonicSeries(
    waveform_name_str,
    position_float,
    phase_degrees_float,
    highest_int
  );
  return total_float / measureSeriesPeak(waveform_name_str, highest_int);
}
