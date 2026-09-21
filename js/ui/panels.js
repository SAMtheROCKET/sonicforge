/**
 * Calibration and Concert Mode panels.
 *
 * Both are stateful, self-contained views over one engine object each, kept
 * out of main.js so that the bootstrapper stays readable.
 */

import { showToast, requestConfirmation } from './feedback.js';
import { renderQR } from '../util/qr.js';
import { EQ_BAND_CENTRES_HERTZ_LIST } from '../dsp/weighting.js';
import { formatFrequency, mapFrequencyToPosition } from '../util/frequency.js';
import { clampToRange } from '../util/numeric.js';
import { TRANSPORT_KINDS, ROLE } from '../sync/concert.js';

/* =========================================================================
   Calibration
   ========================================================================= */

export class CalibrationPanel {
  #abort = null;

  /**
   * @param {import('../core/calibration.js').RoomCalibrator} cal
   * @param {*} app
   */
  constructor(cal, app) {
    this.cal = cal;
    this.app = app;

    this.canvas = document.getElementById('cal-curve');
    this.ctx = this.canvas.getContext('2d');
    this.state = document.getElementById('cal-state');
    this.btnRun = document.getElementById('cal-run');
    this.btnApply = document.getElementById('cal-apply');
    this.btnExport = document.getElementById('cal-export');
    this.stats = document.getElementById('cal-stats');
    this.note = document.getElementById('cal-note');

    this.#bind();
    this.#draw();
    this.#restore();
  }

  #bind() {
    this.btnRun.addEventListener('click', () => (this.cal.is_running_bool ? this.cancel() : this.run()));
    this.btnApply.addEventListener('click', () => this.toggleApply());
    this.btnExport.addEventListener('click', () => this.download());

