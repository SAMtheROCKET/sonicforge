/**
 * The SonicForge command set.
 *
 * Brief:
 *   Each entry is a signature, help text, an example, and a run function.
 *   Every run function receives the runtime and the parsed arguments, and
 *   returns its duration in milliseconds. Returning 0 means the command is
 *   instantaneous and the next one follows immediately.
 *
 *   Commands schedule against runtime.when_seconds_float rather than acting
 *   now, because the VM is running ahead of real time. Anything that is not
 *   an AudioParam event goes through runtime.scheduleAt.
 */

import { formatDuration, formatFrequency } from '../util/frequency.js';
import { clampToRange } from '../util/numeric.js';
import { NOISE_COLOUR_KEYS_LIST } from '../dsp/noise-colours.js';
import {
  readArgumentValue,
  readNumber,
  readFrequencyHertz,
  readDurationMs,
  readWord,
  readWaveformName,
  readGainDb,
} from './arguments.js';
import { playVoice, playAmplitudeModulated } from './voice.js';

export { makeRuntime } from './runtime.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** DTMF row and column frequencies, in hertz. */
const DTMF_ROW_HERTZ_TUPLE = Object.freeze([697, 770, 852, 941]);
const DTMF_COLUMN_HERTZ_TUPLE = Object.freeze([1209, 1336, 1477, 1633]);

/** Keypad character to [row, column] index. */
export const DTMF_MAP = Object.freeze({
  1: [0, 0], 2: [0, 1], 3: [0, 2], A: [0, 3],
  4: [1, 0], 5: [1, 1], 6: [1, 2], B: [1, 3],
  7: [2, 0], 8: [2, 1], 9: [2, 2], C: [2, 3],
  '*': [3, 0], 0: [3, 1], '#': [3, 2], D: [3, 3],
});

/** Characters treated as a pause rather than an unknown digit. */
const DTMF_PAUSE_REGEX = /[\s\-.,]/;

/** Separators accepted between the notes of a chord. */
const CHORD_SEPARATOR_REGEX = /[,\s/+]+/;

/** Channels a script may address, and the pulse count a burst may request. */
const MIN_CHANNEL_NUMBER_INT = 1;
const MAX_CHANNEL_NUMBER_INT = 16;
const MIN_BURST_COUNT_INT = 1;
const MAX_BURST_COUNT_INT = 500;

/** Master level bounds, which allow a little gain the channels do not. */
const MIN_MASTER_DB_FLOAT = -90;
const MAX_MASTER_DB_FLOAT = 6;

/** Bounds for the globals set() can write. */
const MIN_REFERENCE_HERTZ_FLOAT = 380;
const MAX_REFERENCE_HERTZ_FLOAT = 500;
const MIN_SHIELD_DB_FLOAT = -12;
const MAX_SHIELD_DB_FLOAT = 12;

/* ------------------------------------------------------------------------ */

/**
 * Resolve a one-based channel argument to a zero-based rack index.
 *
 * Arguments:
 *   runtime_obj (Object): The command runtime.
 *   argument_obj (Object|null): The channel argument.
 *
 * Returns:
 *   (number): Zero-based index into the rack.
 */
function readChannelIndex(runtime_obj, argument_obj) {
  const channel_count_int =
    runtime_obj.app_obj.rack.channels_list.length || MAX_CHANNEL_NUMBER_INT;
  const requested_int = Math.round(readNumber(argument_obj, 1));
  return clampToRange(
    requested_int, MIN_CHANNEL_NUMBER_INT, channel_count_int
  ) - 1;
}

/**
 * Apply one global parameter on behalf of set().
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   key_str (string): Parameter name, already lower-cased.
 *   value_float (number): Requested value.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   An unknown key is reported to the terminal rather than ignored, because
 *   a silently dropped set() looks exactly like one that worked.
 */
