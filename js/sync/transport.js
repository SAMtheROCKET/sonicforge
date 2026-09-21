/**
 * Concert Mode transports, in three tiers.
 *
 * Brief:
 *   LocalTransport uses BroadcastChannel: same browser profile, different
 *   tabs or windows. Zero infrastructure, works offline, works on a static
 *   host. This is the default.
 *
 *   RelayTransport uses a WebSocket to a room-based relay. The practical
 *   cross-device path: `python server/serve.py` runs one on your network,
 *   and the join QR embeds its address.
 *
 *   PeerTransport uses a WebRTC data channel with manual signalling. Truly
 *   serverless device to device, at the cost of pasting two codes. For
 *   people who will not run a relay.
 *
 *   All three present the same surface, so concert.js never branches on
 *   which tier is in use.
 */

import { Emitter } from '../util/events.js';
import { encodeSignal, decodeSignal } from './signal-codec.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** The tiers, with the copy the interface shows for each. */
export const TRANSPORT_KINDS = Object.freeze({
  local: {
    label: 'This browser',
    hint: 'Other tabs and windows in this profile. No setup.',
  },
  relay: {
    label: 'LAN relay',
    hint: 'Phones and laptops on your network, via a WebSocket relay.',
  },
  peer: {
    label: 'Direct P2P',
    hint: 'WebRTC with a manual code exchange. No server at all.',
  },
});

/**
 * Room-code alphabet, with every ambiguous glyph removed.
 *
 * No O/0, I/1, S/5, B/8 or Z/2, because a room code is read aloud and typed
 * on a phone keyboard at least as often as it is scanned.
 */
const ROOM_CODE_ALPHABET_STR = 'ACDEFGHJKLMNPQRTUVWXY3479';

/** Default room-code length. */
const DEFAULT_ROOM_CODE_LENGTH_INT = 6;

/** Bytes of entropy behind a peer id, rendered as hexadecimal. */
const PEER_ID_BYTE_COUNT_INT = 4;

/** How long a relay has to answer before the attempt fails, in ms. */
const RELAY_TIMEOUT_MS_INT = 6000;

/** Reconnection attempts, and the backoff base, in milliseconds. */
const MAX_RELAY_RETRIES_INT = 5;
const RELAY_BACKOFF_BASE_MS_INT = 400;

/** How long to wait for ICE gathering before shipping what we have. */
const ICE_GATHERING_TIMEOUT_MS_INT = 3000;

/**
 * WebRTC configuration.
 *
 * Public STUN only, no TURN. A TURN server would be infrastructure, and
 * having none is the entire point of this tier.
 */
const RTC_CONFIG_OBJ = Object.freeze({
  iceServers: [{
    urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
    ],
  }],
});

/* ------------------------------------------------------------------------ */

/**
 * Generate a random room code.
 *
 * Brief:
 *   Drawn from an alphabet with every ambiguous glyph removed, because
 *   a room code is read aloud and typed on a phone at least as often as
 *   it is scanned.
 *
 * Arguments:
 *   length_int (number): How many characters to produce.
 *
 * Returns:
 *   (string): A code drawn from the unambiguous alphabet.
 */
export function makeRoomCode(length_int = DEFAULT_ROOM_CODE_LENGTH_INT) {
  const bytes_uint8array = new Uint8Array(length_int);
  crypto.getRandomValues(bytes_uint8array);
  return Array.from(
    bytes_uint8array,
    (byte_int) => ROOM_CODE_ALPHABET_STR[
      byte_int % ROOM_CODE_ALPHABET_STR.length
    ]
  ).join('');
}

/**
 * Generate a short identifier for this device within a room.
 *
 * Brief:
 *   Only has to be unique within one room, so four bytes is ample and
 *   keeps the peer list readable.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (string): Eight hexadecimal characters.
 */
export function makePeerId() {
  const bytes_uint8array = crypto.getRandomValues(
    new Uint8Array(PEER_ID_BYTE_COUNT_INT)
  );
  return Array.from(
    bytes_uint8array, (byte_int) => byte_int.toString(16).padStart(2, '0')
  ).join('');
}

