/**
 * Concert Mode: multi-device orchestration.
 *
 * Brief:
 *   One device becomes the master; every other device that joins the room
 *   mirrors its state and plays in step with it. The interesting part is
 *   not the messaging, which is a room broadcast, it is the clock.
 *
 *   Two phones have unrelated performance.now() epochs and unrelated
 *   AudioContext clocks. Playing "now" on both is useless: the offset
 *   between them is tens of milliseconds, which at 300 Hz is many
 *   wavelengths and makes any phase claim meaningless. So each node runs an
 *   NTP-style exchange against the master, takes the median offset over
 *   several probes to reject jitter, and every scheduled event is expressed
 *   in master time. A node converts master time to its own AudioContext
 *   timeline and schedules against the sample clock, the only clock in the
 *   browser that does not drift.
 *
 *   Each node additionally carries a phase offset, 0-360 degrees, applied
 *   to every tone it plays. Two devices a metre apart, one at 0 and one at
 *   180, is a genuine active-cancellation experiment you can hear.
 *
 * Warning:
 *   The wire field names below (t, from, to, seq, c0, c1, phaseDeg and the
 *   rest) are the protocol, not our identifiers. They are deliberately left
 *   in their original spelling: renaming them would stop two devices
 *   running different builds from understanding each other.
 */

import { Emitter } from '../util/events.js';
import { clampToRange, computeMedian } from '../util/numeric.js';
import { applyWaveform } from '../core/waveforms.js';
import {
  createTransport,
  makeRoomCode,
  makePeerId,
  TRANSPORT_KINDS,
} from './transport.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** The part a device plays in a session. */
export const ROLE = Object.freeze({
  SOLO: 'solo',
  MASTER: 'master',
  NODE: 'node',
});

/** Probes per synchronisation burst, and the gap between them. */
const PROBE_COUNT_INT = 9;
const PROBE_INTERVAL_MS_INT = 220;

/** How often a node re-synchronises its clock, in milliseconds. */
const RESYNC_INTERVAL_MS_INT = 15000;

/** How long a peer may go unheard before it is dropped, in milliseconds. */
const PEER_TIMEOUT_MS_INT = 12000;

/** Interval between presence beats, in milliseconds. */
const HEARTBEAT_INTERVAL_MS_INT = 3000;

/** Lead time given to a scheduled tone, in milliseconds. */
const DEFAULT_LEAD_MS_INT = 600;

/** How late an event may arrive before it is dropped, in seconds. */
const LATE_TOLERANCE_SECONDS_FLOAT = 0.05;

/** Minimum lead given to a tone that only just arrived, in seconds. */
const MIN_START_LEAD_SECONDS_FLOAT = 0.005;

/** Envelope of a scheduled tone, in seconds. */
const SCHEDULED_ATTACK_SECONDS_FLOAT = 0.006;
const SCHEDULED_RELEASE_SECONDS_FLOAT = 0.02;
const SCHEDULED_MIN_SUSTAIN_SECONDS_FLOAT = 0.01;
const SCHEDULED_STOP_TAIL_SECONDS_FLOAT = 0.03;

/** A full turn, in degrees. */
const FULL_TURN_DEGREES_INT = 360;

/** Query parameters carried by a join link. */
const ROOM_PARAM_STR = 'r';
const RELAY_PARAM_STR = 's';

/* ------------------------------------------------------------------------ */

/**
 * Fold an angle into the range 0 to 359 degrees.
 *
 * Arguments:
 *   degrees_any (number): Any angle, possibly negative or over a turn.
 *
 * Returns:
 *   (number): The equivalent angle in [0, 360).
 */
function normaliseDegrees(degrees_any) {
  const rounded_int = Math.round(Number(degrees_any) || 0);
  return ((rounded_int % FULL_TURN_DEGREES_INT) + FULL_TURN_DEGREES_INT) %
    FULL_TURN_DEGREES_INT;
}

