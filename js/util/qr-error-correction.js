/**
 * Galois field arithmetic, Reed-Solomon coding, and BCH format codes.
 *
 * Brief:
 *   The error-correction half of the QR encoder, separated from the matrix
 *   layout so the two can be reasoned about independently. Everything here
 *   is pure integer maths over GF(256) with no knowledge of QR geometry.
 *
 *   Reference: ISO/IEC 18004. Implemented from the specification.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Primitive polynomial generating GF(256) for QR codes: x^8+x^4+x^3+x^2+1. */
const FIELD_PRIMITIVE_POLYNOMIAL_INT = 0x11d;

/** Number of non-zero elements in GF(256). */
const FIELD_ORDER_INT = 255;

/** Generator polynomial of the BCH(15,5) format information code. */
const FORMAT_BCH_GENERATOR_INT = 0x537;

/** Mask XORed into format information so it is never all zeroes. */
const FORMAT_XOR_MASK_INT = 0x5412;

/** Generator polynomial of the BCH(18,6) version information code. */
const VERSION_BCH_GENERATOR_INT = 0x1f25;

/** Two-bit indicator for error-correction level M. */
const EC_LEVEL_M_INDICATOR_INT = 0b00;

/* ---------------------------------------------------------------------------
 * Field tables, built once at module load
 * ------------------------------------------------------------------------ */

const EXPONENT_TABLE_UINT8ARRAY = new Uint8Array(512);
const LOGARITHM_TABLE_UINT8ARRAY = new Uint8Array(256);

(function buildFieldTables() {
  let value_int = 1;

  for (let power_int = 0; power_int < FIELD_ORDER_INT; power_int += 1) {
    EXPONENT_TABLE_UINT8ARRAY[power_int] = value_int;
    LOGARITHM_TABLE_UINT8ARRAY[value_int] = power_int;

    value_int <<= 1;
    if (value_int & 0x100) {
      value_int ^= FIELD_PRIMITIVE_POLYNOMIAL_INT;
    }
  }

  // Duplicate the table so exponent lookups never need a modulo.
  for (let power_int = FIELD_ORDER_INT; power_int < 512; power_int += 1) {
    EXPONENT_TABLE_UINT8ARRAY[power_int] =
      EXPONENT_TABLE_UINT8ARRAY[power_int - FIELD_ORDER_INT];
  }
})();

/* ------------------------------------------------------------------------ */

/**
 * Multiply two elements of GF(256).
 *
 * Brief:
 *   Multiplication becomes addition of logarithms in a finite field, which
 *   is why the exponent and logarithm tables exist at all.
 *
 * Arguments:
 *   left_int (number): First operand, 0 to 255.
 *   right_int (number): Second operand, 0 to 255.
 *
 * Returns:
 *   (number): The product in GF(256).
 *
 * Warning:
 *   Zero is handled separately because it has no logarithm.
 */
export function multiplyInField(left_int, right_int) {
  if (left_int === 0 || right_int === 0) {
    return 0;
  }
  return EXPONENT_TABLE_UINT8ARRAY[
    LOGARITHM_TABLE_UINT8ARRAY[left_int] +
      LOGARITHM_TABLE_UINT8ARRAY[right_int]
  ];
}

/**
 * Build the Reed-Solomon generator polynomial of a given degree.
 *
 * Brief:
 *   The generator is the product of (x - a^i) for i from 0 to degree-1,
 *   expanded into coefficient form. Degree equals the number of error
 *   correction codewords the block will carry.
 *
 * Arguments:
 *   degree_int (number): Number of error correction codewords.
 *
 * Returns:
 *   (number[]): Coefficients, highest order first.
 */
export function buildGeneratorPolynomial(degree_int) {
  let coefficients_list = [1];

  for (let step_int = 0; step_int < degree_int; step_int += 1) {
    const next_list = new Array(coefficients_list.length + 1).fill(0);

    for (
      let index_int = 0;
      index_int < coefficients_list.length;
      index_int += 1
    ) {
      next_list[index_int] ^= coefficients_list[index_int];
      next_list[index_int + 1] ^= multiplyInField(
        coefficients_list[index_int],
        EXPONENT_TABLE_UINT8ARRAY[step_int]
      );
    }
    coefficients_list = next_list;
  }
  return coefficients_list;
}

/**
 * Compute the Reed-Solomon error correction codewords for a data block.
 *
 * Brief:
 *   Polynomial long division of the data by the generator; the remainder is
 *   the error correction. This is what lets a QR code survive being partly
 *   obscured, creased, or photographed at an angle.
 *
 * Arguments:
 *   data_uint8array (Uint8Array): Data codewords for one block.
 *   error_correction_count_int (number): Codewords to generate.
 *
 * Returns:
 *   (Uint8Array): The error correction codewords.
 */
