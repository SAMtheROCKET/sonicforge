/**
 * Concert Mode — multi-device orchestration.
 *
 * One device becomes the Master Node; every other device that joins the room
 * mirrors its state and plays in step with it. The interesting part is not the
 * messaging (that is a room broadcast), it is the CLOCK.
 *
 * Two phones have unrelated `performance.now()` epochs and unrelated
 * AudioContext clocks. Playing "now" on both is useless — the offset between
 * them is tens of milliseconds, which at 300 Hz is many wavelengths and makes
 * any phase claim meaningless. So each node runs an NTP-style exchange against
 * the master, takes the median offset over several probes to reject jitter,
 * and every scheduled event is expressed in MASTER time. A node converts
 * master time to its own AudioContext timeline and schedules against the
 * sample clock, which is the only clock in the browser that does not drift.
 *
 * Each node additionally carries a phase offset, 0–360°, applied to every tone
 * it plays. Two devices a metre apart, one at 0° and one at 180°, is a
 * genuine active-cancellation experiment you can hear.
 */

import { Emitter } from '../util/events.js';
import { clampToRange, computeMedian } from '../util/numeric.js';
import { applyWaveform } from '../core/waveforms.js';
import { createTransport, makeRoomCode, makePeerId, TRANSPORT_KINDS } from './transport.js';

export const ROLE = Object.freeze({ SOLO: 'solo', MASTER: 'master', NODE: 'node' });

const PROBE_COUNT = 9;
const PROBE_INTERVAL = 220;
const RESYNC_INTERVAL = 15000;
const PEER_TIMEOUT = 12000;

export class ConcertMode extends Emitter {
  role = ROLE.SOLO;
  room = null;
  id = makePeerId();
  transport = null;

  /** Master-clock offset in ms: masterTime = localTime + offsetMs */
  offsetMs = 0;
  rttMs = 0;
  phaseDeg = 0;

  /** @type {Map<string, {id:string, role:string, lastSeen:number, rttMs:number, phaseDeg:number, ua:string}>} */
  peers = new Map();

  #probes = [];
  #lastState = null;
  #pending = new Map();
  #probeTimer = null;
  #resyncTimer = null;
  #heartbeat = null;

  constructor(app) {
    super();
    this.app = app;
  }

  get connected() {
    return !!this.transport?.connected;
  }

  get peerCount() {
    return this.peers.size;
  }

  /** Local monotonic clock, in milliseconds. */
  now() {
    return performance.now();
  }

  /** The same instant expressed on the master's clock. */
  masterNow() {
    return this.now() + this.offsetMs;
  }

  /** Convert a master-clock timestamp into this device's AudioContext time. */
  toAudioTime(masterMs) {
    const localMs = masterMs - this.offsetMs;
    return this.app.engine.currentTimeSeconds + (localMs - this.now()) / 1000;
  }

  /* ===================================================================
     Session lifecycle
     =================================================================== */

  /**
   * Become the master of a new room.
   * @param {{kind?:string, relayUrl?:string, room?:string}} opts
   */
  async host({ kind = 'local', relayUrl = null, room = null } = {}) {
    await this.leave({ silent: true });

    this.role = ROLE.MASTER;
    this.room = room || makeRoomCode();
    this.offsetMs = 0;
    this.rttMs = 0;

    this.transport = createTransport(kind, { room: this.room, id: this.id, relayUrl });
    this.#bind();
    await this.transport.connect();

    this.#startHeartbeat();
    this.transport.publish({ t: 'hello', role: this.role, ua: shortUA() });
    this.emit('role', this.role);
    this.emit('room', this.room);
    return this;
  }

  /**
   * Join an existing room as a secondary node.
   */
  async join(room, { kind = 'local', relayUrl = null } = {}) {
    if (!room) throw new Error('A room code is required.');
    await this.leave({ silent: true });

    this.role = ROLE.NODE;
    this.room = String(room).toUpperCase().trim();

    this.transport = createTransport(kind, { room: this.room, id: this.id, relayUrl });
    this.#bind();
    await this.transport.connect();

    this.transport.publish({ t: 'hello', role: this.role, ua: shortUA(), phaseDeg: this.phaseDeg });
    this.#startHeartbeat();
    this.resync();

    this.emit('role', this.role);
    this.emit('room', this.room);
    return this;
  }

