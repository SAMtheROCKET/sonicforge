/**
 * Column-major 4x4 matrix maths for the WebGL visualiser.
 *
 * Brief:
 *   The 3D spectrogram needs exactly four operations: a perspective
 *   projection, a look-at view, a multiply, and a spherical camera
 *   position. Pulling a scene-graph library from a CDN to obtain them would
 *   break the property that SonicForge makes no network requests at runtime
 *   and works fully offline, so they are implemented here instead.
 *
 *   Layout is column-major, matching what WebGL's uniformMatrix4fv expects
 *   with transpose set to false.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Elements in a 4x4 matrix. */
const MATRIX_ELEMENT_COUNT_INT = 16;

/** Rows or columns in a 4x4 matrix. */
const MATRIX_DIMENSION_INT = 4;

/** Identity matrix elements, in column-major order. */
const IDENTITY_ELEMENTS_LIST = Object.freeze([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  0, 0, 0, 1,
]);

/* ------------------------------------------------------------------------ */

/**
 * Build and combine the column-major matrices the renderer requires.
 *
 * Brief:
 *   Every method is static because a matrix here is plain data - a
 *   Float32Array handed straight to WebGL - and wrapping that in an
 *   instance would add allocation and indirection for no benefit.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   Never instantiate this class; it is a namespace for static operations.
 */
export class Matrix4 {
  /**
   * Create an identity matrix.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Float32Array): A new 16-element identity matrix.
   */
  static createIdentity() {
    return new Float32Array(IDENTITY_ELEMENTS_LIST);
  }

  /**
   * Build a perspective projection matrix.
   *
   * Arguments:
   *   vertical_field_of_view_radians_float (number): Full vertical angle.
   *   aspect_ratio_float (number): Viewport width divided by height.
   *   near_plane_float (number): Distance to the near clip plane.
   *   far_plane_float (number): Distance to the far clip plane.
   *
   * Returns:
   *   (Float32Array): The projection matrix.
   *
   * Warning:
   *   The near plane must be greater than zero. Setting it very small
   *   relative to the far plane destroys depth-buffer precision and makes
   *   the surface mesh z-fight.
   */
  static createPerspective(vertical_field_of_view_radians_float,
                           aspect_ratio_float, near_plane_float,
                           far_plane_float) {
    const focal_length_float =
      1 / Math.tan(vertical_field_of_view_radians_float / 2);
    const depth_span_inverse_float = 1 / (near_plane_float - far_plane_float);

    return new Float32Array([
      focal_length_float / aspect_ratio_float, 0, 0, 0,
      0, focal_length_float, 0, 0,
      0, 0,
      (far_plane_float + near_plane_float) * depth_span_inverse_float,
      -1,
      0, 0,
      2 * far_plane_float * near_plane_float * depth_span_inverse_float,
      0,
    ]);
  }

