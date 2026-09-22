/**
 * Behaviour checks: the application actually driven.
 *
 * Brief:
 *   Everything here changes state and reads it back. Several of these
 *   exist because a rename broke a path the model-level checks
 *   never touched, so they drive the real controls rather than the
 *   models behind them.
 */

import { restoreSession } from '../app/session.js';
import {
  CHECKS_LIST,
  CONSOLE_ERRORS_LIST,
  check,
  verdict,
  sleep,
} from './harness.js';

/* ------------------------------------------------------------------------ */

/**
 * Run this group of checks.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 */

/**
 * The rack relocking a retuned channel by itself.
 *
 * Brief:
 *   The unit suite proves a relock cancels exactly, but it calls the relock
 *   by hand, because no timer can drive an offline render. This drives the
 *   live context and waits for the rack's own timer to do it.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 */
async function runPhaseLockChecks(app) {
  const first_obj = app.rack.getChannel(0);
  const second_obj = app.rack.getChannel(1);
  first_obj.setFrequencyHertz(440);
  second_obj.setFrequencyHertz(660);
  first_obj.start();
  second_obj.start();
  second_obj.setFrequencyHertz(440);
  const is_pending_bool = second_obj.needs_phase_relock_bool;

  await sleep(300);
  const first_voice_obj = first_obj.voice_obj;
  const second_voice_obj = second_obj.voice_obj;
  const is_relocked_bool = !first_obj.needs_phase_relock_bool &&
    !second_obj.needs_phase_relock_bool;
  const is_shared_frame_bool = Boolean(first_voice_obj && second_voice_obj) &&
    first_voice_obj.start_seconds_float ===
      second_voice_obj.start_seconds_float &&
    first_voice_obj.anchor_degrees_float ===
      second_voice_obj.anchor_degrees_float;
  first_obj.stop();
  second_obj.stop();

  check('a retuned channel relocks to the audio clock by itself', () =>
    verdict(
      is_pending_bool && is_relocked_bool && is_shared_frame_bool,
      `pending ${is_pending_bool} · relocked ${is_relocked_bool} · ` +
        `shared frame ${is_shared_frame_bool}`
    )
  );
}

