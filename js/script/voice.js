/**
 * One-shot voices for the command set.
 *
 * Brief:
 *   Script commands do not borrow a rack channel; they build their own
 *   short-lived voice and route it through the channel bus, so a scripted
 *   tone is metered, visualised and limited exactly like a rack channel.
 */

import { convertDbToLinear } from '../util/amplitude.js';
import { clampToRange } from '../util/numeric.js';
import { applyWaveform } from '../core/waveforms.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Frequency bounds, relative to Nyquist, an oscillator is held within. */
const MIN_VOICE_HERTZ_FLOAT = 0.01;
const NYQUIST_MARGIN_HERTZ_FLOAT = 1;

/**
 * Envelope proportions for a one-shot voice, in seconds.
 *
 * The attack and release are capped as a fraction of the event as well as
 * absolutely, so a 5 ms blip is still a blip rather than a pure click, and
 * a 30 second tone does not open over a third of a second.
 */
const MAX_ATTACK_SECONDS_FLOAT = 0.006;
const MAX_RELEASE_SECONDS_FLOAT = 0.018;
const ATTACK_FRACTION_FLOAT = 0.25;
const RELEASE_FRACTION_FLOAT = 0.35;

/** Delay between a voice's envelope closing and the node stopping. */
const STOP_TAIL_SECONDS_FLOAT = 0.03;

/** Envelope proportions for the amplitude-modulated voice, in seconds. */
const AM_MAX_ATTACK_SECONDS_FLOAT = 0.03;
const AM_ATTACK_FRACTION_FLOAT = 0.1;
const AM_MIN_SUSTAIN_SECONDS_FLOAT = 0.04;
const AM_RELEASE_SECONDS_FLOAT = 0.05;

/* ------------------------------------------------------------------------ */

/**
 * Clamp a frequency into the range an oscillator can actually produce.
 *
 * Arguments:
 *   frequency_hertz_float (number): Requested frequency.
 *   sample_rate_float (number): The context's sample rate.
 *
 * Returns:
 *   (number): A frequency below Nyquist and above DC.
 */
function clampToNyquist(frequency_hertz_float, sample_rate_float) {
  return clampToRange(
    frequency_hertz_float,
    MIN_VOICE_HERTZ_FLOAT,
    sample_rate_float / 2 - NYQUIST_MARGIN_HERTZ_FLOAT
  );
}

/**
 * Apply a frequency ramp to an oscillator already scheduled to start.
 *
 * Arguments:
 *   oscillator_node (OscillatorNode): The voice to ramp.
 *   ramp_obj (Object): { to_hertz_float, curve_str }.
 *   start_seconds_float (number): When the ramp begins.
 *   duration_seconds_float (number): How long the ramp takes.
 *   sample_rate_float (number): The context's sample rate.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   An exponential ramp cannot pass through or reach zero, which is why the
 *   target is clamped above DC rather than merely being non-negative.
 */
function applyFrequencyRamp(
  oscillator_node,
  ramp_obj,
  start_seconds_float,
  duration_seconds_float,
  sample_rate_float
) {
  const target_hertz_float = clampToNyquist(
    ramp_obj.to_hertz_float, sample_rate_float
  );
  const end_seconds_float = start_seconds_float + duration_seconds_float;

  if (ramp_obj.curve_str === 'linear') {
    oscillator_node.frequency.linearRampToValueAtTime(
      target_hertz_float, end_seconds_float
    );
  } else {
    oscillator_node.frequency.exponentialRampToValueAtTime(
      target_hertz_float, end_seconds_float
    );
  }
}

/**
 * Apply a click-free envelope to a one-shot voice.
 *
 * Arguments:
 *   gain_node (GainNode): The voice's envelope.
 *   peak_amplitude_float (number): Linear amplitude at full level.
 *   start_seconds_float (number): When the voice begins.
 *   duration_seconds_float (number): How long it lasts.
 *
 * Returns:
 *   (none)
 */
function applyVoiceEnvelope(
  gain_node,
  peak_amplitude_float,
  start_seconds_float,
  duration_seconds_float
) {
  const attack_seconds_float = Math.min(
    MAX_ATTACK_SECONDS_FLOAT,
    duration_seconds_float * ATTACK_FRACTION_FLOAT
  );
  const release_seconds_float = Math.min(
    MAX_RELEASE_SECONDS_FLOAT,
    duration_seconds_float * RELEASE_FRACTION_FLOAT
  );

  gain_node.gain.setValueAtTime(0, start_seconds_float);
  gain_node.gain.linearRampToValueAtTime(
    peak_amplitude_float, start_seconds_float + attack_seconds_float
  );
  if (duration_seconds_float > attack_seconds_float + release_seconds_float) {
    gain_node.gain.setValueAtTime(
      peak_amplitude_float,
      start_seconds_float + duration_seconds_float - release_seconds_float
    );
  }
  gain_node.gain.linearRampToValueAtTime(
    0, start_seconds_float + duration_seconds_float
  );
}

