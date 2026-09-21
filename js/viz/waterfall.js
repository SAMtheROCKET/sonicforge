/**
 * 3D spectrogram / waterfall surface.
 *
 * Brief:
 *   X is historical time, with rows scrolling away from the viewer; Y is
 *   amplitude, carried by both vertex displacement and colour; Z is
 *   frequency, log-spaced from the infrasonic floor to Nyquist.
 *
 *   Each frame the analyser's linear FFT bins are resampled onto a
 *   log-frequency grid on the CPU, quantised to 8 bits, and pushed into one
 *   row of a ring-buffer texture. The vertex shader reads that texture to
 *   displace a static mesh, so advancing the history costs a single
 *   texSubImage2D of one row per frame rather than rebuilding geometry.
 */

import {
  createWebgl2Context,
  linkShaderProgram,
  collectProgramLocations,
  createGpuBuffer,
  createHeightTexture,
  resizeCanvasToDisplay,
  attachOrbitControls,
  GLError,
} from './glutil.js';
import { mapPositionToFrequency } from '../util/frequency.js';
import { Matrix4 } from '../util/matrix4.js';
import { clampToRange } from '../util/numeric.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Mesh resolution along the frequency axis. */
const FREQUENCY_POINT_COUNT_INT = 200;

/** Mesh resolution along the time axis, in rows of history. */
const HISTORY_ROW_COUNT_INT = 176;

/** Decibel window mapped onto the 0-255 height range. */
const MIN_DISPLAY_DB_FLOAT = -96;
const MAX_DISPLAY_DB_FLOAT = -12;

/**
 * Low edge of the displayed band, in hertz.
 *
 * 5 Hz rather than the conventional 20 Hz because infrasonic work - candle
 * flicker, thermoacoustic forcing - lives entirely below the audible floor
 * and has to be visible here.
 */
const DISPLAY_LOW_HERTZ_FLOAT = 5;

/** High edge of the displayed band, capped so the grid stays readable. */
const DISPLAY_HIGH_HERTZ_FLOAT = 48000;

/** Vertex displacement multiplier, and the range the caller may set. */
const DEFAULT_AMPLITUDE_LIFT_FLOAT = 0.95;
const MIN_AMPLITUDE_LIFT_FLOAT = 0.15;
const MAX_AMPLITUDE_LIFT_FLOAT = 2.2;

/** Starting camera pose: slightly off-axis, looking down on the surface. */
const DEFAULT_CAMERA_OBJ = Object.freeze({
  azimuth: -0.62,
  elevation: 0.52,
  radius: 3.5,
});

/** Perspective frustum. */
const FIELD_OF_VIEW_RADIANS_FLOAT = Math.PI / 4.2;
const NEAR_PLANE_FLOAT = 0.1;
const FAR_PLANE_FLOAT = 40;

/** Orbit centre and look-at target, chosen so the surface sits centred. */
const ORBIT_CENTRE_TUPLE = Object.freeze([0, 0.22, 0]);
const LOOK_AT_TARGET_TUPLE = Object.freeze([0, 0.16, 0]);
const WORLD_UP_TUPLE = Object.freeze([0, 1, 0]);

/** Smoothing pole for the reported frame rate. */
const FPS_SMOOTHING_FLOAT = 0.9;

/** Rows kept by the Canvas2D fallback, which cannot afford the full mesh. */
const CANVAS_HISTORY_ROW_COUNT_INT = 90;

/** Device pixel ratio cap for the Canvas2D fallback. */
const CANVAS_MAX_PIXEL_RATIO_FLOAT = 1.5;

/** Two triangles, six indices, per grid quad. */
const INDICES_PER_QUAD_INT = 6;

/* ------------------------------------------------------------------------ */

