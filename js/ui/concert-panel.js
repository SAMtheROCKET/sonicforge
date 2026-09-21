/**
 * The Concert Mode panel.
 *
 * Brief:
 *   A stateful view over one ConcertMode session: picks the transport tier,
 *   hosts or joins a room, shows the clock offset the sync achieved, and
 *   lists the connected nodes with their phase offsets.
 */

import { showToast, requestConfirmation } from './feedback.js';
import { renderQR } from '../util/qr.js';
import { TRANSPORT_KINDS, ROLE } from '../sync/concert.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Transport tier selected before the viewer chooses one. */
const DEFAULT_TRANSPORT_KIND_STR = 'local';

/** Port the bundled development relay listens on. */
const DEFAULT_RELAY_PORT_INT = 8787;

/** Tone pushed by the sync-tone button when no channel is selected. */
const FALLBACK_TONE_HERTZ_FLOAT = 440;
const FALLBACK_TONE_WAVEFORM_STR = 'sine';
const FALLBACK_TONE_GAIN_DB_FLOAT = -14;

/** Duration of the scheduled sync tone, in milliseconds. */
const SYNC_TONE_DURATION_MS_INT = 2000;

/** Phase flip applied by the per-peer button, in degrees. */
const PHASE_FLIP_DEGREES_INT = 180;
const FULL_TURN_DEGREES_INT = 360;

/** Toast dwell times, in milliseconds. */
const BRIEF_TOAST_MS_INT = 2200;
const SHORT_TOAST_MS_INT = 1800;
const LONG_TOAST_MS_INT = 6000;
const OFFER_TOAST_MS_INT = 5000;
const LINK_TOAST_MS_INT = 9000;

/** Query parameter names carried by a join link. */
const ROOM_PARAM_STR = 'r';
const RELAY_PARAM_STR = 's';

/* ------------------------------------------------------------------------ */

/**
 * Collect every element the Concert panel drives.
 *
 * Brief:
 *   Gathered once at construction so a missing id fails loudly at boot
 *   rather than on the first click of a control nobody tested.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (Object): Named element references.
 */
function collectConcertElements() {
  return {
    state_el: document.getElementById('concert-state'),
    kind_tabs_el: document.getElementById('concert-kind'),
    hint_el: document.getElementById('concert-hint'),
    relay_row_el: document.getElementById('concert-relay-row'),
    relay_input_el: document.getElementById('concert-relay'),
    host_button_el: document.getElementById('concert-host'),
    code_input_el: document.getElementById('concert-code'),
    join_button_el: document.getElementById('concert-join'),
    live_el: document.getElementById('concert-live'),
    room_el: document.getElementById('concert-room'),
    qr_el: document.getElementById('concert-qr'),
    role_el: document.getElementById('concert-role'),
    peers_el: document.getElementById('concert-peers'),
    offset_el: document.getElementById('concert-offset'),
    rtt_el: document.getElementById('concert-rtt'),
    copy_button_el: document.getElementById('concert-copy'),
    phase_input_el: document.getElementById('concert-phase'),
    phase_value_el: document.getElementById('concert-phase-val'),
    peer_list_el: document.getElementById('concert-peer-list'),
    sync_tone_button_el: document.getElementById('concert-sync-tone'),
    push_button_el: document.getElementById('concert-push'),
    leave_button_el: document.getElementById('concert-leave'),
    pair_el: document.getElementById('concert-peer-pair'),
    signal_input_el: document.getElementById('concert-signal'),
    offer_button_el: document.getElementById('concert-offer'),
    accept_button_el: document.getElementById('concert-accept'),
    copy_signal_button_el: document.getElementById('concert-copy-signal'),
  };
}

/**
 * Build the markup for one peer row.
 *
 * Arguments:
 *   peer_obj (Object): { id, role, ua, phaseDeg }.
 *
 * Returns:
 *   (string): Row markup.
 *
 * Warning:
 *   Peer fields arrive from another device over the transport. They are
 *   short identifiers and a user-agent summary, never markup, and the
 *   transport rejects anything that does not match its message shape.
 */