  async leave({ silent = false } = {}) {
    clearInterval(this.#probeTimer);
    clearInterval(this.#resyncTimer);
    clearInterval(this.#heartbeat);
    this.#probeTimer = this.#resyncTimer = this.#heartbeat = null;
    this.#pending.clear();
    this.#probes = [];

    if (this.transport) {
      try {
        this.transport.publish({ t: 'bye' });
        this.transport.close();
      } catch {}
      this.transport = null;
    }

    this.peers.clear();
    this.role = ROLE.SOLO;
    this.room = null;
    this.offsetMs = 0;
    if (!silent) {
      this.emit('role', this.role);
      this.emit('peers', []);
    }
    return this;
  }

  /* ===================================================================
     Messaging
     =================================================================== */

  #bind() {
    const t = this.transport;
    t.on('message', (msg) => this.#onMessage(msg));
    t.on('open', (info) => this.emit('open', info));
    t.on('close', () => this.emit('closed'));
    t.on('rtcstate', (s) => this.emit('rtcstate', s));
  }

  #startHeartbeat() {
    this.#heartbeat = setInterval(() => {
      this.transport?.publish({ t: 'beat', role: this.role, phaseDeg: this.phaseDeg });
      const cutoff = this.now() - PEER_TIMEOUT;
      let dropped = false;
      for (const [id, p] of this.peers) {
        if (p.lastSeen < cutoff) { this.peers.delete(id); dropped = true; }
      }
      if (dropped) this.emit('peers', [...this.peers.values()]);
    }, 3000);
  }