const VERTEX_SHADER_SOURCE_STR = `#version 300 es
precision highp float;

in vec2 aGrid;              // x = freq index 0..1, y = history index 0..1

uniform mat4 uViewProj;
uniform sampler2D uHeights;
uniform float uHead;        // newest row, in texel units
uniform float uRows;
uniform float uLift;        // amplitude exaggeration

out float vAmp;
out float vAge;
out vec3 vPos;

void main() {
  // Row 0 is the newest; older rows sit further back along -X.
  float row = mod(uHead - aGrid.y * (uRows - 1.0) + uRows * 2.0, uRows);
  float v = (row + 0.5) / uRows;
  float amp = texture(uHeights, vec2(aGrid.x, v)).r;

  // Older rows decay slightly so the surface reads as depth, not noise.
  float age = aGrid.y;
  float fade = 1.0 - age * 0.35;

  float x = (age - 0.5) * 2.6;
  float z = (aGrid.x - 0.5) * 3.2;
  float y = amp * uLift * fade;

  vAmp = amp;
  vAge = age;
  vPos = vec3(x, y, z);
  gl_Position = uViewProj * vec4(x, y, z, 1.0);
}`;

const FRAGMENT_SHADER_SOURCE_STR = `#version 300 es
precision highp float;

in float vAmp;
in float vAge;
in vec3 vPos;
out vec4 fragColor;

uniform float uWire;

// Brand ramp: onyx -> deep blue -> cyan -> violet -> white hot
vec3 ramp(float t) {
  t = clamp(t, 0.0, 1.0);
  vec3 c0 = vec3(0.020, 0.035, 0.075);
  vec3 c1 = vec3(0.000, 0.240, 0.520);
  vec3 c2 = vec3(0.000, 0.949, 0.996);
  vec3 c3 = vec3(0.560, 0.200, 1.000);
  vec3 c4 = vec3(1.000, 0.960, 1.000);
  if (t < 0.28) return mix(c0, c1, t / 0.28);
  if (t < 0.58) return mix(c1, c2, (t - 0.28) / 0.30);
  if (t < 0.84) return mix(c2, c3, (t - 0.58) / 0.26);
  return mix(c3, c4, (t - 0.84) / 0.16);
}

void main() {
  float a = vAmp;
  vec3 col = ramp(a);

  // Cheap rim light from the surface gradient, using screen-space derivatives.
  vec3 dx = dFdx(vPos);
  vec3 dy = dFdy(vPos);
  vec3 n = normalize(cross(dx, dy));
  float lambert = clamp(abs(n.y) * 0.55 + 0.45, 0.0, 1.0);
  col *= lambert;

  // Lift the leading edge so the "now" row reads as the live one.
  col += vec3(0.0, 0.35, 0.45) * pow(1.0 - vAge, 14.0) * 0.8;

  float alpha = mix(0.10, 1.0, smoothstep(0.02, 0.35, a))
              * (1.0 - vAge * 0.55);
  alpha = max(alpha, uWire * 0.14);

  fragColor = vec4(col, alpha);
}`;

/* ------------------------------------------------------------------------ */

/**
 * Build the static grid mesh the vertex shader displaces.
 *
 * Brief:
 *   Positions carry normalised grid coordinates only. Every world-space
 *   value is derived in the shader from the height texture, which is what
 *   lets the surface animate without touching the vertex buffer again.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (Object): { positions_float32array, indices_uint32array }.
 */
function buildGridMesh() {
  const positions_float32array = new Float32Array(
    FREQUENCY_POINT_COUNT_INT * HISTORY_ROW_COUNT_INT * 2
  );
  let write_index_int = 0;
  for (let row_int = 0; row_int < HISTORY_ROW_COUNT_INT; row_int++) {
    for (let column_int = 0;
      column_int < FREQUENCY_POINT_COUNT_INT; column_int++) {
      positions_float32array[write_index_int++] =
        column_int / (FREQUENCY_POINT_COUNT_INT - 1);
      positions_float32array[write_index_int++] =
        row_int / (HISTORY_ROW_COUNT_INT - 1);
    }
  }

  const quad_count_int =
    (FREQUENCY_POINT_COUNT_INT - 1) * (HISTORY_ROW_COUNT_INT - 1);
  const indices_uint32array = new Uint32Array(
    quad_count_int * INDICES_PER_QUAD_INT
  );
  let index_cursor_int = 0;
  for (let row_int = 0; row_int < HISTORY_ROW_COUNT_INT - 1; row_int++) {
    for (let column_int = 0;
      column_int < FREQUENCY_POINT_COUNT_INT - 1; column_int++) {
      const near_left_int = row_int * FREQUENCY_POINT_COUNT_INT + column_int;
      const near_right_int = near_left_int + 1;
      const far_left_int = near_left_int + FREQUENCY_POINT_COUNT_INT;
      const far_right_int = far_left_int + 1;
      indices_uint32array[index_cursor_int++] = near_left_int;
      indices_uint32array[index_cursor_int++] = far_left_int;
      indices_uint32array[index_cursor_int++] = near_right_int;
      indices_uint32array[index_cursor_int++] = near_right_int;
      indices_uint32array[index_cursor_int++] = far_left_int;
      indices_uint32array[index_cursor_int++] = far_right_int;
    }
  }

  return { positions_float32array, indices_uint32array };
}

