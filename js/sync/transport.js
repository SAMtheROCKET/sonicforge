/**
 * Concert Mode transports, in three tiers.
 *
 *   1. LocalTransport   — BroadcastChannel. Same browser profile, different
 *                          tabs or windows. Zero infrastructure, works offline,
 *                          works on a static host. This is the default.
 *   2. RelayTransport   — WebSocket to a room-based relay. The practical
 *                          cross-device path: `python server/serve.py` runs one
 *                          on your LAN, and the join QR embeds its address.
 *   3. PeerTransport    — WebRTC DataChannel with manual SDP exchange. Truly
 *                          serverless device-to-device, at the cost of pasting
 *                          two codes. For people who will not run a relay.
 *
 * All three present the same surface, so concert.js never branches on kind.
 */

import { Emitter } from '../util/events.js';

export const TRANSPORT_KINDS = Object.freeze({
  local: { label: 'This browser', hint: 'Other tabs and windows in this profile. No setup.' },
  relay: { label: 'LAN relay', hint: 'Phones and laptops on your network, via a WebSocket relay.' },
  peer: { label: 'Direct P2P', hint: 'WebRTC with a manual code exchange. No server at all.' },
});

/** Random room code from an alphabet with no ambiguous glyphs. */
export function makeRoomCode(length = 6) {
  const alphabet = 'ACDEFGHJKLMNPQRTUVWXY3479';
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

export function makePeerId() {
  return Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

/* ========================================================================= */

class BaseTransport extends Emitter {
  connected = false;

  constructor(room, id) {
    super();
    this.room = room;
    this.id = id;
  }

  /** @abstract */
  async connect() {
    throw new Error('not implemented');
  }

  send() {
    throw new Error('not implemented');
  }

  close() {
    this.connected = false;
  }

  /** Attach routing metadata and hand off to the concrete implementation. */
  publish(msg) {
    if (!this.connected) return false;
    this.send({ ...msg, from: this.id, room: this.room });
    return true;
  }

  /** Normalise inbound traffic: ignore our own echo and other rooms. */
  _receive(raw) {
    let msg = raw;
    if (typeof raw === 'string') {
      try { msg = JSON.parse(raw); } catch { return; }
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.from === this.id) return;
    if (msg.room && msg.room !== this.room) return;
    this.emit('message', msg);
  }
}

/* =========================================================================
   Tier 1 — BroadcastChannel
   ========================================================================= */

export class LocalTransport extends BaseTransport {
  kind = 'local';

  async connect() {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastChannel is not supported in this browser.');
    }
    this.channel = new BroadcastChannel(`sonicforge:${this.room}`);
    this.channel.onmessage = (e) => this._receive(e.data);
    this.connected = true;
    this.emit('open', { kind: this.kind });
    return this;
  }

  send(msg) {
    this.channel?.postMessage(msg);
  }

  close() {
    try { this.channel?.close(); } catch {}
    this.channel = null;
    super.close();
    this.emit('close');
  }
}

/* =========================================================================
   Tier 2 — WebSocket relay
   ========================================================================= */

export class RelayTransport extends BaseTransport {
  kind = 'relay';
  #retries = 0;
  #closing = false;

  constructor(room, id, url) {
    super(room, id);
    this.url = url;
  }

  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        this.ws = new WebSocket(this.url);
      } catch (err) {
        return reject(new Error(`Invalid relay URL: ${err.message}`));
      }

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { this.ws.close(); } catch {}
        reject(new Error(`Relay at ${this.url} did not respond within 6 s.`));
      }, 6000);

      this.ws.onopen = () => {
        clearTimeout(timeout);
        this.connected = true;
        this.#retries = 0;
        this.ws.send(JSON.stringify({ t: 'join', room: this.room, from: this.id }));
        if (!settled) { settled = true; resolve(this); }
        this.emit('open', { kind: this.kind, url: this.url });
      };

      this.ws.onmessage = (e) => this._receive(e.data);

      this.ws.onerror = () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Could not reach the relay at ${this.url}.`));
        }
      };

      this.ws.onclose = () => {
        clearTimeout(timeout);
        this.connected = false;
        this.emit('close');
        if (!this.#closing && this.#retries < 5) {
          // Exponential backoff — a laptop lid closing should not end the session.
          const delay = 400 * 2 ** this.#retries++;
          setTimeout(() => { if (!this.#closing) this.connect().catch(() => {}); }, delay);
        }
      };
    });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.#closing = true;
    try { this.ws?.close(); } catch {}
    this.ws = null;
    super.close();
  }
}

/* =========================================================================
   Tier 3 — WebRTC with manual signalling
   ========================================================================= */

const RTC_CONFIG = {
  // Only public STUN; no TURN, because a TURN server would be infrastructure
  // and the entire point of this tier is having none.
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

export class PeerTransport extends BaseTransport {
  kind = 'peer';
  role = null;

  constructor(room, id) {
    super(room, id);
    this.pc = new RTCPeerConnection(RTC_CONFIG);
    this.pc.onconnectionstatechange = () => {
      this.emit('rtcstate', this.pc.connectionState);
      if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'disconnected') {
        this.connected = false;
        this.emit('close');
      }
    };
  }

  #wire(channel) {
    this.dc = channel;
    channel.onopen = () => {
      this.connected = true;
      this.emit('open', { kind: this.kind });
    };
    channel.onmessage = (e) => this._receive(e.data);
    channel.onclose = () => {
      this.connected = false;
      this.emit('close');
    };
  }

  /** Wait until ICE gathering finishes so the SDP is self-contained. */
  #gathered() {
    return new Promise((resolve) => {
      if (this.pc.iceGatheringState === 'complete') return resolve();
      const check = () => {
        if (this.pc.iceGatheringState === 'complete') {
          this.pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      this.pc.addEventListener('icegatheringstatechange', check);
      // Some networks never report 'complete'; ship what we have after 3 s.
      setTimeout(resolve, 3000);
    });
  }

  /** Master side: produce the invite code to paste into the other device. */
  async createOffer() {
    this.role = 'offerer';
    this.#wire(this.pc.createDataChannel('sonicforge', { ordered: true }));
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    await this.#gathered();
    return encodeSignal({ room: this.room, from: this.id, sdp: this.pc.localDescription });
  }

  /** Node side: consume the invite code and produce the reply code. */
  async acceptOffer(code) {
    this.role = 'answerer';
    const signal = decodeSignal(code);
    this.room = signal.room ?? this.room;
    this.pc.ondatachannel = (e) => this.#wire(e.channel);
    await this.pc.setRemoteDescription(signal.sdp);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    await this.#gathered();
    return encodeSignal({ room: this.room, from: this.id, sdp: this.pc.localDescription });
  }

  /** Master side: consume the reply code; the channel opens shortly after. */
  async acceptAnswer(code) {
    const signal = decodeSignal(code);
    await this.pc.setRemoteDescription(signal.sdp);
    return this;
  }

  async connect() {
    // Connection is established by the offer/answer exchange above.
    return this;
  }

  send(msg) {
    if (this.dc?.readyState === 'open') this.dc.send(JSON.stringify(msg));
  }

  close() {
    try { this.dc?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    super.close();
    this.emit('close');
  }
}

/** Pack a signalling blob into a compact, paste-safe string. */
export function encodeSignal(obj) {
  const json = JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `SF1:${btoa(bin).replace(/=+$/, '')}`;
}

export function decodeSignal(code) {
  const trimmed = String(code).trim();
  if (!trimmed.startsWith('SF1:')) throw new Error('That is not a SonicForge pairing code.');
  const b64 = trimmed.slice(4).replace(/\s+/g, '');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

/* ========================================================================= */

export function createTransport(kind, { room, id, relayUrl } = {}) {
  switch (kind) {
    case 'relay':
      if (!relayUrl) throw new Error('A relay URL is required for LAN mode.');
      return new RelayTransport(room, id, relayUrl);
    case 'peer':
      if (typeof RTCPeerConnection === 'undefined') {
        throw new Error('WebRTC is not available in this browser.');
      }
      return new PeerTransport(room, id);
    case 'local':
    default:
      return new LocalTransport(room, id);
  }
}