/**
 * Describe this device in one word, for the peer list.
 *
 * Brief:
 *   A platform name, not a fingerprint. The list has to let someone tell
 *   their phone from their laptop, and nothing more than that.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (string): A short platform name.
 */
function describePlatform() {
  const user_agent_str = navigator.userAgent;

  if (/iPhone|iPad/.test(user_agent_str)) {
    return 'iOS';
  }
  if (/Android/.test(user_agent_str)) {
    return 'Android';
  }
  if (/Mac/.test(user_agent_str)) {
    return 'macOS';
  }
  if (/Windows/.test(user_agent_str)) {
    return 'Windows';
  }
  if (/Linux/.test(user_agent_str)) {
    return 'Linux';
  }
  return 'device';
}

/* ------------------------------------------------------------------------ */

/**
 * Add this device's phase offset to every mirrored channel.
 *
 * Brief:
 *   Kept pure and exported so the one thing that has to be right about it
 *   can be asserted directly: the offset must be written under the key the
 *   channel deserialiser reads. Writing it under any other name leaves the
 *   node playing at the master's phase, which looks exactly like success -
 *   tones play, devices are in sync, and the cancellation simply never
 *   happens.
 *
 * Arguments:
 *   channel_states_list (Array<Object>|null): The master's channel states.
 *   phase_degrees_int (number): This device's offset, in degrees.
 *
 * Returns:
 *   (Array<Object>): Channel states with the offset folded in.
 */
export function foldPhaseIntoChannels(
  channel_states_list,
  phase_degrees_int
) {
  return (channel_states_list ?? []).map((channel_state_obj) => ({
    ...channel_state_obj,
    phase_degrees_int: normaliseDegrees(
      (channel_state_obj.phase_degrees_int ?? 0) + phase_degrees_int
    ),
  }));
}

/* ------------------------------------------------------------------------ */

/**
 * A multi-device Concert Mode session.
 *
 * Brief:
 *   Owns the role, the room, the peer list and the clock offset. Every
 *   scheduled event is expressed in master time and converted locally, so
 *   the only clock that matters on each device is its own sample clock.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (ConcertMode): The constructed session, initially solo.
 */
export class ConcertMode extends Emitter {
  role_str = ROLE.SOLO;
  room_code_str = null;
  peer_id_str = makePeerId();
  transport_obj = null;

  /** Master-clock offset: master time equals local time plus this. */
  offset_ms_float = 0;
  rtt_ms_float = 0;
  phase_degrees_int = 0;

  peers_map = new Map();

  #probes_list = [];
  #last_state_obj = null;
  #pending_probes_map = new Map();
  #probe_timer_int = null;
  #resync_timer_int = null;
  #heartbeat_timer_int = null;

  constructor(app_obj) {
    super();
    this.app_obj = app_obj;
  }

  /** True while a transport is connected. */
  get is_connected_bool() {
    return Boolean(this.transport_obj?.is_connected_bool);
  }

  /** How many other devices are currently in the room. */
  get peer_count_int() {
    return this.peers_map.size;
  }

  /**
   * Read this device's monotonic clock.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): Milliseconds since this page's time origin.
   */
  now() {
    return performance.now();
  }

  /**
   * Read the current instant on the master's clock.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (number): Milliseconds on the master's timeline.
   */
  masterNow() {
    return this.now() + this.offset_ms_float;
  }

  /**
   * Convert a master-clock timestamp into this device's audio time.
   *
   * Arguments:
   *   master_ms_float (number): An instant on the master's clock.
   *
   * Returns:
   *   (number): The same instant on this AudioContext's timeline.
   */
  toAudioTime(master_ms_float) {
    const local_ms_float = master_ms_float - this.offset_ms_float;
    return this.app_obj.engine.currentTimeSeconds +
      (local_ms_float - this.now()) / 1000;
  }

