/**
 * The 16-channel rack UI.
 *
 * One row per channel, built once and then mutated in place — rebuilding rows
 * on every state change would destroy focus mid-typing and make the numeric
 * fields unusable. Every control writes straight to the channel model; the
 * model's `change` event writes back to any control the user is not currently
 * editing.
 */

import {
  WAVEFORMS_DICT,
  WAVEFORM_KEYS_LIST,
} from '../core/waveforms.js';
import { SILENCE_THRESHOLD_DB_FLOAT, formatDb } from '../util/amplitude.js';
import { clampToRange } from '../util/numeric.js';

export class ChannelRackUI {
  selected = 0;

  /** @type {Map<number, Record<string, HTMLElement>>} */
  #rows = new Map();

  /**
   * @param {HTMLElement} container
   * @param {import('../core/channel.js').ChannelRack} rack
   * @param {import('../core/tuning.js').Tuning} tuning_obj
   * @param {{onSelect?:(i:number)=>void}} [hooks]
   */
  constructor(container, rack, tuning_obj, hooks = {}) {
    this.container = container;
    this.rack = rack;
    this.tuning_obj = tuning_obj;
    this.hooks = hooks;

    this.#build();

    for (const ch of rack.channels_list) ch.on('change', () => this.sync(ch.index_int));
    tuning_obj.on('change', () => this.syncAll());
  }

  /* =================================================================== */

  #build() {
    const frag = document.createDocumentFragment();

    const head = document.createElement('div');
    head.className = 'chan-head';
    head.innerHTML = ['#', 'ON', 'WAVE', 'FREQUENCY', 'NOTE', 'LEVEL', 'PAN', 'Ø', 'M S']
      .map((t) => `<span>${t}</span>`)
      .join('');
    frag.appendChild(head);

    const waveOptions = WAVEFORM_KEYS_LIST.map(
      (k) => `<option value="${k}">${WAVEFORMS_DICT[k].label_str}</option>`
    ).join('');

    for (const ch of this.rack.channels_list) {
      const row = document.createElement('div');
      row.className = 'chan';
      row.dataset.index = String(ch.index_int);
      row.style.position = 'relative';
      row.innerHTML = `
        <button class="chan__idx" data-role="idx" title="Select channel ${ch.index_int + 1}">${String(ch.index_int + 1).padStart(2, '0')}</button>
        <button class="chan__power" data-role="power" aria-label="Enable channel ${ch.index_int + 1}"></button>
        <select class="input input--xs" data-role="wave" aria-label="Waveform">${waveOptions}</select>
        <input class="input input--xs mono" data-role="freq" type="text" inputmode="decimal" aria-label="Frequency in hertz">
        <span class="mono" data-role="note" style="font-size:10px;color:var(--ink-low);text-align:center"></span>
        <input class="input input--xs mono" data-role="gain" type="text" inputmode="decimal" aria-label="Level in dBFS">
        <input class="range range--bipolar" data-role="pan" type="range" min="-1" max="1" step="0.01" aria-label="Pan">
        <input class="input input--xs mono" data-role="phase" type="text" inputmode="numeric" aria-label="Phase in degrees">
        <span class="chan__flags">
          <button class="flag" data-flag="m" title="Mute">M</button>
          <button class="flag" data-flag="s" title="Solo">S</button>
        </span>
        <span class="chan__meter" style="position:absolute;left:8px;right:8px;bottom:0"><i></i></span>
      `;

      const q = (role) => row.querySelector(`[data-role="${role}"]`);
      const refs = {
        row,
        idx: q('idx'),
        power: q('power'),
        wave: q('wave'),
        freq: q('freq'),
        note: q('note'),
        gain: q('gain'),
        pan: q('pan'),
        phase: q('phase'),
        mute: row.querySelector('[data-flag="m"]'),
        solo: row.querySelector('[data-flag="s"]'),
        meter: row.querySelector('.chan__meter i'),
      };
      this.#rows.set(ch.index_int, refs);
      this.#wire(ch, refs);
      frag.appendChild(row);
    }

