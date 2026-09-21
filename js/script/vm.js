/**
 * The SonicForge script virtual machine.
 *
 * Design constraint: execution must never block the UI thread, and must never
 * drift. Those two goals conflict if you chain setTimeout calls — timer jitter
 * accumulates and a sixteen-step loop ends up audibly ragged.
 *
 * So the VM runs on two clocks. A coarse wall-clock tick (every 25 ms) walks
 * the instruction list *ahead of real time*, scheduling audio events against
 * the AudioContext's sample clock up to a 350 ms lookahead horizon. The audio
 * is therefore sample-accurate, while the JavaScript that produced it is only
 * ever doing a few milliseconds of work per tick.
 *
 * The UI reads a separate timeline that maps scheduled events back to wall
 * time, which is how the terminal can show a live millisecond countdown for a
 * block that was actually scheduled a third of a second ago.
 */

import { Emitter } from '../util/events.js';
import { parse, ScriptError } from './parser.js';
import { COMMANDS, makeRuntime } from './commands.js';

const LOOKAHEAD_SEC = 0.35;
const TICK_MS = 25;
const MAX_STEPS_PER_TICK = 400;
const MAX_TOTAL_STEPS = 500000;

export const VM_STATE = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  DRAINING: 'draining',   // instructions exhausted; audio still playing out
  STOPPED: 'stopped',
  ERROR: 'error',
});

export class ScriptVM extends Emitter {
  state = VM_STATE.IDLE;
  instructions = [];
  timeline = [];

  #pc = 0;
  #frames = [];
  #cursor = 0;
  #steps = 0;
  #timer = null;
  #held = new Set();
  #timeouts = new Set();
  #runtime = null;
  #endsAt = 0;

  constructor(app) {
    super();
    this.app = app;
  }

  get running() {
    return this.state === VM_STATE.RUNNING || this.state === VM_STATE.DRAINING;
  }

  /* ===================================================================
     Compilation
     =================================================================== */

  /**
   * Parse and flatten a program into a linear instruction list.
   * Unknown commands and malformed loops fail here, before a single note plays.
   */
  compile(source) {
    const ast = parse(source);
    const out = [];

    const emit = (nodes) => {
      for (const node of nodes) {
        if (node.kind_str === 'call') {
          const spec = COMMANDS[node.name_str];
          if (!spec) {
            throw new ScriptError(
              `Unknown command '${node.name_str}'. Try: ${suggest(node.name_str)}`,
              { line_int: node.line_int, column_int: node.column_int }
            );
          }
          out.push({
            op: 'CALL',
            name: node.name_str,
            args: node.arguments_list,
            spec,
            line: node.line_int,
          });
        } else if (node.kind_str === 'loop') {
          const head = out.length;
          out.push({
            op: 'LOOP',
            count: node.repeat_count_int,
            end: -1,
            line: node.line_int,
          });
          emit(node.body_list);
          out.push({ op: 'ENDLOOP', head, line: node.line_int });
          out[head].end = out.length;
        }
      }
    };

    emit(ast.body_list);
    return out;
  }

  /** Compile without running — used by the terminal for live validation. */
  validate(source) {
    try {
      const ins = this.compile(source);
      return { ok: true, count: ins.filter((i) => i.op === 'CALL').length };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  /* ===================================================================
     Execution
     =================================================================== */

  /**
   * @param {string|Array|Object} source
   * @param {{label?:string}} [opts]
   */
  run(source, { label = 'script' } = {}) {
    this.stop({ silent: true });

    let instructions;
    try {
      instructions = this.compile(source);
    } catch (err) {
      this.state = VM_STATE.ERROR;
      this.emit('error', err);
      throw err;
    }

    if (!instructions.length) {
      this.emit('log', { level: 'dim', text: 'Nothing to run.' });
      return this;
    }

    this.instructions = instructions;
    this.timeline = [];
    this.label = label;
    this.#pc = 0;
    this.#frames = [];
    this.#steps = 0;
    this.#held.clear();
    this.#runtime = makeRuntime(this.app, this);

    // Start a beat into the future so the first event is never late.
    this.#cursor = this.app.engine.currentTimeSeconds + 0.08;
    this.#endsAt = this.#cursor;
    this.state = VM_STATE.RUNNING;

    this.emit('start', { label, count: instructions.filter((i) => i.op === 'CALL').length });
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), TICK_MS);
    return this;
  }

  #tick() {
    if (!this.running) return;

    const now = this.app.engine.currentTimeSeconds;
    const horizon = now + LOOKAHEAD_SEC;
    let steps = 0;

    try {
      while (
        this.state === VM_STATE.RUNNING &&
        this.#cursor < horizon &&
        steps < MAX_STEPS_PER_TICK
      ) {
        if (this.#pc >= this.instructions.length) {
          this.state = VM_STATE.DRAINING;
          break;
        }
        this.#step();
        steps++;

        if (++this.#steps > MAX_TOTAL_STEPS) {
          throw new ScriptError(
            `Execution budget exhausted after ${MAX_TOTAL_STEPS.toLocaleString()} steps — is a loop count too large?`
          );
        }
      }
    } catch (err) {
      this.#fail(err);
      return;
    }

    this.#prune(now);
    this.emit('tick', this.snapshot(now));

    if (this.state === VM_STATE.DRAINING && now >= this.#endsAt) this.#finish();
  }