  /* ===================================================================
     Session lifecycle
     =================================================================== */

  /**
   * Become the master of a new room.
   *
   * Arguments:
   *   options_obj (Object): { kind_str, relay_url_str, room_code_str }.
   *
   * Returns:
   *   (Promise<ConcertMode>): This session, once hosting.
   */
  async host(options_obj = {}) {
    const {
      kind_str = 'local',
      relay_url_str = null,
      room_code_str = null,
    } = options_obj;

    await this.leave({ is_silent_bool: true });

    this.role_str = ROLE.MASTER;
    this.room_code_str = room_code_str || makeRoomCode();
    this.offset_ms_float = 0;
    this.rtt_ms_float = 0;

    this.transport_obj = createTransport(kind_str, {
      room_code_str: this.room_code_str,
      peer_id_str: this.peer_id_str,
      relay_url_str,
    });
    this.#bindTransport();
    await this.transport_obj.connect();

    this.#startHeartbeat();
    this.transport_obj.publish({
      t: 'hello', role: this.role_str, ua: describePlatform(),
    });
    this.emit('role', this.role_str);
    this.emit('room', this.room_code_str);
    return this;
  }

  /**
   * Join an existing room as a secondary node.
   *
   * Arguments:
   *   room_code_str (string): The room code from the master device.
   *   options_obj (Object): { kind_str, relay_url_str }.
   *
   * Returns:
   *   (Promise<ConcertMode>): This session, once joined.
   *
   * Warning:
   *   Synchronisation starts immediately; the offset is meaningless until
   *   the first burst settles, roughly two seconds later.
   */
  async join(room_code_str, options_obj = {}) {
    const { kind_str = 'local', relay_url_str = null } = options_obj;
    if (!room_code_str) {
      throw new Error('A room code is required.');
    }
    await this.leave({ is_silent_bool: true });

    this.role_str = ROLE.NODE;
    this.room_code_str = String(room_code_str).toUpperCase().trim();

    this.transport_obj = createTransport(kind_str, {
      room_code_str: this.room_code_str,
      peer_id_str: this.peer_id_str,
      relay_url_str,
    });
    this.#bindTransport();
    await this.transport_obj.connect();

    this.transport_obj.publish({
      t: 'hello',
      role: this.role_str,
      ua: describePlatform(),
      phaseDeg: this.phase_degrees_int,
    });
    this.#startHeartbeat();
    this.resync();

    this.emit('role', this.role_str);
    this.emit('room', this.room_code_str);
    return this;
  }

