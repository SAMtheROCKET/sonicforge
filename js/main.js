/**
 * SonicForge — application bootstrap and wiring.
 *
 * Nothing here contains audio logic; every module below owns its own domain.
 * This file's job is to build them in the right order (the engine must exist
 * before anything that needs an AudioContext), connect the DOM to the models,
 * and run the single animation frame loop that drives every meter and readout.
 */

import {
  AudioEngine,
  SAMPLE_RATE_OPTIONS_LIST,
} from './core/audio-engine.js';
import {
  ChannelRack,
  CHANNEL_COUNT_INT,
} from './core/channel-rack.js';
import {
  NoiseGenerator,
  SHAPE_FILTER_LABELS_DICT,
} from './core/noise-generator.js';
import { RoomCalibrator } from './core/room-calibrator.js';
import { TUNING_OBJ, PITCH_STANDARDS_LIST } from './core/tuning.js';
import {
  WAVEFORMS_DICT,
  WAVEFORM_KEYS_LIST,
} from './core/waveforms.js';
import {
  NOISE_COLOURS_DICT,
  NOISE_COLOUR_KEYS_LIST,
} from './dsp/noise-colours.js';

import { ScriptVM } from './script/vm.js';
import { Waterfall } from './viz/waterfall.js';
import { InterferenceView } from './viz/interference.js';

import { FrequencyDial } from './ui/dial.js';
import { ChannelRackUI, paintRange, paintBipolar } from './ui/channels.js';
import { Terminal } from './ui/terminal.js';
import { CalibrationPanel, ConcertPanel } from './ui/panels.js';
import { toast, confirmDialog } from './ui/feedback.js';

import { ConcertMode } from './sync/concert.js';
import { PRESETS, GROUPS, runPreset } from './presets/presets.js';
import { icon } from './ui/icons.js';
import { registerServiceWorker } from './pwa.js';

import {
  SILENCE_THRESHOLD_DB_FLOAT,
  convertDbToLinear,
  formatDb,
} from './util/amplitude.js';
import { formatFrequency } from './util/frequency.js';
import { clampToRange } from './util/numeric.js';

const $ = (id) => document.getElementById(id);
const STORE_KEY = 'sonicforge.session';

/* =========================================================================
   Application facade — the object every module receives
   ========================================================================= */

const app = {
  engine: new AudioEngine(),
  tuning: TUNING_OBJ,
  rack: null,
  noise: null,
  vm: null,
  cal: null,
  concert: null,
  ui: {},
  booted: false,

  log(text, level = 'dim') {
    this.ui.terminal?.log(text, level);
  },

  runScript(source, opts) {
    try {
      this.vm.run(source, opts);
    } catch (err) {
      this.log(err.format ? err.format() : err.message, 'err');
      toast('Script error — see the terminal.', 'err');
    }
  },

  get selectedChannel() {
    return this.rack?.getChannel(this.ui.channels?.selected ?? 0) ?? null;
  },

  selectChannel(i) {
    this.ui.channels?.select(i);
  },

  setVizMode(mode) {
    setVizMode(mode);
  },

  openDtmf() {
    openDtmfPad();
  },

  onDtmfDigit(ch) {
    const btn = document.querySelector(`.dtmf-pad [data-digit="${ch}"]`);
    if (!btn) return;
    btn.classList.add('is-lit');
    setTimeout(() => btn.classList.remove('is-lit'), 110);
  },

  syncUi() {
    syncOscillatorPanel();
    syncNoisePanel();
    syncHeader();
    this.ui.channels?.syncAll();
  },
};

// Exposed for the test harness and for power users in the console.
window.SonicForge = app;

/* =========================================================================
   Boot
   ========================================================================= */

const unlockEl = $('unlock');
const appEl = $('app');

async function boot() {
  if (app.booted) return;
  app.booted = true;

  // The sample rate is fixed for the life of an AudioContext, so the user's
  // choice has to be known before the engine is built.
  let requestedRate = null;
  try {
    requestedRate = Number(localStorage.getItem('sonicforge.rate')) || null;
  } catch {}

  try {
    await app.engine.init({ sampleRate: requestedRate });
  } catch (err) {
    unlockEl.innerHTML = `<div class="unlock__inner"><h1 class="unlock__title">Audio unavailable</h1>
      <p class="unlock__sub">${err.message}</p></div>`;
    return;
  }

  app.rack = new ChannelRack(app.engine, CHANNEL_COUNT_INT);
  app.noise = new NoiseGenerator(app.engine);
  app.vm = new ScriptVM(app);
  app.cal = new RoomCalibrator(app.engine);
  app.concert = new ConcertMode(app);

  appEl.hidden = false;
  unlockEl.classList.add('is-gone');
  setTimeout(() => unlockEl.remove(), 500);

  buildUI();
  restoreSession();
  startFrameLoop();

  app.log(`Engine ready — ${app.engine.sampleRateHertz} Hz, ${app.engine.latencyMs.toFixed(1)} ms latency.`, 'ok');

  // Pre-synthesise the two colours the focus presets use, during idle time,
  // so the first Start is instant rather than a 300 ms stall.
  const warm = () => app.noise.warmColourCache(['pink', 'brown']).catch(() => {});
  'requestIdleCallback' in window ? requestIdleCallback(warm, { timeout: 4000 }) : setTimeout(warm, 2500);
}