/* ------------------------------------------------------------------------ */

/**
 * Shared behaviour for every transport tier.
 *
 * Brief:
 *   Owns the routing metadata and the inbound filter, so each tier only has
 *   to move bytes. Not instantiated directly.
 *
 * Arguments:
 *   room_code_str (string): The room this transport belongs to.
 *   peer_id_str (string): This device's identifier within the room.
 *
 * Returns:
 *   (BaseTransport): The constructed transport.
 */
class BaseTransport extends Emitter {
  is_connected_bool = false;

  constructor(room_code_str, peer_id_str) {
    super();
    this.room_code_str = room_code_str;
    this.peer_id_str = peer_id_str;
  }

  /**
   * Open the underlying connection.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<BaseTransport>): This transport, once connected.
   *
   * Warning:
   *   Abstract. Each tier must override it.
   */
  async connect() {
    throw new Error('not implemented');
  }

  /**
   * Put one message onto the wire.
   *
   * Arguments:
   *   message_obj (Object): The message, already carrying routing fields.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Abstract. Each tier must override it.
   */
  send() {
    throw new Error('not implemented');
  }

  /**
   * Close the underlying connection.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  close() {
    this.is_connected_bool = false;
  }

  /**
   * Attach routing metadata and hand off to the concrete implementation.
   *
   * Arguments:
   *   message_obj (Object): The message body.
   *
   * Returns:
   *   (boolean): False when there is no connection to publish on.
   */
  publish(message_obj) {
    if (!this.is_connected_bool) {
      return false;
    }
    this.send({
      ...message_obj,
      from: this.peer_id_str,
      room: this.room_code_str,
    });
    return true;
  }

  /**
   * Normalise inbound traffic and emit it as a message.
   *
   * Brief:
   *   Drops our own echo and anything addressed to a different room, so the
   *   session logic never has to think about either.
   *
   * Arguments:
   *   raw_any (string|Object): Whatever the underlying channel delivered.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   Called by subclasses, not by consumers. Inbound data is untrusted:
   *   malformed JSON is discarded silently rather than thrown, because a
   *   stray frame must not end the session.
   */
  receiveRaw(raw_any) {
    let message_obj = raw_any;

    if (typeof raw_any === 'string') {
      try {
        message_obj = JSON.parse(raw_any);
      } catch {
        return;
      }
    }
    if (!message_obj || typeof message_obj !== 'object') {
      return;
    }
    if (message_obj.from === this.peer_id_str) {
      return;
    }
    if (message_obj.room && message_obj.room !== this.room_code_str) {
      return;
    }
    this.emit('message', message_obj);
  }
}

/* ------------------------------------------------------------------------ */

/**
 * Tier 1: other tabs and windows in the same browser profile.
 *
 * Brief:
 *   Needs no infrastructure at all and works offline, which makes it the
 *   right default and the only tier that can be relied on everywhere.
 *
 * Arguments:
 *   room_code_str (string): The room to join.
 *   peer_id_str (string): This device's identifier.
 *
 * Returns:
 *   (LocalTransport): The constructed transport.
 */
export class LocalTransport extends BaseTransport {
  kind_str = 'local';

  /**
   * Open the broadcast channel for this room.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<LocalTransport>): This transport.
   *
   * Warning:
   *   Throws where BroadcastChannel is unavailable, which the panel reports
   *   as a reason to pick another tier.
   */
  async connect() {
    if (typeof BroadcastChannel === 'undefined') {
      throw new Error('BroadcastChannel is not supported in this browser.');
    }
    this.channel_obj = new BroadcastChannel(
      `sonicforge:${this.room_code_str}`
    );
    this.channel_obj.onmessage =
      (message_event) => this.receiveRaw(message_event.data);
    this.is_connected_bool = true;
    this.emit('open', { kind: this.kind_str });
    return this;
  }

