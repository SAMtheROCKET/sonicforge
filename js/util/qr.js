/**
 * QR code encoder: byte mode, error-correction level M, versions 1 to 10.
 *
 * Brief:
 *   Concert Mode needs a phone to join a session in one gesture, and the
 *   only dependency-free way to move a URL from a laptop screen to a phone
 *   camera is a real QR code. A library would mean a network request at
 *   runtime, which SonicForge does not make, so the encoder lives here.
 *
 *   Versions 1 to 10 at level M hold up to 213 bytes, far more than any
 *   join URL this application produces.
 *
 *   Reference: ISO/IEC 18004. Implemented from the specification.
 */

import { BitBuffer, encodeReedSolomon } from './qr-error-correction.js';
import {
  QrMatrix,
  drawFinderPattern,
  drawAlignmentPatterns,
  drawTimingPatterns,
  reserveInformationAreas,
  writeFormatInformation,
  writeVersionInformation,
  placeDataWithMask,
} from './qr-patterns.js';
import { scoreMaskPenalty } from './qr-masking.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Block structure per version at error-correction level M. */
const EC_LEVEL_M_BLOCKS_LIST = Object.freeze([
  null,
  { ec_codewords_int: 10, blocks_list: [[1, 16]] },
  { ec_codewords_int: 16, blocks_list: [[1, 28]] },
  { ec_codewords_int: 26, blocks_list: [[1, 44]] },
  { ec_codewords_int: 18, blocks_list: [[2, 32]] },
  { ec_codewords_int: 24, blocks_list: [[2, 43]] },
  { ec_codewords_int: 16, blocks_list: [[4, 27]] },
  { ec_codewords_int: 18, blocks_list: [[4, 31]] },
  { ec_codewords_int: 22, blocks_list: [[2, 38], [2, 39]] },
  { ec_codewords_int: 22, blocks_list: [[3, 36], [2, 37]] },
  { ec_codewords_int: 26, blocks_list: [[4, 43], [1, 44]] },
]);

/** Highest version this encoder supports. */
const MAX_VERSION_INT = 10;

/** Four-bit mode indicator for byte mode. */
const BYTE_MODE_INDICATOR_INT = 0b0100;

/** Alternating pad bytes appended after the terminator. */
const PAD_BYTES_LIST = Object.freeze([0xec, 0x11]);

/** Lowest version requiring a 16-bit character count. */
const LONG_COUNT_VERSION_INT = 10;

/** Default quiet-zone width, in modules. */
const DEFAULT_QUIET_ZONE_INT = 2;

/* ------------------------------------------------------------------------ */


/* ------------------------------------------------------------------------ */


/* ------------------------------------------------------------------------ */


/* ------------------------------------------------------------------------ */

/**
 * Choose the smallest version that can hold a payload at level M.
 *
 * Arguments:
 *   byte_count_int (number): Payload length in bytes.
 *
 * Returns:
 *   (Object): version_int and its block specification.
 *
 * Warning:
 *   Throws RangeError when the payload exceeds version 10 capacity, rather
 *   than silently truncating a URL into something that scans but is wrong.
 */
function selectVersion(byte_count_int) {
  for (
    let version_int = 1;
    version_int <= MAX_VERSION_INT;
    version_int += 1
  ) {
    const spec_obj = EC_LEVEL_M_BLOCKS_LIST[version_int];
    const total_data_codewords_int = spec_obj.blocks_list.reduce(
      (total_int, [count_int, words_int]) => total_int + count_int * words_int,
      0
    );
    const count_bits_int = version_int < LONG_COUNT_VERSION_INT ? 8 : 16;
    const required_bits_int = 4 + count_bits_int + byte_count_int * 8;

    if (required_bits_int <= total_data_codewords_int * 8) {
      return { version_int, spec_obj, total_data_codewords_int };
    }
  }

  throw new RangeError(
    `Payload of ${byte_count_int} bytes exceeds the ` +
      `${MAX_VERSION_INT}-version encoder capacity (213 bytes).`
  );
}

/**
 * Build the padded data codeword stream for a payload.
 *
 * Arguments:
 *   data_uint8array (Uint8Array): Raw payload bytes.
 *   version_int (number): Chosen QR version.
 *   total_data_codewords_int (number): Data capacity of that version.
 *
 * Returns:
 *   (number[]): Data codewords, padded to full capacity.
 */
