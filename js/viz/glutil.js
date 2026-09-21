/**
 * The thinnest possible WebGL2 helper layer.
 *
 * Brief:
 *   SonicForge deliberately does not load Three.js. The visualiser needs
 *   exactly one shader program, one indexed mesh and one streaming texture.
 *   Pulling 600 kB of scene graph from a CDN to get that would break the
 *   "no network at runtime" property that makes this app deployable as a
 *   static file and usable offline.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Context attributes requested before any caller override. */
const DEFAULT_CONTEXT_OPTIONS_OBJ = Object.freeze({
  alpha: true,
  antialias: true,
  depth: true,
  premultipliedAlpha: true,
  powerPreference: 'high-performance',
  preserveDrawingBuffer: false,
});

/** Trailing marker WebGL appends to the name of a uniform array. */
const UNIFORM_ARRAY_SUFFIX_REGEX = /\[0\]$/;

/** Upper bound on the device pixel ratio honoured when resizing. */
const DEFAULT_MAX_PIXEL_RATIO_FLOAT = 2;

/** Closest and furthest the orbit camera may sit from the origin. */
const MIN_ORBIT_RADIUS_FLOAT = 1.4;
const MAX_ORBIT_RADIUS_FLOAT = 7;

/** Elevation limits, in radians, that keep the surface readable. */
const MIN_ELEVATION_RADIANS_FLOAT = -1.35;
const MAX_ELEVATION_RADIANS_FLOAT = 1.45;

/** Rotation applied per pixel of pointer travel, in radians. */
const AZIMUTH_PER_PIXEL_FLOAT = 0.007;
const ELEVATION_PER_PIXEL_FLOAT = 0.006;

/** Fraction of the current radius one wheel notch adds or removes. */
const WHEEL_DOLLY_STEP_FLOAT = 0.08;

/** Pointer count at which a drag becomes a pinch. */
const PINCH_POINTER_COUNT_INT = 2;

/* ------------------------------------------------------------------------ */

/**
 * Raised when a shader fails to compile or a program fails to link.
 *
 * Brief:
 *   A distinct type so the visualiser can tell a genuine GPU problem from
 *   an ordinary programming error and fall back to Canvas2D only for the
 *   former.
 *
 * Arguments:
 *   message_str (string): Driver log, prefixed with the failing stage.
 *
 * Returns:
 *   (GLError): The error instance.
 */
export class GLError extends Error {}

/**
 * Acquire a WebGL2 rendering context for a canvas.
 *
 * Brief:
 *   Returns null rather than throwing, because a missing WebGL2 context is
 *   an expected outcome on older hardware and the caller is expected to fall
 *   back to the Canvas2D visualiser rather than fail.
 *
 * Arguments:
 *   target_canvas (HTMLCanvasElement): Canvas to draw into.
 *   context_options_obj (Object): Attributes overriding the defaults.
 *
 * Returns:
 *   (WebGL2RenderingContext|null): The context, or null if unavailable.
 */
export function createWebgl2Context(target_canvas, context_options_obj = {}) {
  try {
    return target_canvas.getContext('webgl2', {
      ...DEFAULT_CONTEXT_OPTIONS_OBJ,
      ...context_options_obj,
    });
  } catch {
    return null;
  }
}

/**
 * Compile one shader stage from source.
 *
 * Brief:
 *   Separated from the link step so a compile failure names which stage
 *   broke. A driver log that only says "program failed to link" is close to
 *   useless when both stages changed in the same edit.
 *
 * Arguments:
 *   gl (WebGL2RenderingContext): Active context.
 *   shader_stage_int (number): gl.VERTEX_SHADER or gl.FRAGMENT_SHADER.
 *   shader_source_str (string): GLSL ES 3.00 source.
 *
 * Returns:
 *   (WebGLShader): The compiled shader.
 *
 * Warning:
 *   Throws GLError on failure, after deleting the shader so a caller that
 *   catches and retries does not leak one object per attempt.
 */
export function compileShader(gl, shader_stage_int, shader_source_str) {
  const shader_obj = gl.createShader(shader_stage_int);
  gl.shaderSource(shader_obj, shader_source_str);
  gl.compileShader(shader_obj);

  if (!gl.getShaderParameter(shader_obj, gl.COMPILE_STATUS)) {
    const info_log_str = gl.getShaderInfoLog(shader_obj);
    gl.deleteShader(shader_obj);
    const stage_name_str =
      shader_stage_int === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new GLError(
      `${stage_name_str} shader failed to compile:\n${info_log_str}`
    );
  }
  return shader_obj;
}

