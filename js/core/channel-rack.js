/**
 * The sixteen-channel rack and the rules that span channels.
 *
 * Brief:
 *   A channel knows only about itself. Anything that requires looking at
 *   every channel at once - solo masking, stopping everything, finding a
 *   free slot, saving the whole state - lives here. Keeping that separation
 *   is what stops a channel from needing a reference back to its rack.
 *
 *   Phase is one of those rules. A channel's phase only means something
 *   against the other channels, so relocking a retuned channel to the
 *   audio clock is scheduled here, across the whole rack at once.
 */

import { Emitter } from '../util/events.js';
import { SILENCE_THRESHOLD_DB_FLOAT } from '../util/amplitude.js';
import { ToneChannel } from './tone-channel.js';
import { PhaseRelockScheduler } from './phase-lock.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Number of independent channels the rack provides. */
export const CHANNEL_COUNT_INT = 16;

/** Default level applied to every channel on reset, in dBFS. */
const RESET_LEVEL_DB_FLOAT = -18;

/** Default frequency applied to every channel on reset, in hertz. */
const RESET_FREQUENCY_HERTZ_FLOAT = 440;

/** Starting hue of the channel colour wheel, in degrees. */
const HUE_START_DEGREES_INT = 185;

/** Hue step between consecutive channels, in degrees. */
const HUE_STEP_DEGREES_INT = 27;

/** Sixteen distinguishable hues, biased toward the cyan end of the wheel. */
export const CHANNEL_HUES_DEGREES_LIST = Object.freeze(
  Array.from(
    { length: CHANNEL_COUNT_INT },
    (_unused, index_int) =>
      (HUE_START_DEGREES_INT + index_int * HUE_STEP_DEGREES_INT) % 360
  )
);

/* ------------------------------------------------------------------------ */

/**
 * Own every tone channel and enforce the rules that span them.
 *
 * Brief:
 *   Constructs its channels immediately, so the rack is usable the moment
 *   it exists. Re-emits each channel's change event so that a view can
 *   subscribe once to the rack rather than sixteen times.
 *
 * Arguments:
 *   engine_obj (AudioEngine): Engine supplying the context and output bus.
 *   channel_count_int (number): Number of channels to create.
 *
 * Returns:
 *   (ChannelRack): A rack of stopped channels.
 *
 * Warning:
 *   Requires an initialised engine; every channel builds its nodes on
 *   construction.
 */
export class ChannelRack extends Emitter {
  /** @type {ToneChannel[]} */
  channels_list = [];

  constructor(engine_obj, channel_count_int = CHANNEL_COUNT_INT) {
    super();
    this.engine_obj = engine_obj;
    this.phase_relock_obj =
      new PhaseRelockScheduler(engine_obj, this.channels_list);

    for (
      let index_int = 0;
      index_int < channel_count_int;
      index_int += 1
    ) {
      const channel_obj = new ToneChannel(
        index_int,
        engine_obj,
        CHANNEL_HUES_DEGREES_LIST[index_int % CHANNEL_HUES_DEGREES_LIST.length]
      );
      channel_obj.on('solo', () => this.#applySoloMask());
      channel_obj.on('change', () => this.emit('change', channel_obj));
      channel_obj.on('retune', () => this.phase_relock_obj.requestRelock());
      this.channels_list.push(channel_obj);
    }
  }

  /**
   * Relock every settled channel to the audio clock now.
   *
   * Brief:
   *   The rack does this by itself shortly after any retune. It is exposed
   *   for OfflineAudioContext tests, where no timer can drive it.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): How many channels were rebuilt.
   */
  relockChannelPhases() {
    return this.phase_relock_obj.relockSettledChannels();
  }

  /**
   * Fetch one channel by its position in the rack.
   *
   * Arguments:
   *   index_int (number): Zero-based channel index.
   *
   * Returns:
   *   (ToneChannel): The channel, or undefined when out of range.
   */
  getChannel(index_int) {
    return this.channels_list[index_int];
  }

  /** Whether any channel is currently soloed. */
  get isAnySoloed() {
    return this.channels_list.some(
      (channel_obj) => channel_obj.is_soloed_bool
    );
  }

  /** How many channels are currently running. */
  get activeChannelCount() {
    return this.channels_list.filter(
      (channel_obj) => channel_obj.is_enabled_bool
    ).length;
  }

  /**
   * List the channels actually producing audible output.
   *
   * Brief:
   *   A channel can be running yet inaudible: muted, masked by another
   *   channel's solo, or turned fully down. The interference visualiser
   *   needs the ones that genuinely contribute, not merely the running ones.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (ToneChannel[]): Channels contributing signal right now.
   */
  get audibleChannels() {
    return this.channels_list.filter(
      (channel_obj) =>
        channel_obj.is_enabled_bool &&
        !channel_obj.is_muted_bool &&
        !channel_obj.is_silenced_by_solo_bool &&
        channel_obj.gain_db_float > SILENCE_THRESHOLD_DB_FLOAT
    );
  }

  /** Apply the solo mask across every channel and re-level them. */
  #applySoloMask() {
    const is_any_soloed_bool = this.isAnySoloed;

    for (const channel_obj of this.channels_list) {
      channel_obj.is_silenced_by_solo_bool =
        is_any_soloed_bool && !channel_obj.is_soloed_bool;
      channel_obj.refreshGain();
    }
    this.emit('solo', is_any_soloed_bool);
  }

