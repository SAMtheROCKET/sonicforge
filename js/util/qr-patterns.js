/**
 * QR function patterns and data placement.
 *
 * Brief:
 *   Everything that draws fixed geometry into a QR symbol: the three finder
 *   patterns a scanner locates first, the alignment patterns that correct
 *   for perspective, the timing patterns that establish the module grid,
 *   and the boustrophedon walk that threads the payload around them.
 *
 *   Reference: ISO/IEC 18004.
 */

import {
  computeFormatInformationBits,
  computeVersionInformationBits,
} from './qr-error-correction.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Alignment pattern centre coordinates per version. */
export const ALIGNMENT_CENTRES_LIST = Object.freeze([
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
]);

/** Module value meaning "not yet written". */
const UNSET_MODULE_INT = -1;

/** The eight mask predicates defined by the specification. */
export const MASK_PREDICATES_LIST = Object.freeze([
  (column_int, row_int) => (column_int + row_int) % 2 === 0,
  (column_int, row_int) => row_int % 2 === 0,
  (column_int) => column_int % 3 === 0,
  (column_int, row_int) => (column_int + row_int) % 3 === 0,
  (column_int, row_int) =>
    (Math.floor(row_int / 2) + Math.floor(column_int / 3)) % 2 === 0,
  (column_int, row_int) =>
    ((column_int * row_int) % 2) + ((column_int * row_int) % 3) === 0,
  (column_int, row_int) =>
    (((column_int * row_int) % 2) + ((column_int * row_int) % 3)) % 2 === 0,
  (column_int, row_int) =>
    (((column_int + row_int) % 2) + ((column_int * row_int) % 3)) % 2 === 0,
]);

/* ------------------------------------------------------------------------ */

/**
 * Hold the module grid of a QR symbol during construction.
 *
 * Brief:
 *   Tracks two things per module: whether it is dark, and whether it is
 *   reserved for a function pattern. The reservation flag is what stops the
 *   data placement walk from overwriting finders and timing patterns.
 *
 * Arguments:
 *   size_int (number): Symbol width in modules.
 *
 * Returns:
 *   (QrMatrix): A matrix with every module unset.
 */
export class QrMatrix {
  constructor(size_int) {
    this.size_int = size_int;
    this.modules_int8array = new Int8Array(size_int * size_int).fill(
      UNSET_MODULE_INT
    );
    this.reserved_uint8array = new Uint8Array(size_int * size_int);
  }

  /**
   * Read a module's value.
   *
   * Arguments:
   *   column_int (number): Column index.
   *   row_int (number): Row index.
   *
   * Returns:
   *   (number): 1 for dark, 0 for light, -1 when unset.
   */
  get(column_int, row_int) {
    return this.modules_int8array[row_int * this.size_int + column_int];
  }

  /**
   * Write a module, optionally reserving it against data placement.
   *
   * Arguments:
   *   column_int (number): Column index.
   *   row_int (number): Row index.
   *   is_dark_bool (boolean): Whether the module is dark.
   *   is_reserved_bool (boolean): Whether to protect it from data.
   *
   * Returns:
   *   (none)
   */
  set(column_int, row_int, is_dark_bool, is_reserved_bool = false) {
    const offset_int = row_int * this.size_int + column_int;
    this.modules_int8array[offset_int] = is_dark_bool ? 1 : 0;
    if (is_reserved_bool) {
      this.reserved_uint8array[offset_int] = 1;
    }
  }

  /**
   * Report whether a module is reserved for a function pattern.
   *
   * Arguments:
   *   column_int (number): Column index.
   *   row_int (number): Row index.
   *
   * Returns:
   *   (boolean): True when the module must not carry data.
   */
  isReserved(column_int, row_int) {
    return (
      this.reserved_uint8array[row_int * this.size_int + column_int] === 1
    );
  }
}

/**
 * Draw one 7x7 finder pattern and its separator.
 *
 * Brief:
 *   The three finder patterns are what a scanner locates first to establish
 *   the symbol's position and orientation. The one-module separator around
 *   each is what keeps them distinguishable from surrounding data.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to draw into.
 *   origin_column_int (number): Left edge of the finder.
 *   origin_row_int (number): Top edge of the finder.
 *
 * Returns:
 *   (none)
 */