/**
 * Compile both stages and link them into a program.
 *
 * Brief:
 *   The shaders are deleted immediately after attaching. The program holds
 *   its own reference until it is linked, so this frees them at the earliest
 *   point that is safe.
 *
 * Arguments:
 *   gl (WebGL2RenderingContext): Active context.
 *   vertex_source_str (string): Vertex shader source.
 *   fragment_source_str (string): Fragment shader source.
 *
 * Returns:
 *   (WebGLProgram): The linked program.
 *
 * Warning:
 *   Throws GLError if either stage fails to compile or the link fails.
 */
export function linkShaderProgram(
  gl,
  vertex_source_str,
  fragment_source_str
) {
  const vertex_shader_obj = compileShader(
    gl, gl.VERTEX_SHADER, vertex_source_str
  );
  const fragment_shader_obj = compileShader(
    gl, gl.FRAGMENT_SHADER, fragment_source_str
  );

  const program_obj = gl.createProgram();
  gl.attachShader(program_obj, vertex_shader_obj);
  gl.attachShader(program_obj, fragment_shader_obj);
  gl.linkProgram(program_obj);
  gl.deleteShader(vertex_shader_obj);
  gl.deleteShader(fragment_shader_obj);

  if (!gl.getProgramParameter(program_obj, gl.LINK_STATUS)) {
    const info_log_str = gl.getProgramInfoLog(program_obj);
    gl.deleteProgram(program_obj);
    throw new GLError(`program failed to link:\n${info_log_str}`);
  }
  return program_obj;
}

/**
 * Collect every active uniform and attribute location by name.
 *
 * Brief:
 *   Looking locations up once and caching them avoids a string lookup per
 *   uniform per frame, which at 60 fps is the difference between a trivial
 *   cost and a measurable one.
 *
 * Arguments:
 *   gl (WebGL2RenderingContext): Active context.
 *   program_obj (WebGLProgram): A successfully linked program.
 *
 * Returns:
 *   (Object): { uniforms_obj, attributes_obj }, both keyed by GLSL name.
 *
 * Warning:
 *   Array uniforms are reported by WebGL as `name[0]`. The subscript is
 *   stripped so callers can use the bare declared name.
 */
export function collectProgramLocations(gl, program_obj) {
  const uniforms_obj = {};
  const attributes_obj = {};

  const uniform_count_int = gl.getProgramParameter(
    program_obj, gl.ACTIVE_UNIFORMS
  );
  for (let uniform_index_int = 0;
    uniform_index_int < uniform_count_int; uniform_index_int++) {
    const info_obj = gl.getActiveUniform(program_obj, uniform_index_int);
    if (!info_obj) {
      continue;
    }
    const key_str = info_obj.name.replace(UNIFORM_ARRAY_SUFFIX_REGEX, '');
    uniforms_obj[key_str] = gl.getUniformLocation(program_obj, info_obj.name);
  }

  const attribute_count_int = gl.getProgramParameter(
    program_obj, gl.ACTIVE_ATTRIBUTES
  );
  for (let attribute_index_int = 0;
    attribute_index_int < attribute_count_int; attribute_index_int++) {
    const info_obj = gl.getActiveAttrib(program_obj, attribute_index_int);
    if (!info_obj) {
      continue;
    }
    attributes_obj[info_obj.name] =
      gl.getAttribLocation(program_obj, info_obj.name);
  }

  return { uniforms_obj, attributes_obj };
}

/**
 * Create a buffer and upload its initial contents.
 *
 * Brief:
 *   The buffer is left bound on return, which is what the caller wants
 *   while recording a vertex array object and saves a redundant rebind.
 *
 * Arguments:
 *   gl (WebGL2RenderingContext): Active context.
 *   buffer_target_int (number): gl.ARRAY_BUFFER or gl.ELEMENT_ARRAY_BUFFER.
 *   data_arr (ArrayBufferView): Contents to upload.
 *   usage_hint_int (number): Access pattern hint, default gl.STATIC_DRAW.
 *
 * Returns:
 *   (WebGLBuffer): The populated buffer, left bound to its target.
 */