  /**
   * Post one message to the channel.
   *
   * Arguments:
   *   message_obj (Object): The message to post.
   *
   * Returns:
   *   (none)
   */
  send(message_obj) {
    this.channel_obj?.postMessage(message_obj);
  }

  /**
   * Close the broadcast channel.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  close() {
    try {
      this.channel_obj?.close();
    } catch {
      // Already closed.
    }
    this.channel_obj = null;
    super.close();
    this.emit('close');
  }
}

/* ------------------------------------------------------------------------ */

/**
 * Tier 2: a WebSocket relay shared across devices on one network.
 *
 * Brief:
 *   The practical cross-device path. Reconnects with backoff, so a
 *   sleeping laptop rejoins rather than dropping the session.
 *
 * Arguments:
 *   room_code_str (string): The room to join.
 *   peer_id_str (string): This device's identifier.
 *   relay_url_str (string): WebSocket URL of the relay.
 *
 * Returns:
 *   (RelayTransport): The constructed transport.
 */
export class RelayTransport extends BaseTransport {
  kind_str = 'relay';

  #retry_count_int = 0;
  #is_closing_bool = false;

  constructor(room_code_str, peer_id_str, relay_url_str) {
    super(room_code_str, peer_id_str);
    this.relay_url_str = relay_url_str;
  }

  /**
   * Schedule a reconnection attempt after an unexpected close.
   *
   * Brief:
   *   Exponential backoff, because a laptop lid closing should not end the
   *   session, but a relay that has genuinely gone should not be hammered.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #scheduleReconnect() {
    if (this.#is_closing_bool ||
      this.#retry_count_int >= MAX_RELAY_RETRIES_INT) {
      return;
    }
    const delay_ms_int =
      RELAY_BACKOFF_BASE_MS_INT * 2 ** this.#retry_count_int++;

    setTimeout(() => {
      if (!this.#is_closing_bool) {
        this.connect().catch(() => {
          // Reported through the close event; nothing more to do here.
        });
      }
    }, delay_ms_int);
  }

  /**
   * Attach the socket's lifecycle handlers.
   *
   * Arguments:
   *   settlement_obj (Object): { settleOnce, reject_fn, clearTimer } from
   *     the connect promise, so this can resolve or reject it exactly once.
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   A socket may fire error and close in either order, so settlement is
   *   funnelled through one guard rather than tracked per handler.
   */
  #wireSocket(settlement_obj) {
    const { settleOnce, reject_fn, clearTimer } = settlement_obj;

    this.socket_obj.onopen = () => {
      clearTimer();
      this.is_connected_bool = true;
      this.#retry_count_int = 0;
      this.socket_obj.send(JSON.stringify({
        t: 'join', room: this.room_code_str, from: this.peer_id_str,
      }));
      settleOnce(true);
      this.emit('open', { kind: this.kind_str, url: this.relay_url_str });
    };

    this.socket_obj.onmessage =
      (message_event) => this.receiveRaw(message_event.data);

    this.socket_obj.onerror = () => {
      if (settleOnce(false)) {
        reject_fn(new Error(
          `Could not reach the relay at ${this.relay_url_str}.`
        ));
      }
    };

    this.socket_obj.onclose = () => {
      clearTimer();
      this.is_connected_bool = false;
      this.emit('close');
      this.#scheduleReconnect();
    };
  }