export function encodeReedSolomon(data_uint8array,
                                  error_correction_count_int) {
  const generator_list = buildGeneratorPolynomial(
    error_correction_count_int
  );
  const working_uint8array = new Uint8Array(
    data_uint8array.length + error_correction_count_int
  );
  working_uint8array.set(data_uint8array);

  for (
    let index_int = 0;
    index_int < data_uint8array.length;
    index_int += 1
  ) {
    const leading_int = working_uint8array[index_int];
    if (leading_int === 0) {
      continue;
    }

    for (
      let offset_int = 1;
      offset_int <= error_correction_count_int;
      offset_int += 1
    ) {
      working_uint8array[index_int + offset_int] ^= multiplyInField(
        generator_list[offset_int],
        leading_int
      );
    }
  }
  return working_uint8array.subarray(data_uint8array.length);
}

/**
 * Compute the 15-bit format information word for a mask pattern.
 *
 * Brief:
 *   Format information states the error-correction level and mask, is
 *   protected by a BCH(15,5) code, and is then XORed with a fixed mask so
 *   that an all-zero configuration still produces a readable pattern.
 *   SonicForge always uses error-correction level M.
 *
 * Arguments:
 *   mask_id_int (number): Mask pattern index, 0 to 7.
 *
 * Returns:
 *   (number): The 15-bit format information word.
 */
export function computeFormatInformationBits(mask_id_int) {
  const data_int = (EC_LEVEL_M_INDICATOR_INT << 3) | mask_id_int;
  let remainder_int = data_int << 10;

  for (let bit_int = 14; bit_int >= 10; bit_int -= 1) {
    if ((remainder_int >> bit_int) & 1) {
      remainder_int ^= FORMAT_BCH_GENERATOR_INT << (bit_int - 10);
    }
  }
  return ((data_int << 10) | remainder_int) ^ FORMAT_XOR_MASK_INT;
}

/**
 * Compute the 18-bit version information word for a QR version.
 *
 * Brief:
 *   Only versions 7 and above carry version information, because smaller
 *   symbols can be identified from their size alone.
 *
 * Arguments:
 *   version_int (number): QR version, 7 to 40.
 *
 * Returns:
 *   (number): The 18-bit version information word.
 */
export function computeVersionInformationBits(version_int) {
  let remainder_int = version_int << 12;

  for (let bit_int = 17; bit_int >= 12; bit_int -= 1) {
    if ((remainder_int >> bit_int) & 1) {
      remainder_int ^= VERSION_BCH_GENERATOR_INT << (bit_int - 12);
    }
  }
  return (version_int << 12) | remainder_int;
}

/**
 * Accumulate individual bits and read them back as whole bytes.
 *
 * Brief:
 *   QR data is a bit stream whose fields are not byte aligned - a four-bit
 *   mode indicator followed by an eight or sixteen bit character count. A
 *   small bit buffer is far clearer than manual shifting at each site.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (BitBuffer): An empty buffer.
 */
export class BitBuffer {
  /** @type {number[]} */
  #bits_list = [];

  /**
   * Append the low bits of a value, most significant first.
   *
   * Arguments:
   *   value_int (number): Value to append.
   *   bit_count_int (number): How many low bits to take.
   *
   * Returns:
   *   (none)
   */
  put(value_int, bit_count_int) {
    for (
      let shift_int = bit_count_int - 1;
      shift_int >= 0;
      shift_int -= 1
    ) {
      this.#bits_list.push((value_int >> shift_int) & 1);
    }
  }

  /**
   * Report how many bits have been appended.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): Current bit count.
   */
  get lengthInBits() {
    return this.#bits_list.length;
  }

  /**
   * Pack the accumulated bits into bytes.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Uint8Array): Bits packed most significant first, zero padded.
   *
   * Warning:
   *   A partial final byte is padded with zeroes. Callers must have already
   *   appended the terminator and alignment bits the specification requires.
   */
  toBytes() {
    const bytes_uint8array = new Uint8Array(
      Math.ceil(this.#bits_list.length / 8)
    );

    for (
      let bit_index_int = 0;
      bit_index_int < this.#bits_list.length;
      bit_index_int += 1
    ) {
      if (this.#bits_list[bit_index_int]) {
        bytes_uint8array[bit_index_int >> 3] |= 0x80 >> (bit_index_int & 7);
      }
    }
    return bytes_uint8array;
  }
}