    this.cal.on('progress', (p) => this.#progress(p));
    this.cal.on('warn', (m) => showToast(m, 'warn'));
    this.cal.on('result', () => { this.#draw(); this.#stats(); });

    // Drag a previously exported curve onto the chart to load it.
    this.canvas.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.canvas.style.borderColor = 'var(--cyan)';
    });
    this.canvas.addEventListener('dragleave', () => {
      this.canvas.style.borderColor = '';
    });
    this.canvas.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.canvas.style.borderColor = '';
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      try {
        this.cal.importMeasurement(JSON.parse(await file.text()));
        this.#draw();
        this.#stats();
        this.btnApply.disabled = false;
        this.btnExport.disabled = false;
        showToast(`Loaded calibration from ${file.name}`, 'ok');
      } catch (err) {
        showToast(`Could not read that file: ${err.message}`, 'err');
      }
    });

    window.addEventListener('resize', () => this.#draw());
  }

  async run() {
    if (!this.app.engine.is_ready_bool) {
      showToast('Start the audio engine first.', 'warn');
      return;
    }

    const ok = await requestConfirmation({
      title_str: 'Measure your speakers and room',
      body_html_str:
        'SonicForge will play a 3-second sweep through your <b>speakers</b> and listen back with the ' +
        '<b>microphone</b>, then build a correction curve.<br><br>' +
        '<b>Take your headphones off</b> — measuring headphones through a laptop mic tells you nothing. ' +
        'Keep the room quiet and stay still.<br><br>' +
        '<span class="text-cyan">The recording never leaves this device.</span> Nothing is stored, nothing is uploaded, ' +
        'and the microphone is released the instant the sweep ends.',
      confirm_label_str: 'Start measurement',
    });
    if (!ok) return;

    this.#abort = new AbortController();
    this.btnRun.textContent = 'Cancel';
    this.btnRun.classList.remove('btn--primary');
    this.state.textContent = 'measuring';
    this.state.className = 'badge badge--amber';

    try {
      const result = await this.cal.run({ signal: this.#abort.signal });
      this.btnApply.disabled = false;
      this.btnExport.disabled = false;
      this.state.textContent = `${Math.round(result.confidence_float * 100)}% confidence`;
      this.state.className = result.confidence_float > 0.6 ? 'badge badge--lime' : 'badge badge--amber';

      if (result.confidence_float < 0.35) {
        showToast('Low confidence — check that the speakers are audible and the room is quiet.', 'warn', 7000);
      } else {
        showToast('Measurement complete. Press Apply to engage the correction.', 'ok');
      }
      this.#persist();
    } catch (err) {
      if (err.name === 'AbortError') {
        this.state.textContent = 'cancelled';
        this.state.className = 'badge';
      } else {
        this.state.textContent = 'failed';
        this.state.className = 'badge badge--rose';
        showToast(friendlyMicError(err), 'err', 8000);
      }
    } finally {
      this.#abort = null;
      this.btnRun.textContent = 'Measure room';
      this.btnRun.classList.add('btn--primary');
      this.#draw();
    }
  }

  cancel() {
    this.#abort?.abort();
  }

  toggleApply() {
    const on = this.cal.toggleCorrection();
    this.btnApply.textContent = this.cal.is_applied_bool ? 'Bypass' : 'Apply';
    this.btnApply.classList.toggle('is-active', this.cal.is_applied_bool);
    showToast(this.cal.is_applied_bool ? 'Correction engaged.' : 'Correction bypassed.', 'ok', 2200);
    this.#draw();
    return on;
  }

  download() {
    const data = this.cal.exportMeasurement();
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sonicforge-calibration-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    showToast('Calibration curve exported.', 'ok');
  }

  #progress({ phase_str, progress_float, message_str }) {
    if (message) this.app.log(`[calibrate] ${message}`, phase === 'done' ? 'ok' : 'dim');
    this.state.textContent = `${phase} ${Math.round(t * 100)}%`;
  }

  #stats() {
    const r = this.cal.result_obj;
    if (!r) return;
    this.stats.hidden = false;
    document.getElementById('cal-latency').textContent = `${r.latency_ms_float.toFixed(0)} ms`;
    document.getElementById('cal-floor').textContent = `${r.noise_floor_db_float.toFixed(1)} dB`;
    document.getElementById('cal-confidence').textContent = `${Math.round(r.confidence_float * 100)} %`;
  }

  /* ------------------------------------------------------------------ */

  #draw() {
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    if (rect.width) {
      canvas.width = Math.round(rect.width * dpr);
      canvas.height = Math.round(rect.height * dpr);
    }

    const c = this.ctx;
    const w = canvas.width;
    const h = canvas.height;
    const pad = 6 * dpr;
    c.clearRect(0, 0, w, h);

    const RANGE = 24; // ±dB shown
    const yOf = (db) => h / 2 - (clampToRange(db, -RANGE, RANGE) / RANGE) * (h / 2 - pad);
    const xOf = (hz) => pad + mapFrequencyToPosition(hz, 20, 20000) * (w - pad * 2);

    // --- grid ---------------------------------------------------------
    c.strokeStyle = 'rgba(255,255,255,0.055)';
    c.lineWidth = 1;
    c.font = `${8 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
    c.fillStyle = 'rgba(125,137,166,0.55)';
    c.textBaseline = 'top';

    for (const hz of [31.5, 100, 315, 1000, 3150, 10000]) {
      const x = xOf(hz);
      c.beginPath();
      c.moveTo(x, pad);
      c.lineTo(x, h - pad);
      c.stroke();
      c.fillText(hz >= 1000 ? `${hz / 1000}k` : String(hz), x + 2 * dpr, h - 11 * dpr);
    }
    for (const db of [-12, 0, 12]) {
      const y = yOf(db);
      c.beginPath();
      c.moveTo(pad, y);
      c.lineTo(w - pad, y);
      c.strokeStyle = db === 0 ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.055)';
      c.stroke();
      if (db !== 0) c.fillText(`${db > 0 ? '+' : ''}${db}`, pad + 2 * dpr, y + 2 * dpr);
    }

    const r = this.cal.result_obj;
    if (!r) {
      c.fillStyle = 'rgba(125,137,166,0.6)';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.font = `${10 * dpr}px system-ui`;
      c.fillText('No measurement yet — or drop a saved curve here', w / 2, h / 2);
      c.textAlign = 'left';
      return;
    }

    // --- measured deviation --------------------------------------------
    c.beginPath();
    for (let i = 0; i < r.grid_float64array.length; i++) {
      const x = xOf(r.grid_float64array[i]);
      const y = yOf(r.deviation_db_float64array[i]);
      i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    }
    c.strokeStyle = 'rgba(125,137,166,0.75)';
    c.lineWidth = 1.4 * dpr;
    c.stroke();

    // --- correction bands ------------------------------------------------
    const applied = this.cal.is_applied_bool;
    c.beginPath();
    EQ_BAND_CENTRES_HERTZ_LIST.forEach((hz, i) => {
      const x = xOf(hz);
      const y = yOf(r.correction_db_list[i]);
      i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
    });
    c.strokeStyle = applied ? 'rgba(0,242,254,0.95)' : 'rgba(0,242,254,0.4)';
    c.lineWidth = 2 * dpr;
    c.shadowBlur = applied ? 10 * dpr : 0;
    c.shadowColor = 'rgba(0,242,254,0.6)';
    c.stroke();
    c.shadowBlur = 0;

    EQ_BAND_CENTRES_HERTZ_LIST.forEach((hz, i) => {
      c.beginPath();
      c.arc(xOf(hz), yOf(r.correction_db_list[i]), 2.6 * dpr, 0, Math.PI * 2);
      c.fillStyle = applied ? '#00f2fe' : 'rgba(0,242,254,0.5)';
      c.fill();
    });

    c.fillStyle = 'rgba(125,137,166,0.8)';
    c.textBaseline = 'top';
    c.fillText(applied ? 'correction ENGAGED' : 'correction ready', pad + 2 * dpr, pad);
  }

  /* ------------------------------------------------------------------ */

  #persist() {
    try {
      localStorage.setItem('sonicforge.calibration', JSON.stringify(this.cal.exportMeasurement()));
    } catch {}
  }

  #restore() {
    try {
      const raw = localStorage.getItem('sonicforge.calibration');
      if (!raw) return;
      this.cal.importMeasurement(JSON.parse(raw));
      this.btnApply.disabled = false;
      this.btnExport.disabled = false;
      this.state.textContent = 'saved curve';
      this.state.className = 'badge badge--cyan';
      this.#draw();
      this.#stats();
    } catch {}
  }
}

function friendlyMicError(err) {
  const name = err?.name ?? '';
  if (name === 'NotAllowedError') return 'Microphone permission was denied. Allow it in the address bar and try again.';
  if (name === 'NotFoundError') return 'No microphone was found on this device.';
  if (name === 'NotReadableError') return 'The microphone is in use by another application.';
  if (location.protocol === 'http:' && location.hostname !== 'localhost') {
    return 'Microphone access requires HTTPS (or localhost).';
  }
  return err?.message ?? 'Calibration failed.';
}

/* =========================================================================
   Concert Mode
   ========================================================================= */

export class ConcertPanel {
  kind = 'local';

  /**
   * @param {import('../sync/concert.js').ConcertMode} concert
   * @param {*} app
   */
  constructor(concert, app) {
    this.concert = concert;
    this.app = app;

    this.el = {
      state: document.getElementById('concert-state'),
      kindTabs: document.getElementById('concert-kind'),
      hint: document.getElementById('concert-hint'),
      relayRow: document.getElementById('concert-relay-row'),
      relay: document.getElementById('concert-relay'),
      host: document.getElementById('concert-host'),
      code: document.getElementById('concert-code'),
      join: document.getElementById('concert-join'),
      live: document.getElementById('concert-live'),
      room: document.getElementById('concert-room'),
      qr: document.getElementById('concert-qr'),
      role: document.getElementById('concert-role'),
      peers: document.getElementById('concert-peers'),
      offset: document.getElementById('concert-offset'),
      rtt: document.getElementById('concert-rtt'),
      copy: document.getElementById('concert-copy'),
      phase: document.getElementById('concert-phase'),
      phaseVal: document.getElementById('concert-phase-val'),
      peerList: document.getElementById('concert-peer-list'),
      syncTone: document.getElementById('concert-sync-tone'),
      push: document.getElementById('concert-push'),
      leave: document.getElementById('concert-leave'),
      pair: document.getElementById('concert-peer-pair'),
      signal: document.getElementById('concert-signal'),
      offer: document.getElementById('concert-offer'),
      accept: document.getElementById('concert-accept'),
      copySignal: document.getElementById('concert-copy-signal'),
    };

    this.#bind();
    this.#setKind('local');
    this.#autoJoin();
  }

  #bind() {
    const e = this.el;

    e.kindTabs.addEventListener('click', (ev) => {
      const kind = ev.target.closest('[data-kind]')?.dataset.kind;
      if (kind) this.#setKind(kind);
    });

    e.host.addEventListener('click', () => this.host());
    e.join.addEventListener('click', () => this.join());
    e.leave.addEventListener('click', () => this.leave());

    e.code.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') this.join(); });

    e.copy.addEventListener('click', async () => {
      const url = this.concert.joinUrl({ relayUrl: this.#relayUrl() });
      try {
        await navigator.clipboard.writeText(url);
        showToast('Join link copied.', 'ok', 2200);
      } catch {
        showToast(url, 'info', 9000);
      }
    });

    e.phase.addEventListener('input', () => {
      const deg = Number(e.phase.value);
      e.phaseVal.textContent = `${deg}°`;
      this.concert.setPhaseDegrees(deg);
    });

    e.syncTone.addEventListener('click', () => {
      const ch = this.app.selectedChannel;
      const at = this.concert.scheduleTone({
        freq: ch?.freq ?? 440,
        durationMs: 2000,
        waveform: ch?.waveform ?? 'sine',
        gainDb: ch?.gainDb ?? -14,
      });
      if (at) showToast('Tone scheduled on every node.', 'ok', 2200);
      else showToast('Only the master node can schedule.', 'warn');
    });

    e.push.addEventListener('click', () => {
      if (this.concert.broadcastState()) showToast('State pushed to all nodes.', 'ok', 2200);
      else showToast('Only the master node can push state.', 'warn');
    });

    // --- manual WebRTC pairing ---------------------------------------
    e.offer.addEventListener('click', async () => {
      try {
        const code = await this.concert.transport.createOffer();
        e.signal.value = code;
        e.signal.select();
        showToast('Offer created — send this code to the other device.', 'ok', 5000);
      } catch (err) {
        showToast(err.message, 'err');
      }
    });

    e.accept.addEventListener('click', async () => {
      const code = e.signal.value.trim();
      if (!code) return showToast('Paste a pairing code first.', 'warn');
      try {
        const t = this.concert.transport;
        if (t.role === 'offerer') {
          await t.acceptAnswer(code);
          showToast('Answer accepted — connecting…', 'ok');
        } else {
          const reply = await t.acceptOffer(code);
          e.signal.value = reply;
          e.signal.select();
          showToast('Reply code generated — send it back to the host.', 'ok', 6000);
        }
      } catch (err) {
        showToast(err.message, 'err', 6000);
      }
    });

    e.copySignal.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(e.signal.value);
        showToast('Code copied.', 'ok', 1800);
      } catch {}
    });

    // --- concert events -------------------------------------------------
    const c = this.concert;
    c.on('role', () => this.#render());
    c.on('room', () => this.#render());
    c.on('peers', (peers) => this.#renderPeers(peers));
    c.on('sync', ({ offsetMs, rttMs, samples }) => {
      e.offset.textContent = `${offsetMs >= 0 ? '+' : ''}${offsetMs.toFixed(1)} ms`;
      e.rtt.textContent = `${rttMs.toFixed(1)} ms`;
      this.app.log(`[concert] clock locked: offset ${offsetMs.toFixed(1)} ms, rtt ${rttMs.toFixed(1)} ms (${samples} probes)`, 'ok');
    });
    c.on('syncing', (on) => { if (on) e.offset.textContent = 'syncing…'; });
    c.on('syncfail', (m) => showToast(m, 'warn'));
    c.on('late', ({ byMs }) =>
      this.app.log(`[concert] event arrived ${byMs.toFixed(0)} ms late and was dropped`, 'warn')
    );
    c.on('open', (info) => showToast(`Connected via ${TRANSPORT_KINDS[info.kind].label}.`, 'ok'));
    c.on('closed', () => this.#render());
    c.on('mirrored', () => this.app.syncUi());
  }

  #setKind(kind) {
    this.kind = kind;
    for (const b of this.el.kindTabs.querySelectorAll('[data-kind]')) {
      b.classList.toggle('is-active', b.dataset.kind === kind);
    }
    this.el.hint.textContent = TRANSPORT_KINDS[kind].hint;
    this.el.relayRow.hidden = kind !== 'relay';
    this.el.pair.hidden = kind !== 'peer';

    if (kind === 'relay' && !this.el.relay.value) {
      // Best guess: the relay shipped with the dev server, on this host.
      const host = location.hostname || 'localhost';
      this.el.relay.value = `ws://${host}:8787`;
    }
  }

  #relayUrl() {
    return this.kind === 'relay' ? this.el.relay.value.trim() : null;
  }

  async host() {
    try {
      await this.concert.host({ kind: this.kind, relayUrl: this.#relayUrl() });
      this.app.log(`[concert] hosting room ${this.concert.room} via ${this.kind}`, 'ok');
    } catch (err) {
      showToast(err.message, 'err', 6000);
    }
  }

  async join() {
    const code = this.el.code.value.trim().toUpperCase();
    if (!code) return showToast('Enter the room code from the master device.', 'warn');
    try {
      await this.concert.join(code, { kind: this.kind, relayUrl: this.#relayUrl() });
      this.app.log(`[concert] joined room ${code} via ${this.kind}`, 'ok');
    } catch (err) {
      showToast(err.message, 'err', 6000);
    }
  }

  async leave() {
    await this.concert.leave();
    this.app.log('[concert] left the room', 'dim');
  }

  #render() {
    const c = this.concert;
    const e = this.el;
    const live = c.role !== ROLE.SOLO;

    e.live.hidden = !live;
    e.state.textContent = live ? `${c.role} · ${c.room}` : 'solo';
    e.state.className = `badge ${live ? (c.role === ROLE.MASTER ? 'badge--cyan' : 'badge--violet') : ''}`;
    e.host.disabled = live;
    e.join.disabled = live;

    if (!live) return;

    e.room.textContent = c.room;
    e.role.textContent = c.role;

    // Nodes take their clock from the master, so their own offset is what
    // matters; the master is the reference and shows zero by definition.
    if (c.role === ROLE.MASTER) {
      e.offset.textContent = 'reference';
      e.rtt.textContent = '—';
      e.syncTone.disabled = false;
      e.push.disabled = false;
    } else {
      e.syncTone.disabled = true;
      e.push.disabled = true;
    }

    try {
      renderQR(e.qr, c.joinUrl({ relayUrl: this.#relayUrl() }));
      e.qr.hidden = false;
    } catch (err) {
      e.qr.hidden = true;
      console.warn('[SonicForge] QR render failed:', err.message);
    }
  }

  #renderPeers(peers) {
    const e = this.el;
    e.peers.textContent = String(peers.length);

    e.peerList.replaceChildren();
    for (const p of peers) {
      const row = document.createElement('div');
      row.className = 'peer';
      row.innerHTML = `
        <span class="status-dot status-dot--live"></span>
        <span class="peer__id">${p.id}</span>
        <span class="badge">${p.role}</span>
        <span class="peer__meta">${p.ua} · ${p.phaseDeg ?? 0}°</span>`;

      if (this.concert.role === ROLE.MASTER) {
        const btn = document.createElement('button');
        btn.className = 'btn btn--xs';
        btn.textContent = '+180°';
        btn.title = 'Flip this node 180° out of phase';
        btn.addEventListener('click', () => {
          this.concert.setPeerPhase(p.id, ((p.phaseDeg ?? 0) + 180) % 360);
        });
        row.appendChild(btn);
      }
      e.peerList.appendChild(row);
    }
  }

  /** Honour a ?#r=CODE join link. */
  async #autoJoin() {
    const parsed = this.constructor.parseHash();
    if (!parsed) return;

    this.el.code.value = parsed.room;
    if (parsed.relayUrl) {
      this.el.relay.value = parsed.relayUrl;
      this.#setKind('relay');
    }

    const ok = await requestConfirmation({
      title_str: `Join room ${parsed.room}?`,
      body_html_str:
        'This link invites you into a SonicForge Concert Mode session. ' +
        'Your device will mirror the host’s tones and play in sync with it.',
      confirm_label_str: 'Join session',
    });
    if (ok) this.join();
  }

  static parseHash() {
    if (!location.hash || location.hash.length < 2) return null;
    const params = new URLSearchParams(location.hash.slice(1));
    const room = params.get('r');
    if (!room) return null;
    return { room: room.toUpperCase(), relayUrl: params.get('s') };
  }
}