/**
 * Route a voice's envelope to the channel bus, panning it if asked.
 *
 * Brief:
 *   A panner is only inserted when the voice is actually off-centre, so a
 *   centred one-shot costs one node fewer.
 *
 * Arguments:
 *   runtime_obj (Object): The command runtime.
 *   gain_node (GainNode): The voice's envelope.
 *   pan_position_float (number): -1 hard left to +1 hard right.
 *   when_seconds_float (number): When the position takes effect.
 *
 * Returns:
 *   (none)
 */
function connectToChannelBus(
  runtime_obj,
  gain_node,
  pan_position_float,
  when_seconds_float
) {
  const ctx = runtime_obj.ctx;
  let output_node = gain_node;

  if (pan_position_float !== 0 && ctx.createStereoPanner) {
    const panner_node = ctx.createStereoPanner();
    panner_node.pan.setValueAtTime(
      clampToRange(pan_position_float, -1, 1), when_seconds_float
    );
    gain_node.connect(panner_node);
    output_node = panner_node;
  }
  output_node.connect(runtime_obj.engine_obj.channel_bus_node);
}

/**
 * Create a one-shot voice with a click-free envelope.
 *
 * Brief:
 *   Routed through the channel bus so it is metered, visualised and limited
 *   like everything else, and registered with the VM so stopping the run
 *   silences it even though it may not have started yet.
 *
 * Arguments:
 *   runtime_obj (Object): The command runtime.
 *   spec_obj (Object): { frequency_hertz_float, waveform_name_str,
 *     gain_db_float, pan_position_float, phase_degrees_float,
 *     duration_seconds_float, ramp_obj, when_seconds_float }.
 *
 * Returns:
 *   (OscillatorNode): The started voice.
 */
export function playVoice(runtime_obj, spec_obj) {
  const {
    frequency_hertz_float,
    waveform_name_str,
    gain_db_float,
    pan_position_float = 0,
    phase_degrees_float = 0,
    duration_seconds_float,
    ramp_obj = null,
    when_seconds_float = runtime_obj.when_seconds_float,
  } = spec_obj;

  const ctx = runtime_obj.ctx;
  const oscillator_node = ctx.createOscillator();
  applyWaveform(oscillator_node, waveform_name_str, phase_degrees_float);
  oscillator_node.frequency.setValueAtTime(
    clampToNyquist(frequency_hertz_float, ctx.sampleRate), when_seconds_float
  );

  if (ramp_obj) {
    applyFrequencyRamp(
      oscillator_node,
      ramp_obj,
      when_seconds_float,
      duration_seconds_float,
      ctx.sampleRate
    );
  }

  const gain_node = ctx.createGain();
  applyVoiceEnvelope(
    gain_node,
    convertDbToLinear(gain_db_float),
    when_seconds_float,
    duration_seconds_float
  );
  oscillator_node.connect(gain_node);

  connectToChannelBus(
    runtime_obj, gain_node, pan_position_float, when_seconds_float
  );

  oscillator_node.start(when_seconds_float);
  oscillator_node.stop(
    when_seconds_float + duration_seconds_float + STOP_TAIL_SECONDS_FLOAT
  );
  runtime_obj.holdNode(oscillator_node, gain_node);
  return oscillator_node;
}

/**
 * Build the modulator half of an amplitude-modulated voice.
 *
 * Brief:
 *   The modulator is an oscillator driving a gain, not a computed envelope.
 *   That keeps it sample-accurate for the whole run at no extra cost, and
 *   is what lets the envelope rate be infrasonic while the carrier is not.
 *
 * Arguments:
 *   ctx (BaseAudioContext): The audio context.
 *   spec_obj (Object): { modulation_hertz_float, depth_float,
 *     peak_amplitude_float, when_seconds_float }.
 *
 * Returns:
 *   (Object): { modulator_node, carrier_gain_node }.
 */