/**
 * Find the geometric-mean band edges around one log grid point.
 *
 * Brief:
 *   Geometric rather than arithmetic means, because the grid is logarithmic
 *   and an arithmetic midpoint would bias every band upward.
 *
 * Arguments:
 *   grid_frequencies_float64array (Float64Array): The log grid.
 *   point_index_int (number): Grid point to bracket.
 *   low_hertz_float (number): Frequency at the left edge of the display.
 *   high_hertz_float (number): Frequency at the right edge of the display.
 *
 * Returns:
 *   (Object): { lower_hertz_float, upper_hertz_float }.
 */
function computeBandEdges(
  grid_frequencies_float64array,
  point_index_int,
  low_hertz_float,
  high_hertz_float
) {
  const is_first_bool = point_index_int === 0;
  const is_last_bool = point_index_int === FREQUENCY_POINT_COUNT_INT - 1;

  const lower_hertz_float = is_first_bool
    ? low_hertz_float
    : Math.sqrt(
      grid_frequencies_float64array[point_index_int - 1] *
      grid_frequencies_float64array[point_index_int]
    );
  const upper_hertz_float = is_last_bool
    ? high_hertz_float
    : Math.sqrt(
      grid_frequencies_float64array[point_index_int] *
      grid_frequencies_float64array[point_index_int + 1]
    );

  return { lower_hertz_float, upper_hertz_float };
}

/**
 * Real-time 3D spectrogram with a Canvas2D fallback.
 *
 * Brief:
 *   Constructing the view attempts WebGL2 and silently degrades to a
 *   projected Canvas2D waterfall if the context cannot be created, so the
 *   application remains fully usable where WebGL is blocked.
 *
 * Arguments:
 *   target_canvas (HTMLCanvasElement): Canvas to render into.
 *   engine_obj (AudioEngine): Source of the analyser spectrum.
 *
 * Returns:
 *   (Waterfall): The constructed view.
 *
 * Warning:
 *   The instance installs pointer listeners on the canvas. Call destroy()
 *   before discarding it or those listeners outlive the view.
 */
export class Waterfall {
  render_mode_str = 'webgl';
  is_running_bool = false;
  camera_obj = { ...DEFAULT_CAMERA_OBJ };

  #gl = null;
  #program_obj = null;
  #vertex_array_obj = null;
  #height_texture_obj = null;
  #locations_obj = null;
  #index_count_int = 0;
  #head_row_int = 0;
  #row_uint8array = new Uint8Array(FREQUENCY_POINT_COUNT_INT);
  #detach_controls_fn = null;
  #animation_frame_id_int = 0;
  #lift_float = DEFAULT_AMPLITUDE_LIFT_FLOAT;
  #last_frame_ms_float = 0;
  #frames_per_second_float = 0;

