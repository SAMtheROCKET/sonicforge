/**
 * Deterministic pseudo-random generation for reproducible noise synthesis.
 *
 * Brief:
 *   Math.random cannot be seeded, which makes any assertion about a noise
 *   buffer's spectrum unreproducible. Every generator here accepts an
 *   explicit source so the test suite can measure the same buffer twice and
 *   get the same answer, while production code passes Math.random.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Mixing constants of the mulberry32 algorithm. */
const MULBERRY_INCREMENT_INT = 0x6d2b79f5;
const MULBERRY_FIRST_SHIFT_INT = 15;
const MULBERRY_SECOND_SHIFT_INT = 7;
const MULBERRY_THIRD_SHIFT_INT = 14;
const MULBERRY_SECOND_MULTIPLIER_INT = 61;

/** 2^32, used to normalise a 32-bit integer into the unit interval. */
const UINT32_RANGE_FLOAT = 4294967296;

const TAU_FLOAT = Math.PI * 2;

/* ------------------------------------------------------------------------ */

/**
 * Create a seeded pseudo-random generator over the unit interval.
 *
 * Brief:
 *   Mulberry32 is chosen for being tiny, fast, and statistically good
 *   enough for audio-rate noise. It is not cryptographically secure and is
 *   never used for anything that needs to be.
 *
 * Arguments:
 *   seed_int (number): Any 32-bit integer seed.
 *
 * Returns:
 *   (Function): A generator returning floats in [0, 1) on each call.
 *
 * Warning:
 *   Two generators built from the same seed produce identical sequences.
 *   That is the entire point here, but it makes them unsuitable anywhere
 *   unpredictability actually matters.
 */
export function createSeededRandom(seed_int) {
  let state_int = seed_int >>> 0;

  return function generateNextUnitFloat() {
    state_int = (state_int + MULBERRY_INCREMENT_INT) | 0;

    let mixed_int = Math.imul(
      state_int ^ (state_int >>> MULBERRY_FIRST_SHIFT_INT),
      1 | state_int
    );
    mixed_int =
      (mixed_int +
        Math.imul(
          mixed_int ^ (mixed_int >>> MULBERRY_SECOND_SHIFT_INT),
          MULBERRY_SECOND_MULTIPLIER_INT | mixed_int
        )) ^
      mixed_int;

    return (
      ((mixed_int ^ (mixed_int >>> MULBERRY_THIRD_SHIFT_INT)) >>> 0) /
      UINT32_RANGE_FLOAT
    );
  };
}

/**
 * Draw a normally distributed sample with zero mean and unit variance.
 *
 * Brief:
 *   White noise built from a uniform generator has a subtly non-Gaussian
 *   amplitude distribution that is audible as a faint buzz at high gain.
 *   The Box-Muller transform converts uniform samples into true Gaussian
 *   deviates, which sound correct.
 *
 * Arguments:
 *   random_source_fn (Function): Source returning floats in [0, 1).
 *
 * Returns:
 *   (number): A Gaussian deviate, typically within about -4 to 4.
 *
 * Warning:
 *   Discards the second deviate that Box-Muller produces, trading a little
 *   efficiency for a far simpler stateless interface.
 */
export function sampleGaussian(random_source_fn = Math.random) {
  let uniform_float = 0;
  while (uniform_float === 0) {
    uniform_float = random_source_fn();
  }

  const radius_float = Math.sqrt(-2 * Math.log(uniform_float));
  const angle_float = TAU_FLOAT * random_source_fn();
  return radius_float * Math.cos(angle_float);
}