export function createGpuBuffer(
  gl,
  buffer_target_int,
  data_arr,
  usage_hint_int = gl.STATIC_DRAW
) {
  const buffer_obj = gl.createBuffer();
  gl.bindBuffer(buffer_target_int, buffer_obj);
  gl.bufferData(buffer_target_int, data_arr, usage_hint_int);
  return buffer_obj;
}

/**
 * Allocate the single-channel texture used as a streaming height field.
 *
 * Brief:
 *   The time axis wraps, so the waterfall can advance by writing one row per
 *   frame into a ring rather than shifting the whole image.
 *
 * Arguments:
 *   gl (WebGL2RenderingContext): Active context.
 *   width_px_int (number): Texels along the frequency axis.
 *   height_px_int (number): Texels along the time axis.
 *
 * Returns:
 *   (WebGLTexture): The allocated texture, left bound to TEXTURE_2D.
 *
 * Warning:
 *   Wrapping is REPEAT on the time axis and CLAMP_TO_EDGE on the frequency
 *   axis. Repeating the frequency axis would fold 20 kHz back onto 20 Hz.
 */
export function createHeightTexture(gl, width_px_int, height_px_int) {
  const texture_obj = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture_obj);
  gl.texStorage2D(
    gl.TEXTURE_2D, 1, gl.R8, width_px_int, height_px_int
  );
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return texture_obj;
}

/**
 * Match the drawing buffer to the canvas's displayed size.
 *
 * Brief:
 *   The pixel ratio is capped so that a 4K display does not quietly cost
 *   four times the fill rate for a surface nobody can see the extra detail
 *   in.
 *
 * Arguments:
 *   target_canvas (HTMLCanvasElement): Canvas to resize.
 *   max_pixel_ratio_float (number): Upper bound on devicePixelRatio.
 *
 * Returns:
 *   (boolean): True when the drawing buffer size actually changed.
 *
 * Warning:
 *   Assigning to canvas.width or canvas.height clears the canvas, so this
 *   returns early when the size already matches.
 */
export function resizeCanvasToDisplay(
  target_canvas,
  max_pixel_ratio_float = DEFAULT_MAX_PIXEL_RATIO_FLOAT
) {
  const pixel_ratio_float = Math.min(
    window.devicePixelRatio || 1, max_pixel_ratio_float
  );
  const bounds_obj = target_canvas.getBoundingClientRect();
  const width_px_int = Math.max(
    1, Math.round(bounds_obj.width * pixel_ratio_float)
  );
  const height_px_int = Math.max(
    1, Math.round(bounds_obj.height * pixel_ratio_float)
  );

  if (target_canvas.width === width_px_int &&
    target_canvas.height === height_px_int) {
    return false;
  }
  target_canvas.width = width_px_int;
  target_canvas.height = height_px_int;
  return true;
}

/**
 * Constrain the orbit radius to the usable range.
 *
 * Arguments:
 *   radius_float (number): Proposed distance from the origin.
 *
 * Returns:
 *   (number): The radius clamped into range.
 */
function clampOrbitRadius(radius_float) {
  return Math.max(
    MIN_ORBIT_RADIUS_FLOAT, Math.min(MAX_ORBIT_RADIUS_FLOAT, radius_float)
  );
}

/**
 * Constrain the orbit elevation so the camera cannot pass the poles.
 *
 * Arguments:
 *   elevation_radians_float (number): Proposed elevation.
 *
 * Returns:
 *   (number): The elevation clamped into range.
 */
function clampOrbitElevation(elevation_radians_float) {
  return Math.max(
    MIN_ELEVATION_RADIANS_FLOAT,
    Math.min(MAX_ELEVATION_RADIANS_FLOAT, elevation_radians_float)
  );
}

/**
 * Measure the distance between the first two tracked pointers.
 *
 * Arguments:
 *   pointers_map (Map): Live pointer positions keyed by pointerId.
 *
 * Returns:
 *   (number): Separation in pixels.
 */
function measurePinchSpan(pointers_map) {
  const [first_obj, second_obj] = [...pointers_map.values()];
  return Math.hypot(
    first_obj.x_px_float - second_obj.x_px_float,
    first_obj.y_px_float - second_obj.y_px_float
  );
}