  constructor(target_canvas, engine_obj) {
    this.canvas = target_canvas;
    this.engine_obj = engine_obj;

    this.low_hertz_float = DISPLAY_LOW_HERTZ_FLOAT;
    this.high_hertz_float = Math.min(
      engine_obj.nyquistHertz, DISPLAY_HIGH_HERTZ_FLOAT
    );

    this.grid_frequencies_float64array = new Float64Array(
      FREQUENCY_POINT_COUNT_INT
    );
    for (let point_index_int = 0;
      point_index_int < FREQUENCY_POINT_COUNT_INT; point_index_int++) {
      this.grid_frequencies_float64array[point_index_int] =
        mapPositionToFrequency(
          point_index_int / (FREQUENCY_POINT_COUNT_INT - 1),
          this.low_hertz_float,
          this.high_hertz_float
        );
    }

    try {
      this.#initialiseWebgl();
    } catch (err) {
      console.warn(
        '[SonicForge] WebGL2 unavailable, falling back to Canvas2D:',
        err.message
      );
      this.render_mode_str = 'canvas2d';
      this.#initialiseCanvas2d();
    }

    this.#detach_controls_fn = attachOrbitControls(
      target_canvas, this.camera_obj
    );
  }

  /* =================================================================== */

  /**
   * Create the program, mesh and height texture, and set fixed GL state.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Throws GLError when WebGL2 is unavailable, which the constructor
   *   catches to select the Canvas2D path.
   */
  #initialiseWebgl() {
    const gl = createWebgl2Context(this.canvas);
    if (!gl) {
      throw new GLError('WebGL2 context could not be created');
    }
    this.#gl = gl;

    this.#program_obj = linkShaderProgram(
      gl, VERTEX_SHADER_SOURCE_STR, FRAGMENT_SHADER_SOURCE_STR
    );
    this.#locations_obj = collectProgramLocations(gl, this.#program_obj);

    const { positions_float32array, indices_uint32array } = buildGridMesh();
    this.#index_count_int = indices_uint32array.length;

    const grid_location_int = this.#locations_obj.attributes_obj.aGrid;
    this.#vertex_array_obj = gl.createVertexArray();
    gl.bindVertexArray(this.#vertex_array_obj);
    createGpuBuffer(gl, gl.ARRAY_BUFFER, positions_float32array);
    gl.enableVertexAttribArray(grid_location_int);
    gl.vertexAttribPointer(grid_location_int, 2, gl.FLOAT, false, 0, 0);
    createGpuBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, indices_uint32array);
    gl.bindVertexArray(null);

    this.#height_texture_obj = createHeightTexture(
      gl, FREQUENCY_POINT_COUNT_INT, HISTORY_ROW_COUNT_INT
    );

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);
  }

  /**
   * Prepare the Canvas2D fallback surface.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #initialiseCanvas2d() {
    this.canvas_2d_ctx = this.canvas.getContext('2d');
    this.history_list = [];
  }

  /* =================================================================== */

  /**
   * Begin the render loop.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Waterfall): This instance, for chaining.
   */
  start() {
    if (this.is_running_bool) {
      return this;
    }
    this.is_running_bool = true;
    this.#last_frame_ms_float = performance.now();

    const stepFrame = () => {
      if (!this.is_running_bool) {
        return;
      }
      // Scheduled before drawing, so a draw that throws cannot silently
      // end the animation and leave a frozen canvas behind.
      this.#animation_frame_id_int = requestAnimationFrame(stepFrame);
      this.#renderFrame();
    };
    this.#animation_frame_id_int = requestAnimationFrame(stepFrame);
    return this;
  }

  /**
   * Halt the render loop without releasing GPU resources.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Waterfall): This instance, for chaining.
   */
  stop() {
    this.is_running_bool = false;
    cancelAnimationFrame(this.#animation_frame_id_int);
    return this;
  }

  /**
   * Stop rendering, detach listeners and release GPU resources.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  destroy() {
    this.stop();
    this.#detach_controls_fn?.();
    const gl = this.#gl;
    if (!gl) {
      return;
    }
    gl.deleteTexture(this.#height_texture_obj);
    gl.deleteProgram(this.#program_obj);
    gl.deleteVertexArray(this.#vertex_array_obj);
  }

  /**
   * Set the vertex displacement multiplier.
   *
   * Arguments:
   *   lift_float (number): Requested exaggeration, clamped into range.
   *
   * Returns:
   *   (none)
   */
  setAmplitudeLift(lift_float) {
    this.#lift_float = clampToRange(
      lift_float, MIN_AMPLITUDE_LIFT_FLOAT, MAX_AMPLITUDE_LIFT_FLOAT
    );
  }

  /** Smoothed frame rate, in frames per second. */
  get frames_per_second_float() {
    return this.#frames_per_second_float;
  }

  /* =================================================================== */

  /**
   * Resample the analyser's linear bins onto the log grid and quantise.
   *
   * Brief:
   *   Peak-picking rather than averaging, because a single sine sitting
   *   between two log grid points must not be allowed to disappear.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #sampleSpectrumRow() {
    const spectrum_db_arr = this.engine_obj.meter.readSpectrumDb();
    if (!spectrum_db_arr || !spectrum_db_arr.length) {
      this.#row_uint8array.fill(0);
      return;
    }

    const bin_count_int = spectrum_db_arr.length;
    const nyquist_hertz_float = this.engine_obj.sampleRateHertz / 2;
    const span_db_float = MAX_DISPLAY_DB_FLOAT - MIN_DISPLAY_DB_FLOAT;

    for (let point_index_int = 0;
      point_index_int < FREQUENCY_POINT_COUNT_INT; point_index_int++) {
      const { lower_hertz_float, upper_hertz_float } = computeBandEdges(
        this.grid_frequencies_float64array,
        point_index_int,
        this.low_hertz_float,
        this.high_hertz_float
      );

      const first_bin_int = clampToRange(
        Math.floor((lower_hertz_float / nyquist_hertz_float) * bin_count_int),
        0,
        bin_count_int - 1
      );
      const last_bin_int = clampToRange(
        Math.ceil((upper_hertz_float / nyquist_hertz_float) * bin_count_int),
        first_bin_int,
        bin_count_int - 1
      );

      let peak_db_float = -Infinity;
      for (let bin_int = first_bin_int; bin_int <= last_bin_int; bin_int++) {
        if (spectrum_db_arr[bin_int] > peak_db_float) {
          peak_db_float = spectrum_db_arr[bin_int];
        }
      }
      if (!Number.isFinite(peak_db_float)) {
        peak_db_float = MIN_DISPLAY_DB_FLOAT;
      }

      const normalised_float = clampToRange(
        (peak_db_float - MIN_DISPLAY_DB_FLOAT) / span_db_float, 0, 1
      );
      this.#row_uint8array[point_index_int] = (normalised_float * 255) | 0;
    }
  }

  /**
   * Advance the frame-rate estimate, sample a row, and draw.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #renderFrame() {
    const now_ms_float = performance.now();
    const elapsed_ms_float = now_ms_float - this.#last_frame_ms_float;
    this.#last_frame_ms_float = now_ms_float;
    this.#frames_per_second_float =
      this.#frames_per_second_float * FPS_SMOOTHING_FLOAT +
      (1000 / Math.max(elapsed_ms_float, 1)) * (1 - FPS_SMOOTHING_FLOAT);

    this.#sampleSpectrumRow();
    if (this.render_mode_str === 'webgl') {
      this.#drawWebglSurface();
    } else {
      this.#drawCanvas2dSurface();
    }
  }

  /**
   * Compute the combined view-projection matrix for the current camera.
   *
   * Arguments:
   *   aspect_ratio_float (number): Drawing buffer width over height.
   *
   * Returns:
   *   (Float32Array): Column-major 4x4 view-projection matrix.
   */
  #computeViewProjection(aspect_ratio_float) {
    const projection_float32array = Matrix4.createPerspective(
      FIELD_OF_VIEW_RADIANS_FLOAT,
      aspect_ratio_float,
      NEAR_PLANE_FLOAT,
      FAR_PLANE_FLOAT
    );
    const eye_position_arr = Matrix4.computeOrbitEyePosition(
      ORBIT_CENTRE_TUPLE,
      this.camera_obj.radius,
      this.camera_obj.azimuth,
      this.camera_obj.elevation
    );
    const view_float32array = Matrix4.createLookAt(
      eye_position_arr, LOOK_AT_TARGET_TUPLE, WORLD_UP_TUPLE
    );
    return Matrix4.multiply(projection_float32array, view_float32array);
  }

  /**
   * Upload the newest spectrum row into the ring-buffer texture.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #uploadNewestRow() {
    const gl = this.#gl;
    this.#head_row_int = (this.#head_row_int + 1) % HISTORY_ROW_COUNT_INT;
    gl.bindTexture(gl.TEXTURE_2D, this.#height_texture_obj);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      this.#head_row_int,
      FREQUENCY_POINT_COUNT_INT,
      1,
      gl.RED,
      gl.UNSIGNED_BYTE,
      this.#row_uint8array
    );
  }

  /**
   * Draw one frame of the WebGL surface.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #drawWebglSurface() {
    const gl = this.#gl;
    const target_canvas = this.canvas;
    resizeCanvasToDisplay(target_canvas);
    gl.viewport(0, 0, target_canvas.width, target_canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.#uploadNewestRow();

    const aspect_ratio_float =
      target_canvas.width / Math.max(1, target_canvas.height);
    const view_projection_float32array =
      this.#computeViewProjection(aspect_ratio_float);
    const uniforms_obj = this.#locations_obj.uniforms_obj;

    gl.useProgram(this.#program_obj);
    gl.bindVertexArray(this.#vertex_array_obj);
    gl.uniformMatrix4fv(
      uniforms_obj.uViewProj, false, view_projection_float32array
    );
    gl.uniform1i(uniforms_obj.uHeights, 0);
    gl.uniform1f(uniforms_obj.uHead, this.#head_row_int);
    gl.uniform1f(uniforms_obj.uRows, HISTORY_ROW_COUNT_INT);
    gl.uniform1f(uniforms_obj.uLift, this.#lift_float);
    gl.uniform1f(uniforms_obj.uWire, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#height_texture_obj);

    gl.drawElements(
      gl.TRIANGLES, this.#index_count_int, gl.UNSIGNED_INT, 0
    );
    gl.bindVertexArray(null);
  }

  /**
   * Draw one history row as a projected polyline.
   *
   * Arguments:
   *   row_uint8array (Uint8Array): Quantised heights for this row.
   *   row_index_int (number): 0 for the newest row.
   *
   * Returns:
   *   (none)
   */
  #strokeCanvasRow(row_uint8array, row_index_int) {
    const canvas_2d_ctx = this.canvas_2d_ctx;
    const width_px_int = this.canvas.width;
    const height_px_int = this.canvas.height;

    const age_float = row_index_int / CANVAS_HISTORY_ROW_COUNT_INT;
    const depth_float = 1 - age_float * 0.55;
    const baseline_y_px_float = height_px_int * (0.30 + age_float * 0.62);
    const offset_x_px_float = width_px_int * age_float * 0.11;
    const row_width_px_float = width_px_int * (1 - age_float * 0.22);

    canvas_2d_ctx.beginPath();
    for (let point_index_int = 0;
      point_index_int < FREQUENCY_POINT_COUNT_INT; point_index_int++) {
      const x_px_float = offset_x_px_float +
        (point_index_int / (FREQUENCY_POINT_COUNT_INT - 1)) *
        row_width_px_float;
      const y_px_float = baseline_y_px_float -
        (row_uint8array[point_index_int] / 255) *
        height_px_int * 0.34 * depth_float;
      if (point_index_int === 0) {
        canvas_2d_ctx.moveTo(x_px_float, y_px_float);
      } else {
        canvas_2d_ctx.lineTo(x_px_float, y_px_float);
      }
    }

    const green_int = Math.round(120 + 120 * (1 - age_float));
    const blue_int = Math.round(200 + 55 * (1 - age_float));
    const alpha_float = (1 - age_float) * 0.85;
    canvas_2d_ctx.strokeStyle =
      `rgba(0, ${green_int}, ${blue_int}, ${alpha_float})`;
    canvas_2d_ctx.lineWidth = row_index_int === 0 ? 2 : 1;
    canvas_2d_ctx.stroke();

    if (row_index_int === 0) {
      canvas_2d_ctx.shadowBlur = 14;
      canvas_2d_ctx.shadowColor = 'rgba(0,242,254,0.7)';
      canvas_2d_ctx.stroke();
      canvas_2d_ctx.shadowBlur = 0;
    }
  }

  /**
   * Canvas2D fallback: a projected waterfall drawn as stacked polylines.
   *
   * Brief:
   *   Not as pretty as the GPU path, but it keeps the application fully
   *   functional on machines where WebGL2 is blocked or unavailable.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #drawCanvas2dSurface() {
    const canvas_2d_ctx = this.canvas_2d_ctx;
    const target_canvas = this.canvas;
    resizeCanvasToDisplay(target_canvas, CANVAS_MAX_PIXEL_RATIO_FLOAT);

    this.history_list.unshift(Uint8Array.from(this.#row_uint8array));
    if (this.history_list.length > CANVAS_HISTORY_ROW_COUNT_INT) {
      this.history_list.pop();
    }

    canvas_2d_ctx.clearRect(
      0, 0, target_canvas.width, target_canvas.height
    );
    for (let row_index_int = this.history_list.length - 1;
      row_index_int >= 0; row_index_int--) {
      this.#strokeCanvasRow(this.history_list[row_index_int], row_index_int);
    }
  }
}
