/**
 * The SonicForge command set.
 *
 * Every command receives a runtime (`rt`) carrying the application handles and
 * — critically — `rt.when`, the AudioContext timestamp at which this command
 * is supposed to take effect. Because the VM schedules ahead of real time, a
 * command must never act "now": audio is scheduled against `rt.when`, and any
 * side effect that cannot be expressed as an AudioParam event is deferred with
 * `rt.at()` so it lands at the right moment.
 *
 * Each command returns its duration in milliseconds. Returning 0 means the
 * command is instantaneous and the next one follows immediately.
 */

import { convertDbToLinear } from '../util/amplitude.js';
import { formatDuration, formatFrequency } from '../util/frequency.js';
import { clampToRange } from '../util/numeric.js';
import {
  applyWaveform,
  WAVEFORM_KEYS_LIST,
} from '../core/waveforms.js';
import { NOISE_COLOUR_KEYS_LIST } from '../dsp/noise-colours.js';
import { parseNoteName } from '../core/tuning.js';

/* =========================================================================
   Argument coercion
   ========================================================================= */

const WORD_ALIASES = {
  sin: 'sine', sine: 'sine',
  sqr: 'square', square: 'square',
  tri: 'triangle', triangle: 'triangle',
  saw: 'sawtooth', sawtooth: 'sawtooth', ramp: 'sawtooth',
  imp: 'impulse', impulse: 'impulse', pulse: 'impulse', click: 'impulse',
  lin: 'linear', linear: 'linear',
  exp: 'exponential', exponential: 'exponential', log: 'exponential',
};

function argValue(a) {
  if (a == null) return undefined;
  if (a.kind_str === 'number') return a.value_any;
  if (a.kind_str === 'string' || a.kind_str === 'word') return a.value_any;
  return undefined;
}