  /**
   * Build a view matrix placing a camera at a point looking at a target.
   *
   * Arguments:
   *   eye_position_list (number[]): Camera position as [x, y, z].
   *   target_position_list (number[]): Point to look at as [x, y, z].
   *   up_direction_list (number[]): World up vector as [x, y, z].
   *
   * Returns:
   *   (Float32Array): The view matrix.
   *
   * Warning:
   *   Degenerates when the view direction is parallel to the up vector.
   *   Zero-length axes fall back to length one to avoid producing NaNs
   *   that would blank the entire canvas.
   */
  static createLookAt(eye_position_list, target_position_list,
                      up_direction_list) {
    let backward_x_float = eye_position_list[0] - target_position_list[0];
    let backward_y_float = eye_position_list[1] - target_position_list[1];
    let backward_z_float = eye_position_list[2] - target_position_list[2];

    let length_float =
      Math.hypot(backward_x_float, backward_y_float, backward_z_float) || 1;
    backward_x_float /= length_float;
    backward_y_float /= length_float;
    backward_z_float /= length_float;

    let right_x_float =
      up_direction_list[1] * backward_z_float -
      up_direction_list[2] * backward_y_float;
    let right_y_float =
      up_direction_list[2] * backward_x_float -
      up_direction_list[0] * backward_z_float;
    let right_z_float =
      up_direction_list[0] * backward_y_float -
      up_direction_list[1] * backward_x_float;

    length_float =
      Math.hypot(right_x_float, right_y_float, right_z_float) || 1;
    right_x_float /= length_float;
    right_y_float /= length_float;
    right_z_float /= length_float;

    const upward_x_float =
      backward_y_float * right_z_float - backward_z_float * right_y_float;
    const upward_y_float =
      backward_z_float * right_x_float - backward_x_float * right_z_float;
    const upward_z_float =
      backward_x_float * right_y_float - backward_y_float * right_x_float;

    return new Float32Array([
      right_x_float, upward_x_float, backward_x_float, 0,
      right_y_float, upward_y_float, backward_y_float, 0,
      right_z_float, upward_z_float, backward_z_float, 0,
      -(right_x_float * eye_position_list[0] +
        right_y_float * eye_position_list[1] +
        right_z_float * eye_position_list[2]),
      -(upward_x_float * eye_position_list[0] +
        upward_y_float * eye_position_list[1] +
        upward_z_float * eye_position_list[2]),
      -(backward_x_float * eye_position_list[0] +
        backward_y_float * eye_position_list[1] +
        backward_z_float * eye_position_list[2]),
      1,
    ]);
  }

  /**
   * Multiply two matrices, applying the right-hand one first.
   *
   * Arguments:
   *   left_float32array (Float32Array): Left operand.
   *   right_float32array (Float32Array): Right operand, applied first.
   *   output_float32array (Float32Array): Optional destination buffer.
   *
   * Returns:
   *   (Float32Array): The product, written into the destination buffer.
   *
   * Warning:
   *   The destination must not alias either operand; results would be
   *   corrupted midway through the accumulation.
   */
  static multiply(left_float32array, right_float32array,
                  output_float32array = new Float32Array(
                    MATRIX_ELEMENT_COUNT_INT
                  )) {
    for (
      let column_int = 0;
      column_int < MATRIX_DIMENSION_INT;
      column_int += 1
    ) {
      const base_int = column_int * MATRIX_DIMENSION_INT;
      const right_0_float = right_float32array[base_int];
      const right_1_float = right_float32array[base_int + 1];
      const right_2_float = right_float32array[base_int + 2];
      const right_3_float = right_float32array[base_int + 3];

      for (let row_int = 0; row_int < MATRIX_DIMENSION_INT; row_int += 1) {
        output_float32array[base_int + row_int] =
          left_float32array[row_int] * right_0_float +
          left_float32array[row_int + 4] * right_1_float +
          left_float32array[row_int + 8] * right_2_float +
          left_float32array[row_int + 12] * right_3_float;
      }
    }
    return output_float32array;
  }

  /**
   * Compute a camera position orbiting a target on a sphere.
   *
   * Arguments:
   *   target_position_list (number[]): Orbit centre as [x, y, z].
   *   radius_float (number): Distance from the centre.
   *   azimuth_radians_float (number): Rotation about the vertical axis.
   *   elevation_radians_float (number): Angle above the horizontal plane.
   *
   * Returns:
   *   (number[]): Camera position as [x, y, z].
   *
   * Warning:
   *   An elevation approaching a quarter turn places the camera directly
   *   above the target, where the look-at up vector becomes ambiguous.
   *   Callers should clamp short of that.
   */
  static computeOrbitEyePosition(target_position_list, radius_float,
                                 azimuth_radians_float,
                                 elevation_radians_float) {
    const horizontal_scale_float = Math.cos(elevation_radians_float);
    return [
      target_position_list[0] +
        radius_float * horizontal_scale_float *
          Math.sin(azimuth_radians_float),
      target_position_list[1] +
        radius_float * Math.sin(elevation_radians_float),
      target_position_list[2] +
        radius_float * horizontal_scale_float *
          Math.cos(azimuth_radians_float),
    ];
  }
}