  /**
   * Open the WebSocket and join the room.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<RelayTransport>): This transport, once the socket is open.
   *
   * Warning:
   *   Rejects on an invalid URL, on a socket error, and on a timeout. The
   *   settled flag exists because a socket can fire error and close in
   *   either order, and the promise must settle exactly once.
   */
  connect() {
    return new Promise((resolve_fn, reject_fn) => {
      let is_settled_bool = false;

      try {
        this.socket_obj = new WebSocket(this.relay_url_str);
      } catch (err) {
        reject_fn(new Error(`Invalid relay URL: ${err.message}`));
        return;
      }

      const timeout_id_int = setTimeout(() => {
        if (is_settled_bool) {
          return;
        }
        is_settled_bool = true;
        try {
          this.socket_obj.close();
        } catch {
          // Never opened.
        }
        reject_fn(new Error(
          `Relay at ${this.relay_url_str} did not respond within 6 s.`
        ));
      }, RELAY_TIMEOUT_MS_INT);

      this.#wireSocket({
        settleOnce: (accept_bool) => {
          if (is_settled_bool) {
            return false;
          }
          is_settled_bool = true;
          clearTimeout(timeout_id_int);
          if (accept_bool) {
            resolve_fn(this);
          }
          return true;
        },
        reject_fn,
        clearTimer: () => clearTimeout(timeout_id_int),
      });
    });
  }

  /**
   * Send one message over the socket.
   *
   * Arguments:
   *   message_obj (Object): The message to send.
   *
   * Returns:
   *   (none)
   */
  send(message_obj) {
    if (this.socket_obj?.readyState === WebSocket.OPEN) {
      this.socket_obj.send(JSON.stringify(message_obj));
    }
  }

  /**
   * Close the socket and stop reconnecting.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  close() {
    this.#is_closing_bool = true;
    try {
      this.socket_obj?.close();
    } catch {
      // Already closed.
    }
    this.socket_obj = null;
    super.close();
  }
}

/* ------------------------------------------------------------------------ */

/**
 * Tier 3: a direct WebRTC data channel with manual signalling.
 *
 * Brief:
 *   The offer and answer are exchanged by copy and paste, so there is no
 *   signalling server and therefore no infrastructure at all.
 *
 * Arguments:
 *   room_code_str (string): The room to join.
 *   peer_id_str (string): This device's identifier.
 *
 * Returns:
 *   (PeerTransport): The constructed transport.
 */
export class PeerTransport extends BaseTransport {
  kind_str = 'peer';
  pairing_role_str = null;

  constructor(room_code_str, peer_id_str) {
    super(room_code_str, peer_id_str);
    this.connection_obj = new RTCPeerConnection(RTC_CONFIG_OBJ);

    this.connection_obj.onconnectionstatechange = () => {
      const connection_state_str = this.connection_obj.connectionState;
      this.emit('rtcstate', connection_state_str);
      if (connection_state_str === 'failed' ||
        connection_state_str === 'disconnected') {
        this.is_connected_bool = false;
        this.emit('close');
      }
    };
  }

  /**
   * Wire a data channel's lifecycle into this transport's events.
   *
   * Arguments:
   *   channel_obj (RTCDataChannel): The channel to adopt.
   *
   * Returns:
   *   (none)
   */
  #wireDataChannel(channel_obj) {
    this.data_channel_obj = channel_obj;