/**
 * Attach pointer-driven orbit controls to an element.
 *
 * Brief:
 *   Drag rotates, the wheel dollies, and a two-finger pinch scales the
 *   radius. The supplied state object is mutated in place so the render loop
 *   can read the current camera without any copying between frames.
 *
 * Arguments:
 *   target_el (HTMLElement): Element to listen on.
 *   orbit_state_obj (Object): { azimuth, elevation, radius }, mutated.
 *   options_obj (Object): { on_change_fn } called after every change.
 *
 * Returns:
 *   (Function): Detach function removing every listener.
 *
 * Warning:
 *   The wheel listener is registered non-passive because it calls
 *   preventDefault to stop the page scrolling under the visualiser.
 */
export function attachOrbitControls(
  target_el,
  orbit_state_obj,
  options_obj = {}
) {
  const { on_change_fn = null } = options_obj;
  const pointers_map = new Map();
  let is_dragging_bool = false;
  let last_x_px_float = 0;
  let last_y_px_float = 0;
  let pinch_span_px_float = 0;

  const handlePointerDown = (pointer_event) => {
    pointers_map.set(pointer_event.pointerId, {
      x_px_float: pointer_event.clientX,
      y_px_float: pointer_event.clientY,
    });
    if (pointers_map.size !== 1) {
      return;
    }
    is_dragging_bool = true;
    last_x_px_float = pointer_event.clientX;
    last_y_px_float = pointer_event.clientY;
    target_el.setPointerCapture?.(pointer_event.pointerId);
  };

  const handlePinch = () => {
    const span_px_float = measurePinchSpan(pointers_map);
    if (pinch_span_px_float && span_px_float) {
      orbit_state_obj.radius = clampOrbitRadius(
        orbit_state_obj.radius * (pinch_span_px_float / span_px_float)
      );
      on_change_fn?.(orbit_state_obj);
    }
    pinch_span_px_float = span_px_float;
  };

  const handleDrag = (pointer_event) => {
    orbit_state_obj.azimuth -=
      (pointer_event.clientX - last_x_px_float) * AZIMUTH_PER_PIXEL_FLOAT;
    orbit_state_obj.elevation = clampOrbitElevation(
      orbit_state_obj.elevation +
      (pointer_event.clientY - last_y_px_float) * ELEVATION_PER_PIXEL_FLOAT
    );
    last_x_px_float = pointer_event.clientX;
    last_y_px_float = pointer_event.clientY;
    on_change_fn?.(orbit_state_obj);
  };

  const handlePointerMove = (pointer_event) => {
    if (!pointers_map.has(pointer_event.pointerId)) {
      return;
    }
    pointers_map.set(pointer_event.pointerId, {
      x_px_float: pointer_event.clientX,
      y_px_float: pointer_event.clientY,
    });

    if (pointers_map.size >= PINCH_POINTER_COUNT_INT) {
      handlePinch();
      return;
    }
    if (is_dragging_bool) {
      handleDrag(pointer_event);
    }
  };

  const handlePointerUp = (pointer_event) => {
    pointers_map.delete(pointer_event.pointerId);
    if (pointers_map.size < PINCH_POINTER_COUNT_INT) {
      pinch_span_px_float = 0;
    }
    if (pointers_map.size === 0) {
      is_dragging_bool = false;
    }
  };

  const handleWheel = (wheel_event) => {
    wheel_event.preventDefault();
    const step_float =
      1 + Math.sign(wheel_event.deltaY) * WHEEL_DOLLY_STEP_FLOAT;
    orbit_state_obj.radius = clampOrbitRadius(
      orbit_state_obj.radius * step_float
    );
    on_change_fn?.(orbit_state_obj);
  };

  const listeners_list = [
    ['pointerdown', handlePointerDown, undefined],
    ['pointermove', handlePointerMove, undefined],
    ['pointerup', handlePointerUp, undefined],
    ['pointercancel', handlePointerUp, undefined],
    ['pointerleave', handlePointerUp, undefined],
    ['wheel', handleWheel, { passive: false }],
  ];

  for (const [event_name_str, handler_fn, options] of listeners_list) {
    target_el.addEventListener(event_name_str, handler_fn, options);
  }

  return () => {
    for (const [event_name_str, handler_fn] of listeners_list) {
      target_el.removeEventListener(event_name_str, handler_fn);
    }
  };
}