  /**
   * Leave the room and return to solo.
   *
   * Arguments:
   *   options_obj (Object): { is_silent_bool } to suppress the events.
   *
   * Returns:
   *   (Promise<ConcertMode>): This session.
   */
  async leave(options_obj = {}) {
    const { is_silent_bool = false } = options_obj;

    clearInterval(this.#probe_timer_int);
    clearInterval(this.#resync_timer_int);
    clearInterval(this.#heartbeat_timer_int);
    this.#probe_timer_int = null;
    this.#resync_timer_int = null;
    this.#heartbeat_timer_int = null;
    this.#pending_probes_map.clear();
    this.#probes_list = [];

    if (this.transport_obj) {
      try {
        this.transport_obj.publish({ t: 'bye' });
        this.transport_obj.close();
      } catch {
        // Already gone; nothing to announce to.
      }
      this.transport_obj = null;
    }

    this.peers_map.clear();
    this.role_str = ROLE.SOLO;
    this.room_code_str = null;
    this.offset_ms_float = 0;

    if (!is_silent_bool) {
      this.emit('role', this.role_str);
      this.emit('peers', []);
    }
    return this;
  }

  /* ===================================================================
     Messaging
     =================================================================== */

  /**
   * Forward the transport's events onto this session.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bindTransport() {
    const transport_obj = this.transport_obj;
    transport_obj.on(
      'message', (message_obj) => this.#onMessage(message_obj)
    );
    transport_obj.on('open', (info_obj) => this.emit('open', info_obj));
    transport_obj.on('close', () => this.emit('closed'));
    transport_obj.on(
      'rtcstate', (state_str) => this.emit('rtcstate', state_str)
    );
  }

  /**
   * Announce presence and drop peers that have gone quiet.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #startHeartbeat() {
    this.#heartbeat_timer_int = setInterval(() => {
      this.transport_obj?.publish({
        t: 'beat', role: this.role_str, phaseDeg: this.phase_degrees_int,
      });

      const cutoff_ms_float = this.now() - PEER_TIMEOUT_MS_INT;
      let has_dropped_bool = false;
      for (const [peer_id_str, peer_obj] of this.peers_map) {
        if (peer_obj.lastSeen < cutoff_ms_float) {
          this.peers_map.delete(peer_id_str);
          has_dropped_bool = true;
        }
      }
      if (has_dropped_bool) {
        this.emit('peers', [...this.peers_map.values()]);
      }
    }, HEARTBEAT_INTERVAL_MS_INT);
  }

  /**
   * Record that a peer was heard from.
   *
   * Arguments:
   *   message_obj (Object): The message that carried the news.
   *   extra_obj (Object): Fields to merge over the stored record.
   *
   * Returns:
   *   (Object): The updated peer record.
   */
  #touchPeer(message_obj, extra_obj = {}) {
    const existing_obj = this.peers_map.get(message_obj.from);
    const peer_obj = {
      id: message_obj.from,
      role: message_obj.role ?? existing_obj?.role ?? 'node',
      ua: message_obj.ua ?? existing_obj?.ua ?? '',
      rttMs: existing_obj?.rttMs ?? 0,
      phaseDeg: message_obj.phaseDeg ?? existing_obj?.phaseDeg ?? 0,
      ...existing_obj,
      ...extra_obj,
      lastSeen: this.now(),
    };
    this.peers_map.set(message_obj.from, peer_obj);
    return peer_obj;
  }

  /**
   * Handle a presence message.
   *
   * Arguments:
   *   message_obj (Object): A hello, beat or bye message.
   *
   * Returns:
   *   (none)
   */
  #onPresence(message_obj) {
    if (message_obj.t === 'bye') {
      this.peers_map.delete(message_obj.from);
      this.emit('peers', [...this.peers_map.values()]);
      return;
    }

    this.#touchPeer(message_obj);
    this.emit('peers', [...this.peers_map.values()]);

    if (message_obj.t !== 'hello') {
      return;
    }
    // Announce ourselves back so the newcomer learns about us too.
    this.transport_obj.publish({
      t: 'beat',
      role: this.role_str,
      ua: describePlatform(),
      phaseDeg: this.phase_degrees_int,
    });
    if (this.role_str === ROLE.MASTER) {
      this.broadcastState();
    }
  }

  /**
   * Handle one half of the clock exchange.
   *
   * Arguments:
   *   message_obj (Object): A probe or probe-reply message.
   *
   * Returns:
   *   (none)
   */
  #onClockMessage(message_obj) {
    if (message_obj.t === 'probe') {
      // Only the master answers probes; it stamps its own clock.
      if (this.role_str !== ROLE.MASTER) {
        return;
      }
      this.transport_obj.publish({
        t: 'probe-reply',
        to: message_obj.from,
        seq: message_obj.seq,
        c0: message_obj.c0,
        c1: this.now(),
      });
      return;
    }

    if (message_obj.to !== this.peer_id_str) {
      return;
    }
    const sent_ms_float = this.#pending_probes_map.get(message_obj.seq);
    if (sent_ms_float === undefined) {
      return;
    }
    this.#pending_probes_map.delete(message_obj.seq);

    const received_ms_float = this.now();
    const rtt_ms_float = received_ms_float - sent_ms_float;
    // Classic NTP estimator: assume the two legs are symmetric.
    const offset_ms_float =
      message_obj.c1 - (sent_ms_float + received_ms_float) / 2;

    this.#probes_list.push({ offset_ms_float, rtt_ms_float });
    this.emit('probe', {
      offset: offset_ms_float,
      rtt: rtt_ms_float,
      count: this.#probes_list.length,
    });
  }