    channel_obj.onopen = () => {
      this.is_connected_bool = true;
      this.emit('open', { kind: this.kind_str });
    };
    channel_obj.onmessage =
      (message_event) => this.receiveRaw(message_event.data);
    channel_obj.onclose = () => {
      this.is_connected_bool = false;
      this.emit('close');
    };
  }

  /**
   * Wait until ICE gathering finishes so the SDP is self-contained.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<void>)
   *
   * Warning:
   *   Resolves on a timer as well as on completion. Some networks never
   *   report 'complete', and a code carrying most of the candidates is far
   *   more useful than one that never arrives.
   */
  #waitForIceGathering() {
    return new Promise((resolve_fn) => {
      if (this.connection_obj.iceGatheringState === 'complete') {
        resolve_fn();
        return;
      }

      const checkState = () => {
        if (this.connection_obj.iceGatheringState === 'complete') {
          this.connection_obj.removeEventListener(
            'icegatheringstatechange', checkState
          );
          resolve_fn();
        }
      };

      this.connection_obj.addEventListener(
        'icegatheringstatechange', checkState
      );
      setTimeout(resolve_fn, ICE_GATHERING_TIMEOUT_MS_INT);
    });
  }

  /**
   * Master side: produce the invite code to paste into the other device.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<string>): The pairing code.
   */
  async createOffer() {
    this.pairing_role_str = 'offerer';
    this.#wireDataChannel(
      this.connection_obj.createDataChannel('sonicforge', { ordered: true })
    );

    const offer_obj = await this.connection_obj.createOffer();
    await this.connection_obj.setLocalDescription(offer_obj);
    await this.#waitForIceGathering();

    return encodeSignal({
      room: this.room_code_str,
      from: this.peer_id_str,
      sdp: this.connection_obj.localDescription,
    });
  }

  /**
   * Node side: consume the invite code and produce the reply code.
   *
   * Arguments:
   *   code_str (string): The invite code from the master device.
   *
   * Returns:
   *   (Promise<string>): The reply code to send back.
   */
  async acceptOffer(code_str) {
    this.pairing_role_str = 'answerer';
    const signal_obj = decodeSignal(code_str);
    this.room_code_str = signal_obj.room ?? this.room_code_str;

    this.connection_obj.ondatachannel =
      (channel_event) => this.#wireDataChannel(channel_event.channel);
    await this.connection_obj.setRemoteDescription(signal_obj.sdp);

    const answer_obj = await this.connection_obj.createAnswer();
    await this.connection_obj.setLocalDescription(answer_obj);
    await this.#waitForIceGathering();

    return encodeSignal({
      room: this.room_code_str,
      from: this.peer_id_str,
      sdp: this.connection_obj.localDescription,
    });
  }

  /**
   * Master side: consume the reply code.
   *
   * Arguments:
   *   code_str (string): The reply code from the other device.
   *
   * Returns:
   *   (Promise<PeerTransport>): This transport; the channel opens shortly.
   */
  async acceptAnswer(code_str) {
    const signal_obj = decodeSignal(code_str);
    await this.connection_obj.setRemoteDescription(signal_obj.sdp);
    return this;
  }

  /**
   * Satisfy the transport interface.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<PeerTransport>): This transport.
   *
   * Warning:
   *   A no-op: the connection is established by the offer and answer
   *   exchange, not by this call.
   */
  async connect() {
    return this;
  }

  /**
   * Send one message over the data channel.
   *
   * Arguments:
   *   message_obj (Object): The message to send.
   *
   * Returns:
   *   (none)
   */
  send(message_obj) {
    if (this.data_channel_obj?.readyState === 'open') {
      this.data_channel_obj.send(JSON.stringify(message_obj));
    }
  }

  /**
   * Close the data channel and the peer connection.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  close() {
    try {
      this.data_channel_obj?.close();
    } catch {
      // Already closed.
    }
    try {
      this.connection_obj?.close();
    } catch {
      // Already closed.
    }
    super.close();
    this.emit('close');
  }
}

/* ------------------------------------------------------------------------ */

/**
 * Build the transport for one tier.
 *
 * Brief:
 *   The only place that branches on tier. Everything downstream sees
 *   one interface.
 *
 * Arguments:
 *   kind_str (string): 'local', 'relay' or 'peer'.
 *   options_obj (Object): { room_code_str, peer_id_str, relay_url_str }.
 *
 * Returns:
 *   (BaseTransport): A transport of the requested tier.
 *
 * Warning:
 *   Throws when a tier's prerequisite is missing, so the panel can explain
 *   why rather than producing a transport that silently never connects.
 */
export function createTransport(kind_str, options_obj = {}) {
  const { room_code_str, peer_id_str, relay_url_str } = options_obj;

  switch (kind_str) {
    case 'relay':
      if (!relay_url_str) {
        throw new Error('A relay URL is required for LAN mode.');
      }
      return new RelayTransport(room_code_str, peer_id_str, relay_url_str);

    case 'peer':
      if (typeof RTCPeerConnection === 'undefined') {
        throw new Error('WebRTC is not available in this browser.');
      }
      return new PeerTransport(room_code_str, peer_id_str);

    case 'local':
    default:
      return new LocalTransport(room_code_str, peer_id_str);
  }
}
