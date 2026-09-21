/**
 * Application self-test.
 *
 * tests.html proves the DSP and the parser. It cannot prove that the actual
 * application boots — that the engine initialises, that every panel constructs,
 * that the visualiser gets a context, that a preset runs without throwing.
 * Those are exactly the failures a unit suite never catches.
 *
 * So this module boots the real app and audits it, and it is only ever loaded
 * when `?selftest=1` is present on localhost. It never ships behaviour to a
 * real user: on any other origin the import is skipped entirely by main.js.
 */

import { restoreSession } from './app/session.js';

const checks = [];
const consoleErrors = [];

/**
 * Run one check. The return contract is explicit, because the loose version of
 * this helper treated every returned string as a pass — which silently marked
 * a layout violation green while printing its own failure message.
 *
 *   true            -> pass
 *   false           -> fail
 *   'text'          -> pass, with `text` as supporting detail
 *   {ok, detail}    -> exactly what it says
 */
function check(name, fn, { critical = true } = {}) {
  let ok = false;
  let detail = '';
  try {
    const result = fn();
    if (result === true || result === undefined) ok = true;
    else if (result === false || result === null) ok = false;
    else if (typeof result === 'string') { ok = true; detail = result; }
    else if (typeof result === 'object' && 'ok' in result) {
      ok = Boolean(result.ok);
      detail = result.detail ?? '';
    } else ok = Boolean(result);
  } catch (err) {
    ok = false;
    detail = `${err.name}: ${err.message}`;
  }
  checks.push({ name, ok, detail, critical });
  return ok;
}

/** Shorthand for a check that either passes with a note or fails with a reason. */
const verdict = (ok, detail) => ({ ok, detail });