function buildPeerMarkup(peer_obj) {
  const phase_degrees_int = peer_obj.phaseDeg ?? 0;
  return `
    <span class="status-dot status-dot--live"></span>
    <span class="peer__id">${peer_obj.id}</span>
    <span class="badge">${peer_obj.role}</span>
    <span class="peer__meta">${peer_obj.ua} · ${phase_degrees_int}°</span>`;
}

/* ------------------------------------------------------------------------ */

/**
 * Panel driving a multi-device Concert Mode session.
 *
 * Brief:
 *   Owns the tier tabs, the room controls and the node list. The session
 *   model owns the clock and the transport; this decides what is shown and
 *   which controls a node in this role is allowed to use.
 *
 * Arguments:
 *   concert_obj (ConcertMode): The session model.
 *   app_obj (Object): The application shell, for logging and channel state.
 *
 * Returns:
 *   (ConcertPanel): The constructed panel.
 */
export class ConcertPanel {
  transport_kind_str = DEFAULT_TRANSPORT_KIND_STR;

  constructor(concert_obj, app_obj) {
    this.concert_obj = concert_obj;
    this.app_obj = app_obj;
    this.el = collectConcertElements();

    this.#bindControls();
    this.#bindPairing();
    this.#bindConcertEvents();
    this.#setTransportKind(DEFAULT_TRANSPORT_KIND_STR);
    this.#autoJoin();
  }

  /* =================================================================== */

  /**
   * Wire the room controls: tier tabs, host, join, leave, copy and phase.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bindControls() {
    const el = this.el;

    el.kind_tabs_el.addEventListener('click', (click_event) => {
      const kind_str =
        click_event.target.closest('[data-kind]')?.dataset.kind;
      if (kind_str) {
        this.#setTransportKind(kind_str);
      }
    });

    el.host_button_el.addEventListener('click', () => this.host());
    el.join_button_el.addEventListener('click', () => this.join());
    el.leave_button_el.addEventListener('click', () => this.leave());
    el.code_input_el.addEventListener('keydown', (keyboard_event) => {
      if (keyboard_event.key === 'Enter') {
        this.join();
      }
    });

    el.copy_button_el.addEventListener('click', async () => {
      const join_url_str = this.concert_obj.joinUrl({
        relayUrl: this.#resolveRelayUrl(),
      });
      try {
        await navigator.clipboard.writeText(join_url_str);
        showToast('Join link copied.', 'ok', BRIEF_TOAST_MS_INT);
      } catch {
        showToast(join_url_str, 'info', LINK_TOAST_MS_INT);
      }
    });

    el.phase_input_el.addEventListener('input', () => {
      const phase_degrees_int = Number(el.phase_input_el.value);
      el.phase_value_el.textContent = `${phase_degrees_int}°`;
      this.concert_obj.setPhaseDegrees(phase_degrees_int);
    });

    el.sync_tone_button_el.addEventListener('click', () => this.#sendTone());
    el.push_button_el.addEventListener('click', () => this.#pushState());
  }

  /**
   * Schedule the selected channel's tone on every node.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #sendTone() {
    const channel_obj = this.app_obj.selectedChannel;
    const scheduled_at_float = this.concert_obj.scheduleTone({
      freq: channel_obj?.frequency_hertz_float ?? FALLBACK_TONE_HERTZ_FLOAT,
      durationMs: SYNC_TONE_DURATION_MS_INT,
      waveform:
        channel_obj?.waveform_name_str ?? FALLBACK_TONE_WAVEFORM_STR,
      gainDb: channel_obj?.gain_db_float ?? FALLBACK_TONE_GAIN_DB_FLOAT,
    });

    if (scheduled_at_float) {
      showToast('Tone scheduled on every node.', 'ok', BRIEF_TOAST_MS_INT);
    } else {
      showToast('Only the master node can schedule.', 'warn');
    }
  }

  /**
   * Push the local channel state to every node.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #pushState() {
    if (this.concert_obj.broadcastState()) {
      showToast('State pushed to all nodes.', 'ok', BRIEF_TOAST_MS_INT);
    } else {
      showToast('Only the master node can push state.', 'warn');
    }
  }

  /**
   * Wire the manual WebRTC pairing controls.
   *
   * Brief:
   *   The peer tier has no signalling server by design, so the offer and
   *   answer are exchanged by copy and paste through whatever channel the
   *   two people already have.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bindPairing() {
    const el = this.el;

    el.offer_button_el.addEventListener('click', async () => {
      try {
        const offer_code_str =
          await this.concert_obj.transport.createOffer();
        el.signal_input_el.value = offer_code_str;
        el.signal_input_el.select();
        showToast(
          'Offer created — send this code to the other device.',
          'ok',
          OFFER_TOAST_MS_INT
        );
      } catch (err) {
        showToast(err.message, 'err');
      }
    });

    el.accept_button_el.addEventListener(
      'click', () => this.#acceptPairingCode()
    );

    el.copy_signal_button_el.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(el.signal_input_el.value);
        showToast('Code copied.', 'ok', SHORT_TOAST_MS_INT);
      } catch {
        // Clipboard unavailable; the code is already visible in the field.
      }
    });
  }

  /**
   * Accept whichever half of the pairing handshake is pasted in.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<void>)
   */
  async #acceptPairingCode() {
    const el = this.el;
    const code_str = el.signal_input_el.value.trim();
    if (!code_str) {
      showToast('Paste a pairing code first.', 'warn');
      return;
    }

