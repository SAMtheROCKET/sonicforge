/**
 * The thinnest possible WebGL2 helper layer.
 *
 * SonicForge deliberately does not load Three.js. The visualiser needs exactly
 * one shader program, one indexed mesh and one streaming texture; pulling 600 kB
 * of scene graph from a CDN to get that would break the "no network at runtime"
 * property that makes this app deployable as a static file and usable offline.
 */

export class GLError extends Error {}

/** Acquire a WebGL2 context, or null if the platform cannot provide one. */
export function getGL(canvas, opts = {}) {
  try {
    return canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      depth: true,
      premultipliedAlpha: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      ...opts,
    });
  } catch {
    return null;
  }
}

export function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    throw new GLError(`${kind} shader failed to compile:\n${log}`);
  }
  return sh;
}

export function link(gl, vsSource, fsSource) {
  const vs = compile(gl, gl.VERTEX_SHADER, vsSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fsSource);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new GLError(`program failed to link:\n${log}`);
  }
  return prog;
}

/** Collect uniform and attribute locations by name in one pass. */
export function locations(gl, prog) {
  const uniforms = {};
  const attribs = {};

  const nu = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < nu; i++) {
    const info = gl.getActiveUniform(prog, i);
    if (info) uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(prog, info.name);
  }

  const na = gl.getProgramParameter(prog, gl.ACTIVE_ATTRIBUTES);
  for (let i = 0; i < na; i++) {
    const info = gl.getActiveAttrib(prog, i);
    if (info) attribs[info.name] = gl.getAttribLocation(prog, info.name);
  }
  return { uniforms, attribs };
}

export function buffer(gl, target, data, usage = gl.STATIC_DRAW) {
  const buf = gl.createBuffer();
  gl.bindBuffer(target, buf);
  gl.bufferData(target, data, usage);
  return buf;
}

/**
 * Single-channel 8-bit texture used as a streaming height field.
 * NEAREST on the frequency axis keeps bin edges honest; LINEAR on the time
 * axis lets the surface glide instead of stepping.
 */
export function heightTexture(gl, width, height) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  return tex;
}

/**
 * Resize the drawing buffer to match CSS size × dpr, capped so that a 4K
 * display does not quietly cost four times the fill rate.
 * @returns true if the size changed
 */
export function resizeToDisplay(canvas, maxDpr = 2) {
  const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * dpr));
  const h = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width === w && canvas.height === h) return false;
  canvas.width = w;
  canvas.height = h;
  return true;
}

/**
 * Pointer-driven orbit controller: drag to rotate, wheel to dolly,
 * two-finger pinch on touch.
 */
export function orbitControls(el, state, { onChange } = {}) {
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let pinchDist = 0;
  const pointers = new Map();

  const clampEl = (v) => Math.max(-1.35, Math.min(1.45, v));

  const down = (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    }
  };

  const move = (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDist) {
        state.radius = Math.max(1.4, Math.min(7, state.radius * (pinchDist / d)));
        onChange?.(state);
      }
      pinchDist = d;
      return;
    }

    if (!dragging) return;
    state.azimuth -= (e.clientX - lastX) * 0.007;
    state.elevation = clampEl(state.elevation + (e.clientY - lastY) * 0.006);
    lastX = e.clientX;
    lastY = e.clientY;
    onChange?.(state);
  };

  const up = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = 0;
    if (pointers.size === 0) dragging = false;
  };

  const wheel = (e) => {
    e.preventDefault();
    state.radius = Math.max(1.4, Math.min(7, state.radius * (1 + Math.sign(e.deltaY) * 0.08)));
    onChange?.(state);
  };

  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('pointerleave', up);
  el.addEventListener('wheel', wheel, { passive: false });

  return () => {
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    el.removeEventListener('pointerleave', up);
    el.removeEventListener('wheel', wheel);
  };
}