export function drawFinderPattern(matrix_obj, origin_column_int,
                                  origin_row_int) {
  for (let offset_row_int = -1; offset_row_int <= 7; offset_row_int += 1) {
    for (
      let offset_column_int = -1;
      offset_column_int <= 7;
      offset_column_int += 1
    ) {
      const column_int = origin_column_int + offset_column_int;
      const row_int = origin_row_int + offset_row_int;

      const is_outside_bool =
        column_int < 0 ||
        row_int < 0 ||
        column_int >= matrix_obj.size_int ||
        row_int >= matrix_obj.size_int;
      if (is_outside_bool) {
        continue;
      }

      const is_ring_bool =
        (offset_column_int >= 0 && offset_column_int <= 6 &&
          (offset_row_int === 0 || offset_row_int === 6)) ||
        (offset_row_int >= 0 && offset_row_int <= 6 &&
          (offset_column_int === 0 || offset_column_int === 6));
      const is_core_bool =
        offset_column_int >= 2 && offset_column_int <= 4 &&
        offset_row_int >= 2 && offset_row_int <= 4;

      matrix_obj.set(column_int, row_int, is_ring_bool || is_core_bool, true);
    }
  }
}

/**
 * Draw every alignment pattern required by a version.
 *
 * Brief:
 *   Alignment patterns let a decoder correct for perspective distortion when
 *   the code is photographed at an angle. Version 1 needs none; larger
 *   symbols need progressively more.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to draw into.
 *   version_int (number): QR version.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   Alignment patterns never overlap a finder, so candidate positions that
 *   collide with one are skipped.
 */
export function drawAlignmentPatterns(matrix_obj, version_int) {
  const centres_list = ALIGNMENT_CENTRES_LIST[version_int];
  const finder_centres_list = [
    [3, 3],
    [matrix_obj.size_int - 4, 3],
    [3, matrix_obj.size_int - 4],
  ];

  for (const centre_row_int of centres_list) {
    for (const centre_column_int of centres_list) {
      const overlaps_finder_bool = finder_centres_list.some(
        ([finder_column_int, finder_row_int]) =>
          Math.abs(centre_column_int - finder_column_int) <= 4 &&
          Math.abs(centre_row_int - finder_row_int) <= 4
      );
      if (overlaps_finder_bool) {
        continue;
      }

      for (let offset_row_int = -2; offset_row_int <= 2; offset_row_int += 1) {
        for (
          let offset_column_int = -2;
          offset_column_int <= 2;
          offset_column_int += 1
        ) {
          const ring_int = Math.max(
            Math.abs(offset_column_int),
            Math.abs(offset_row_int)
          );
          matrix_obj.set(
            centre_column_int + offset_column_int,
            centre_row_int + offset_row_int,
            ring_int !== 1,
            true
          );
        }
      }
    }
  }
}

/**
 * Draw the horizontal and vertical timing patterns.
 *
 * Brief:
 *   The alternating row and column give a decoder the module pitch, which is
 *   how it counts modules correctly in a blurred or skewed image.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to draw into.
 *
 * Returns:
 *   (none)
 */
export function drawTimingPatterns(matrix_obj) {
  for (
    let position_int = 8;
    position_int < matrix_obj.size_int - 8;
    position_int += 1
  ) {
    const is_dark_bool = position_int % 2 === 0;
    if (!matrix_obj.isReserved(position_int, 6)) {
      matrix_obj.set(position_int, 6, is_dark_bool, true);
    }
    if (!matrix_obj.isReserved(6, position_int)) {
      matrix_obj.set(6, position_int, is_dark_bool, true);
    }
  }
}

/**
 * Reserve the format and version information areas.
 *
 * Brief:
 *   These areas are written last but must be reserved first, or the data
 *   placement walk would fill them and be overwritten.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to reserve within.
 *   version_int (number): QR version.
 *
 * Returns:
 *   (none)
 */
export function reserveInformationAreas(matrix_obj, version_int) {
  const size_int = matrix_obj.size_int;

  for (let index_int = 0; index_int < 9; index_int += 1) {
    if (!matrix_obj.isReserved(index_int, 8)) {
      matrix_obj.set(index_int, 8, false, true);
    }
    if (!matrix_obj.isReserved(8, index_int)) {
      matrix_obj.set(8, index_int, false, true);
    }
  }

  for (let index_int = 0; index_int < 8; index_int += 1) {
    matrix_obj.set(size_int - 1 - index_int, 8, false, true);
    matrix_obj.set(8, size_int - 1 - index_int, false, true);
  }

  // The specification fixes this one module as always dark.
  matrix_obj.set(8, size_int - 8, true, true);

  if (version_int >= 7) {
    for (let index_int = 0; index_int < 18; index_int += 1) {
      const short_int = Math.floor(index_int / 3);
      const long_int = (index_int % 3) + size_int - 11;
      matrix_obj.set(short_int, long_int, false, true);
      matrix_obj.set(long_int, short_int, false, true);
    }
  }
}