function num(a, fallback) {
  const v = argValue(a);
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * A frequency argument may be a number, a unit-suffixed number, or a note
 * name — `play(A4)` and `play(440hz)` are the same tone.
 */
function freq(rt, a, fallback = 440) {
  const v = argValue(a);
  if (typeof v === 'number' && Number.isFinite(v)) return clampToRange(v, 0.01, 22050);
  if (typeof v === 'string') {
    const midi = parseNoteName(v);
    if (Number.isFinite(midi)) return rt.app.tuning.convertMidiToHertz(midi);
    const n = Number(v);
    if (Number.isFinite(n)) return clampToRange(n, 0.01, 22050);
  }
  return fallback;
}

/** Time in milliseconds. Bare numbers are milliseconds by convention. */
function time(a, fallback = 500) {
  const n = num(a, fallback);
  return clampToRange(n, 0, 30 * 60 * 1000);
}

function word(a, fallback = '') {
  const v = argValue(a);
  if (typeof v !== 'string') return fallback;
  const key = v.toLowerCase();
  return WORD_ALIASES[key] ?? key;
}

function waveform(a, fallback = 'sine') {
  const w = word(a, fallback);
  return WAVEFORM_KEYS_LIST.includes(w) ? w : fallback;
}

function gainDb(a, fallback = -12) {
  return clampToRange(num(a, fallback), -90, 0);
}

/* =========================================================================
   Runtime
   ========================================================================= */

/**
 * Build the object handed to every command invocation.
 * @param {*} app  the SonicForge application facade
 * @param {import('./vm.js').ScriptVM} vm
 */
export function makeRuntime(app, vm) {
  return {
    app,
    vm,
    get engine() { return app.engine; },
    get ctx() { return app.engine.context_obj; },
    when: 0,
    line: 0,
    pc: 0,
    lastLabel: null,

    /** Log a line to the terminal, deferred to the moment it actually happens. */
    log(text, level = 'exec') {
      this.at(() => app.log?.(text, level));
    },

    /** Immediate log, used for parameter echoes that should appear at schedule time. */
    logNow(text, level = 'dim') {
      app.log?.(text, level);
    },

    /**
     * Defer a side effect until `rt.when` arrives in wall-clock terms.
     * Anything that is not an AudioParam event must go through this, or the
     * VM's lookahead would make it happen up to 350 ms early.
     */
    at(fn, when = this.when) {
      const delay = Math.max(0, (when - app.engine.currentTimeSeconds) * 1000);
      if (delay < 2) {
        try { fn(); } catch (e) { console.error('[SonicForge] command error', e); }
        return null;
      }
      return vm.defer(fn, delay);
    },

    hold: (node, gain) => vm.hold(node, gain),
    label(text) { this.lastLabel = text; },
  };
}

/* =========================================================================
   Voice helper
   ========================================================================= */

/**
 * Create a one-shot voice with a click-free envelope, routed through the
 * channel bus so it is metered, visualised and limited like everything else.
 */
function voice(rt, { freq: f, waveform: wf, gainDb: db, pan = 0, phase = 0, durSec, ramp = null, when = rt.when }) {
  const ctx = rt.ctx;

  const osc = ctx.createOscillator();
  applyWaveform(osc, wf, phase);
  osc.frequency.setValueAtTime(clampToRange(f, 0.01, ctx.sampleRate / 2 - 1), when);

  if (ramp) {
    const target = clampToRange(ramp.to, 0.01, ctx.sampleRate / 2 - 1);
    if (ramp.curve === 'linear') {
      osc.frequency.linearRampToValueAtTime(target, when + durSec);
    } else {
      osc.frequency.exponentialRampToValueAtTime(target, when + durSec);
    }
  }

  const g = ctx.createGain();
  const amp = convertDbToLinear(db);
  // Envelope proportions scale down for very short events so a 5 ms blip is
  // still a blip and not a pure click.
  const atk = Math.min(0.006, durSec * 0.25);
  const rel = Math.min(0.018, durSec * 0.35);
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(amp, when + atk);
  if (durSec > atk + rel) g.gain.setValueAtTime(amp, when + durSec - rel);
  g.gain.linearRampToValueAtTime(0, when + durSec);

  osc.connect(g);

  let out = g;
  if (pan !== 0 && ctx.createStereoPanner) {
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(clampToRange(pan, -1, 1), when);
    g.connect(p);
    out = p;
  }
  out.connect(rt.engine.channel_bus_node);

  osc.start(when);
  osc.stop(when + durSec + 0.03);
  rt.hold(osc, g);
  return osc;
}

/* =========================================================================
   Command registry
   ========================================================================= */

const DTMF_ROWS = [697, 770, 852, 941];
const DTMF_COLS = [1209, 1336, 1477, 1633];
export const DTMF_MAP = Object.freeze({
  1: [0, 0], 2: [0, 1], 3: [0, 2], A: [0, 3],
  4: [1, 0], 5: [1, 1], 6: [1, 2], B: [1, 3],
  7: [2, 0], 8: [2, 1], 9: [2, 2], C: [2, 3],
  '*': [3, 0], 0: [3, 1], '#': [3, 2], D: [3, 3],
});

export const COMMANDS = {
  /* ---------------------------------------------------------------- */
  play: {
    signature: 'play(frequency, duration_ms, waveform, gain_db, pan)',
    help: 'Play a single tone. Frequency accepts Hz, kHz, or a note name (A4).',
    example: 'play(440hz, 1s, sine, -12db)',
    run(rt, a) {
      const f = freq(rt, a[0], 440);
      const ms = time(a[1], 500);
      const wf = waveform(a[2], 'sine');
      const db = gainDb(a[3], -12);
      const pan = clampToRange(num(a[4], 0), -1, 1);
      if (ms <= 0) return 0;

      voice(rt, { freq: f, waveform: wf, gainDb: db, pan, durSec: ms / 1000 });
      rt.label(`play ${formatFrequency(f)} · ${wf} · ${formatDuration(ms)}`);
      rt.log(`▶ ${formatFrequency(f)}  ${wf}  ${db.toFixed(1)} dBFS  ${formatDuration(ms)}`);
      return ms;
    },
  },

  /* ---------------------------------------------------------------- */
  sweep: {
    signature: "sweep(start_hz, end_hz, duration_ms, curve['linear'|'exponential'], waveform, gain_db)",
    help: 'Glide between two frequencies. Exponential is constant octaves per second.',
    example: 'sweep(20hz, 20khz, 3s, exponential)',
    run(rt, a) {
      const f0 = freq(rt, a[0], 20);
      const f1 = freq(rt, a[1], 20000);
      const ms = time(a[2], 2000);
      const curve = word(a[3], 'exponential') === 'linear' ? 'linear' : 'exponential';
      const wf = waveform(a[4], 'sine');
      const db = gainDb(a[5], -12);
      if (ms <= 0) return 0;

      voice(rt, {
        freq: f0, waveform: wf, gainDb: db, durSec: ms / 1000,
        ramp: { to: f1, curve },
      });
      rt.label(`sweep ${formatFrequency(f0)} → ${formatFrequency(f1)} · ${curve}`);
      rt.log(`↗ sweep ${formatFrequency(f0)} → ${formatFrequency(f1)}  ${curve}  ${formatDuration(ms)}`);
      return ms;
    },
  },

  /* ---------------------------------------------------------------- */
  wait: {
    signature: 'wait(duration_ms)',
    help: 'Silence for a duration. Accepts ms or s suffixes.',
    example: 'wait(250ms)',
    run(rt, a) {
      const ms = time(a[0], 250);
      rt.label(`wait ${formatDuration(ms)}`);
      return ms;
    },
  },

  /* ---------------------------------------------------------------- */
  loop: {
    signature: 'loop(count, [commands])',
    help: 'Repeat a block. Handled by the VM — nesting is supported.',
    example: 'loop(4, [ play(880, 100), wait(150) ])',
    run() { return 0; }, // never reached; the compiler rewrites loops
  },

  /* ---------------------------------------------------------------- */
  burst: {
    signature: 'burst(frequency, count, on_ms, off_ms, gain_db)',
    help: 'Pulse train at one frequency — the primitive behind water ejection.',
    example: 'burst(165hz, 20, 120ms, 60ms, -6db)',
    run(rt, a) {
      const f = freq(rt, a[0], 165);
      const count = clampToRange(Math.round(num(a[1], 8)), 1, 500);
      const on = time(a[2], 120);
      const off = time(a[3], 60);
      const db = gainDb(a[4], -8);

      for (let i = 0; i < count; i++) {
        const when = rt.when + (i * (on + off)) / 1000;
        voice(rt, { freq: f, waveform: 'sine', gainDb: db, durSec: on / 1000, when });
      }
      const total = count * (on + off);
      rt.label(`burst ${formatFrequency(f)} ×${count}`);
      rt.log(`≡ burst ${formatFrequency(f)} ×${count}  ${formatDuration(on)} on / ${formatDuration(off)} off`);
      return total;
    },
  },

  /* ---------------------------------------------------------------- */
  am: {
    signature: 'am(carrier_hz, modulation_hz, duration_ms, depth, gain_db)',
    help:
      'Amplitude-modulated tone. The envelope rate can be infrasonic even though the carrier is not — ' +
      'this is the only way ordinary speakers deliver a sub-20 Hz forcing, because they physically ' +
      'cannot reproduce a sub-20 Hz tone.',
    example: 'am(200hz, 11hz, 30s, 100%, -8db)',
    run(rt, a) {
      const carrier = freq(rt, a[0], 200);
      const modHz = Math.abs(num(a[1], 10));
      const ms = time(a[2], 10000);
      const depth = clampToRange(num(a[3], 1), 0, 1);
      const db = gainDb(a[4], -10);
      if (ms <= 0) return 0;

      const ctx = rt.ctx;
      const when = rt.when;
      const durSec = ms / 1000;
      const amp = convertDbToLinear(db);

      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(clampToRange(carrier, 0.01, ctx.sampleRate / 2 - 1), when);

      // The modulator is an oscillator driving a gain, not a computed envelope:
      // it stays sample-accurate for the whole run and costs nothing extra.
      const mod = ctx.createOscillator();
      mod.type = 'sine';
      mod.frequency.setValueAtTime(Math.max(modHz, 0.01), when);

      // depth/2 swing around (1 − depth/2) gives 0…1 at full depth.
      const modDepth = ctx.createGain();
      modDepth.gain.setValueAtTime((depth / 2) * amp, when);

      const carrierGain = ctx.createGain();
      carrierGain.gain.setValueAtTime((1 - depth / 2) * amp, when);

      mod.connect(modDepth);
      modDepth.connect(carrierGain.gain);
      osc.connect(carrierGain);

      // Outer envelope so the burst itself starts and ends without a click.
      const env = ctx.createGain();
      env.gain.setValueAtTime(0, when);
      env.gain.linearRampToValueAtTime(1, when + Math.min(0.03, durSec * 0.1));
      env.gain.setValueAtTime(1, when + Math.max(0.04, durSec - 0.05));
      env.gain.linearRampToValueAtTime(0, when + durSec);

      carrierGain.connect(env);
      env.connect(rt.engine.channel_bus_node);

      osc.start(when);
      mod.start(when);
      osc.stop(when + durSec + 0.03);
      mod.stop(when + durSec + 0.03);
      rt.hold(osc, env);
      rt.hold(mod, null);

      rt.label(`am ${formatFrequency(carrier)} ☉ ${modHz.toFixed(2)} Hz`);
      rt.log(
        `≋ AM  carrier ${formatFrequency(carrier)}  envelope ${modHz.toFixed(2)} Hz  ` +
        `depth ${(depth * 100).toFixed(0)}%  ${formatDuration(ms)}`
      );
      return ms;
    },
  },

  /* ---------------------------------------------------------------- */
  chord: {
    signature: 'chord("C4,E4,G4", duration_ms, waveform, gain_db)',
    help: 'Play several notes or frequencies simultaneously.',
    example: 'chord("A3,C#4,E4", 1.5s, triangle)',
    run(rt, a) {
      const spec = String(argValue(a[0]) ?? 'C4,E4,G4');
      const ms = time(a[1], 1000);
      const wf = waveform(a[2], 'sine');
      const db = gainDb(a[3], -18);

      const parts = spec.split(/[,\s/+]+/).filter(Boolean);
      if (!parts.length || ms <= 0) return 0;

      for (const p of parts) {
        const f = freq(rt, { kind_str: 'string', value_any: p }, NaN);
        if (!Number.isFinite(f)) continue;
        voice(rt, { freq: f, waveform: wf, gainDb: db, durSec: ms / 1000 });
      }
      rt.label(`chord ${parts.join(' ')}`);
      rt.log(`♫ chord ${parts.join(' ')}  ${formatDuration(ms)}`);
      return ms;
    },
  },

  /* ---------------------------------------------------------------- */
  dtmf: {
    signature: 'dtmf("555-0100", tone_ms, gap_ms, gain_db)',
    help: 'Dual-tone multi-frequency dialling. Non-keypad characters are treated as pauses.',
    example: 'dtmf("1-800-555-0199", 120ms, 80ms)',
    run(rt, a) {
      const digits = String(argValue(a[0]) ?? '').toUpperCase();
      const toneMs = time(a[1], 120);
      const gapMs = time(a[2], 80);
      const db = gainDb(a[3], -14);
      if (!digits) return 0;

      let offset = 0;
      let played = 0;
      for (const ch of digits) {
        const pair = DTMF_MAP[ch];
        if (!pair) {
          if (/[\s\-.,]/.test(ch)) offset += toneMs + gapMs;  // pause
          continue;
        }
        const when = rt.when + offset / 1000;
        voice(rt, { freq: DTMF_ROWS[pair[0]], waveform: 'sine', gainDb: db, durSec: toneMs / 1000, when });
        voice(rt, { freq: DTMF_COLS[pair[1]], waveform: 'sine', gainDb: db, durSec: toneMs / 1000, when });
        rt.at(() => rt.app.onDtmfDigit?.(ch), when);
        offset += toneMs + gapMs;
        played++;
      }
      rt.label(`dtmf ${digits}`);
      rt.log(`☎ dtmf "${digits}"  ${played} digits`);
      return offset;
    },
  },

  /* ---------------------------------------------------------------- */
  tone: {
    signature: 'tone(channel, frequency, gain_db, waveform, pan)',
    help: 'Configure and start one of the 16 rack channels. Non-blocking.',
    example: 'tone(1, 440hz, -15db, sine)',
    run(rt, a) {
      const idx = clampToRange(Math.round(num(a[0], 1)), 1, rt.app.rack.channels_list.length) - 1;
      const f = freq(rt, a[1], 440);
      const db = gainDb(a[2], -18);
      const wf = waveform(a[3], 'sine');
      const pan = clampToRange(num(a[4], 0), -1, 1);

      rt.at(() => {
        const ch = rt.app.rack.getChannel(idx);
        if (!ch) return;
        ch.setWaveformName(wf);
        ch.setFrequencyHertz(f);
        ch.setGainDb(db);
        ch.setPanPosition(pan);
        if (!ch.is_enabled_bool) ch.start();
      });
      rt.label(`ch${idx + 1} ← ${formatFrequency(f)}`);
      rt.log(`✦ channel ${idx + 1}: ${formatFrequency(f)} ${wf} ${db.toFixed(1)} dBFS`);
      return 0;
    },
  },

  /* ---------------------------------------------------------------- */
  off: {
    signature: 'off(channel | all)',
    help: 'Stop one rack channel, or every channel.',
    example: 'off(all)',
    run(rt, a) {
      const v = argValue(a[0]);
      rt.at(() => {
        if (v === undefined || v === 'all' || v === 0) rt.app.rack.stopAllChannels();
        else rt.app.rack.getChannel(clampToRange(Math.round(Number(v)), 1, 16) - 1)?.stop();
      });
      rt.label(v === 'all' || v === undefined ? 'off all' : `off ch${v}`);
      return 0;
    },
  },

  /* ---------------------------------------------------------------- */
  noise: {
    signature: 'noise(colour, gain_db, duration_ms)',
    help: `Start the noise generator. Colours: ${NOISE_COLOUR_KEYS_LIST.join(', ')}. With a duration it stops itself.`,
    example: 'noise(brown, -22db, 10s)',
    run(rt, a) {
      const color = word(a[0], 'pink');
      const db = gainDb(a[1], -24);
      const ms = num(a[2], 0);
      const valid = NOISE_COLOUR_KEYS_LIST.includes(color) ? color : 'pink';

      rt.at(async () => {
        await rt.app.noise.setColour(valid);
        rt.app.noise.setGainDb(db);
        await rt.app.noise.start();
      });

      if (ms > 0) rt.at(() => rt.app.noise.stop(), rt.when + ms / 1000);

      rt.label(`noise ${valid}`);
      rt.log(`░ noise ${valid} @ ${db.toFixed(1)} dBFS${ms > 0 ? ` for ${formatDuration(ms)}` : ''}`);
      return ms > 0 ? ms : 0;
    },
  },

  /* ---------------------------------------------------------------- */
  hush: {
    signature: 'hush()',
    help: 'Stop the noise generator.',
    example: 'hush()',
    run(rt) {
      rt.at(() => rt.app.noise.stop());
      rt.label('hush');
      return 0;
    },
  },

  /* ---------------------------------------------------------------- */
  gain: {
    signature: 'gain(db)',
    help: 'Set the master output level in dBFS.',
    example: 'gain(-18db)',
    run(rt, a) {
      const db = clampToRange(num(a[0], -12), -90, 6);
      rt.at(() => { rt.app.engine.masterLevelDb = db; rt.app.syncUi?.(); });
      rt.label(`gain ${db.toFixed(1)} dBFS`);
      rt.log(`▤ master ${db.toFixed(1)} dBFS`);
      return 0;
    },
  },

  /* ---------------------------------------------------------------- */
  set: {
    signature: 'set(parameter, value)',
    help: 'Set a global: a4, shield, blend, limiter, noisepan.',
    example: 'set(a4, 432hz)',
    run(rt, a) {
      const key = word(a[0], '');
      const v = num(a[1], NaN);
      const app = rt.app;

      rt.at(() => {
        switch (key) {
          case 'a4': case 'pitch': case 'TUNING_OBJ':
            app.tuning.referenceHertz = clampToRange(v, 380, 500); break;
          case 'shield': case 'vocal':
            app.noise.setShieldDb(clampToRange(v, -12, 12)); break;
          case 'blend': case 'hybrid':
            app.noise.setBlendRatio(clampToRange(v, 0, 1)); break;
          case 'limiter':
            app.engine.isLimiterEnabled = !!v; break;
          case 'noisepan':
            app.noise.setPanPosition(clampToRange(v, -1, 1)); break;
          default:
            app.log?.(`set(): unknown parameter '${key}'`, 'warn');
        }
        app.syncUi?.();
      });
      rt.label(`set ${key} = ${v}`);
      rt.log(`⚙ set ${key} = ${v}`);
      return 0;
    },
  },

  /* ---------------------------------------------------------------- */
  phase: {
    signature: 'phase(channel, degrees)',
    help: 'Rotate a channel’s starting phase, 0–360°. Use two channels at 0° and 180° to demonstrate cancellation.',
    example: 'phase(2, 180deg)',
    run(rt, a) {
      const idx = clampToRange(Math.round(num(a[0], 1)), 1, 16) - 1;
      const deg = num(a[1], 0);
      rt.at(() => { rt.app.rack.getChannel(idx)?.setPhaseDegrees(deg); rt.app.syncUi?.(); });
      rt.label(`phase ch${idx + 1} ${Math.round(deg)}°`);
      return 0;
    },
  },

  /* ---------------------------------------------------------------- */
  print: {
    signature: 'print("message")',
    help: 'Write a line to the terminal log at the moment it is reached.',
    example: 'print("stage 2 complete")',
    run(rt, a) {
      const msg = String(argValue(a[0]) ?? '');
      rt.log(msg, 'ok');
      rt.label(`print`);
      return 0;
    },
  },

  /* ---------------------------------------------------------------- */
  stop: {
    signature: 'stop()',
    help: 'Silence every channel, the noise generator, and any scheduled one-shots.',
    example: 'stop()',
    run(rt) {
      rt.at(() => {
        rt.app.rack.stopAllChannels();
        rt.app.noise.stop();
        rt.vm.releaseHeld();
        rt.app.syncUi?.();
      });
      rt.label('stop all');
      rt.log('■ all sources stopped', 'warn');
      return 0;
    },
  },
};

/** Command names, for autocomplete. */
export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));