    try {
      const transport_obj = this.concert_obj.transport;
      if (transport_obj.role === 'offerer') {
        await transport_obj.acceptAnswer(code_str);
        showToast('Answer accepted — connecting…', 'ok');
        return;
      }
      const reply_code_str = await transport_obj.acceptOffer(code_str);
      el.signal_input_el.value = reply_code_str;
      el.signal_input_el.select();
      showToast(
        'Reply code generated — send it back to the host.',
        'ok',
        LONG_TOAST_MS_INT
      );
    } catch (err) {
      showToast(err.message, 'err', LONG_TOAST_MS_INT);
    }
  }

  /**
   * Mirror the session's events into the panel and the log.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #bindConcertEvents() {
    const concert_obj = this.concert_obj;
    const el = this.el;

    concert_obj.on('role', () => this.#render());
    concert_obj.on('room', () => this.#render());
    concert_obj.on('peers', (peers_list) => this.#renderPeers(peers_list));
    concert_obj.on('closed', () => this.#render());
    concert_obj.on('mirrored', () => this.app_obj.syncUi());

    concert_obj.on('sync', ({ offsetMs, rttMs, samples }) => {
      const sign_str = offsetMs >= 0 ? '+' : '';
      el.offset_el.textContent = `${sign_str}${offsetMs.toFixed(1)} ms`;
      el.rtt_el.textContent = `${rttMs.toFixed(1)} ms`;
      this.app_obj.log(
        `[concert] clock locked: offset ${offsetMs.toFixed(1)} ms, ` +
        `rtt ${rttMs.toFixed(1)} ms (${samples} probes)`,
        'ok'
      );
    });

    concert_obj.on('syncing', (is_syncing_bool) => {
      if (is_syncing_bool) {
        el.offset_el.textContent = 'syncing…';
      }
    });
    concert_obj.on(
      'syncfail', (message_str) => showToast(message_str, 'warn')
    );
    concert_obj.on('late', ({ byMs }) => {
      this.app_obj.log(
        `[concert] event arrived ${byMs.toFixed(0)} ms late and was dropped`,
        'warn'
      );
    });
    concert_obj.on('open', (info_obj) => {
      showToast(
        `Connected via ${TRANSPORT_KINDS[info_obj.kind].label}.`, 'ok'
      );
    });
  }

  /* =================================================================== */

  /**
   * Select the transport tier and show the controls it needs.
   *
   * Arguments:
   *   transport_kind_str (string): 'local', 'relay' or 'peer'.
   *
   * Returns:
   *   (none)
   */
  #setTransportKind(transport_kind_str) {
    this.transport_kind_str = transport_kind_str;
    const el = this.el;

    for (const tab_el of el.kind_tabs_el.querySelectorAll('[data-kind]')) {
      tab_el.classList.toggle(
        'is-active', tab_el.dataset.kind === transport_kind_str
      );
    }

    el.hint_el.textContent = TRANSPORT_KINDS[transport_kind_str].hint;
    el.relay_row_el.hidden = transport_kind_str !== 'relay';
    el.pair_el.hidden = transport_kind_str !== 'peer';

    if (transport_kind_str === 'relay' && !el.relay_input_el.value) {
      // Best guess: the relay shipped with the dev server, on this host.
      const host_str = location.hostname || 'localhost';
      el.relay_input_el.value = `ws://${host_str}:${DEFAULT_RELAY_PORT_INT}`;
    }
  }

  /**
   * Resolve the relay URL for the selected tier.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (string|null): The relay URL, or null for tiers that need none.
   */
  #resolveRelayUrl() {
    return this.transport_kind_str === 'relay'
      ? this.el.relay_input_el.value.trim()
      : null;
  }

  /**
   * Open a room as the master node.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<void>)
   */
  async host() {
    try {
      await this.concert_obj.host({
        kind: this.transport_kind_str,
        relayUrl: this.#resolveRelayUrl(),
      });
      this.app_obj.log(
        `[concert] hosting room ${this.concert_obj.room} ` +
        `via ${this.transport_kind_str}`,
        'ok'
      );
    } catch (err) {
      showToast(err.message, 'err', LONG_TOAST_MS_INT);
    }
  }

  /**
   * Join an existing room by its code.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<void>)
   */
  async join() {
    const code_str = this.el.code_input_el.value.trim().toUpperCase();
    if (!code_str) {
      showToast('Enter the room code from the master device.', 'warn');
      return;
    }

    try {
      await this.concert_obj.join(code_str, {
        kind: this.transport_kind_str,
        relayUrl: this.#resolveRelayUrl(),
      });
      this.app_obj.log(
        `[concert] joined room ${code_str} via ${this.transport_kind_str}`,
        'ok'
      );
    } catch (err) {
      showToast(err.message, 'err', LONG_TOAST_MS_INT);
    }
  }

  /**
   * Leave the current room.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<void>)
   */
  async leave() {
    await this.concert_obj.leave();
    this.app_obj.log('[concert] left the room', 'dim');
  }

  /* =================================================================== */

  /**
   * Show the clock readouts appropriate to this node's role.
   *
   * Brief:
   *   Nodes take their clock from the master, so their own offset is what
   *   matters. The master is the reference and shows zero by definition.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   */
  #renderRoleControls() {
    const el = this.el;
    const is_master_bool = this.concert_obj.role === ROLE.MASTER;

    if (is_master_bool) {
      el.offset_el.textContent = 'reference';
      el.rtt_el.textContent = '—';
    }
    el.sync_tone_button_el.disabled = !is_master_bool;
    el.push_button_el.disabled = !is_master_bool;
  }

  /**
   * Redraw the room state, badges and join QR code.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (none)
   *
   * Warning:
   *   QR rendering is guarded: a URL too long for the chosen version throws
   *   rather than silently producing an unscannable code.
   */
  #render() {
    const concert_obj = this.concert_obj;
    const el = this.el;
    const is_live_bool = concert_obj.role !== ROLE.SOLO;

    el.live_el.hidden = !is_live_bool;
    el.state_el.textContent = is_live_bool
      ? `${concert_obj.role} · ${concert_obj.room}`
      : 'solo';

    let badge_class_str = 'badge';
    if (is_live_bool) {
      badge_class_str += concert_obj.role === ROLE.MASTER
        ? ' badge--cyan'
        : ' badge--violet';
    }
    el.state_el.className = badge_class_str;
    el.host_button_el.disabled = is_live_bool;
    el.join_button_el.disabled = is_live_bool;

    if (!is_live_bool) {
      return;
    }

    el.room_el.textContent = concert_obj.room;
    el.role_el.textContent = concert_obj.role;
    this.#renderRoleControls();

    try {
      renderQR(
        el.qr_el,
        concert_obj.joinUrl({ relayUrl: this.#resolveRelayUrl() })
      );
      el.qr_el.hidden = false;
    } catch (err) {
      el.qr_el.hidden = true;
      console.warn('[SonicForge] QR render failed:', err.message);
    }
  }

  /**
   * Redraw the connected-node list.
   *
   * Arguments:
   *   peers_list (Array<Object>): Connected peers.
   *
   * Returns:
   *   (none)
   */
  #renderPeers(peers_list) {
    const el = this.el;
    el.peers_el.textContent = String(peers_list.length);
    el.peer_list_el.replaceChildren();

    const is_master_bool = this.concert_obj.role === ROLE.MASTER;

    for (const peer_obj of peers_list) {
      const row_el = document.createElement('div');
      row_el.className = 'peer';
      row_el.innerHTML = buildPeerMarkup(peer_obj);

      if (is_master_bool) {
        const flip_button_el = document.createElement('button');
        flip_button_el.className = 'btn btn--xs';
        flip_button_el.textContent = '+180°';
        flip_button_el.title = 'Flip this node 180° out of phase';
        flip_button_el.addEventListener('click', () => {
          const next_degrees_int =
            ((peer_obj.phaseDeg ?? 0) + PHASE_FLIP_DEGREES_INT) %
            FULL_TURN_DEGREES_INT;
          this.concert_obj.setPeerPhase(peer_obj.id, next_degrees_int);
        });
        row_el.appendChild(flip_button_el);
      }
      el.peer_list_el.appendChild(row_el);
    }
  }

  /**
   * Honour a join link of the form #r=CODE.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Promise<void>)
   *
   * Warning:
   *   Joining is always confirmed, because the link may have arrived from
   *   anywhere and joining hands control of this device's output to a host.
   */
  async #autoJoin() {
    const parsed_obj = this.constructor.parseHash();
    if (!parsed_obj) {
      return;
    }

    this.el.code_input_el.value = parsed_obj.room_str;
    if (parsed_obj.relay_url_str) {
      this.el.relay_input_el.value = parsed_obj.relay_url_str;
      this.#setTransportKind('relay');
    }

    const is_confirmed_bool = await requestConfirmation({
      title_str: `Join room ${parsed_obj.room_str}?`,
      body_html_str:
        'This link invites you into a SonicForge Concert Mode session. ' +
        'Your device will mirror the host’s tones and play in sync with it.',
      confirm_label_str: 'Join session',
    });
    if (is_confirmed_bool) {
      this.join();
    }
  }

  /**
   * Read a room code and relay URL out of the location hash.
   *
   * Arguments:
   *   (none)
   *
   * Returns:
   *   (Object|null): { room_str, relay_url_str }, or null if absent.
   */
  static parseHash() {
    if (!location.hash || location.hash.length < 2) {
      return null;
    }
    const params_obj = new URLSearchParams(location.hash.slice(1));
    const room_str = params_obj.get(ROOM_PARAM_STR);
    if (!room_str) {
      return null;
    }
    return {
      room_str: room_str.toUpperCase(),
      relay_url_str: params_obj.get(RELAY_PARAM_STR),
    };
  }
}