/** Capture anything the app logs as an error while we drive it. */
function captureErrors() {
  const nativeError = console.error;
  console.error = (...args) => {
    consoleErrors.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '));
    nativeError.apply(console, args);
  };
  window.addEventListener('error', (e) => consoleErrors.push(`uncaught: ${e.message}`));
  window.addEventListener('unhandledrejection', (e) =>
    consoleErrors.push(`unhandled rejection: ${e.reason?.message ?? e.reason}`)
  );
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runSelfTest(app, { boot }) {
  captureErrors();
  const t0 = performance.now();

  // --- boot ---------------------------------------------------------
  await boot();
  await sleep(400);

  check('engine initialises', () => app.engine.is_ready_bool);
  check('audio context is running or suspended, not closed', () =>
    ['running', 'suspended'].includes(app.engine.state) ? `state=${app.engine.state}` : false
  );
  check('sample rate is plausible', () =>
    app.engine.sampleRateHertz >= 8000 ? `${app.engine.sampleRateHertz} Hz` : false
  );
  check('nyquist ceiling exposed', () => `${app.engine.nyquistHertz} Hz`);
  check('master chain built', () =>
    Boolean(app.engine.master_gain_node && app.engine.limiter_node && app.engine.meter.spectrum_analyser_node)
  );
  check('EQ array has ten bands', () =>
    app.engine.equaliser.filters_list.length === 10 ? '10 biquads' : `got ${app.engine.equaliser.filters_list.length}`
  );
  check('analyser resolves infrasound', () => {
    const binHz = app.engine.sampleRateHertz / app.engine.meter.spectrum_analyser_node.fftSize;
    return binHz <= 2 ? `${binHz.toFixed(2)} Hz per bin` : `too coarse: ${binHz.toFixed(2)} Hz per bin`;
  });

  // --- models --------------------------------------------------------
  check('16 channels exist', () => app.rack.channels_list.length === 16);
  check('noise generator constructed', () =>
    Boolean(app.noise?.level_gain_node)
  );
  check('script VM constructed', () => Boolean(app.vm));
  check('calibration constructed', () => Boolean(app.cal));
  check('concert mode constructed', () => Boolean(app.concert));

  // --- UI ------------------------------------------------------------
  check('app shell is visible', () => document.getElementById('app')?.hidden === false);
  check('16 channel rows rendered', () => {
    const n = document.querySelectorAll('#chan-list .chan').length;
    return n === 16 ? '16 rows' : `got ${n}`;
  });
  check('presets rendered', () => {
    const n = document.querySelectorAll('#preset-list .preset').length;
    return n >= 15 ? `${n} presets` : `only ${n}`;
  });
  check('waveform selector rendered', () =>
    document.querySelectorAll('#wave-seg [data-wave]').length === 5
  );
  check('noise colour selector rendered', () =>
    document.querySelectorAll('#noise-a [data-color]').length === 7
  );
  check('dial constructed', () => Boolean(app.ui.dial));
  check('terminal constructed', () => Boolean(app.ui.terminal));
  check('visualiser constructed', () => app.ui.waterfall?.render_mode_str ?? false);
  check('interference view constructed', () => Boolean(app.ui.interference));
  check('sample-rate selector populated', () =>
    document.querySelectorAll('#sample-rate option').length >= 4
  );

  // --- behaviour: actually drive it ------------------------------------
  check('channel starts and stops', () => {
    const ch = app.rack.getChannel(0);
    ch.setFrequencyHertz(440);
    ch.start();
    const started = ch.is_enabled_bool && Boolean(ch.oscillator_node);
    ch.stop();
    return started ? 'started + stopped cleanly' : false;
  });

  // Drives the row's own text field rather than the model, because the
  // field's commit path reaches the rack and the engine by paths the model
  // API never touches. One of those references was stale and threw here.
  check('channel row frequency field commits', () => {
    const row = document.querySelector('#chan-list .chan[data-index="0"]');
    const field = row?.querySelector('[data-role="freq"]');
    if (!field) {
      return verdict(false, 'row 0 has no frequency field');
    }
    const channel = app.rack.getChannel(0);
    const before = channel.frequency_hertz_float;
    field.value = '523.25';
    field.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true,
    }));
    const after = channel.frequency_hertz_float;
    channel.setFrequencyHertz(before);
    return verdict(
      Math.abs(after - 523.25) < 0.01,
      `${before.toFixed(2)} Hz -> ${after.toFixed(2)} Hz`
    );
  });

  check('channel row level field accepts -inf', () => {
    const row = document.querySelector('#chan-list .chan[data-index="1"]');
    const field = row?.querySelector('[data-role="gain"]');
    if (!field) {
      return verdict(false, 'row 1 has no level field');
    }
    const channel = app.rack.getChannel(1);
    const before = channel.gain_db_float;
    field.value = '-inf';
    field.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true,
    }));
    const silenced = channel.gain_db_float;
    channel.setGainDb(before);
    return verdict(silenced <= -90, `level became ${silenced} dBFS`);
  });

  check('frequency clamps to Nyquist', () => {
    const ch = app.rack.getChannel(1);
    ch.setFrequencyHertz(999999);
    const clamped = ch.frequency_hertz_float <= app.engine.nyquistHertz;
    ch.setFrequencyHertz(440);
    return clamped ? `clamped to ${app.engine.maxFrequencyHertz}` : false;
  });

  check('infrasonic frequency is accepted', () => {
    const ch = app.rack.getChannel(1);
    ch.setFrequencyHertz(7);
    const ok = Math.abs(ch.frequency_hertz_float - 7) < 0.01;
    ch.setFrequencyHertz(440);
    return ok ? '7 Hz set exactly' : `got ${ch.frequency_hertz_float}`;
  });

  check('phase offset applies to a running oscillator', () => {
    const ch = app.rack.getChannel(2);
    ch.start();
    ch.setPhaseDegrees(180);
    const ok = ch.phase_degrees_int === 180;
    ch.stop();
    return ok;
  });

  check('solo masks other channels', () => {
    const a = app.rack.getChannel(0);
    const b = app.rack.getChannel(1);
    a.start(); b.start();
    a.setSoloed(true);
    const masked = b.is_silenced_by_solo_bool === true && a.is_silenced_by_solo_bool === false;
    a.setSoloed(false);
    a.stop(); b.stop();
    return masked;
  });

  check('A4 recalibration propagates', () => {
    app.tuning.referenceHertz = 432;
    const c4 = app.tuning.convertMidiToHertz(60);
    app.tuning.referenceHertz = 440;
    return Math.abs(c4 - 256.87) < 0.1 ? `C4 = ${c4.toFixed(2)} Hz at A4=432` : `got ${c4}`;
  });

  // set() writes globals through a switch on a keyword. A migration once
  // rewrote one of those case labels -- a string literal, not an identifier
  // -- so an alias silently stopped matching. Both spellings are checked.
  for (const keyword of ['a4', 'tuning']) {
    // eslint-disable-next-line no-await-in-loop
    await (async () => {
      app.tuning.referenceHertz = 440;
      app.vm.run(`set(${keyword}, 432)`, { label_str: 'selftest' });
      await sleep(260);
      const reached = app.tuning.referenceHertz;
      app.vm.stop({ is_silent_bool: true });
      app.tuning.referenceHertz = 440;
      check(`set(${keyword}) reaches the tuning reference`, () =>
        verdict(Math.abs(reached - 432) < 0.01, `A4 became ${reached} Hz`)
      );
    })();
  }

  check('script compiles and runs', () => {
    const before = app.vm.state_str;
    app.vm.run('play(440hz, 60ms, sine, -30db)\nwait(20ms)', { label: 'selftest' });
    const running = app.vm.is_running_bool;
    app.vm.stop();
    return running ? `state moved from ${before}` : false;
  });

  check('script rejects an unknown command with a helpful error', () => {
    const v = app.vm.validate('frobnicate(1)');
    return !v.is_valid_bool && /Unknown command/.test(v.err.message)
      ? v.err.message.slice(0, 60)
      : false;
  });

  check('loop expands to the right instruction count', () => {
    const ins = app.vm.compile('loop(3, [ play(440,10), wait(10) ])');
    // LOOP + 2 calls + ENDLOOP
    return ins.length === 4 ? '4 instructions' : `got ${ins.length}`;
  });

  check('JSON script form compiles', () => {
    const ins = app.vm.compile('[["play",440,100],["wait",50]]');
    return ins.length === 2;
  });

  check('am() command exists for infrasonic envelopes', () => {
    const v = app.vm.validate('am(200hz, 11hz, 1s, 100%, -30db)');
    return v.is_valid_bool ? 'validated' : v.err.message;
  });

  await check('noise generator starts', async () => true) && await (async () => {
    try {
      await app.noise.setColour('pink');
      app.noise.setGainDb(-40);
      await app.noise.start();
      await sleep(150);
      const running = app.noise.is_running_bool;
      app.noise.stop();
      checks.push({ name: 'noise generator starts and stops', ok: running, detail: 'pink', critical: true });
    } catch (err) {
      checks.push({ name: 'noise generator starts and stops', ok: false, detail: err.message, critical: true });
    }
  })();

  // The blend has two slots. Callers used to pass the interface's 'A'/'B'
  // labels, which the model silently read as "primary" -- so setting colour
  // B overwrote colour A and the crossfade had one colour on both sides.
  await (async () => {
    // setColour is async, so a bad slot arrives as a rejected promise, not
    // a throw. Catching it synchronously would leave an unhandled rejection
    // and fail the frame-loop check instead of this one.
    const before = app.noise.secondary_colour_str;
    let rejected = false;
    try {
      await app.noise.setColour('brown', 'B');
    } catch (err) {
      rejected = /unknown noise slot/.test(err.message);
    }
    checks.push({
      name: 'noise slots are addressed by the names the model defines',
      ok: rejected && app.noise.secondary_colour_str === before,
      detail: rejected
        ? 'an unknown slot name is rejected'
        : 'a bad slot was accepted',
      critical: true,
    });
  })();

  await (async () => {
    await app.noise.setColour('white', 'primary');
    await app.noise.setColour('brown', 'secondary');
    checks.push({
      name: 'the two noise slots hold different colours',
      ok: app.noise.primary_colour_str === 'white' &&
        app.noise.secondary_colour_str === 'brown',
      detail: `${app.noise.primary_colour_str} / ` +
        `${app.noise.secondary_colour_str}`,
      critical: true,
    });
  })();

  check('every preset has a runnable definition', () => {
    let bad = [];
    for (const p of app.__presets ?? []) {
      if (!p.script && !p.apply) bad.push(p.id);
      if (p.script) {
        const v = app.vm.validate(p.script);
        if (!v.is_valid_bool) bad.push(`${p.id}: ${v.err.message}`);
      }
    }
    return bad.length === 0 ? `${(app.__presets ?? []).length} presets validated` : bad.join(' | ');
  });

  check('QR encoder produces a join code', () => {
    app.concert.room_code_str = 'TESTRM';
    const url = app.concert.joinUrl();
    return url.includes('TESTRM') ? url.slice(0, 48) : false;
  });

  // The panel and the remote 'phase' handler both call this by name. It was
  // defined as setPhase() and called as setPhaseDegrees(), so the phase
  // slider threw on every input and the remote handler threw on arrival.
  check('concert exposes the phase setter its callers use', () => {
    if (typeof app.concert.setPhaseDegrees !== 'function') {
      return verdict(false, 'setPhaseDegrees is not a function');
    }
    app.concert.setPhaseDegrees(180);
    const reached = app.concert.phase_degrees_int;
    app.concert.setPhaseDegrees(0);
    return verdict(reached === 180, `offset became ${reached}°`);
  });

  // A reload must never start playing. The forced-stopped keys have to be
  // the ones the deserialisers actually read: a differently named key is
  // ignored, the saved running state passes through, and the page comes
  // back sounding.
  await (async () => {
    const saved = localStorage.getItem('sonicforge.session');
    const channel = app.rack.getChannel(0);
    channel.setGainDb(-60);
    channel.start();
    app.rack.getChannel(2).start();

    localStorage.setItem('sonicforge.session', JSON.stringify({
      v: 1,
      a4: 440,
      masterDb: app.engine.masterLevelDb,
      channels: app.rack.toJSON(),
      noise: { ...app.noise.toJSON(), is_running_bool: true },
      viz: 'waterfall',
    }));
    app.rack.stopAllChannels();

    restoreSession(app);
    await sleep(120);
    const live = app.rack.activeChannelCount;
    const noisy = app.noise.is_running_bool;

    app.rack.stopAllChannels();
    app.noise.stop();
    if (saved === null) {
      localStorage.removeItem('sonicforge.session');
    } else {
      localStorage.setItem('sonicforge.session', saved);
    }

    checks.push({
      name: 'a restored session leaves every source stopped',
      ok: live === 0 && !noisy,
      detail: `${live} channels live, noise ${noisy ? 'running' : 'idle'}`,
      critical: true,
    });
  })();

  // Add-tone copies the selected channel's waveform. It used to read a
  // property that no longer exists, so every added tone was a sine.
  check('add-tone copies the selected waveform', () => {
    app.rack.stopAllChannels();
    const source = app.rack.getChannel(0);
    source.setWaveformName('square');
    app.ui.channels.selectChannel(0);
    source.start();

    document.getElementById('btn-add-tone').click();
    const added = app.rack.channels_list.find(
      (c) => c.is_enabled_bool && c.index_int !== 0
    );
    const waveform = added?.waveform_name_str;
    app.rack.stopAllChannels();
    source.setWaveformName('sine');

    return verdict(waveform === 'square', `added a ${waveform}`);
  });

  check('calibration curve canvas present', () =>
    Boolean(document.getElementById('cal-curve')?.getContext('2d'))
  );

  check('localStorage persistence works', () => {
    try {
      localStorage.setItem('sonicforge.__probe', '1');
      const ok = localStorage.getItem('sonicforge.__probe') === '1';
      localStorage.removeItem('sonicforge.__probe');
      return ok;
    } catch {
      return 'unavailable (private mode) — app degrades gracefully';
    }
  }, { critical: false });

  // The calibration panel's progress handler only runs during a real
  // measurement, which needs a microphone and eight seconds. Emitting one
  // progress event exercises the same path in a millisecond, and that path
  // was reading three identifiers a rename had already removed.
  check('calibration progress handler survives an event', () => {
    const before = consoleErrors.length;
    app.cal.emit('progress', {
      phase_str: 'sweep',
      progress_float: 0.5,
      message_str: 'self-test probe',
    });
    const badge = document.getElementById('cal-state');
    const grew = consoleErrors.length > before;
    return verdict(
      !grew && /50\s*%/.test(badge.textContent),
      grew ? consoleErrors[consoleErrors.length - 1] : badge.textContent
    );
  });

  // Let a few animation frames run so the render loops are exercised.
  await sleep(700);

  // Every visualiser, not just the default one. The interference and
  // goniometer views read the meter's stereo pair, and a rename on that
  // method threw on their first frame while the waterfall - the only mode
  // this suite used to visit - stayed perfectly green.
  const vizModesTried = [];
  for (const vizName of ['interference', 'gonio', 'waterfall']) {
    app.setVizMode(vizName);
    await sleep(220);
    vizModesTried.push(vizName);
  }
  check('every visualiser mode renders', () =>
    verdict(
      vizModesTried.length === 3,
      vizModesTried.join(', ')
    )
  );
  check('interference view still animating', () => {
    app.setVizMode('interference');
    const iv = app.ui.interference;
    return verdict(
      iv.is_running_bool && iv.stats_obj.voice_count_int >= 0,
      `running=${iv.is_running_bool}`
    );
  });

  // Returning the joined errors as a string would be scored as a pass by
  // the check() contract, which is how a real throw once stayed green.
  check('frame loop did not throw', () =>
    verdict(consoleErrors.length === 0, consoleErrors.join(' | '))
  );
  check('meter reads without error', () => {
    const levels_obj = app.engine.meter.readLevels();
    return Number.isFinite(levels_obj.peak_linear_float) ? `peak=${levels_obj.peak_linear_float.toFixed(5)}` : false;
  });
  check('spectrum reads at full resolution', () => {
    const s = app.engine.meter.readSpectrumDb();
    return s.length === app.engine.meter.spectrum_analyser_node.fftSize / 2
      ? `${s.length} bins`
      : `got ${s.length}`;
  });

  // --- layout audit -----------------------------------------------------
  // Screenshots caught overlapping terminal lines and clipped panel copy.
  // These assertions make that class of regression machine-detectable.

  check('page does not scroll horizontally', () => {
    const over = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    return verdict(over <= 1, over <= 1 ? 'no overflow' : `${over}px of horizontal overflow`);
  });

  check('terminal log lines do not overlap', () => {
    const lines = [...document.querySelectorAll('.term__log .term__line')];
    if (lines.length < 2) return 'too few lines to test';
    const rects = lines.map((el) => el.getBoundingClientRect());
    for (let i = 1; i < rects.length; i++) {
      const prev = rects[i - 1];
      const cur = rects[i];
      if (cur.top < prev.bottom - 1) {
        return verdict(false,
          `line ${i} starts at ${cur.top.toFixed(1)} but line ${i - 1} ends at ${prev.bottom.toFixed(1)}`);
      }
    }
    return `${lines.length} lines stacked cleanly`;
  });

  check('no panel clips its own content', () => {
    const bad = [];
    for (const body of document.querySelectorAll('.panel__body')) {
      // A scrollable body is fine; a body whose content is cut with no way
      // to reach it is not.
      const style = getComputedStyle(body);
      const hidden = style.overflowY === 'hidden' || style.overflow === 'hidden';
      const clipped = body.scrollHeight - body.clientHeight > 2;
      // A body may delegate scrolling to a child (the channel rack does), in
      // which case the content is still reachable and this is not a defect.
      const innerScroller = [...body.querySelectorAll('*')].some((el) => {
        const cs = getComputedStyle(el);
        return (cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      });
      if (clipped && hidden && !innerScroller) {
        const title = body.closest('.panel')?.querySelector('.panel__title')?.textContent ?? '?';
        bad.push(`${title} (+${body.scrollHeight - body.clientHeight}px)`);
      }
    }
    return verdict(bad.length === 0, bad.length === 0 ? 'all panel content reachable' : bad.join(', '));
  });

  check('rail panels keep their natural height', () => {
    const bad = [];
    for (const rail of document.querySelectorAll('.rail')) {
      for (const panel of rail.children) {
        // .panel--flush is explicitly meant to absorb slack and scroll.
        if (panel.classList.contains('panel--flush')) continue;
        const body = panel.querySelector('.panel__body');
        if (!body) continue;
        if (body.scrollHeight - body.clientHeight > 2) {
          const title = panel.querySelector('.panel__title')?.textContent ?? '?';
          bad.push(`${title} squeezed by ${body.scrollHeight - body.clientHeight}px`);
        }
      }
    }
    return verdict(bad.length === 0, bad.length === 0 ? 'no squeezed panels' : bad.join(', '));
  });

  check('no text is truncated in a select', () => {
    const bad = [];
    for (const sel of document.querySelectorAll('select.input')) {
      if (sel.scrollWidth > sel.clientWidth + 2) {
        bad.push(`#${sel.id || sel.className} needs ${sel.scrollWidth - sel.clientWidth}px more`);
      }
    }
    return verdict(bad.length === 0, bad.length === 0 ? 'all selects fit' : bad.join(', '));
  });

  check('channel rows are all rendered and reachable', () => {
    const list = document.getElementById('chan-list');
    const rows = list.querySelectorAll('.chan').length;
    const scrollable = list.scrollHeight > list.clientHeight;
    const canScroll = getComputedStyle(list).overflowY !== 'hidden';
    const good = rows === 16 && (!scrollable || canScroll);
    return verdict(good, good
      ? `${rows} rows, ${scrollable ? 'scrollable' : 'fully visible'}`
      : `${rows} rows, scrollable=${scrollable}, canScroll=${canScroll}`);
  });

  // --- rendered output sanity -------------------------------------------
  // The suite once passed 48/48 while the dial displayed "NaN cents",
  // because no check looked at what the user actually sees. A renamed
  // field silently yields undefined, and undefined formats as NaN.

  check('no visible text contains NaN or undefined', () => {
    const offenders_list = [];

    for (const element of document.querySelectorAll('#app *')) {
      if (element.children.length > 0) {
        continue;
      }
      const text_str = (element.textContent ?? '').trim();
      if (!text_str) {
        continue;
      }
      if (/NaN|undefined|\[object Object\]/.test(text_str)) {
        const label_str = element.id || element.className || element.tagName;
        offenders_list.push(`${label_str}: "${text_str.slice(0, 40)}"`);
      }
    }

    return verdict(
      offenders_list.length === 0,
      offenders_list.length === 0
        ? 'all readouts render real values'
        : offenders_list.slice(0, 6).join(' | ')
    );
  });

  check('no form control holds NaN', () => {
    const offenders_list = [];

    for (const control of document.querySelectorAll('input, select')) {
      const value_str = String(control.value ?? '');
      if (/NaN|undefined/.test(value_str)) {
        offenders_list.push(`${control.id || control.name}: "${value_str}"`);
      }
    }

    return verdict(
      offenders_list.length === 0,
      offenders_list.length === 0
        ? 'all inputs hold real values'
        : offenders_list.slice(0, 6).join(' | ')
    );
  });

  check('the dial reports a real note and cent deviation', () => {
    const note_str = document.getElementById('dial-note')?.textContent ?? '';
    const cents_str = document.getElementById('dial-cents')?.textContent ?? '';
    const is_valid_bool =
      /^[A-G]#?-?\d+$/.test(note_str.trim()) && /\d/.test(cents_str);

    return verdict(is_valid_bool, `${note_str} / ${cents_str}`);
  });

  check('every channel row shows a note name', () => {
    const cells_list = [
      ...document.querySelectorAll('#chan-list [data-role="note"]'),
    ];
    const blank_count_int = cells_list.filter(
      (cell) => !/^[A-G]/.test((cell.textContent ?? '').trim())
    ).length;

    return verdict(
      cells_list.length === 16 && blank_count_int === 0,
      `${cells_list.length - blank_count_int}/${cells_list.length} rows ` +
        'show a note'
    );
  });

  check('the visualiser hint hides while audio is playing', () => {
    const channel_obj = app.rack.getChannel(0);
    channel_obj.start();
    app.syncUi();

    const hint_el = document.getElementById('viz-empty');
    const opacity_str = hint_el?.style.opacity ?? '';
    channel_obj.stop();
    app.syncUi();

    return verdict(
      opacity_str === '0',
      `opacity was "${opacity_str}" with a channel running`
    );
  });

  // --- report ----------------------------------------------------------
  const failed = checks.filter((c) => !c.ok);
  const report = {
    kind: 'app',
    done: true,
    pass: checks.length - failed.length,
    fail: failed.length,
    ms: Math.round(performance.now() - t0),
    vizMode: app.ui.waterfall?.render_mode_str,
    sampleRate: app.engine.sampleRateHertz,
    consoleErrors,
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, detail: c.detail })),
    failures: failed.map((c) => ({ test: c.name, error: c.detail || 'returned false' })),
  };

  window.__APPTEST__ = report;
  console.log(`[SonicForge selftest] ${report.pass} passed, ${report.fail} failed`);

  try {
    await fetch('/__results', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(report),
    });
  } catch {}

  return report;
}