  #touch(msg, extra = {}) {
    const existing = this.peers.get(msg.from);
    const peer = {
      id: msg.from,
      role: msg.role ?? existing?.role ?? 'node',
      ua: msg.ua ?? existing?.ua ?? '',
      rttMs: existing?.rttMs ?? 0,
      phaseDeg: msg.phaseDeg ?? existing?.phaseDeg ?? 0,
      ...existing,
      ...extra,
      lastSeen: this.now(),
    };
    this.peers.set(msg.from, peer);
    return peer;
  }

  #onMessage(msg) {
    switch (msg.t) {
      /* --- presence ------------------------------------------------- */
      case 'hello': {
        this.#touch(msg);
        this.emit('peers', [...this.peers.values()]);
        // Announce ourselves back so the newcomer learns about us too.
        this.transport.publish({ t: 'beat', role: this.role, ua: shortUA(), phaseDeg: this.phaseDeg });
        if (this.role === ROLE.MASTER) this.broadcastState();
        break;
      }

      case 'beat': {
        this.#touch(msg);
        this.emit('peers', [...this.peers.values()]);
        break;
      }

      case 'bye': {
        this.peers.delete(msg.from);
        this.emit('peers', [...this.peers.values()]);
        break;
      }

      /* --- clock synchronisation ------------------------------------ */
      case 'probe': {
        // Only the master answers probes; it stamps its own clock.
        if (this.role !== ROLE.MASTER) break;
        this.transport.publish({ t: 'probe-reply', to: msg.from, seq: msg.seq, c0: msg.c0, c1: this.now() });
        break;
      }

      case 'probe-reply': {
        if (msg.to !== this.id) break;
        const sent = this.#pending.get(msg.seq);
        if (sent === undefined) break;
        this.#pending.delete(msg.seq);

        const c2 = this.now();
        const rtt = c2 - sent;
        // Classic NTP estimator: assume the two legs are symmetric.
        const offset = msg.c1 - (sent + c2) / 2;
        this.#probes.push({ offset, rtt });
        this.emit('probe', { offset, rtt, count: this.#probes.length });
        break;
      }

      /* --- control -------------------------------------------------- */
      case 'state': {
        if (this.role !== ROLE.NODE) break;
        this.#applyState(msg.state);
        break;
      }

      case 'script': {
        if (this.role !== ROLE.NODE) break;
        this.emit('remote-script', msg);
        this.app.runScript(msg.source, { label: `concert:${msg.label ?? 'remote'}` });
        break;
      }

      case 'schedule': {
        if (this.role !== ROLE.NODE) break;
        this.#playScheduled(msg);
        break;
      }

      case 'stop': {
        if (this.role !== ROLE.NODE) break;
        this.app.rack.stopAllChannels();
        this.app.noise.stop();
        this.app.vm.stop();
        break;
      }

      case 'phase': {
        // The master can set a specific node's phase offset remotely.
        if (msg.to && msg.to !== this.id) break;
        this.setPhaseDegrees(msg.deg, { propagate: false });
        break;
      }

      default:
        this.emit('message', msg);
    }
  }

  /* ===================================================================
     Clock synchronisation
     =================================================================== */

  /** Run a burst of probes and adopt the median offset. */
  resync() {
    if (this.role !== ROLE.NODE || !this.connected) return this;

    clearInterval(this.#probeTimer);
    this.#probes = [];
    this.#pending.clear();

    let seq = 0;
    this.emit('syncing', true);

    this.#probeTimer = setInterval(() => {
      if (seq >= PROBE_COUNT) {
        clearInterval(this.#probeTimer);
        this.#probeTimer = null;
        this.#settleSync();
        return;
      }
      const s = seq++;
      const c0 = this.now();
      this.#pending.set(s, c0);
      this.transport.publish({ t: 'probe', seq: s, c0 });
    }, PROBE_INTERVAL);

    clearInterval(this.#resyncTimer);
    this.#resyncTimer = setInterval(() => this.resync(), RESYNC_INTERVAL);
    return this;
  }

  #settleSync() {
    this.emit('syncing', false);
    if (!this.#probes.length) {
      this.emit('syncfail', 'No reply from the master node.');
      return;
    }

    // Discard the slowest half: a probe that hit a scheduler stall carries a
    // badly asymmetric round trip and a correspondingly wrong offset.
    const sorted = [...this.#probes].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));

    this.offsetMs = computeMedian(best.map((p) => p.offset));
    this.rttMs = computeMedian(best.map((p) => p.rtt));

    this.emit('sync', { offsetMs: this.offsetMs, rttMs: this.rttMs, samples: best.length });
  }

  /* ===================================================================
     Master broadcasts
     =================================================================== */

  /** Mirror the master's full channel + noise state to every node. */
  broadcastState() {
    if (this.role !== ROLE.MASTER || !this.connected) return false;
    return this.transport.publish({
      t: 'state',
      state: {
        channels: this.app.rack.toJSON(),
        noise: this.app.noise.toJSON(),
        masterDb: this.app.engine.masterLevelDb,
        a4: this.app.tuning.referenceHertz,
      },
    });
  }

  /** Ask every node to run a script. */
  broadcastScript(source, label = 'remote') {
    if (this.role !== ROLE.MASTER || !this.connected) return false;
    return this.transport.publish({ t: 'script', source, label });
  }

  /**
   * Schedule a tone to begin on every node at the same instant.
   * `leadMs` must exceed the worst round trip, or slow nodes miss the window.
   */
  scheduleTone({ freq, durationMs = 1000, waveform = 'sine', gainDb = -14, leadMs = 600 }) {
    if (this.role !== ROLE.MASTER || !this.connected) return false;
    const at = this.masterNow() + leadMs;
    const payload = { t: 'schedule', at, freq, durationMs, waveform, gainDb };
    this.transport.publish(payload);
    // The master honours its own instruction, so it is one of the voices.
    this.#playScheduled(payload);
    return at;
  }

  broadcastStop() {
    if (this.role !== ROLE.MASTER || !this.connected) return false;
    return this.transport.publish({ t: 'stop' });
  }

  /* ===================================================================
     Node behaviour
     =================================================================== */

  /**
   * Set this device's phase offset. Applied on top of every channel's own
   * phase, which is what makes a room full of phones into an interference
   * experiment rather than a chorus.
   */
  setPhase(deg, { propagate = true } = {}) {
    this.phaseDeg = ((Math.round(Number(deg) || 0) % 360) + 360) % 360;

    // Re-fold the offset into the last mirrored state rather than nudging the
    // live channels, so repeated changes stay relative to the master's phases
    // instead of compounding on themselves.
    if (this.role === ROLE.NODE && this.#lastState) this.#applyState(this.#lastState);

    if (propagate && this.connected) {
      this.transport.publish({ t: 'beat', role: this.role, phaseDeg: this.phaseDeg });
    }
    this.emit('phase', this.phaseDeg);
    return this;
  }

  /** Master-side: push a phase offset to one node. */
  setPeerPhase(peerId, deg) {
    if (this.role !== ROLE.MASTER || !this.connected) return false;
    const p = this.peers.get(peerId);
    if (p) { p.phaseDeg = ((deg % 360) + 360) % 360; this.emit('peers', [...this.peers.values()]); }
    return this.transport.publish({ t: 'phase', to: peerId, deg });
  }

  #applyState(state) {
    if (!state) return;
    this.#lastState = state;
    if (Number.isFinite(state.a4)) this.app.tuning.referenceHertz = state.a4;
    if (Number.isFinite(state.masterDb)) this.app.engine.masterLevelDb = state.masterDb;

    // Channels inherit the master's parameters, then this node's own phase
    // offset is folded in on top.
    const channels = (state.channels ?? []).map((c) => ({
      ...c,
      phaseDeg: (((c.phase_degrees_int ?? 0) + this.phaseDeg) % 360 + 360) % 360,
    }));
    this.app.rack.fromJSON(channels);
    if (state.noise) this.app.noise.fromJSON(state.noise);
    this.app.syncUi?.();
    this.emit('mirrored', state);
  }

  #playScheduled({ at, freq, durationMs, waveform, gainDb }) {
    const when = this.toAudioTime(at);
    const engine = this.app.engine;
    const ctx = engine.context_obj;
    const lead = when - engine.currentTimeSeconds;

    if (lead < -0.05) {
      this.emit('late', { byMs: -lead * 1000 });
      return;
    }

    const start = Math.max(when, engine.currentTimeSeconds + 0.005);
    const durSec = durationMs / 1000;

    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    // The device phase offset is what makes multi-node cancellation testable.
    applyWaveform(osc, waveform, this.phaseDeg);
    osc.frequency.setValueAtTime(clampToRange(freq, 0.01, ctx.sampleRate / 2 - 1), start);

    const amp = 10 ** (gainDb / 20);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(amp, start + 0.006);
    g.gain.setValueAtTime(amp, start + Math.max(0.01, durSec - 0.02));
    g.gain.linearRampToValueAtTime(0, start + durSec);

    osc.connect(g);
    g.connect(engine.channel_bus_node);
    osc.start(start);
    osc.stop(start + durSec + 0.03);
    osc.onended = () => { try { osc.disconnect(); g.disconnect(); } catch {} };

    this.emit('scheduled', { freq, at, leadMs: lead * 1000 });
  }

  /* ===================================================================
     Join links
     =================================================================== */

  /** A URL that drops a phone straight into this room. */
  joinUrl({ relayUrl = null } = {}) {
    const base = location.href.split('#')[0];
    const params = new URLSearchParams();
    params.set('r', this.room ?? '');
    if (relayUrl) params.set('s', relayUrl);
    return `${base}#${params.toString()}`;
  }

  /** Parse a join link's hash, for auto-join on load. */
  static parseJoinUrl(hash = location.hash) {
    if (!hash || hash.length < 2) return null;
    const params = new URLSearchParams(hash.slice(1));
    const room = params.get('r');
    if (!room) return null;
    return { room: room.toUpperCase(), relayUrl: params.get('s') || null };
  }
}

function shortUA() {
  const ua = navigator.userAgent;
  if (/iPhone|iPad/.test(ua)) return 'iOS';
  if (/Android/.test(ua)) return 'Android';
  if (/Mac/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux/.test(ua)) return 'Linux';
  return 'device';
}

export { TRANSPORT_KINDS };