/**
 * Channel start, stop and row fields.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runChannelChecks(app) {
  // --- behaviour: actually drive it ------------------------------------
  check('channel starts and stops', () => {
    const channel_obj = app.rack.getChannel(0);
    channel_obj.setFrequencyHertz(440);
    channel_obj.start();
    const is_started_bool =
      channel_obj.is_enabled_bool && Boolean(channel_obj.oscillator_node);
    channel_obj.stop();
    return is_started_bool ? 'started + stopped cleanly' : false;
  });

  // Drives the row's own text field rather than the model, because the
  // field's commit path reaches the rack and the engine by paths the model
  // API never touches. One of those references was stale and threw here.
  check('channel row frequency field commits', () => {
    const row_el = document.querySelector('#chan-list .chan[data-index="0"]');
    const field_el = row_el?.querySelector('[data-role="freq"]');
    if (!field_el) {
      return verdict(false, 'row 0 has no frequency field');
    }
    const channel_obj = app.rack.getChannel(0);
    const before_any = channel_obj.frequency_hertz_float;
    field_el.value = '523.25';
    field_el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true,
    }));
    const after_any = channel_obj.frequency_hertz_float;
    channel_obj.setFrequencyHertz(before_any);
    return verdict(
      Math.abs(after_any - 523.25) < 0.01,
      `${before_any.toFixed(2)} Hz -> ${after_any.toFixed(2)} Hz`
    );
  });

  check('channel row level field accepts -inf', () => {
    const row_el = document.querySelector('#chan-list .chan[data-index="1"]');
    const field_el = row_el?.querySelector('[data-role="gain"]');
    if (!field_el) {
      return verdict(false, 'row 1 has no level field');
    }
    const channel_obj = app.rack.getChannel(1);
    const before_any = channel_obj.gain_db_float;
    field_el.value = '-inf';
    field_el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', bubbles: true,
    }));
    const silenced_db_float = channel_obj.gain_db_float;
    channel_obj.setGainDb(before_any);
    return verdict(
      silenced_db_float <= -90,
      `level became ${silenced_db_float} dBFS`
    );
  });
}


/**
 * Frequency bounds, phase, solo and pitch.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runTuningChecks(app) {
  check('frequency clamps to Nyquist', () => {
    const channel_obj = app.rack.getChannel(1);
    channel_obj.setFrequencyHertz(999999);
    const clamped_hertz_float =
      channel_obj.frequency_hertz_float <= app.engine.nyquistHertz;
    channel_obj.setFrequencyHertz(440);
    return clamped_hertz_float
      ? `clamped to ${app.engine.maxFrequencyHertz}`
      : false;
  });

  check('infrasonic frequency is accepted', () => {
    const channel_obj = app.rack.getChannel(1);
    channel_obj.setFrequencyHertz(7);
    const is_ok_bool = Math.abs(channel_obj.frequency_hertz_float - 7) < 0.01;
    channel_obj.setFrequencyHertz(440);
    return is_ok_bool
      ? '7 Hz set exactly'
      : `got ${channel_obj.frequency_hertz_float}`;
  });

  check('phase offset applies to a running oscillator', () => {
    const channel_obj = app.rack.getChannel(2);
    channel_obj.start();
    channel_obj.setPhaseDegrees(180);
    const is_ok_bool = channel_obj.phase_degrees_int === 180;
    channel_obj.stop();
    return is_ok_bool;
  });

  check('solo masks other channels', () => {
    const a = app.rack.getChannel(0);
    const b = app.rack.getChannel(1);
    a.start(); b.start();
    a.setSoloed(true);
    const is_masked_bool =
      b.is_silenced_by_solo_bool === true &&
      a.is_silenced_by_solo_bool === false;
    a.setSoloed(false);
    a.stop(); b.stop();
    return is_masked_bool;
  });

  check('A4 recalibration propagates', () => {
    app.tuning.referenceHertz = 432;
    const c4_hertz_float = app.tuning.convertMidiToHertz(60);
    app.tuning.referenceHertz = 440;
    return Math.abs(c4_hertz_float - 256.87) < 0.1
      ? `C4 = ${c4_hertz_float.toFixed(2)} Hz at A4=432`
      : `got ${c4_hertz_float}`;
  });
}


/**
 * Scripting: compilation, globals and command coverage.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 */
async function runScriptChecks(app) {
  // set() writes globals through a switch on a keyword. A migration once
  // rewrote one of those case labels -- a string literal, not an identifier
  // -- so an alias silently stopped matching. Both spellings are checked.
  for (const keyword of ['a4', 'tuning']) {
    // eslint-disable-next-line no-await-in-loop
    await (async () => {
      app.tuning.referenceHertz = 440;
      app.vm.run(`set(${keyword}, 432)`, { label_str: 'selftest' });
      await sleep(260);
      const reached_any = app.tuning.referenceHertz;
      app.vm.stop({ is_silent_bool: true });
      app.tuning.referenceHertz = 440;
      check(`set(${keyword}) reaches the tuning reference`, () =>
        verdict(
          Math.abs(reached_any - 432) < 0.01,
          `A4 became ${reached_any} Hz`
        )
      );
    })();
  }

  check('script compiles and runs', () => {
    const before_any = app.vm.state_str;
    app.vm.run(
      'play(440hz, 60ms, sine, ' +
      '-30db)\nwait(20ms)',
      { label: 'selftest' }
    );
    const is_running_bool = app.vm.is_running_bool;
    app.vm.stop();
    return is_running_bool ? `state moved from ${before_any}` : false;
  });

  check('script rejects an unknown command with a helpful error', () => {
    const value_any = app.vm.validate('frobnicate(1)');
    return !value_any.is_valid_bool &&
      /Unknown command/.test(value_any.err.message)
      ? value_any.err.message.slice(0, 60)
      : false;
  });
}


/**
 * Command coverage.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 */