  #step() {
    const ins = this.instructions[this.#pc];

    switch (ins.op) {
      case 'LOOP': {
        if (ins.count <= 0) {
          this.#pc = ins.end;            // skip the whole body
        } else {
          this.#frames.push({ head: this.#pc, remaining: ins.count, total: ins.count, iteration: 1 });
          this.#pc++;
        }
        break;
      }

      case 'ENDLOOP': {
        const frame = this.#frames[this.#frames.length - 1];
        if (!frame) { this.#pc++; break; }
        frame.remaining--;
        if (frame.remaining > 0) {
          frame.iteration++;
          this.#pc = frame.head + 1;      // jump back into the body
        } else {
          this.#frames.pop();
          this.#pc++;
        }
        break;
      }

      case 'CALL': {
        const rt = this.#runtime;
        rt.when = this.#cursor;
        rt.line = ins.line;
        rt.pc = this.#pc;

        const durationMs = ins.spec.run(rt, ins.args) || 0;
        const durSec = Math.max(0, durationMs) / 1000;

        this.timeline.push({
          pc: this.#pc,
          name: ins.name,
          label: rt.lastLabel || ins.name,
          line: ins.line,
          start: this.#cursor,
          end: this.#cursor + durSec,
          depth: this.#frames.length,
          iteration: this.#frames[this.#frames.length - 1]?.iteration ?? 0,
          iterations: this.#frames[this.#frames.length - 1]?.total ?? 0,
        });
        rt.lastLabel = null;

        this.#cursor += durSec;
        if (this.#cursor > this.#endsAt) this.#endsAt = this.#cursor;
        this.#pc++;
        break;
      }

      default:
        this.#pc++;
    }
  }

  #prune(now) {
    // Keep a small tail so the UI can render what just finished.
    if (this.timeline.length > 512) {
      this.timeline = this.timeline.filter((e) => e.end > now - 2);
    }
  }

  /** What the UI should be showing right now. */
  snapshot(now = this.app.engine.currentTimeSeconds) {
    let current = null;
    for (let i = this.timeline.length - 1; i >= 0; i--) {
      const e = this.timeline[i];
      if (e.start <= now && now < e.end) { current = e; break; }
      if (e.end <= now && !current) current = current ?? null;
    }
    // Zero-duration commands never span `now`; fall back to the most recent.
    if (!current) {
      for (let i = this.timeline.length - 1; i >= 0; i--) {
        if (this.timeline[i].start <= now) { current = this.timeline[i]; break; }
      }
    }

    const remainMs = current ? Math.max(0, (current.end - now) * 1000) : 0;
    const totalMs = Math.max(0, (this.#endsAt - now) * 1000);

    return {
      state: this.state,
      current,
      remainMs,
      totalMs,
      progress: current && current.end > current.start
        ? (now - current.start) / (current.end - current.start)
        : 0,
      depth: this.#frames.length,
      iteration: this.#frames[this.#frames.length - 1]?.iteration ?? 0,
      iterations: this.#frames[this.#frames.length - 1]?.total ?? 0,
      scheduled: this.#pc,
      total: this.instructions.length,
    };
  }

  /* ===================================================================
     Resource ownership
     =================================================================== */

  /**
   * Register a node the VM created so that `stop()` can silence it even though
   * it was scheduled to start in the future.
   */
  hold(node, gainNode = null) {
    const entry = { node, gainNode };
    this.#held.add(entry);
    if (node && 'onended' in node) {
      node.onended = () => {
        this.#held.delete(entry);
        try { node.disconnect(); } catch {}
        try { gainNode?.disconnect(); } catch {}
      };
    }
    return entry;
  }

  /**
   * Queue a deferred side effect, owned by the VM so that `stop()` can cancel
   * work that was scheduled during lookahead but has not fired yet.
   */
  defer(fn, delayMs) {
    const id = setTimeout(() => {
      this.#timeouts.delete(id);
      try { fn(); } catch (err) { console.error('[SonicForge] deferred command error', err); }
    }, delayMs);
    this.#timeouts.add(id);
    return id;
  }

  /** Public handle used by the `stop()` command to silence in-flight voices. */
  releaseHeld(fade = 0.02) {
    this.#releaseAll(fade);
  }

  #releaseAll(fade = 0.02) {
    const t = this.app.engine.currentTimeSeconds;
    for (const id of this.#timeouts) clearTimeout(id);
    this.#timeouts.clear();

    for (const { node, gainNode } of this.#held) {
      try {
        if (gainNode) {
          gainNode.gain.cancelScheduledValues(t);
          gainNode.gain.setValueAtTime(gainNode.gain.value, t);
          gainNode.gain.linearRampToValueAtTime(0, t + fade);
        }
        node?.stop?.(t + fade + 0.005);
      } catch {
        try { node?.disconnect?.(); } catch {}
      }
    }
    this.#held.clear();
  }

  /* ===================================================================
     Termination
     =================================================================== */

  stop({ silent = false } = {}) {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    const wasRunning = this.running;
    this.#releaseAll();
    this.state = VM_STATE.STOPPED;
    this.#frames = [];
    if (wasRunning && !silent) this.emit('stop', this.snapshot());
    return this;
  }

  #finish() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    this.#held.clear();
    this.state = VM_STATE.IDLE;
    this.emit('finish', { label: this.label, steps: this.#steps });
  }

  #fail(err) {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    this.#releaseAll();
    this.state = VM_STATE.ERROR;
    this.emit('error', err);
  }
}

/* ------------------------------------------------------------------------ */

/** Cheap edit-distance suggestion for unknown command names. */
function suggest(name) {
  const keys = Object.keys(COMMANDS);
  const scored = keys
    .map((k) => [k, distance(name, k)])
    .sort((a, b) => a[1] - b[1]);
  const near = scored.filter(([, d]) => d <= 3).slice(0, 3).map(([k]) => k);
  return (near.length ? near : keys.slice(0, 5)).join(', ');
}

function distance(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[n];
}