function buildAmplitudeModulator(ctx, spec_obj) {
  const {
    modulation_hertz_float,
    depth_float,
    peak_amplitude_float,
    when_seconds_float,
  } = spec_obj;

  const modulator_node = ctx.createOscillator();
  modulator_node.type = 'sine';
  modulator_node.frequency.setValueAtTime(
    Math.max(modulation_hertz_float, MIN_VOICE_HERTZ_FLOAT),
    when_seconds_float
  );

  // Half the depth swinging around (1 - depth/2) spans 0..1 at full depth.
  const modulation_depth_node = ctx.createGain();
  modulation_depth_node.gain.setValueAtTime(
    (depth_float / 2) * peak_amplitude_float, when_seconds_float
  );

  const carrier_gain_node = ctx.createGain();
  carrier_gain_node.gain.setValueAtTime(
    (1 - depth_float / 2) * peak_amplitude_float, when_seconds_float
  );

  modulator_node.connect(modulation_depth_node);
  modulation_depth_node.connect(carrier_gain_node.gain);
  return { modulator_node, carrier_gain_node };
}

/**
 * Build the outer envelope of an amplitude-modulated voice.
 *
 * Brief:
 *   Separate from the modulation itself: this exists only so the burst
 *   starts and ends without a click, and it must not be confused with the
 *   modulation depth, which is what the listener is meant to hear.
 *
 * Arguments:
 *   ctx (BaseAudioContext): The audio context.
 *   when_seconds_float (number): When the voice begins.
 *   duration_seconds_float (number): How long it lasts.
 *
 * Returns:
 *   (GainNode): The envelope, already scheduled.
 */
function buildAmplitudeEnvelope(
  ctx,
  when_seconds_float,
  duration_seconds_float
) {
  const envelope_node = ctx.createGain();
  const attack_seconds_float = Math.min(
    AM_MAX_ATTACK_SECONDS_FLOAT,
    duration_seconds_float * AM_ATTACK_FRACTION_FLOAT
  );
  const sustain_seconds_float = Math.max(
    AM_MIN_SUSTAIN_SECONDS_FLOAT,
    duration_seconds_float - AM_RELEASE_SECONDS_FLOAT
  );

  envelope_node.gain.setValueAtTime(0, when_seconds_float);
  envelope_node.gain.linearRampToValueAtTime(
    1, when_seconds_float + attack_seconds_float
  );
  envelope_node.gain.setValueAtTime(
    1, when_seconds_float + sustain_seconds_float
  );
  envelope_node.gain.linearRampToValueAtTime(
    0, when_seconds_float + duration_seconds_float
  );
  return envelope_node;
}

/**
 * Create an amplitude-modulated voice.
 *
 * Brief:
 *   This is the only way an ordinary speaker delivers a sub-20 Hz forcing.
 *   The driver reproduces the audible carrier; the flame, or whatever is
 *   being driven, responds to the infrasonic envelope.
 *
 * Arguments:
 *   runtime_obj (Object): The command runtime.
 *   spec_obj (Object): { carrier_hertz_float, modulation_hertz_float,
 *     depth_float, gain_db_float, duration_seconds_float }.
 *
 * Returns:
 *   (OscillatorNode): The started carrier.
 */
export function playAmplitudeModulated(runtime_obj, spec_obj) {
  const {
    carrier_hertz_float,
    modulation_hertz_float,
    depth_float,
    gain_db_float,
    duration_seconds_float,
  } = spec_obj;

  const ctx = runtime_obj.ctx;
  const when_seconds_float = runtime_obj.when_seconds_float;
  const peak_amplitude_float = convertDbToLinear(gain_db_float);

  const carrier_node = ctx.createOscillator();
  carrier_node.type = 'sine';
  carrier_node.frequency.setValueAtTime(
    clampToNyquist(carrier_hertz_float, ctx.sampleRate), when_seconds_float
  );

  const { modulator_node, carrier_gain_node } = buildAmplitudeModulator(
    ctx,
    {
      modulation_hertz_float,
      depth_float,
      peak_amplitude_float,
      when_seconds_float,
    }
  );
  carrier_node.connect(carrier_gain_node);

  const envelope_node = buildAmplitudeEnvelope(
    ctx, when_seconds_float, duration_seconds_float
  );
  carrier_gain_node.connect(envelope_node);
  envelope_node.connect(runtime_obj.engine_obj.channel_bus_node);

  const stop_seconds_float =
    when_seconds_float + duration_seconds_float + STOP_TAIL_SECONDS_FLOAT;
  carrier_node.start(when_seconds_float);
  modulator_node.start(when_seconds_float);
  carrier_node.stop(stop_seconds_float);
  modulator_node.stop(stop_seconds_float);

  runtime_obj.holdNode(carrier_node, envelope_node);
  runtime_obj.holdNode(modulator_node, null);
  return carrier_node;
}