function applyGlobalParameter(app_obj, key_str, value_float) {
  switch (key_str) {
    case 'a4':
    case 'pitch':
    case 'tuning':
      app_obj.tuning.referenceHertz = clampToRange(
        value_float, MIN_REFERENCE_HERTZ_FLOAT, MAX_REFERENCE_HERTZ_FLOAT
      );
      break;
    case 'shield':
    case 'vocal':
      app_obj.noise.setShieldDb(clampToRange(
        value_float, MIN_SHIELD_DB_FLOAT, MAX_SHIELD_DB_FLOAT
      ));
      break;
    case 'blend':
    case 'hybrid':
      app_obj.noise.setBlendRatio(clampToRange(value_float, 0, 1));
      break;
    case 'limiter':
      app_obj.engine.isLimiterEnabled = Boolean(value_float);
      break;
    case 'noisepan':
      app_obj.noise.setPanPosition(clampToRange(value_float, -1, 1));
      break;
    default:
      app_obj.log?.(`set(): unknown parameter '${key_str}'`, 'warn');
  }
}

/* ------------------------------------------------------------------------ */

/** Every command the scripting language understands. */
export const COMMANDS = {
  play: {
    signature: 'play(frequency, duration_ms, waveform, gain_db, pan)',
    help:
      'Play a single tone. Frequency accepts Hz, kHz, or a note name (A4).',
    example: 'play(440hz, 1s, sine, -12db)',
    run(runtime_obj, arguments_list) {
      const frequency_hertz_float =
        readFrequencyHertz(runtime_obj, arguments_list[0], 440);
      const duration_ms_float = readDurationMs(arguments_list[1], 500);
      const waveform_name_str =
        readWaveformName(arguments_list[2], 'sine');
      const gain_db_float = readGainDb(arguments_list[3], -12);
      const pan_position_float =
        clampToRange(readNumber(arguments_list[4], 0), -1, 1);
      if (duration_ms_float <= 0) {
        return 0;
      }

      playVoice(runtime_obj, {
        frequency_hertz_float,
        waveform_name_str,
        gain_db_float,
        pan_position_float,
        duration_seconds_float: duration_ms_float / 1000,
      });
      const frequency_str = formatFrequency(frequency_hertz_float);
      runtime_obj.setLabel(
        `play ${frequency_str} · ${waveform_name_str} · ` +
        `${formatDuration(duration_ms_float)}`
      );
      runtime_obj.logAt(
        `▶ ${frequency_str}  ${waveform_name_str}  ` +
        `${gain_db_float.toFixed(1)} dBFS  ` +
        `${formatDuration(duration_ms_float)}`
      );
      return duration_ms_float;
    },
  },

  sweep: {
    signature:
      'sweep(start_hz, end_hz, duration_ms, ' +
      "curve['linear'|'exponential'], waveform, gain_db)",
    help:
      'Glide between two frequencies. Exponential is constant octaves per ' +
      'second.',
    example: 'sweep(20hz, 20khz, 3s, exponential)',
    run(runtime_obj, arguments_list) {
      const start_hertz_float =
        readFrequencyHertz(runtime_obj, arguments_list[0], 20);
      const end_hertz_float =
        readFrequencyHertz(runtime_obj, arguments_list[1], 20000);
      const duration_ms_float = readDurationMs(arguments_list[2], 2000);
      const curve_str = readWord(arguments_list[3], 'exponential') === 'linear'
        ? 'linear'
        : 'exponential';
      const waveform_name_str = readWaveformName(arguments_list[4], 'sine');
      const gain_db_float = readGainDb(arguments_list[5], -12);
      if (duration_ms_float <= 0) {
        return 0;
      }

      playVoice(runtime_obj, {
        frequency_hertz_float: start_hertz_float,
        waveform_name_str,
        gain_db_float,
        duration_seconds_float: duration_ms_float / 1000,
        ramp_obj: { to_hertz_float: end_hertz_float, curve_str },
      });
      const span_str = `${formatFrequency(start_hertz_float)} → ` +
        `${formatFrequency(end_hertz_float)}`;
      runtime_obj.setLabel(`sweep ${span_str} · ${curve_str}`);
      runtime_obj.logAt(
        `↗ sweep ${span_str}  ${curve_str}  ` +
        `${formatDuration(duration_ms_float)}`
      );
      return duration_ms_float;
    },
  },

  wait: {
    signature: 'wait(duration_ms)',
    help: 'Silence for a duration. Accepts ms or s suffixes.',
    example: 'wait(250ms)',
    run(runtime_obj, arguments_list) {
      const duration_ms_float = readDurationMs(arguments_list[0], 250);
      runtime_obj.setLabel(`wait ${formatDuration(duration_ms_float)}`);
      return duration_ms_float;
    },
  },

  loop: {
    signature: 'loop(count, [commands])',
    help: 'Repeat a block. Handled by the VM — nesting is supported.',
    example: 'loop(4, [ play(880, 100), wait(150) ])',
    // Never reached: the compiler rewrites loops into LOOP/ENDLOOP.
    run() {
      return 0;
    },
  },

  burst: {
    signature: 'burst(frequency, count, on_ms, off_ms, gain_db)',
    help:
      'Pulse train at one frequency — the primitive behind water ejection.',
    example: 'burst(165hz, 20, 120ms, 60ms, -6db)',
    run(runtime_obj, arguments_list) {
      const frequency_hertz_float =
        readFrequencyHertz(runtime_obj, arguments_list[0], 165);
      const pulse_count_int = clampToRange(
        Math.round(readNumber(arguments_list[1], 8)),
        MIN_BURST_COUNT_INT,
        MAX_BURST_COUNT_INT
      );
      const on_ms_float = readDurationMs(arguments_list[2], 120);
      const off_ms_float = readDurationMs(arguments_list[3], 60);
      const gain_db_float = readGainDb(arguments_list[4], -8);

      for (let pulse_int = 0; pulse_int < pulse_count_int; pulse_int++) {
        playVoice(runtime_obj, {
          frequency_hertz_float,
          waveform_name_str: 'sine',
          gain_db_float,
          duration_seconds_float: on_ms_float / 1000,
          when_seconds_float: runtime_obj.when_seconds_float +
            (pulse_int * (on_ms_float + off_ms_float)) / 1000,
        });
      }

      const frequency_str = formatFrequency(frequency_hertz_float);
      runtime_obj.setLabel(`burst ${frequency_str} ×${pulse_count_int}`);
      runtime_obj.logAt(
        `≡ burst ${frequency_str} ×${pulse_count_int}  ` +
        `${formatDuration(on_ms_float)} on / ` +
        `${formatDuration(off_ms_float)} off`
      );
      return pulse_count_int * (on_ms_float + off_ms_float);
    },
  },

  am: {
    signature: 'am(carrier_hz, modulation_hz, duration_ms, depth, gain_db)',
    help:
      'Amplitude-modulated tone. The envelope rate can be infrasonic even ' +
      'though the carrier is not — this is the only way ordinary speakers ' +
      'deliver a sub-20 Hz forcing, because they physically cannot ' +
      'reproduce a sub-20 Hz tone.',
    example: 'am(200hz, 11hz, 30s, 100%, -8db)',
    run(runtime_obj, arguments_list) {
      const carrier_hertz_float =
        readFrequencyHertz(runtime_obj, arguments_list[0], 200);
      const modulation_hertz_float =
        Math.abs(readNumber(arguments_list[1], 10));
      const duration_ms_float = readDurationMs(arguments_list[2], 10000);
      const depth_float =
        clampToRange(readNumber(arguments_list[3], 1), 0, 1);
      const gain_db_float = readGainDb(arguments_list[4], -10);
      if (duration_ms_float <= 0) {
        return 0;
      }

      playAmplitudeModulated(runtime_obj, {
        carrier_hertz_float,
        modulation_hertz_float,
        depth_float,
        gain_db_float,
        duration_seconds_float: duration_ms_float / 1000,
      });

      const carrier_str = formatFrequency(carrier_hertz_float);
      const modulation_str = modulation_hertz_float.toFixed(2);
      runtime_obj.setLabel(`am ${carrier_str} ☉ ${modulation_str} Hz`);
      runtime_obj.logAt(
        `≋ AM  carrier ${carrier_str}  envelope ${modulation_str} Hz  ` +
        `depth ${(depth_float * 100).toFixed(0)}%  ` +
        `${formatDuration(duration_ms_float)}`
      );
      return duration_ms_float;
    },
  },

  chord: {
    signature: 'chord("C4,E4,G4", duration_ms, waveform, gain_db)',
    help: 'Play several notes or frequencies simultaneously.',
    example: 'chord("A3,C#4,E4", 1.5s, triangle)',
    run(runtime_obj, arguments_list) {
      const spec_str =
        String(readArgumentValue(arguments_list[0]) ?? 'C4,E4,G4');
      const duration_ms_float = readDurationMs(arguments_list[1], 1000);
      const waveform_name_str = readWaveformName(arguments_list[2], 'sine');
      const gain_db_float = readGainDb(arguments_list[3], -18);

      const note_names_list =
        spec_str.split(CHORD_SEPARATOR_REGEX).filter(Boolean);
      if (!note_names_list.length || duration_ms_float <= 0) {
        return 0;
      }

      for (const note_name_str of note_names_list) {
        const frequency_hertz_float = readFrequencyHertz(
          runtime_obj,
          { kind_str: 'string', value_any: note_name_str },
          NaN
        );
        if (!Number.isFinite(frequency_hertz_float)) {
          continue;
        }
        playVoice(runtime_obj, {
          frequency_hertz_float,
          waveform_name_str,
          gain_db_float,
          duration_seconds_float: duration_ms_float / 1000,
        });
      }

      runtime_obj.setLabel(`chord ${note_names_list.join(' ')}`);
      runtime_obj.logAt(
        `♫ chord ${note_names_list.join(' ')}  ` +
        `${formatDuration(duration_ms_float)}`
      );
      return duration_ms_float;
    },
  },

  dtmf: {
    signature: 'dtmf("555-0100", tone_ms, gap_ms, gain_db)',
    help:
      'Dual-tone multi-frequency dialling. Non-keypad characters are ' +
      'treated as pauses.',
    example: 'dtmf("1-800-555-0199", 120ms, 80ms)',
    run(runtime_obj, arguments_list) {
      const digits_str =
        String(readArgumentValue(arguments_list[0]) ?? '').toUpperCase();
      const tone_ms_float = readDurationMs(arguments_list[1], 120);
      const gap_ms_float = readDurationMs(arguments_list[2], 80);
      const gain_db_float = readGainDb(arguments_list[3], -14);
      if (!digits_str) {
        return 0;
      }

      let offset_ms_float = 0;
      let played_count_int = 0;

      for (const character_str of digits_str) {
        const pair_arr = DTMF_MAP[character_str];
        if (!pair_arr) {
          if (DTMF_PAUSE_REGEX.test(character_str)) {
            offset_ms_float += tone_ms_float + gap_ms_float;
          }
          continue;
        }

        const when_seconds_float =
          runtime_obj.when_seconds_float + offset_ms_float / 1000;
        for (const frequency_hertz_float of [
          DTMF_ROW_HERTZ_TUPLE[pair_arr[0]],
          DTMF_COLUMN_HERTZ_TUPLE[pair_arr[1]],
        ]) {
          playVoice(runtime_obj, {
            frequency_hertz_float,
            waveform_name_str: 'sine',
            gain_db_float,
            duration_seconds_float: tone_ms_float / 1000,
            when_seconds_float,
          });
        }
        runtime_obj.scheduleAt(
          () => runtime_obj.app_obj.onDtmfDigit?.(character_str),
          when_seconds_float
        );
        offset_ms_float += tone_ms_float + gap_ms_float;
        played_count_int++;
      }

      runtime_obj.setLabel(`dtmf ${digits_str}`);
      runtime_obj.logAt(
        `☎ dtmf "${digits_str}"  ${played_count_int} digits`
      );
      return offset_ms_float;
    },
  },

  tone: {
    signature: 'tone(channel, frequency, gain_db, waveform, pan)',
    help: 'Configure and start one of the 16 rack channels. Non-blocking.',
    example: 'tone(1, 440hz, -15db, sine)',
    run(runtime_obj, arguments_list) {
      const index_int = readChannelIndex(runtime_obj, arguments_list[0]);
      const frequency_hertz_float =
        readFrequencyHertz(runtime_obj, arguments_list[1], 440);
      const gain_db_float = readGainDb(arguments_list[2], -18);
      const waveform_name_str = readWaveformName(arguments_list[3], 'sine');
      const pan_position_float =
        clampToRange(readNumber(arguments_list[4], 0), -1, 1);

      runtime_obj.scheduleAt(() => {
        const channel_obj = runtime_obj.app_obj.rack.getChannel(index_int);
        if (!channel_obj) {
          return;
        }
        channel_obj.setWaveformName(waveform_name_str);
        channel_obj.setFrequencyHertz(frequency_hertz_float);
        channel_obj.setGainDb(gain_db_float);
        channel_obj.setPanPosition(pan_position_float);
        if (!channel_obj.is_enabled_bool) {
          channel_obj.start();
        }
      });

      const frequency_str = formatFrequency(frequency_hertz_float);
      runtime_obj.setLabel(`ch${index_int + 1} ← ${frequency_str}`);
      runtime_obj.logAt(
        `✦ channel ${index_int + 1}: ${frequency_str} ` +
        `${waveform_name_str} ${gain_db_float.toFixed(1)} dBFS`
      );
      return 0;
    },
  },

  off: {
    signature: 'off(channel | all)',
    help: 'Stop one rack channel, or every channel.',
    example: 'off(all)',
    run(runtime_obj, arguments_list) {
      const value_any = readArgumentValue(arguments_list[0]);
      const is_all_bool =
        value_any === undefined || value_any === 'all' || value_any === 0;

      runtime_obj.scheduleAt(() => {
        if (is_all_bool) {
          runtime_obj.app_obj.rack.stopAllChannels();
          return;
        }
        const index_int =
          readChannelIndex(runtime_obj, arguments_list[0]);
        runtime_obj.app_obj.rack.getChannel(index_int)?.stop();
      });

      runtime_obj.setLabel(is_all_bool ? 'off all' : `off ch${value_any}`);
      return 0;
    },
  },

  noise: {
    signature: 'noise(colour, gain_db, duration_ms)',
    help:
      `Start the noise generator. Colours: ` +
      `${NOISE_COLOUR_KEYS_LIST.join(', ')}. ` +
      'With a duration it stops itself.',
    example: 'noise(brown, -22db, 10s)',
    run(runtime_obj, arguments_list) {
      const requested_str = readWord(arguments_list[0], 'pink');
      const colour_str = NOISE_COLOUR_KEYS_LIST.includes(requested_str)
        ? requested_str
        : 'pink';
      const gain_db_float = readGainDb(arguments_list[1], -24);
      const duration_ms_float = readNumber(arguments_list[2], 0);

      runtime_obj.scheduleAt(async () => {
        await runtime_obj.app_obj.noise.setColour(colour_str);
        runtime_obj.app_obj.noise.setGainDb(gain_db_float);
        await runtime_obj.app_obj.noise.start();
      });

      if (duration_ms_float > 0) {
        runtime_obj.scheduleAt(
          () => runtime_obj.app_obj.noise.stop(),
          runtime_obj.when_seconds_float + duration_ms_float / 1000
        );
      }

      const for_str = duration_ms_float > 0
        ? ` for ${formatDuration(duration_ms_float)}`
        : '';
      runtime_obj.setLabel(`noise ${colour_str}`);
      runtime_obj.logAt(
        `░ noise ${colour_str} @ ${gain_db_float.toFixed(1)} dBFS${for_str}`
      );
      return duration_ms_float > 0 ? duration_ms_float : 0;
    },
  },

  hush: {
    signature: 'hush()',
    help: 'Stop the noise generator.',
    example: 'hush()',
    run(runtime_obj) {
      runtime_obj.scheduleAt(() => runtime_obj.app_obj.noise.stop());
      runtime_obj.setLabel('hush');
      return 0;
    },
  },

  gain: {
    signature: 'gain(db)',
    help: 'Set the master output level in dBFS.',
    example: 'gain(-18db)',
    run(runtime_obj, arguments_list) {
      const gain_db_float = clampToRange(
        readNumber(arguments_list[0], -12),
        MIN_MASTER_DB_FLOAT,
        MAX_MASTER_DB_FLOAT
      );

      runtime_obj.scheduleAt(() => {
        runtime_obj.app_obj.engine.masterLevelDb = gain_db_float;
        runtime_obj.app_obj.syncUi?.();
      });
      runtime_obj.setLabel(`gain ${gain_db_float.toFixed(1)} dBFS`);
      runtime_obj.logAt(`▤ master ${gain_db_float.toFixed(1)} dBFS`);
      return 0;
    },
  },

  set: {
    signature: 'set(parameter, value)',
    help: 'Set a global: a4, shield, blend, limiter, noisepan.',
    example: 'set(a4, 432hz)',
    run(runtime_obj, arguments_list) {
      const key_str = readWord(arguments_list[0], '');
      const value_float = readNumber(arguments_list[1], NaN);
      const app_obj = runtime_obj.app_obj;

      runtime_obj.scheduleAt(() => {
        applyGlobalParameter(app_obj, key_str, value_float);
        app_obj.syncUi?.();
      });
      runtime_obj.setLabel(`set ${key_str} = ${value_float}`);
      runtime_obj.logAt(`⚙ set ${key_str} = ${value_float}`);
      return 0;
    },
  },

  phase: {
    signature: 'phase(channel, degrees)',
    help:
      'Rotate a channel’s starting phase, 0–360°. Use two channels at 0° ' +
      'and 180° to demonstrate cancellation.',
    example: 'phase(2, 180deg)',
    run(runtime_obj, arguments_list) {
      const index_int = readChannelIndex(runtime_obj, arguments_list[0]);
      const phase_degrees_float = readNumber(arguments_list[1], 0);

      runtime_obj.scheduleAt(() => {
        runtime_obj.app_obj.rack.getChannel(index_int)
          ?.setPhaseDegrees(phase_degrees_float);
        runtime_obj.app_obj.syncUi?.();
      });
      runtime_obj.setLabel(
        `phase ch${index_int + 1} ${Math.round(phase_degrees_float)}°`
      );
      return 0;
    },
  },

  print: {
    signature: 'print("message")',
    help: 'Write a line to the terminal log at the moment it is reached.',
    example: 'print("stage 2 complete")',
    run(runtime_obj, arguments_list) {
      const message_str = String(readArgumentValue(arguments_list[0]) ?? '');
      runtime_obj.logAt(message_str, 'ok');
      runtime_obj.setLabel('print');
      return 0;
    },
  },

  stop: {
    signature: 'stop()',
    help:
      'Silence every channel, the noise generator, and any scheduled ' +
      'one-shots.',
    example: 'stop()',
    run(runtime_obj) {
      runtime_obj.scheduleAt(() => {
        runtime_obj.app_obj.rack.stopAllChannels();
        runtime_obj.app_obj.noise.stop();
        runtime_obj.vm_obj.releaseHeldNodes();
        runtime_obj.app_obj.syncUi?.();
      });
      runtime_obj.setLabel('stop all');
      runtime_obj.logAt('■ all sources stopped', 'warn');
      return 0;
    },
  },
};

/** Command names, in declaration order, for autocomplete. */
export const COMMAND_NAMES = Object.freeze(Object.keys(COMMANDS));