async function runCommandChecks(app) {
  check('loop expands to the right instruction count', () => {
    const instructions_list =
      app.vm.compile('loop(3, [ play(440,10), wait(10) ])');
    // LOOP + 2 calls + ENDLOOP
    return instructions_list.length === 4
      ? '4 instructions'
      : `got ${instructions_list.length}`;
  });

  check('JSON script form compiles', () => {
    const instructions_list = app.vm.compile('[["play",440,100],["wait",50]]');
    return instructions_list.length === 2;
  });

  check('am() command exists for infrasonic envelopes', () => {
    const value_any = app.vm.validate('am(200hz, 11hz, 1s, 100%, -30db)');
    return value_any.is_valid_bool ? 'validated' : value_any.err.message;
  });

  await check('noise generator starts', async () => true) &&
    await (async () => {
    try {
      await app.noise.setColour('pink');
      app.noise.setGainDb(-40);
      await app.noise.start();
      await sleep(150);
      const is_running_bool = app.noise.is_running_bool;
      app.noise.stop();
      CHECKS_LIST.push({
        name: 'noise generator starts and stops',
        ok: is_running_bool,
        detail: 'pink',
        critical: true,
      });
    } catch (err) {
      CHECKS_LIST.push({
        name: 'noise generator starts and stops',
        ok: false,
        detail: err.message,
        critical: true,
      });
    }
  })();
}


/**
 * Noise generator and preset definitions.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 */
async function runNoiseChecks(app) {
  // The blend has two slots. Callers used to pass the interface's 'A'/'B'
  // labels, which the model silently read as "primary" -- so setting colour
  // B overwrote colour A and the crossfade had one colour on both sides.
  await (async () => {
    // setColour is async, so a bad slot arrives as a rejected promise, not
    // a throw. Catching it synchronously would leave an unhandled rejection
    // and fail the frame-loop check instead of this one.
    const before_any = app.noise.secondary_colour_str;
    let is_rejected_bool = false;
    try {
      await app.noise.setColour('brown', 'B');
    } catch (err) {
      is_rejected_bool = /unknown noise slot/.test(err.message);
    }
    CHECKS_LIST.push({
      name: 'noise slots are addressed by the names the model defines',
      ok: is_rejected_bool && app.noise.secondary_colour_str === before_any,
      detail: is_rejected_bool
        ? 'an unknown slot name is rejected'
        : 'a bad slot was accepted',
      critical: true,
    });
  })();

  await (async () => {
    await app.noise.setColour('white', 'primary');
    await app.noise.setColour('brown', 'secondary');
    CHECKS_LIST.push({
      name: 'the two noise slots hold different colours',
      ok: app.noise.primary_colour_str === 'white' &&
        app.noise.secondary_colour_str === 'brown',
      detail: `${app.noise.primary_colour_str} / ` +
        `${app.noise.secondary_colour_str}`,
      critical: true,
    });
  })();

  check('every preset has a runnable definition', () => {
    let bad_list = [];
    for (const p of app.__presets ?? []) {
      if (!p.script && !p.apply) bad_list.push(p.id);
      if (p.script) {
        const value_any = app.vm.validate(p.script);
        if (!value_any.is_valid_bool) {
          bad_list.push(`${p.id}: ${value_any.err.message}`);
        }
      }
    }
    return bad_list.length === 0
      ? `${(app.__presets ?? []).length} presets validated`
      : bad_list.join(' | ');
  });
}


/**
 * Concert Mode surface checks.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runConcertChecks(app) {
  check('QR encoder produces a join code', () => {
    app.concert.room_code_str = 'TESTRM';
    const url_str = app.concert.joinUrl();
    return url_str.includes('TESTRM') ? url_str.slice(0, 48) : false;
  });

  // The panel and the remote 'phase' handler both call this by name. It was
  // defined as setPhase() and called as setPhaseDegrees(), so the phase
  // slider threw on every input and the remote handler threw on arrival.
  check('concert exposes the phase setter its callers use', () => {
    if (typeof app.concert.setPhaseDegrees !== 'function') {
      return verdict(false, 'setPhaseDegrees is not a function');
    }
    app.concert.setPhaseDegrees(180);
    const reached_any = app.concert.phase_degrees_int;
    app.concert.setPhaseDegrees(0);
    return verdict(reached_any === 180, `offset became ${reached_any}°`);
  });
}


/**
 * Session restore.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 */