function buildDataCodewords(data_uint8array, version_int,
                            total_data_codewords_int) {
  const buffer_obj = new BitBuffer();
  buffer_obj.put(BYTE_MODE_INDICATOR_INT, 4);
  buffer_obj.put(
    data_uint8array.length,
    version_int < LONG_COUNT_VERSION_INT ? 8 : 16
  );
  for (const byte_int of data_uint8array) {
    buffer_obj.put(byte_int, 8);
  }

  const capacity_bits_int = total_data_codewords_int * 8;
  buffer_obj.put(
    0,
    Math.min(4, capacity_bits_int - buffer_obj.lengthInBits)
  );
  while (buffer_obj.lengthInBits % 8 !== 0) {
    buffer_obj.put(0, 1);
  }

  const codewords_list = Array.from(buffer_obj.toBytes());
  let pad_index_int = 0;
  while (codewords_list.length < total_data_codewords_int) {
    codewords_list.push(PAD_BYTES_LIST[pad_index_int % 2]);
    pad_index_int += 1;
  }
  return codewords_list;
}

/**
 * Split data into blocks, add error correction, and interleave.
 *
 * Brief:
 *   Interleaving spreads each block across the symbol so that a localised
 *   smudge damages a little of every block rather than destroying one
 *   entirely, which is what error correction can actually recover from.
 *
 * Arguments:
 *   codewords_list (number[]): Padded data codewords.
 *   spec_obj (Object): Block specification for the version.
 *
 * Returns:
 *   (Uint8Array): The interleaved payload ready for placement.
 */
function interleaveBlocks(codewords_list, spec_obj) {
  const data_blocks_list = [];
  const ec_blocks_list = [];
  let offset_int = 0;

  for (const [block_count_int, words_int] of spec_obj.blocks_list) {
    for (
      let block_int = 0;
      block_int < block_count_int;
      block_int += 1
    ) {
      const block_uint8array = Uint8Array.from(
        codewords_list.slice(offset_int, offset_int + words_int)
      );
      offset_int += words_int;
      data_blocks_list.push(block_uint8array);
      ec_blocks_list.push(
        encodeReedSolomon(block_uint8array, spec_obj.ec_codewords_int)
      );
    }
  }

  const payload_list = [];
  const longest_block_int = Math.max(
    ...data_blocks_list.map((block) => block.length)
  );

  for (let index_int = 0; index_int < longest_block_int; index_int += 1) {
    for (const block_uint8array of data_blocks_list) {
      if (index_int < block_uint8array.length) {
        payload_list.push(block_uint8array[index_int]);
      }
    }
  }
  for (
    let index_int = 0;
    index_int < spec_obj.ec_codewords_int;
    index_int += 1
  ) {
    for (const block_uint8array of ec_blocks_list) {
      if (index_int < block_uint8array.length) {
        payload_list.push(block_uint8array[index_int]);
      }
    }
  }
  return Uint8Array.from(payload_list);
}

/**
 * Build one fully laid out candidate matrix for a given mask.
 *
 * Arguments:
 *   size_int (number): Symbol width in modules.
 *   version_int (number): QR version.
 *   payload_uint8array (Uint8Array): Interleaved payload.
 *   mask_id_int (number): Mask pattern index.
 *
 * Returns:
 *   (QrMatrix): The completed matrix.
 */
function buildCandidateMatrix(size_int, version_int, payload_uint8array,
                              mask_id_int) {
  const matrix_obj = new QrMatrix(size_int);

  drawFinderPattern(matrix_obj, 0, 0);
  drawFinderPattern(matrix_obj, size_int - 7, 0);
  drawFinderPattern(matrix_obj, 0, size_int - 7);
  drawAlignmentPatterns(matrix_obj, version_int);
  drawTimingPatterns(matrix_obj);
  reserveInformationAreas(matrix_obj, version_int);
  writeVersionInformation(matrix_obj, version_int);
  placeDataWithMask(matrix_obj, payload_uint8array, mask_id_int);
  writeFormatInformation(matrix_obj, mask_id_int);

  return matrix_obj;
}

