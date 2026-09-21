/**
 * Mask pattern evaluation.
 *
 * Brief:
 *   A QR symbol may be masked eight different ways, and the encoder must
 *   pick the one a scanner will read most reliably. The specification
 *   defines four penalty rules for that choice; lower is better. Skipping
 *   this step produces symbols that encode correctly and scan badly.
 *
 *   Reference: ISO/IEC 18004 section 8.8.2.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Penalty weights from the specification's mask evaluation rules. */
const PENALTY_RUN_BASE_INT = 3;
const PENALTY_BLOCK_INT = 3;
const PENALTY_FINDER_LIKE_INT = 40;
const PENALTY_BALANCE_STEP_INT = 10;

/* ------------------------------------------------------------------------ */

/**
 * Score a masked matrix against the specification's penalty rules.
 *
 * Brief:
 *   Lower is better. The four rules penalise long same-colour runs, solid
 *   two-by-two blocks, patterns that resemble a finder, and an overall
 *   imbalance between dark and light. Choosing the lowest-scoring mask is
 *   what makes a code reliably scannable.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): A fully populated, masked matrix.
 *
 * Returns:
 *   (number): Total penalty score.
 */
export function scoreMaskPenalty(matrix_obj) {
  return (
    scoreRunsAndBlocks(matrix_obj) +
    scoreFinderLikePatterns(matrix_obj) +
    scoreDarkBalance(matrix_obj)
  );
}

/**
 * Score same-colour runs and solid two-by-two blocks.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to score.
 *
 * Returns:
 *   (number): Combined penalty for rules one and two.
 */
function scoreRunsAndBlocks(matrix_obj) {
  const size_int = matrix_obj.size_int;
  const isDark_fn = (column_int, row_int) =>
    matrix_obj.get(column_int, row_int) === 1;
  let penalty_int = 0;

  for (let line_int = 0; line_int < size_int; line_int += 1) {
    penalty_int += scoreSingleRun(
      (position_int) => isDark_fn(position_int, line_int),
      size_int
    );
    penalty_int += scoreSingleRun(
      (position_int) => isDark_fn(line_int, position_int),
      size_int
    );
  }

  for (let row_int = 0; row_int < size_int - 1; row_int += 1) {
    for (let column_int = 0; column_int < size_int - 1; column_int += 1) {
      const corner_bool = isDark_fn(column_int, row_int);
      const is_solid_block_bool =
        corner_bool === isDark_fn(column_int + 1, row_int) &&
        corner_bool === isDark_fn(column_int, row_int + 1) &&
        corner_bool === isDark_fn(column_int + 1, row_int + 1);
      if (is_solid_block_bool) {
        penalty_int += PENALTY_BLOCK_INT;
      }
    }
  }
  return penalty_int;
}

/**
 * Score one row or column for runs of five or more same-colour modules.
 *
 * Arguments:
 *   sample_fn (Function): Returns darkness at a position.
 *   size_int (number): Line length.
 *
 * Returns:
 *   (number): Penalty for this line.
 */
function scoreSingleRun(sample_fn, size_int) {
  let penalty_int = 0;
  let run_colour_bool = sample_fn(0);
  let run_length_int = 1;

  for (let position_int = 1; position_int < size_int; position_int += 1) {
    const colour_bool = sample_fn(position_int);
    if (colour_bool === run_colour_bool) {
      run_length_int += 1;
      continue;
    }
    if (run_length_int >= 5) {
      penalty_int += run_length_int - PENALTY_RUN_BASE_INT + 1;
    }
    run_colour_bool = colour_bool;
    run_length_int = 1;
  }

  if (run_length_int >= 5) {
    penalty_int += run_length_int - PENALTY_RUN_BASE_INT + 1;
  }
  return penalty_int;
}

/**
 * Score occurrences of the 1:1:3:1:1 finder-like pattern.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to score.
 *
 * Returns:
 *   (number): Penalty for rule three.
 */
function scoreFinderLikePatterns(matrix_obj) {
  const size_int = matrix_obj.size_int;
  const isDark_fn = (column_int, row_int) =>
    matrix_obj.get(column_int, row_int) === 1;

  const forward_list = [
    true, false, true, true, true, false, true,
    false, false, false, false,
  ];
  const reverse_list = [
    false, false, false, false, true, false, true,
    true, true, false, true,
  ];

  const matchesAt_fn = (sample_fn, start_int) => {
    let forward_bool = true;
    let reverse_bool = true;
    for (let offset_int = 0; offset_int < 11; offset_int += 1) {
      const value_bool = sample_fn(start_int + offset_int);
      if (value_bool !== forward_list[offset_int]) {
        forward_bool = false;
      }
      if (value_bool !== reverse_list[offset_int]) {
        reverse_bool = false;
      }
    }
    return forward_bool || reverse_bool;
  };

  let penalty_int = 0;
  for (let line_int = 0; line_int < size_int; line_int += 1) {
    for (let start_int = 0; start_int <= size_int - 11; start_int += 1) {
      if (matchesAt_fn((p_int) => isDark_fn(p_int, line_int), start_int)) {
        penalty_int += PENALTY_FINDER_LIKE_INT;
      }
      if (matchesAt_fn((p_int) => isDark_fn(line_int, p_int), start_int)) {
        penalty_int += PENALTY_FINDER_LIKE_INT;
      }
    }
  }
  return penalty_int;
}

/**
 * Score the overall deviation from a fifty per cent dark ratio.
 *
 * Arguments:
 *   matrix_obj (QrMatrix): Matrix to score.
 *
 * Returns:
 *   (number): Penalty for rule four.
 */
function scoreDarkBalance(matrix_obj) {
  let dark_count_int = 0;
  for (
    let index_int = 0;
    index_int < matrix_obj.modules_int8array.length;
    index_int += 1
  ) {
    if (matrix_obj.modules_int8array[index_int] === 1) {
      dark_count_int += 1;
    }
  }

  const dark_percent_float =
    (dark_count_int * 100) / matrix_obj.modules_int8array.length;
  return (
    Math.floor(Math.abs(dark_percent_float - 50) / 5) *
    PENALTY_BALANCE_STEP_INT
  );
}