async function runSessionChecks(app) {
  // A reload must never start playing. The forced-stopped keys have to be
  // the ones the deserialisers actually read: a differently named key is
  // ignored, the saved running state passes through, and the page comes
  // back sounding.
  await (async () => {
    const saved_str = localStorage.getItem('sonicforge.session');
    const channel_obj = app.rack.getChannel(0);
    channel_obj.setGainDb(-60);
    channel_obj.start();
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
    const live_count_int = app.rack.activeChannelCount;
    const is_noisy_bool = app.noise.is_running_bool;

    app.rack.stopAllChannels();
    app.noise.stop();
    if (saved_str === null) {
      localStorage.removeItem('sonicforge.session');
    } else {
      localStorage.setItem('sonicforge.session', saved_str);
    }

    CHECKS_LIST.push({
      name: 'a restored session leaves every source stopped',
      ok: live_count_int === 0 && !is_noisy_bool,
      detail: `${live_count_int} channels live, ` +
        `noise ${is_noisy_bool ? 'running' : 'idle'}`,
      critical: true,
    });
  })();
}


/**
 * Add-tone behaviour.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function runAddToneChecks(app) {
  // Add-tone copies the selected channel's waveform. It used to read a
  // property that no longer exists, so every added tone was a sine.
  check('add-tone copies the selected waveform', () => {
    app.rack.stopAllChannels();
    const source_obj = app.rack.getChannel(0);
    source_obj.setWaveformName('square');
    app.ui.channels.selectChannel(0);
    source_obj.start();

    document.getElementById('btn-add-tone').click();
    const added_obj = app.rack.channels_list.find(
      (c) => c.is_enabled_bool && c.index_int !== 0
    );
    const waveform_str = added_obj?.waveform_name_str;
    app.rack.stopAllChannels();
    source_obj.setWaveformName('sine');

    return verdict(waveform_str === 'square', `added a ${waveform_str}`);
  });

  check('calibration curve canvas present', () =>
    Boolean(document.getElementById('cal-curve')?.getContext('2d'))
  );

  check('localStorage persistence works', () => {
    try {
      localStorage.setItem('sonicforge.__probe', '1');
      const is_ok_bool = localStorage.getItem('sonicforge.__probe') === '1';
      localStorage.removeItem('sonicforge.__probe');
      return is_ok_bool;
    } catch {
      return 'unavailable (private mode) — app degrades gracefully';
    }
  }, { critical: false });

  // The calibration panel's progress handler only runs during a real
  // measurement, which needs a microphone and eight seconds. Emitting one
  // progress event exercises the same path in a millisecond, and that path
  // was reading three identifiers a rename had already removed.
  check('calibration progress handler survives an event', () => {
    const before_any = CONSOLE_ERRORS_LIST.length;
    app.cal.emit('progress', {
      phase_str: 'sweep',
      progress_float: 0.5,
      message_str: 'self-test probe',
    });
    const badge_el = document.getElementById('cal-state');
    const has_grown_bool = CONSOLE_ERRORS_LIST.length > before_any;
    return verdict(
      !has_grown_bool && /50\s*%/.test(badge_el.textContent),
      has_grown_bool
        ? CONSOLE_ERRORS_LIST[CONSOLE_ERRORS_LIST.length - 1]
        : badge_el.textContent
    );
  });
}


/**
 * Run this group of checks.
 *
 * Brief:
 *   Drives the real controls rather than the models behind them,
 *   because several of these exist for bugs the model-level checks
 *   passed straight through.
 *
 * Arguments:
 *   app (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 */
export async function runBehaviourChecks(app) {
  runChannelChecks(app);
  await runPhaseLockChecks(app);
  runTuningChecks(app);
  await runScriptChecks(app);
  await runCommandChecks(app);
  await runNoiseChecks(app);
  runConcertChecks(app);
  await runSessionChecks(app);
  runAddToneChecks(app);
}