  /**
   * Handle a control message from the master.
   *
   * Arguments:
   *   message_obj (Object): A state, script, schedule or stop message.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Only a node acts on these. A master ignoring them is what stops two
   *   masters in one room from driving each other in a loop.
   */
  #onControl(message_obj) {
    if (this.role_str !== ROLE.NODE) {
      return;
    }

    switch (message_obj.t) {
      case 'state':
        this.#applyState(message_obj.state);
        break;

      case 'script':
        this.emit('remote-script', message_obj);
        this.app_obj.runScript(message_obj.source, {
          label_str: `concert:${message_obj.label ?? 'remote'}`,
        });
        break;

      case 'schedule':
        this.#playScheduled(message_obj);
        break;

      case 'stop':
        this.app_obj.rack.stopAllChannels();
        this.app_obj.noise.stop();
        this.app_obj.vm.stop();
        break;

      default:
        break;
    }
  }

  /**
   * Route one inbound message to its handler.
   *
   * Arguments:
   *   message_obj (Object): The decoded message.
   *
   * Returns:
   *   (none)
   */
  #onMessage(message_obj) {
    switch (message_obj.t) {
      case 'hello':
      case 'beat':
      case 'bye':
        this.#onPresence(message_obj);
        break;

      case 'probe':
      case 'probe-reply':
        this.#onClockMessage(message_obj);
        break;

      case 'state':
      case 'script':
      case 'schedule':
      case 'stop':
        this.#onControl(message_obj);
        break;

      case 'phase':
        // The master can set a specific node's phase offset remotely.
        if (!message_obj.to || message_obj.to === this.peer_id_str) {
          this.setPhaseDegrees(
            message_obj.deg, { should_propagate_bool: false }
          );
        }
        break;

      default:
        this.emit('message', message_obj);
    }
  }

  /* ===================================================================
     Clock synchronisation
     =================================================================== */

  /**
   * Run a burst of probes and adopt the median offset.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (ConcertMode): This session, for chaining.
   *
   * Warning:
   *   Only a connected node synchronises. The master is the reference and
   *   has nothing to synchronise against.
   */
  resync() {
    if (this.role_str !== ROLE.NODE || !this.is_connected_bool) {
      return this;
    }

    clearInterval(this.#probe_timer_int);
    this.#probes_list = [];
    this.#pending_probes_map.clear();

    let sequence_int = 0;
    this.emit('syncing', true);

    this.#probe_timer_int = setInterval(() => {
      if (sequence_int >= PROBE_COUNT_INT) {
        clearInterval(this.#probe_timer_int);
        this.#probe_timer_int = null;
        this.#settleSync();
        return;
      }
      const this_sequence_int = sequence_int++;
      const sent_ms_float = this.now();
      this.#pending_probes_map.set(this_sequence_int, sent_ms_float);
      this.transport_obj.publish({
        t: 'probe', seq: this_sequence_int, c0: sent_ms_float,
      });
    }, PROBE_INTERVAL_MS_INT);

    clearInterval(this.#resync_timer_int);
    this.#resync_timer_int = setInterval(
      () => this.resync(), RESYNC_INTERVAL_MS_INT
    );
    return this;
  }

  /**
   * Adopt an offset from the completed probe burst.
   *
   * Brief:
   *   The slowest half of the probes is discarded. A probe that hit a
   *   scheduler stall carries a badly asymmetric round trip and therefore a
   *   correspondingly wrong offset, and the median alone does not remove it
   *   when several probes stall together.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #settleSync() {
    this.emit('syncing', false);
    if (!this.#probes_list.length) {
      this.emit('syncfail', 'No reply from the master node.');
      return;
    }

    const sorted_list = [...this.#probes_list].sort(
      (first_obj, second_obj) =>
        first_obj.rtt_ms_float - second_obj.rtt_ms_float
    );
    const best_list = sorted_list.slice(
      0, Math.max(1, Math.ceil(sorted_list.length / 2))
    );

    this.offset_ms_float = computeMedian(
      best_list.map((probe_obj) => probe_obj.offset_ms_float)
    );
    this.rtt_ms_float = computeMedian(
      best_list.map((probe_obj) => probe_obj.rtt_ms_float)
    );

    this.emit('sync', {
      offsetMs: this.offset_ms_float,
      rttMs: this.rtt_ms_float,
      samples: best_list.length,
    });
  }

  /* ===================================================================
     Master broadcasts
     =================================================================== */

  /**
   * Mirror the master's full channel and noise state to every node.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (boolean): False when this device is not a connected master.
   */
  broadcastState() {
    if (this.role_str !== ROLE.MASTER || !this.is_connected_bool) {
      return false;
    }
    return this.transport_obj.publish({
      t: 'state',
      state: {
        channels: this.app_obj.rack.toJSON(),
        noise: this.app_obj.noise.toJSON(),
        masterDb: this.app_obj.engine.masterLevelDb,
        a4: this.app_obj.tuning.referenceHertz,
      },
    });
  }

  /**
   * Ask every node to run a script.
   *
   * Arguments:
   *   source_str (string): The script source.
   *   label_str (string): Name shown in each node's terminal.
   *
   * Returns:
   *   (boolean): False when this device is not a connected master.
   */
  broadcastScript(source_str, label_str = 'remote') {
    if (this.role_str !== ROLE.MASTER || !this.is_connected_bool) {
      return false;
    }
    return this.transport_obj.publish({
      t: 'script', source: source_str, label: label_str,
    });
  }

  /**
   * Schedule a tone to begin on every node at the same instant.
   *
   * Arguments:
   *   options_obj (Object): { freq, durationMs, waveform, gainDb, leadMs }.
   *
   * Returns:
   *   (number|false): The master-clock start time, or false if not master.
   *
   * Warning:
   *   leadMs must exceed the worst round trip in the room, or slow nodes
   *   receive the instruction after the moment it names and drop it.
   */
  scheduleTone(options_obj) {
    const {
      freq,
      durationMs = 1000,
      waveform = 'sine',
      gainDb = -14,
      leadMs = DEFAULT_LEAD_MS_INT,
    } = options_obj;

    if (this.role_str !== ROLE.MASTER || !this.is_connected_bool) {
      return false;
    }

    const at_ms_float = this.masterNow() + leadMs;
    const payload_obj = {
      t: 'schedule', at: at_ms_float, freq, durationMs, waveform, gainDb,
    };
    this.transport_obj.publish(payload_obj);

    // The master honours its own instruction, so it is one of the voices.
    this.#playScheduled(payload_obj);
    return at_ms_float;
  }

  /**
   * Ask every node to fall silent.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (boolean): False when this device is not a connected master.
   */
  broadcastStop() {
    if (this.role_str !== ROLE.MASTER || !this.is_connected_bool) {
      return false;
    }
    return this.transport_obj.publish({ t: 'stop' });
  }

  /* ===================================================================
     Node behaviour
     =================================================================== */

  /**
   * Set this device's phase offset.
   *
   * Brief:
   *   Applied on top of every channel's own phase, which is what turns a
   *   room full of phones into an interference experiment rather than a
   *   chorus.
   *
   * Arguments:
   *   degrees_any (number): Offset in degrees; folded into 0-359.
   *   options_obj (Object): { should_propagate_bool }.
   *
   * Returns:
   *   (ConcertMode): This session, for chaining.
   *
   * Warning:
   *   The offset is re-folded into the last mirrored state rather than
   *   nudging the live channels, so repeated changes stay relative to the
   *   master's phases instead of compounding on themselves.
   */
  setPhaseDegrees(degrees_any, options_obj = {}) {
    const { should_propagate_bool = true } = options_obj;
    this.phase_degrees_int = normaliseDegrees(degrees_any);

    if (this.role_str === ROLE.NODE && this.#last_state_obj) {
      this.#applyState(this.#last_state_obj);
    }
    if (should_propagate_bool && this.is_connected_bool) {
      this.transport_obj.publish({
        t: 'beat', role: this.role_str, phaseDeg: this.phase_degrees_int,
      });
    }
    this.emit('phase', this.phase_degrees_int);
    return this;
  }

  /**
   * Push a phase offset to one node.
   *
   * Arguments:
   *   peer_id_str (string): The node to address.
   *   degrees_any (number): Offset in degrees.
   *
   * Returns:
   *   (boolean): False when this device is not a connected master.
   */
  setPeerPhase(peer_id_str, degrees_any) {
    if (this.role_str !== ROLE.MASTER || !this.is_connected_bool) {
      return false;
    }

    const peer_obj = this.peers_map.get(peer_id_str);
    if (peer_obj) {
      peer_obj.phaseDeg = normaliseDegrees(degrees_any);
      this.emit('peers', [...this.peers_map.values()]);
    }
    return this.transport_obj.publish({
      t: 'phase', to: peer_id_str, deg: degrees_any,
    });
  }

  /**
   * Adopt the master's mirrored state, folding in this node's phase.
   *
   * Arguments:
   *   state_obj (Object): The master's serialised state.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   The per-channel phase must be written under the same key the channel
   *   deserialiser reads, or the node's offset is silently dropped and
   *   every device plays at the master's phase.
   */
  #applyState(state_obj) {
    if (!state_obj) {
      return;
    }
    this.#last_state_obj = state_obj;

    if (Number.isFinite(state_obj.a4)) {
      this.app_obj.tuning.referenceHertz = state_obj.a4;
    }
    if (Number.isFinite(state_obj.masterDb)) {
      this.app_obj.engine.masterLevelDb = state_obj.masterDb;
    }

    this.app_obj.rack.fromJSON(
      foldPhaseIntoChannels(state_obj.channels, this.phase_degrees_int)
    );
    if (state_obj.noise) {
      this.app_obj.noise.fromJSON(state_obj.noise);
    }
    this.app_obj.syncUi?.();
    this.emit('mirrored', state_obj);
  }

  /**
   * Play a tone the master scheduled, on this device's sample clock.
   *
   * Arguments:
   *   message_obj (Object): { at, freq, durationMs, waveform, gainDb }.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   An instruction that arrives after the moment it names is dropped, not
   *   played late. Playing it late would be worse than not playing it: the
   *   whole point is that every device sounds at the same instant.
   */
  #playScheduled(message_obj) {
    const { at, freq, durationMs, waveform, gainDb } = message_obj;
    const engine_obj = this.app_obj.engine;
    const when_seconds_float = this.toAudioTime(at);
    const lead_seconds_float =
      when_seconds_float - engine_obj.currentTimeSeconds;

    if (lead_seconds_float < -LATE_TOLERANCE_SECONDS_FLOAT) {
      this.emit('late', { byMs: -lead_seconds_float * 1000 });
      return;
    }

    const start_seconds_float = Math.max(
      when_seconds_float,
      engine_obj.currentTimeSeconds + MIN_START_LEAD_SECONDS_FLOAT
    );
    this.#buildScheduledVoice({
      start_seconds_float,
      duration_seconds_float: durationMs / 1000,
      frequency_hertz_float: freq,
      waveform_name_str: waveform,
      gain_db_float: gainDb,
    });

    this.emit('scheduled', {
      freq, at, leadMs: lead_seconds_float * 1000,
    });
  }

  /**
   * Build and start one scheduled voice.
   *
   * Arguments:
   *   spec_obj (Object): Start, duration, frequency, waveform and level.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   This device's phase offset is applied here. It is what makes
   *   multi-node cancellation testable rather than theoretical.
   */
  #buildScheduledVoice(spec_obj) {
    const {
      start_seconds_float,
      duration_seconds_float,
      frequency_hertz_float,
      waveform_name_str,
      gain_db_float,
    } = spec_obj;

    const engine_obj = this.app_obj.engine;
    const ctx = engine_obj.context_obj;
    const oscillator_node = ctx.createOscillator();
    const gain_node = ctx.createGain();

    applyWaveform(
      oscillator_node, waveform_name_str, this.phase_degrees_int
    );
    oscillator_node.frequency.setValueAtTime(
      clampToRange(frequency_hertz_float, 0.01, ctx.sampleRate / 2 - 1),
      start_seconds_float
    );

    const amplitude_float = 10 ** (gain_db_float / 20);
    const sustain_seconds_float = Math.max(
      SCHEDULED_MIN_SUSTAIN_SECONDS_FLOAT,
      duration_seconds_float - SCHEDULED_RELEASE_SECONDS_FLOAT
    );
    gain_node.gain.setValueAtTime(0, start_seconds_float);
    gain_node.gain.linearRampToValueAtTime(
      amplitude_float,
      start_seconds_float + SCHEDULED_ATTACK_SECONDS_FLOAT
    );
    gain_node.gain.setValueAtTime(
      amplitude_float, start_seconds_float + sustain_seconds_float
    );
    gain_node.gain.linearRampToValueAtTime(
      0, start_seconds_float + duration_seconds_float
    );

    oscillator_node.connect(gain_node);
    gain_node.connect(engine_obj.channel_bus_node);
    oscillator_node.start(start_seconds_float);
    oscillator_node.stop(
      start_seconds_float + duration_seconds_float +
      SCHEDULED_STOP_TAIL_SECONDS_FLOAT
    );
    oscillator_node.onended = () => {
      try {
        oscillator_node.disconnect();
        gain_node.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }

  /* ===================================================================
     Join links
     =================================================================== */

  /**
   * Build a URL that drops a phone straight into this room.
   *
   * Arguments:
   *   options_obj (Object): { relay_url_str } to embed, if any.
   *
   * Returns:
   *   (string): The join URL, with the room in its hash.
   *
   * Warning:
   *   The room goes in the hash rather than the query string so it is never
   *   sent to the host serving the page.
   */
  joinUrl(options_obj = {}) {
    const { relay_url_str = null } = options_obj;
    const base_url_str = location.href.split('#')[0];
    const params_obj = new URLSearchParams();

    params_obj.set(ROOM_PARAM_STR, this.room_code_str ?? '');
    if (relay_url_str) {
      params_obj.set(RELAY_PARAM_STR, relay_url_str);
    }
    return `${base_url_str}#${params_obj.toString()}`;
  }

  /**
   * Parse a join link's hash, for auto-join on load.
   *
   * Arguments:
   *   hash_str (string): The location hash to read.
   *
   * Returns:
   *   (Object|null): { room_code_str, relay_url_str }, or null if absent.
   */
  static parseJoinUrl(hash_str = location.hash) {
    if (!hash_str || hash_str.length < 2) {
      return null;
    }
    const params_obj = new URLSearchParams(hash_str.slice(1));
    const room_code_str = params_obj.get(ROOM_PARAM_STR);
    if (!room_code_str) {
      return null;
    }
    return {
      room_code_str: room_code_str.toUpperCase(),
      relay_url_str: params_obj.get(RELAY_PARAM_STR) || null,
    };
  }
}

export { TRANSPORT_KINDS };
