/**
 * 3D spectrogram / waterfall.
 *
 *   X  historical time   (rows scroll away from the viewer)
 *   Y  amplitude          (vertex displacement + colour)
 *   Z  frequency          (log-spaced, 20 Hz at the left edge, 20 kHz at the right)
 *
 * Each frame the analyser's linear FFT bins are resampled onto a log-frequency
 * grid on the CPU, quantised to 8 bits, and pushed into one row of a ring-buffer
 * texture. The vertex shader then reads that texture to displace a static mesh,
 * so scrolling the history costs a single `texSubImage2D` of one row per frame
 * rather than rebuilding geometry.
 */

import { getGL, link, locations, buffer, heightTexture, resizeToDisplay, orbitControls, GLError } from './glutil.js';
import { mapPositionToFrequency } from '../util/frequency.js';
import { Matrix4 } from '../util/matrix4.js';
import { clampToRange } from '../util/numeric.js';

const FREQ_POINTS = 200;   // mesh resolution along Z
const HISTORY = 176;       // mesh resolution along X (rows of history)
const MIN_DB = -96;
const MAX_DB = -12;

/* ------------------------------------------------------------------------ */

const VERT = `#version 300 es
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

const FRAG = `#version 300 es
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

  float alpha = mix(0.10, 1.0, smoothstep(0.02, 0.35, a)) * (1.0 - vAge * 0.55);
  alpha = max(alpha, uWire * 0.14);

  fragColor = vec4(col, alpha);
}`;

/* ------------------------------------------------------------------------ */

export class Waterfall {
  mode = 'webgl';
  running = false;

  camera = { azimuth: -0.62, elevation: 0.52, radius: 3.5 };

  #gl = null;
  #prog = null;
  #vao = null;
  #tex = null;
  #loc = null;
  #indexCount = 0;
  #head = 0;
  #row = new Uint8Array(FREQ_POINTS);
  #detach = null;
  #raf = 0;
  #lift = 0.95;
  #lastFrame = 0;
  #fps = 0;

  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/engine.js').AudioEngine} engine
   */
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.engine = engine;

    // Display band. The low edge is 5 Hz rather than the conventional 20 Hz
    // because infrasonic work — candle flicker, thermoacoustic forcing — lives
    // entirely below the audible floor and has to be visible here. The high
    // edge follows Nyquist, so raising the sample rate reveals ultrasound.
    this.loHz = 5;
    this.hiHz = Math.min(engine.nyquistHertz, 48000);

    // Log-spaced frequency grid — the whole point of resampling on the CPU.
    this.freqs = new Float64Array(FREQ_POINTS);
    for (let i = 0; i < FREQ_POINTS; i++) {
      this.freqs[i] = mapPositionToFrequency(i / (FREQ_POINTS - 1), this.loHz, this.hiHz);
    }

    try {
      this.#initGL();
    } catch (err) {
      console.warn('[SonicForge] WebGL2 unavailable, falling back to Canvas2D:', err.message);
      this.mode = 'canvas2d';
      this.#initCanvas();
    }

    this.#detach = orbitControls(canvas, this.camera);
  }

  /* =================================================================== */

  #initGL() {
    const gl = getGL(this.canvas);
    if (!gl) throw new GLError('WebGL2 context could not be created');
    this.#gl = gl;

    this.#prog = link(gl, VERT, FRAG);
    this.#loc = locations(gl, this.#prog);

    // --- Static grid mesh ------------------------------------------
    const verts = new Float32Array(FREQ_POINTS * HISTORY * 2);
    let p = 0;
    for (let j = 0; j < HISTORY; j++) {
      for (let i = 0; i < FREQ_POINTS; i++) {
        verts[p++] = i / (FREQ_POINTS - 1);
        verts[p++] = j / (HISTORY - 1);
      }
    }

    const quads = (FREQ_POINTS - 1) * (HISTORY - 1);
    const idx = new Uint32Array(quads * 6);
    let q = 0;
    for (let j = 0; j < HISTORY - 1; j++) {
      for (let i = 0; i < FREQ_POINTS - 1; i++) {
        const a = j * FREQ_POINTS + i;
        const b = a + 1;
        const c = a + FREQ_POINTS;
        const d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    this.#indexCount = idx.length;

    this.#vao = gl.createVertexArray();
    gl.bindVertexArray(this.#vao);
    buffer(gl, gl.ARRAY_BUFFER, verts);
    gl.enableVertexAttribArray(this.#loc.attribs.aGrid);
    gl.vertexAttribPointer(this.#loc.attribs.aGrid, 2, gl.FLOAT, false, 0, 0);
    buffer(gl, gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bindVertexArray(null);

    this.#tex = heightTexture(gl, FREQ_POINTS, HISTORY);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 0);
  }

  #initCanvas() {
    this.ctx2d = this.canvas.getContext('2d');
    this.history = [];
  }

  /* =================================================================== */

  start() {
    if (this.running) return this;
    this.running = true;
    this.#lastFrame = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.#frame();
      this.#raf = requestAnimationFrame(loop);
    };
    this.#raf = requestAnimationFrame(loop);
    return this;
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this.#raf);
    return this;
  }

  destroy() {
    this.stop();
    this.#detach?.();
    const gl = this.#gl;
    if (gl) {
      gl.deleteTexture(this.#tex);
      gl.deleteProgram(this.#prog);
      gl.deleteVertexArray(this.#vao);
    }
  }

  setLift(v) {
    this.#lift = clampToRange(v, 0.15, 2.2);
  }

  get fps() {
    return this.#fps;
  }

  /* =================================================================== */

  /**
   * Resample the analyser's linear bins onto the log grid and quantise.
   * Peak-picking rather than averaging, because a single sine sitting between
   * two log grid points must not be allowed to disappear.
   */
  #sampleRow() {
    const spectrum = this.engine.meter.readSpectrumDb();
    if (!spectrum || !spectrum.length) {
      this.#row.fill(0);
      return;
    }
    const bins = spectrum.length;
    const nyquist = this.engine.sampleRateHertz / 2;
    const span = MAX_DB - MIN_DB;

    for (let i = 0; i < FREQ_POINTS; i++) {
      const fLo = i === 0 ? this.loHz : Math.sqrt(this.freqs[i - 1] * this.freqs[i]);
      const fHi = i === FREQ_POINTS - 1 ? this.hiHz : Math.sqrt(this.freqs[i] * this.freqs[i + 1]);

      let b0 = Math.floor((fLo / nyquist) * bins);
      let b1 = Math.ceil((fHi / nyquist) * bins);
      b0 = clampToRange(b0, 0, bins - 1);
      b1 = clampToRange(b1, b0, bins - 1);

      let peak = -Infinity;
      for (let b = b0; b <= b1; b++) if (spectrum[b] > peak) peak = spectrum[b];
      if (!Number.isFinite(peak)) peak = MIN_DB;

      const t = clampToRange((peak - MIN_DB) / span, 0, 1);
      this.#row[i] = (t * 255) | 0;
    }
  }

  #frame() {
    const now = performance.now();
    const dt = now - this.#lastFrame;
    this.#lastFrame = now;
    this.#fps = this.#fps * 0.9 + (1000 / Math.max(dt, 1)) * 0.1;

    this.#sampleRow();
    if (this.mode === 'webgl') this.#drawGL();
    else this.#drawCanvas();
  }

  #drawGL() {
    const gl = this.#gl;
    const canvas = this.canvas;
    resizeToDisplay(canvas);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Push the newest row into the ring buffer.
    this.#head = (this.#head + 1) % HISTORY;
    gl.bindTexture(gl.TEXTURE_2D, this.#tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, this.#head, FREQ_POINTS, 1, gl.RED, gl.UNSIGNED_BYTE, this.#row);

    const aspect = canvas.width / Math.max(1, canvas.height);
    const proj = Matrix4.createPerspective(Math.PI / 4.2, aspect, 0.1, 40);
    const eye = Matrix4.computeOrbitEyePosition([0, 0.22, 0], this.camera.radius, this.camera.azimuth, this.camera.elevation);
    const view = Matrix4.createLookAt(eye, [0, 0.16, 0], [0, 1, 0]);
    const viewProj = Matrix4.multiply(proj, view);

    gl.useProgram(this.#prog);
    gl.bindVertexArray(this.#vao);
    gl.uniformMatrix4fv(this.#loc.uniforms.uViewProj, false, viewProj);
    gl.uniform1i(this.#loc.uniforms.uHeights, 0);
    gl.uniform1f(this.#loc.uniforms.uHead, this.#head);
    gl.uniform1f(this.#loc.uniforms.uRows, HISTORY);
    gl.uniform1f(this.#loc.uniforms.uLift, this.#lift);
    gl.uniform1f(this.#loc.uniforms.uWire, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.#tex);

    gl.drawElements(gl.TRIANGLES, this.#indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
  }

  /**
   * Canvas2D fallback: a projected waterfall drawn as stacked polylines.
   * Not as pretty, but it keeps the app fully functional on machines where
   * WebGL2 is blocked or unavailable.
   */
  #drawCanvas() {
    const c = this.ctx2d;
    const canvas = this.canvas;
    resizeToDisplay(canvas, 1.5);
    const w = canvas.width;
    const h = canvas.height;

    this.history.unshift(Uint8Array.from(this.#row));
    if (this.history.length > 90) this.history.pop();

    c.clearRect(0, 0, w, h);
    const rows = this.history.length;

    for (let j = rows - 1; j >= 0; j--) {
      const row = this.history[j];
      const age = j / 90;
      const depth = 1 - age * 0.55;
      const yBase = h * (0.30 + age * 0.62);
      const xOff = w * age * 0.11;
      const width = w * (1 - age * 0.22);

      c.beginPath();
      for (let i = 0; i < FREQ_POINTS; i++) {
        const x = xOff + (i / (FREQ_POINTS - 1)) * width;
        const y = yBase - (row[i] / 255) * h * 0.34 * depth;
        i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      const alpha = (1 - age) * 0.85;
      c.strokeStyle = `rgba(0, ${120 + 120 * (1 - age)}, ${200 + 55 * (1 - age)}, ${alpha})`;
      c.lineWidth = j === 0 ? 2 : 1;
      c.stroke();

      if (j === 0) {
        c.shadowBlur = 14;
        c.shadowColor = 'rgba(0,242,254,0.7)';
        c.stroke();
        c.shadowBlur = 0;
      }
    }
  }
}