  /**
   * Find the first channel that is not currently running.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (ToneChannel): The first idle channel, or null when all are running.
   */
  findFirstIdleChannel() {
    return (
      this.channels_list.find(
        (channel_obj) => !channel_obj.is_enabled_bool
      ) ?? null
    );
  }

  /**
   * Start every channel that is not already running.
   *
   * Arguments:
   *   when_seconds_float (number): Context time to start at, or null.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Sixteen simultaneous voices at default level will engage the master
   *   limiter. That is the limiter doing its job, not a fault.
   */
  startAllChannels(when_seconds_float = null) {
    for (const channel_obj of this.channels_list) {
      if (!channel_obj.is_enabled_bool) {
        channel_obj.start(when_seconds_float);
      }
    }
    this.emit('change');
  }

  /**
   * Stop every channel.
   *
   * Arguments:
   *   when_seconds_float (number): Context time to stop at, or null.
   *
   * Returns:
   *   (none)
   */
  stopAllChannels(when_seconds_float = null) {
    for (const channel_obj of this.channels_list) {
      channel_obj.stop(when_seconds_float);
    }
    this.emit('change');
  }

  /**
   * Stop everything and restore every channel to its defaults.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Discards all channel state with no undo.
   */
  resetAllChannels() {
    for (const channel_obj of this.channels_list) {
      channel_obj.stop();
      channel_obj.is_muted_bool = false;
      channel_obj.is_soloed_bool = false;
      channel_obj.is_silenced_by_solo_bool = false;
      channel_obj.gain_db_float = RESET_LEVEL_DB_FLOAT;
      channel_obj.pan_position_float = 0;
      channel_obj.phase_degrees_int = 0;
      channel_obj.detune_cents_float = 0;
      channel_obj.glide_ms_float = 0;
      channel_obj.waveform_name_str = 'sine';
      channel_obj.frequency_hertz_float = RESET_FREQUENCY_HERTZ_FLOAT;
      channel_obj.panner_node.pan.value = 0;
      channel_obj.emit('change', channel_obj);
    }
    this.emit('change');
  }

  /**
   * Capture the state of every channel.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object[]): One captured state per channel, in rack order.
   */
  toJSON() {
    return this.channels_list.map((channel_obj) => channel_obj.toJSON());
  }

  /**
   * Restore every channel from a previously captured array.
   *
   * Arguments:
   *   states_list (Object[]): States produced by toJSON.
   *
   * Returns:
   *   (ChannelRack): This rack, for chaining.
   *
   * Warning:
   *   Entries beyond the rack's channel count are ignored rather than
   *   creating extra channels.
   */
  fromJSON(states_list) {
    if (!Array.isArray(states_list)) {
      return this;
    }

    states_list.forEach((state_obj, index_int) => {
      this.channels_list[index_int]?.fromJSON(state_obj);
    });
    this.#applySoloMask();
    this.emit('change');
    return this;
  }
}