/**
 * Write the format information for a chosen mask, in both copies.
 *
 * Brief:
 *   Two copies are written in different corners so the symbol stays readable
 *   even if one corner is damaged.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to write into.
 *   mask_id_int (number): Mask pattern index, 0 to 7.
 *
 * Returns:
 *   (none)
 */
export function writeFormatInformation(matrix_obj, mask_id_int) {
  const format_bits_int = computeFormatInformationBits(mask_id_int);
  const size_int = matrix_obj.size_int;

  for (let bit_int = 0; bit_int < 15; bit_int += 1) {
    const is_dark_bool = ((format_bits_int >> bit_int) & 1) === 1;

    if (bit_int < 6) {
      matrix_obj.set(8, bit_int, is_dark_bool, true);
    } else if (bit_int === 6) {
      matrix_obj.set(8, 7, is_dark_bool, true);
    } else if (bit_int === 7) {
      matrix_obj.set(8, 8, is_dark_bool, true);
    } else if (bit_int === 8) {
      matrix_obj.set(7, 8, is_dark_bool, true);
    } else {
      matrix_obj.set(14 - bit_int, 8, is_dark_bool, true);
    }

    if (bit_int < 8) {
      matrix_obj.set(size_int - 1 - bit_int, 8, is_dark_bool, true);
    } else {
      matrix_obj.set(8, size_int - 15 + bit_int, is_dark_bool, true);
    }
  }
}

/**
 * Write the version information block, for versions 7 and above.
 *
 * Brief:
 *   Smaller symbols are identified by size alone, so they carry none.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to write into.
 *   version_int (number): QR version.
 *
 * Returns:
 *   (none)
 */
export function writeVersionInformation(matrix_obj, version_int) {
  if (version_int < 7) {
    return;
  }

  const version_bits_int = computeVersionInformationBits(version_int);
  const size_int = matrix_obj.size_int;

  for (let bit_int = 0; bit_int < 18; bit_int += 1) {
    const is_dark_bool = ((version_bits_int >> bit_int) & 1) === 1;
    const short_int = Math.floor(bit_int / 3);
    const long_int = (bit_int % 3) + size_int - 11;
    matrix_obj.set(short_int, long_int, is_dark_bool, true);
    matrix_obj.set(long_int, short_int, is_dark_bool, true);
  }
}

/**
 * Walk the data payload into the matrix, applying a mask as it goes.
 *
 * Brief:
 *   Data is placed in a boustrophedon walk: two modules wide, upward then
 *   downward, right to left, skipping the vertical timing column and every
 *   reserved module.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to write into.
 *   payload_uint8array (Uint8Array): Interleaved data and EC codewords.
 *   mask_id_int (number): Mask pattern index, 0 to 7.
 *
 * Returns:
 *   (none)
 */
export function placeDataWithMask(matrix_obj, payload_uint8array,
                                  mask_id_int) {
  const size_int = matrix_obj.size_int;
  const total_bits_int = payload_uint8array.length * 8;
  const mask_fn = MASK_PREDICATES_LIST[mask_id_int];

  let bit_cursor_int = 0;
  let is_upward_bool = true;
  let right_column_int = size_int - 1;

  while (right_column_int >= 1) {
    // Column 6 is the vertical timing pattern. The walk steps onto column 5
    // and continues from there, so the pair stride stays correct for every
    // remaining column - stepping over it without shifting the cursor would
    // leave the leftmost column unwritten.
    if (right_column_int === 6) {
      right_column_int = 5;
    }

    for (let step_int = 0; step_int < size_int; step_int += 1) {
      const row_int = is_upward_bool ? size_int - 1 - step_int : step_int;

      for (let pair_int = 0; pair_int < 2; pair_int += 1) {
        const column_int = right_column_int - pair_int;
        if (matrix_obj.isReserved(column_int, row_int)) {
          continue;
        }

        let is_dark_bool = false;
        if (bit_cursor_int < total_bits_int) {
          const byte_int = payload_uint8array[bit_cursor_int >> 3];
          is_dark_bool =
            ((byte_int >> (7 - (bit_cursor_int & 7))) & 1) === 1;
          bit_cursor_int += 1;
        }

        if (mask_fn(column_int, row_int)) {
          is_dark_bool = !is_dark_bool;
        }
        matrix_obj.set(column_int, row_int, is_dark_bool);
      }
    }
    is_upward_bool = !is_upward_bool;
    right_column_int -= 2;
  }
}