unlockEl.addEventListener('click', boot, { once: true });
unlockEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') boot();
});
app.engine.armGestureUnlock();

/**
 * Headless self-test hook.
 *
 * Only ever active on localhost with an explicit ?selftest=1, so it cannot
 * affect a deployed build — the module is not even fetched otherwise. It lets
 * the real application be booted and audited by CI rather than by hand.
 */
if (
  /^(localhost|127\.0\.0\.1)$/.test(location.hostname) &&
  new URLSearchParams(location.search).has('selftest')
) {
  app.__presets = PRESETS;
  import('./selftest.js')
    .then(({ runSelfTest }) => runSelfTest(app, { boot }))
    .catch((err) => console.error('[SonicForge] self-test failed to load', err));
}

/* =========================================================================
   UI construction
   ========================================================================= */

function buildUI() {
  buildHeader();
  buildOscillator();
  buildChannels();
  buildNoiseBuffer();
  buildViz();
  buildTerminal();
  buildPresets();

  app.ui.calibration = new CalibrationPanel(app.cal, app);
  app.ui.concert = new ConcertPanel(app.concert, app);

  bindShortcuts();
  bindRailToggle();

  $('btn-help').addEventListener('click', showHelp);
}

/* ---------------------------------------------------------------- header */

function buildHeader() {
  const play = $('master-play');
  const label = $('master-play-label');

  play.addEventListener('click', () => {
    const anyLive = app.rack.activeChannelCount > 0 || app.noise.is_running_bool || app.vm.running;
    if (anyLive) {
      app.rack.stopAllChannels();
      app.noise.stop();
      app.vm.stop();
    } else {
      // Nothing is running: start whatever the user has selected, or the
      // first channel if the rack is entirely idle.
      const ch = app.selectedChannel ?? app.rack.getChannel(0);
      ch.start();
    }
    syncHeader();
  });

  $('panic').addEventListener('click', panic);

  const gain = $('master-gain');
  gain.addEventListener('input', () => {
    app.engine.masterLevelDb = Number(gain.value);
    $('master-db').textContent = `${formatDb(app.engine.masterLevelDb)} dB`;
    paintRange(gain);
  });
  gain.value = String(app.engine.masterLevelDb);
  paintRange(gain);

  // --- A4 calibration -------------------------------------------------
  const sel = $('a4-preset');
  sel.innerHTML = PITCH_STANDARDS_LIST
    .map((p) => `<option value="${p.hertz_float}">${p.label_str} Hz — ${p.note_str}</option>`)
    .join('') + '<option value="custom">Custom…</option>';
  sel.value = '440';

  const hz = $('a4-hz');

  sel.addEventListener('change', () => {
    if (sel.value === 'custom') { hz.focus(); hz.select(); return; }
    TUNING_OBJ.referenceHertz = Number(sel.value);
  });

  const commitA4 = () => {
    const v = parseFloat(hz.value);
    if (!Number.isFinite(v) || v < 380 || v > 500) {
      hz.classList.add('is-invalid');
      setTimeout(() => hz.classList.remove('is-invalid'), 700);
      hz.value = TUNING_OBJ.referenceHertz.toFixed(2).replace(/\.00$/, '');
      return;
    }
    TUNING_OBJ.referenceHertz = v;
  };
  hz.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commitA4(); hz.blur(); } });
  hz.addEventListener('blur', commitA4);

  TUNING_OBJ.on('change', (a4) => {
    hz.value = a4.toFixed(2).replace(/\.00$/, '');
    const match = PITCH_STANDARDS_LIST.find(
      (p) => Math.abs(p.hertz_float - a4) < 0.05
    );
    sel.value = match ? String(match.hertz_float) : 'custom';

    const cents = TUNING_OBJ.centsFromIsoReference;
    const badge = $('a4-cents');
    badge.textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(1)} ¢`;
    badge.className = `badge ${Math.abs(cents) < 0.1 ? '' : 'badge--violet'}`;

    syncOscillatorPanel();
    app.log(`Concert pitch → A4 = ${a4} Hz (${cents >= 0 ? '+' : ''}${cents.toFixed(1)} cents from ISO).`, 'ok');
  });

  // --- sample rate / Nyquist ceiling ------------------------------------
  const rateSel = $('sample-rate');
  const actual = app.engine.sampleRateHertz;
  const known = SAMPLE_RATE_OPTIONS_LIST.some((r) => r.rate_hertz_int === actual);

  rateSel.innerHTML =
    SAMPLE_RATE_OPTIONS_LIST.map((r) => `<option value="${r.rate_hertz_int}" title="${r.note_str}">${r.label_str}</option>`).join('') +
    (known ? '' : `<option value="${actual}">${(actual / 1000).toFixed(1)} kHz</option>`);
  rateSel.value = String(actual);
  updateNyquistBadge();

  rateSel.addEventListener('change', async () => {
    const wanted = Number(rateSel.value);
    if (wanted === app.engine.sampleRateHertz) return;

    const ok = await confirmDialog({
      title: `Switch to ${(wanted / 1000).toFixed(1)} kHz?`,
      body:
        'An AudioContext’s sample rate is fixed once it is created, so SonicForge has to reload ' +
        `to change it.<br><br>At ${(wanted / 1000).toFixed(1)} kHz the highest synthesisable frequency ` +
        `becomes <b>${(wanted / 2000).toFixed(1)} kHz</b>. Your channels and calibration curve are preserved.` +
        (wanted >= 96000
          ? '<br><br>Note that most speakers produce nothing above ~22 kHz regardless of sample rate — ' +
            'ultrasonic output needs a piezo tweeter.'
          : ''),
      confirm: 'Reload',
    });

    if (!ok) { rateSel.value = String(app.engine.sampleRateHertz); return; }
    persist();
    try { localStorage.setItem('sonicforge.rate', String(wanted)); } catch {}
    location.reload();
  });

  app.engine.on('warn', (m) => toast(m, 'warn', 6000));

  $('limiter').addEventListener('change', (e) => {
    app.engine.isLimiterEnabled = e.target.checked;
    if (!e.target.checked) {
      toast('Limiter bypassed — the output path is now provably linear, and clipping is possible.', 'warn', 6000);
    }
  });
}

function updateNyquistBadge() {
  const badge = $('nyquist-badge');
  const nyq = app.engine.nyquistHertz;
  badge.textContent = `${(nyq / 1000).toFixed(1)} kHz`;
  badge.title = `Nyquist limit — the highest frequency this context can represent is ${nyq.toFixed(0)} Hz`;
  badge.className = `badge ${nyq > 24000 ? 'badge--violet' : ''}`;
}

function syncVisualiserHint() {
  const hint = $('viz-empty');
  if (!hint) {
    return;
  }
  // Driven by state changes rather than only by the frame loop, so the hint
  // never lingers over a live waveform waiting for the next slow tick.
  const isSilent = app.rack.activeChannelCount === 0 &&
    !app.noise.is_running_bool;
  hint.style.opacity = isSilent ? '1' : '0';
}

function syncHeader() {
  const live = app.rack.activeChannelCount > 0 || app.noise.is_running_bool || app.vm.running;
  syncVisualiserHint();
  const play = $('master-play');
  play.classList.toggle('is-playing', live);
  play.setAttribute('aria-pressed', String(live));
  $('master-play-label').textContent = live ? 'Stop' : 'Play';
  $('chan-count').textContent = `${app.rack.activeChannelCount} / ${CHANNEL_COUNT_INT} live`;
}

function panic() {
  app.vm.stop();
  app.rack.stopAllChannels();
  app.noise.stop();
  app.engine.panic();
  // Restore the master gain a beat later so the app is usable again.
  setTimeout(() => { app.engine.masterLevelDb = app.engine.masterLevelDb; }, 120);
  syncHeader();
  toast('Panic — everything silenced.', 'warn', 2200);
  app.log('PANIC: all sources stopped.', 'warn');
}

/* ------------------------------------------------------------ oscillator */

function buildOscillator() {
  // --- waveform segmented control -----------------------------------
  const seg = $('wave-seg');
  seg.innerHTML = WAVEFORM_KEYS_LIST
    .map((k) => `<button data-wave="${k}" title="${WAVEFORMS_DICT[k].hint_str}">${WAVEFORMS_DICT[k].glyph_str} ${WAVEFORMS_DICT[k].label_str}</button>`)
    .join('');
  seg.addEventListener('click', (e) => {
    const w = e.target.closest('[data-wave]')?.dataset.wave;
    if (w) { app.selectedChannel?.setWaveformName(w); syncOscillatorPanel(); }
  });

  // --- dial -----------------------------------------------------------
  app.ui.dial = new FrequencyDial($('dial'), {
    tuning_obj: TUNING_OBJ,
    maxHz: app.engine.maxFrequencyHertz,
    onChange: (hz) => {
      app.selectedChannel?.setFrequencyHertz(hz);
      syncOscillatorPanel();
    },
  });

  // --- numeric frequency entry -----------------------------------------
  const freqInput = $('freq-input');
  const commitFreq = () => {
    const raw = freqInput.value.trim().toLowerCase();
    let hz = NaN;

    // Accept a note name as well as a number: typing "A4" is faster than 440.
    const asNote = TUNING_OBJ.resolveNoteNameToHertz(raw.toUpperCase());
    if (Number.isFinite(asNote)) hz = asNote;
    else if (/k$/.test(raw)) hz = parseFloat(raw) * 1000;
    else hz = parseFloat(raw);

    if (!Number.isFinite(hz) || hz <= 0) {
      freqInput.classList.add('is-invalid');
      setTimeout(() => freqInput.classList.remove('is-invalid'), 700);
      syncOscillatorPanel();
      return;
    }
    const ch = app.selectedChannel;
    ch?.setFrequencyHertz(clampToRange(hz, 0.05, app.engine.maxFrequencyHertz));
    app.ui.dial.set(ch.frequency_hertz_float, { silent: true });
    syncOscillatorPanel();
  };
  freqInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commitFreq(); freqInput.blur(); }
    else if (e.key === 'Escape') { syncOscillatorPanel(); freqInput.blur(); }
  });
  freqInput.addEventListener('blur', commitFreq);
  freqInput.addEventListener('focus', () => freqInput.select());

  // --- transpose buttons -------------------------------------------------
  for (const btn of document.querySelectorAll('[data-freq-step]')) {
    btn.addEventListener('click', () => {
      const ch = app.selectedChannel;
      if (!ch) return;
      ch.setFrequencyHertz(TUNING_OBJ.transposeBySemitones(ch.frequency_hertz_float, Number(btn.dataset.freqStep)));
      app.ui.dial.set(ch.frequency_hertz_float, { silent: true });
      syncOscillatorPanel();
    });
  }

  $('btn-snap').addEventListener('click', () => {
    const ch = app.selectedChannel;
    if (!ch) return;
    ch.setFrequencyHertz(TUNING_OBJ.snapToNearestSemitone(ch.frequency_hertz_float));
    app.ui.dial.set(ch.frequency_hertz_float, { silent: true });
    syncOscillatorPanel();
  });

  $('btn-add-tone').addEventListener('click', () => {
    const free = app.rack.findFirstIdleChannel();
    if (!free) return toast('All 16 channels are already running.', 'warn');
    const src = app.selectedChannel;
    free.setWaveformName(src?.waveform ?? 'sine');
    free.setFrequencyHertz(src ? src.frequency_hertz_float * 1.5 : 440); // a perfect fifth above
    free.setGainDb(-18);
    free.start();
    app.ui.channels.select(free.index_int);
    syncHeader();
  });

  // --- per-channel level / pan / phase ---------------------------------
  const chGain = $('ch-gain');
  chGain.addEventListener('input', () => {
    app.selectedChannel?.setGainDb(Number(chGain.value));
    $('ch-gain-val').textContent = formatDb(Number(chGain.value));
    paintRange(chGain);
  });

  const chPan = $('ch-pan');
  chPan.addEventListener('input', () => {
    const v = Number(chPan.value);
    app.selectedChannel?.setPanPosition(v);
    $('ch-pan-val').textContent = panLabel(v);
    paintBipolar(chPan);
  });
  chPan.addEventListener('dblclick', () => {
    chPan.value = '0';
    chPan.dispatchEvent(new Event('input'));
  });

  const chPhase = $('ch-phase');
  chPhase.addEventListener('input', () => {
    const v = Number(chPhase.value);
    app.selectedChannel?.setPhaseDegrees(v);
    $('ch-phase-val').textContent = `${v}°`;
    paintRange(chPhase);
  });
}

function panLabel(v) {
  if (Math.abs(v) < 0.005) return 'C';
  const pct = Math.round(Math.abs(v) * 100);
  return `${v < 0 ? 'L' : 'R'}${pct}`;
}

function syncOscillatorPanel() {
  const ch = app.selectedChannel;
  if (!ch) return;

  $('freq-input').value =
    ch.frequency_hertz_float >= 1000 ? ch.frequency_hertz_float.toFixed(1) : ch.frequency_hertz_float >= 100 ? ch.frequency_hertz_float.toFixed(2) : ch.frequency_hertz_float.toFixed(3);

  const d = TUNING_OBJ.describeFrequency(ch.frequency_hertz_float);
  $('dial-note').textContent = d.label_str;
  const cents = Math.round(d.cents_float);
  const centsEl = $('dial-cents');
  centsEl.textContent = `${cents > 0 ? '+' : ''}${cents} ¢`;
  centsEl.className = `dial__cents ${cents > 3 ? 'is-sharp' : cents < -3 ? 'is-flat' : ''}`;

  $('dial-ch').textContent = `CH ${String(ch.index_int + 1).padStart(2, '0')}`;

  // Tell the user plainly when they have left the audible band — otherwise
  // "I hear nothing" gets misread as a broken app rather than physics.
  const band = ch.frequency_hertz_float < 20 ? 'infrasonic' : ch.frequency_hertz_float > 20000 ? 'ultrasonic' : null;
  const target = $('osc-target');
  target.textContent = `Channel ${String(ch.index_int + 1).padStart(2, '0')}${band ? ` · ${band}` : ''}`;
  target.className = `badge ${band ? 'badge--violet' : 'badge--cyan'}`;
  target.title = band === 'infrasonic'
    ? 'Below the hearing threshold. Most speakers cannot reproduce this at all — use am() to deliver the envelope on an audible carrier.'
    : band === 'ultrasonic'
      ? 'Above the hearing threshold. Needs a piezo tweeter; ordinary drivers roll off by ~22 kHz.'
      : '';

  for (const b of $('wave-seg').querySelectorAll('[data-wave]')) {
    b.classList.toggle('is-active', b.dataset.wave === ch.waveform_name_str);
  }

  const chGain = $('ch-gain');
  chGain.value = String(ch.gain_db_float);
  $('ch-gain-val').textContent = formatDb(ch.gain_db_float);
  paintRange(chGain);

  const chPan = $('ch-pan');
  chPan.value = String(ch.pan_position_float);
  $('ch-pan-val').textContent = panLabel(ch.pan_position_float);
  paintBipolar(chPan);

  const chPhase = $('ch-phase');
  chPhase.value = String(ch.phase_degrees_int);
  $('ch-phase-val').textContent = `${ch.phase_degrees_int}°`;
  paintRange(chPhase);

  app.ui.dial?.set(ch.frequency_hertz_float, { silent: true });
}

/* -------------------------------------------------------------- channels */

function buildChannels() {
  app.ui.channels = new ChannelRackUI($('chan-list'), app.rack, TUNING_OBJ, {
    onSelect: () => syncOscillatorPanel(),
  });

  app.rack.on('change', () => {
    syncHeader();
    persistSoon();
  });

  $('chan-all-on').addEventListener('click', () => { app.rack.startAllChannels(); syncHeader(); });
  $('chan-all-off').addEventListener('click', () => { app.rack.stopAllChannels(); syncHeader(); });
  $('chan-reset').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Reset all channels?',
      body: 'Every channel returns to 440 Hz, sine, −18 dBFS, centred, 0°. This cannot be undone.',
      confirm: 'Reset',
      danger: true,
    });
    if (!ok) return;
    app.rack.resetAllChannels();
    app.ui.channels.syncAll();
    syncOscillatorPanel();
    syncHeader();
  });
}

/* ----------------------------------------------------------------- noise */

function buildNoiseBuffer() {
  const segA = $('noise-a');
  segA.innerHTML = NOISE_COLOUR_KEYS_LIST
    .map((k) => `<button data-color="${k}" title="${NOISE_COLOURS_DICT[k].hint_str}">${NOISE_COLOURS_DICT[k].label_str}</button>`)
    .join('');
  segA.addEventListener('click', async (e) => {
    const c = e.target.closest('[data-color]')?.dataset.color;
    if (!c) return;
    await app.noise.setColour(c, 'A');
    syncNoisePanel();
  });

  const selB = $('noise-b');
  selB.innerHTML = NOISE_COLOUR_KEYS_LIST.map((k) => `<option value="${k}">${NOISE_COLOURS_DICT[k].label_str}</option>`).join('');
  selB.addEventListener('change', async () => {
    await app.noise.setColour(selB.value, 'B');
    syncNoisePanel();
  });

  const shape = $('noise-shape');
  shape.innerHTML = Object.entries(SHAPE_FILTER_LABELS_DICT)
    .map(([k, label]) => `<option value="${k}">${label}</option>`)
    .join('');
  shape.addEventListener('change', () => {
    app.noise.setShapeFilter({ type: shape.value });
    syncNoisePanel();
  });

  $('noise-freq').addEventListener('change', (e) => {
    app.noise.setShapeFilter({ freq: parseFloat(e.target.value) || 1000 });
    syncNoisePanel();
  });

  const blend = $('noise-blend');
  blend.addEventListener('input', async () => {
    await app.noise.setBlendRatio(Number(blend.value));
    paintRange(blend);
    syncNoisePanel();
  });

  const gain = $('noise-gain');
  gain.addEventListener('input', () => {
    app.noise.setGainDb(Number(gain.value));
    $('noise-gain-val').textContent = formatDb(Number(gain.value), 0);
    paintRange(gain);
  });

  const shield = $('noise-shield');
  shield.addEventListener('input', () => {
    app.noise.setShieldDb(Number(shield.value));
    $('noise-shield-val').textContent = Number(shield.value).toFixed(1);
    paintRange(shield);
  });

  const toggle = $('noise-toggle');
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    toggle.innerHTML = '<span class="spinner"></span>';
    try {
      await app.noise.toggle();
    } catch (err) {
      toast(`Noise failed: ${err.message}`, 'err');
    } finally {
      toggle.disabled = false;
      syncNoisePanel();
      syncHeader();
    }
  });

  app.noise.on('change', () => { syncNoisePanel(); persistSoon(); });
  app.noise.on('building', (c) => app.log(`Synthesising ${NOISE_COLOURS_DICT[c].label_str} noise buffer…`, 'dim'));

  syncNoisePanel();
}

function syncNoisePanel() {
  const n = app.noise;

  for (const b of $('noise-a').querySelectorAll('[data-color]')) {
    b.classList.toggle('is-active', b.dataset.color === n.primary_colour_str);
  }
  $('noise-b').value = n.secondary_colour_str;

  const blend = $('noise-blend');
  blend.value = String(n.blend_ratio_float);
  paintRange(blend);

  const gain = $('noise-gain');
  gain.value = String(n.gain_db_float);
  $('noise-gain-val').textContent = formatDb(n.gain_db_float, 0);
  paintRange(gain);

  const shield = $('noise-shield');
  shield.value = String(n.shield_db_float);
  $('noise-shield-val').textContent = n.shield_db_float.toFixed(1);
  paintRange(shield);

  $('noise-shape').value = n.shape_type_str;
  $('noise-freq').value = String(Math.round(n.shape_frequency_hertz_float));
  $('noise-freq').disabled = n.shape_type_str === 'off';

  const state = $('noise-state');
  state.textContent = n.is_running_bool ? 'running' : 'idle';
  state.className = `badge ${n.is_running_bool ? 'badge--lime' : ''}`;
  $('noise-toggle').textContent = n.is_running_bool ? 'Stop' : 'Start';

  const spec = NOISE_COLOURS_DICT[n.primary_colour_str];
  const mix = n.blend_ratio_float > 0.01
    ? ` · blended ${Math.round((1 - n.blend_ratio_float) * 100)}/${Math.round(n.blend_ratio_float * 100)} with ${NOISE_COLOURS_DICT[n.secondary_colour_str].label_str}`
    : '';
  const slope = spec.slope_db_per_octave_float === null ? 'shaped spectrum' : `${spec.slope_db_per_octave_float > 0 ? '+' : ''}${spec.slope_db_per_octave_float} dB/octave`;
  $('noise-hint').textContent = `${spec.hint_str} (${slope})${mix}`;
}

/* ------------------------------------------------------------------- viz */

let vizMode = 'waterfall';

function buildViz() {
  app.ui.waterfall = new Waterfall($('viz-waterfall'), app.engine);
  app.ui.interference = new InterferenceView($('viz-interference'), app.engine, app.rack);

  $('viz-badge').textContent = app.ui.waterfall.mode === 'webgl' ? 'WebGL2' : 'Canvas2D';
  if (app.ui.waterfall.mode !== 'webgl') {
    app.log('WebGL2 is unavailable — the visualiser is running its Canvas2D fallback.', 'warn');
  }

  $('viz-tabs').addEventListener('click', (e) => {
    const mode = e.target.closest('[data-viz]')?.dataset.viz;
    if (mode) setVizMode(mode);
  });

  setVizMode('waterfall');
}

function setVizMode(mode) {
  vizMode = mode;
  const wf = app.ui.waterfall;
  const iv = app.ui.interference;

  const showWaterfall = mode === 'waterfall';
  $('viz-waterfall').hidden = !showWaterfall;
  $('viz-interference').hidden = showWaterfall;

  if (showWaterfall) { iv.stop(); wf.start(); }
  else {
    wf.stop();
    iv.setMode(mode === 'gonio' ? 'gonio' : 'both').start();
  }

  for (const b of $('viz-tabs').querySelectorAll('[data-viz]')) {
    b.classList.toggle('is-active', b.dataset.viz === mode);
  }

  $('viz-empty').textContent = showWaterfall
    ? 'Drag to orbit · scroll to zoom'
    : mode === 'gonio'
      ? 'Vertical = mono · horizontal = out of phase'
      : 'Cyan = left sum · violet = right sum · red dots = nulls';
  syncVisualiserHint();
  $('viz-badge').textContent = showWaterfall
    ? (wf.mode === 'webgl' ? 'WebGL2' : 'Canvas2D')
    : mode === 'gonio' ? 'Goniometer' : 'Interference';
}

/* -------------------------------------------------------------- terminal */

function buildTerminal() {
  app.ui.terminal = new Terminal(document.querySelector('[data-term="root"]'), app.vm);

  $('term-clear').addEventListener('click', () => app.ui.terminal.clear());
  $('term-stop').addEventListener('click', () => { app.vm.stop(); syncHeader(); });
  $('term-multiline').addEventListener('click', (e) => {
    const on = !app.ui.terminal.multiline;
    app.ui.terminal.setMultiline(on);
    e.target.classList.toggle('is-active', on);
  });

  app.vm.on('start', syncHeader);
  app.vm.on('finish', syncHeader);
  app.vm.on('stop', syncHeader);
}

/* --------------------------------------------------------------- presets */

function buildPresets() {
  const list = $('preset-list');
  const frag = document.createDocumentFragment();

  for (const group of GROUPS) {
    const section = document.createElement('div');
    section.className = 'preset-group';

    const title = document.createElement('div');
    title.className = 'preset-group__title';
    title.textContent = group.label;
    section.appendChild(title);

    for (const preset of PRESETS.filter((p) => p.group === group.id)) {
      const btn = document.createElement('button');
      btn.className = `preset preset--${preset.tone ?? 'cyan'}`;
      btn.dataset.preset = preset.id;
      btn.innerHTML = `
        <span class="preset__glyph">${icon(preset.icon, { size: 13 })}</span>
        <span class="preset__text">
          <span class="preset__name"></span>
          <span class="preset__desc"></span>
        </span>`;
      btn.querySelector('.preset__name').textContent = preset.name;
      btn.querySelector('.preset__desc').textContent = preset.desc;
      btn.addEventListener('click', () => launchPreset(preset, btn));
      section.appendChild(btn);
    }
    frag.appendChild(section);
  }

  list.appendChild(frag);

  $('preset-stop').addEventListener('click', () => {
    app.vm.stop();
    app.rack.stopAllChannels();
    app.noise.stop();
    for (const b of list.querySelectorAll('.preset')) b.classList.remove('is-running');
    syncHeader();
  });
}

async function launchPreset(preset, btn) {
  // Safety interlock: presets that drive hardware hard must be acknowledged,
  // and the master level is capped for the duration.
  if (preset.safety) {
    const ok = await confirmDialog({
      title: preset.safety.title,
      body: preset.safety.body,
      confirm: preset.safety.confirm,
      danger: true,
    });
    if (!ok) return;

    if (Number.isFinite(preset.safety.capDb) && app.engine.masterLevelDb > preset.safety.capDb) {
      app.engine.masterLevelDb = preset.safety.capDb;
      $('master-gain').value = String(preset.safety.capDb);
      $('master-db').textContent = `${formatDb(preset.safety.capDb)} dB`;
      paintRange($('master-gain'));
      app.log(`Master capped at ${formatDb(preset.safety.capDb)} dBFS for this routine.`, 'warn');
    }
  }

  for (const b of $('preset-list').querySelectorAll('.preset')) b.classList.remove('is-running');
  btn.classList.add('is-running');

  try {
    await runPreset(app, preset);
    app.log(`Preset: ${preset.name}`, 'ok');
  } catch (err) {
    toast(`Preset failed: ${err.message}`, 'err');
    btn.classList.remove('is-running');
  }
  app.syncUi();
  syncHeader();

  const clear = () => btn.classList.remove('is-running');
  app.vm.once('finish', clear);
  app.vm.once('stop', clear);
}

/* ------------------------------------------------------------- DTMF pad */

function openDtmfPad() {
  if (document.getElementById('dtmf-pad-host')) return;

  const host = document.createElement('div');
  host.id = 'dtmf-pad-host';
  host.className = 'panel';
  host.style.cssText = 'position:fixed;right:16px;bottom:52px;z-index:120;width:206px';
  host.innerHTML = `
    <div class="panel__head">
      <span class="panel__title">DTMF Keypad</span>
      <span class="panel__spacer"></span>
      <button class="iconbtn" data-close aria-label="Close">${icon('x', { size: 13 })}</button>
    </div>
    <div class="panel__body panel__body--tight">
      <div class="dtmf-pad">
        ${['1', '2', '3', 'A', '4', '5', '6', 'B', '7', '8', '9', 'C', '*', '0', '#', 'D']
          .map((d) => `<button data-digit="${d}">${d}</button>`).join('')}
      </div>
    </div>`;

  host.querySelector('[data-close]').addEventListener('click', () => host.remove());
  host.addEventListener('click', (e) => {
    const d = e.target.closest('[data-digit]')?.dataset.digit;
    if (d) app.runScript(`dtmf("${d}", 160ms, 0ms, -14db)`, { label: 'dtmf-key' });
  });

  document.body.appendChild(host);
}

/* =========================================================================
   Frame loop — one rAF for every meter, readout and status field
   ========================================================================= */

function startFrameLoop() {
  const meterFill = $('meter-fill');
  const meterPeak = $('meter-peak');
  const meterVal = $('meter-val');
  const stEngine = $('st-engine');
  const dotEngine = $('dot-engine');
  const stVoices = $('st-voices');
  const stGr = $('st-gr');
  const stFps = $('st-fps');
  const vizHud = $('viz-hud');

  $('st-rate').textContent = `${(app.engine.sampleRateHertz / 1000).toFixed(1)} kHz`;
  $('st-latency').textContent = `${app.engine.latencyMs.toFixed(1)} ms`;

  let peakHold = -Infinity;
  let peakHoldAt = 0;
  let slowTick = 0;

  const frame = (now) => {
    const levels_obj = app.engine.meter.readLevels();

    const t = Number.isFinite(levels_obj.peak_db_float) ? clampToRange((levels_obj.peak_db_float + 60) / 60, 0, 1) : 0;
    meterFill.style.right = `${(1 - t) * 100}%`;

    if (levels_obj.peak_db_float > peakHold || now - peakHoldAt > 1400) {
      peakHold = levels_obj.peak_db_float;
      peakHoldAt = now;
    }
    const ph = Number.isFinite(peakHold) ? clampToRange((peakHold + 60) / 60, 0, 1) : 0;
    meterPeak.style.left = `${ph * 100}%`;

    meterVal.textContent = Number.isFinite(levels_obj.peak_db_float) ? `${levels_obj.peak_db_float.toFixed(1)}` : '-∞';
    meterVal.classList.toggle('is-clip', levels_obj.is_clipping_bool);

    // Per-channel meters and the slower status fields do not need 60 Hz.
    if (++slowTick % 3 === 0) {
      app.ui.channels.updateMeters();

      const state = app.engine.state;
      stEngine.textContent = state;
      dotEngine.className = `status-dot ${state === 'running' ? 'status-dot--live' : state === 'suspended' ? 'status-dot--warn' : 'status-dot--err'}`;

      stVoices.textContent = String(app.rack.activeChannelCount + (app.noise.is_running_bool ? 1 : 0));
      const gr = app.engine.gainReductionDb;
      stGr.textContent = `${gr.toFixed(1)} dB`;
      stGr.style.color = gr < -0.5 ? 'var(--amber)' : '';

      const fps = vizMode === 'waterfall' ? app.ui.waterfall.fps : 60;
      stFps.textContent = String(Math.round(fps));

      // Visualiser HUD
      if (vizMode === 'waterfall') {
        const audible = app.rack.audibleChannels;
        vizHud.innerHTML = audible.length
          ? `<span>VOICES <b>${audible.length}</b></span><span>PEAK <b>${Number.isFinite(levels_obj.peak_db_float) ? levels_obj.peak_db_float.toFixed(1) : '-inf'} dB</b></span><span>20 Hz → 20 kHz</span>`
          : '<span>20 Hz → 20 kHz log</span>';
      } else {
        const s = app.ui.interference.stats;
        vizHud.innerHTML = `<span>VOICES <b>${s.voices}</b></span>` +
          (s.beatHz > 0 ? `<span>BEAT <b>${s.beatHz.toFixed(2)} Hz</b></span>` : '') +
          (s.voices > 1 ? `<span>SUM <b>${(s.cancellation * 100).toFixed(0)}%</b></span>` : '');
      }

      syncVisualiserHint();
    }

    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/* =========================================================================
   Keyboard
   ========================================================================= */

function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);

    // Escape always panics, even from inside a field.
    if (e.key === 'Escape' && !typing) { e.preventDefault(); panic(); return; }
    if (typing) return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        $('master-play').click();
        break;

      case '/':
        e.preventDefault();
        app.ui.terminal.input.focus();
        break;

      case 'm':
        app.selectedChannel?.setMuted(!app.selectedChannel.is_muted_bool);
        break;

      case 's':
        app.selectedChannel?.setSoloed(!app.selectedChannel.is_soloed_bool);
        break;

      case 'n':
        $('noise-toggle').click();
        break;

      case 'v':
        setVizMode(vizMode === 'waterfall' ? 'interference' : vizMode === 'interference' ? 'gonio' : 'waterfall');
        break;

      case 'ArrowUp':
      case 'ArrowDown': {
        e.preventDefault();
        const dir = e.key === 'ArrowUp' ? -1 : 1;
        app.ui.channels.select(
          (app.ui.channels.selected + dir + CHANNEL_COUNT_INT) % CHANNEL_COUNT_INT
        );
        break;
      }

      default:
        // 1–9 toggle the corresponding channel.
        if (/^[1-9]$/.test(e.key)) {
          const ch = app.rack.getChannel(Number(e.key) - 1);
          ch?.toggle();
          app.ui.channels.select(ch.index_int);
          syncHeader();
        }
    }
  });
}

function bindRailToggle() {
  const toggle = $('rail-toggle');
  const rail = $('rail-left');
  toggle.addEventListener('click', () => rail.classList.toggle('is-open'));
  rail.addEventListener('click', (e) => {
    if (e.target.closest('.preset')) rail.classList.remove('is-open');
  });
}

function showHelp() {
  confirmDialog({
    title: 'SonicForge',
    body: `
      <p style="margin-bottom:12px">Sixteen independent tone channels, seven noise colours, microphone room
      calibration, a scripting terminal and a WebGL spectrogram. Everything runs locally.</p>
      <table style="width:100%;font-size:11.5px;border-collapse:collapse">
        <tr><td style="padding:3px 0"><span class="kbd">Space</span></td><td>Play / stop everything</td></tr>
        <tr><td style="padding:3px 0"><span class="kbd">Esc</span></td><td>Panic — immediate silence</td></tr>
        <tr><td style="padding:3px 0"><span class="kbd">/</span></td><td>Focus the script terminal</td></tr>
        <tr><td style="padding:3px 0"><span class="kbd">1</span>–<span class="kbd">9</span></td><td>Toggle that channel</td></tr>
        <tr><td style="padding:3px 0"><span class="kbd">↑</span><span class="kbd">↓</span></td><td>Select previous / next channel</td></tr>
        <tr><td style="padding:3px 0"><span class="kbd">M</span> <span class="kbd">S</span></td><td>Mute / solo the selected channel</td></tr>
        <tr><td style="padding:3px 0"><span class="kbd">N</span></td><td>Toggle the noise generator</td></tr>
        <tr><td style="padding:3px 0"><span class="kbd">V</span></td><td>Cycle the visualiser</td></tr>
      </table>
      <p style="margin-top:12px;opacity:.75">On the dial: <b>Shift</b> for fine, <b>Alt</b> for coarse,
      <b>Ctrl</b> to snap to semitones. In the terminal, <b>Tab</b> completes and <b>↑</b> recalls history.</p>`,
    confirm: 'Close',
    cancel: 'Dismiss',
  });
}

/* =========================================================================
   Session persistence
   ========================================================================= */

let persistTimer = null;

function persistSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 600);
}

function persist() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      v: 1,
      a4: TUNING_OBJ.referenceHertz,
      masterDb: app.engine.masterLevelDb,
      channels: app.rack.toJSON(),
      noise: app.noise.toJSON(),
      viz: vizMode,
    }));
  } catch {}
}

function restoreSession() {
  let data = null;
  try {
    data = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
  } catch {}

  if (!data || data.v !== 1) {
    // First run: a sensible starting point rather than sixteen silent rows.
    const ch = app.rack.getChannel(0);
    ch.setFrequencyHertz(440);
    ch.setGainDb(-18);
    app.syncUi();
    syncHeader();
    return;
  }

  if (Number.isFinite(data.a4)) TUNING_OBJ.referenceHertz = data.a4;
  if (Number.isFinite(data.masterDb)) {
    app.engine.masterLevelDb = data.masterDb;
    $('master-gain').value = String(data.masterDb);
    $('master-db').textContent = `${formatDb(data.masterDb)} dB`;
    paintRange($('master-gain'));
  }

  // Channels are restored in a stopped state deliberately: nobody wants a
  // page reload to start playing a 12 kHz tone at whatever the volume is now.
  if (Array.isArray(data.channels)) {
    app.rack.fromJSON(data.channels.map((c) => ({ ...c, enabled: false })));
  }
  if (data.noise) app.noise.fromJSON({ ...data.noise, running: false });
  if (data.viz) setVizMode(data.viz);

  app.syncUi();
  syncHeader();
  app.log('Previous session restored (sources left stopped).', 'dim');
}

// Offline support. Skipped on localhost so the dev server is never shadowed
// by a cache-first worker.
registerServiceWorker(() => {
  toast('A new version of SonicForge is ready — reload to update.', 'ok', 0);
});

window.addEventListener('beforeunload', persist);
window.addEventListener('pagehide', persist);

// Chrome suspends an AudioContext that loses its gesture on some platforms.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && app.engine.is_ready_bool && app.engine.state === 'suspended') {
    app.engine.resume();
  }
});

export { app };