    this.container.appendChild(frag);
    this.syncAll();
    this.select(0);
  }

  #wire(ch, r) {
    const select = () => this.select(ch.index_int);

    r.row.addEventListener('pointerdown', (e) => {
      // Clicking anywhere on the row focuses it, but must not steal the click
      // from the control the user actually aimed at.
      if (e.target.closest('input, select, button')) return;
      select();
    });

    r.idx.addEventListener('click', select);

    r.power.addEventListener('click', () => {
      ch.toggle();
      select();
    });

    r.wave.addEventListener('change', () => ch.setWaveformName(r.wave.value));

    // Numeric fields commit on Enter or blur, never on every keystroke —
    // typing "1200" must not briefly play 1 Hz, then 12 Hz, then 120 Hz.
    const commitNumber = (input, apply, format) => {
      const commit = () => {
        const raw = input.value.trim();
        const parsed = parseValue(raw);
        if (parsed === null) {
          input.classList.add('is-invalid');
          setTimeout(() => input.classList.remove('is-invalid'), 700);
          format();
          return;
        }
        apply(parsed);
        format();
      };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commit(); input.blur(); }
        else if (e.key === 'Escape') { format(); input.blur(); }
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const dir = e.key === 'ArrowUp' ? 1 : -1;
          const mult = e.shiftKey ? 0.1 : e.altKey ? 10 : 1;
          const cur = parseValue(input.value) ?? 0;
          apply(cur + dir * mult);
          format();
        }
      });
      input.addEventListener('blur', commit);
      input.addEventListener('focus', () => { select(); input.select(); });
    };

    commitNumber(
      r.freq,
      // The real ceiling is Nyquist, which moves when the sample rate does.
      (v) => ch.setFrequencyHertz(clampToRange(v, 0.05, this.rack.engine.maxFrequencyHertz)),
      () => { r.freq.value = formatFreq(ch.frequency_hertz_float); }
    );

    commitNumber(
      r.gain,
      (v) => ch.setGainDb(clampToRange(v, SILENCE_THRESHOLD_DB_FLOAT, 0)),
      () => { r.gain.value = ch.gain_db_float <= SILENCE_THRESHOLD_DB_FLOAT ? '-inf' : ch.gain_db_float.toFixed(1); }
    );

    commitNumber(
      r.phase,
      (v) => ch.setPhaseDegrees(v),
      () => { r.phase.value = String(ch.phase_degrees_int); }
    );

    r.pan.addEventListener('input', () => {
      ch.setPanPosition(Number(r.pan.value));
      paintBipolar(r.pan);
    });
    r.pan.addEventListener('pointerdown', select);
    r.pan.addEventListener('dblclick', () => { ch.setPanPosition(0); this.sync(ch.index_int); });

    r.mute.addEventListener('click', () => ch.setMuted(!ch.is_muted_bool));
    r.solo.addEventListener('click', () => ch.setSoloed(!ch.is_soloed_bool));
  }

  /* =================================================================== */

  select(index) {
    this.selected = clampToRange(index, 0, this.rack.channels_list.length - 1);
    for (const [i, r] of this.#rows) r.row.classList.toggle('is-selected', i === this.selected);
    this.hooks.onSelect?.(this.selected);
    return this;
  }

  get selectedChannel() {
    return this.rack.getChannel(this.selected);
  }

  syncAll() {
    for (const ch of this.rack.channels_list) this.sync(ch.index_int);
  }

  sync(index) {
    const ch = this.rack.getChannel(index);
    const r = this.#rows.get(index);
    if (!ch || !r) return;

    r.row.classList.toggle('is-on', ch.is_enabled_bool);
    r.row.classList.toggle('is-live', ch.is_enabled_bool && !ch.is_muted_bool && !ch.is_silenced_by_solo_bool);
    r.row.classList.toggle('is-muted', ch.is_muted_bool || ch.is_silenced_by_solo_bool);

    if (document.activeElement !== r.wave) r.wave.value = ch.waveform_name_str;
    if (document.activeElement !== r.freq) r.freq.value = formatFreq(ch.frequency_hertz_float);
    if (document.activeElement !== r.gain) {
      r.gain.value = ch.gain_db_float <= SILENCE_THRESHOLD_DB_FLOAT ? '-inf' : ch.gain_db_float.toFixed(1);
    }
    if (document.activeElement !== r.phase) r.phase.value = String(ch.phase_degrees_int);
    if (document.activeElement !== r.pan) {
      r.pan.value = String(ch.pan_position_float);
      paintBipolar(r.pan);
    }

    const d = this.tuning_obj.describeFrequency(ch.frequency_hertz_float);
    const cents = Math.round(d.cents_float);
    r.note.textContent = Number.isFinite(d.midi_number_int)
      ? `${d.label_str}${cents === 0 ? '' : cents > 0 ? `+${cents}` : cents}`
      : '--';
    r.note.title = Number.isFinite(d.midi_number_int)
      ? `${d.label_str} (${d.exact_hertz_float.toFixed(2)} Hz ` +
        `at A4=${this.tuning_obj.referenceHertz})`
      : '';

    r.mute.classList.toggle('is-on', ch.is_muted_bool);
    r.solo.classList.toggle('is-on', ch.is_soloed_bool);
  }

  /** Drive the per-channel level meters. Called once per animation frame. */
  updateMeters() {
    for (const [i, r] of this.#rows) {
      const ch = this.rack.getChannel(i);
      const db = ch.is_enabled_bool ? ch.readPeakLevelDb() : -Infinity;
      // -60…0 dBFS mapped across the bar.
      const t = Number.isFinite(db) ? clampToRange((db + 60) / 60, 0, 1) : 0;
      r.meter.style.right = `${(1 - t) * 100}%`;
    }
  }
}

/* ------------------------------------------------------------------------ */

/** Accept "440", "1.5k", "1k2", "-inf", "12 dB". */
function parseValue(raw) {
  const s = String(raw).trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  if (s === '-inf' || s === '-∞' || s === 'off' || s === 'mute') return SILENCE_THRESHOLD_DB_FLOAT;

  const kMatch = /^([-+]?\d*\.?\d*)k(\d*)$/.exec(s);
  if (kMatch) {
    const whole = Number(kMatch[1] || 0);
    const frac = kMatch[2] ? Number(`0.${kMatch[2]}`) : 0;
    const v = (whole + frac) * 1000;
    return Number.isFinite(v) ? v : null;
  }

  const n = parseFloat(s.replace(/[a-z°%]+$/i, ''));
  return Number.isFinite(n) ? n : null;
}

function formatFreq(hz) {
  if (hz >= 10000) return hz.toFixed(0);
  if (hz >= 1000) return hz.toFixed(1);
  if (hz >= 100) return hz.toFixed(2);
  return hz.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

/** Paint the centre-anchored fill on a bipolar range input. */
export function paintBipolar(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const v = Number(input.value);
  const centre = ((0 - min) / (max - min)) * 100;
  const pos = ((v - min) / (max - min)) * 100;
  input.style.setProperty('--lo', `${Math.min(centre, pos)}%`);
  input.style.setProperty('--hi', `${Math.max(centre, pos)}%`);
}

/** Paint the left-anchored fill on a unipolar range input. */
export function paintRange(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const v = Number(input.value);
  input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
}