/**
 * Encode text as a QR symbol.
 *
 * Brief:
 *   Selects the smallest version that fits, builds the codeword stream,
 *   adds and interleaves error correction, then lays out all eight mask
 *   candidates and keeps the one the specification's penalty rules score
 *   lowest.
 *
 * Arguments:
 *   text_str (string): Payload to encode; UTF-8 encoded internally.
 *
 * Returns:
 *   (Object): size_int, version_int, mask_int, modules_int8array, and an
 *   isDark_fn accessor taking a column and row.
 *
 * Warning:
 *   Throws RangeError for payloads beyond 213 bytes.
 */
export function encodeQR(text_str) {
  const data_uint8array = new TextEncoder().encode(String(text_str));
  const { version_int, spec_obj, total_data_codewords_int } =
    selectVersion(data_uint8array.length);

  const codewords_list = buildDataCodewords(
    data_uint8array,
    version_int,
    total_data_codewords_int
  );
  const payload_uint8array = interleaveBlocks(codewords_list, spec_obj);
  const size_int = version_int * 4 + 17;

  let best_matrix_obj = null;
  let best_score_int = Infinity;
  let best_mask_int = 0;

  for (let mask_id_int = 0; mask_id_int < 8; mask_id_int += 1) {
    const candidate_obj = buildCandidateMatrix(
      size_int,
      version_int,
      payload_uint8array,
      mask_id_int
    );
    const score_int = scoreMaskPenalty(candidate_obj);

    if (score_int < best_score_int) {
      best_score_int = score_int;
      best_matrix_obj = candidate_obj;
      best_mask_int = mask_id_int;
    }
  }

  return {
    size_int,
    version_int,
    mask_int: best_mask_int,
    modules_int8array: best_matrix_obj.modules_int8array,
    isDark_fn: (column_int, row_int) =>
      best_matrix_obj.modules_int8array[row_int * size_int + column_int] === 1,
  };
}

/**
 * Render a QR symbol into a canvas at an integer module scale.
 *
 * Brief:
 *   An integer scale keeps every module exactly the same number of pixels,
 *   which is what makes a small on-screen code reliably scannable. A
 *   fractional scale produces uneven module widths that confuse decoders.
 *
 * Arguments:
 *   canvas_el (HTMLCanvasElement): Destination canvas, resized to fit.
 *   text_str (string): Payload to encode.
 *   options_obj (Object): Optional quiet_zone_int, dark_str, light_str.
 *
 * Returns:
 *   (Object): The encoded symbol, as returned by encodeQR.
 *
 * Warning:
 *   The quiet zone is mandatory. Rendering without one produces a symbol
 *   most scanners silently refuse to read.
 */
export function renderQR(canvas_el, text_str, options_obj = {}) {
  const {
    quiet_zone_int = DEFAULT_QUIET_ZONE_INT,
    dark_str = '#05070d',
    light_str = '#ffffff',
  } = options_obj;

  const symbol_obj = encodeQR(text_str);
  const total_modules_int = symbol_obj.size_int + quiet_zone_int * 2;

  const target_px_int = Math.max(canvas_el.clientWidth || 132, 88);
  const device_ratio_float = window.devicePixelRatio || 1;
  const scale_int = Math.max(
    2,
    Math.floor((target_px_int * device_ratio_float) / total_modules_int)
  );

  canvas_el.width = total_modules_int * scale_int;
  canvas_el.height = total_modules_int * scale_int;

  const context_ctx = canvas_el.getContext('2d');
  context_ctx.fillStyle = light_str;
  context_ctx.fillRect(0, 0, canvas_el.width, canvas_el.height);
  context_ctx.fillStyle = dark_str;

  for (let row_int = 0; row_int < symbol_obj.size_int; row_int += 1) {
    for (
      let column_int = 0;
      column_int < symbol_obj.size_int;
      column_int += 1
    ) {
      if (!symbol_obj.isDark_fn(column_int, row_int)) {
        continue;
      }
      context_ctx.fillRect(
        (column_int + quiet_zone_int) * scale_int,
        (row_int + quiet_zone_int) * scale_int,
        scale_int,
        scale_int
      );
    }
  }
  return symbol_obj;
}
