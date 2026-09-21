/**
 * The scripting terminal.
 *
 * A command palette with a rolling log, history, inline signature hints, and a
 * live execution tracker. The tracker is the part that earns its place: because
 * the VM schedules ahead of real time, it can tell you exactly which block is
 * sounding right now and how many milliseconds remain in it — something a
 * setTimeout-chained sequencer fundamentally cannot report.
 */

import { COMMANDS, COMMAND_NAMES } from '../script/commands.js';
import { VM_STATE } from '../script/vm.js';
import { formatDuration } from '../util/frequency.js';

const MAX_LINES = 400;
const HISTORY_KEY = 'sonicforge.history';

export class Terminal {
  #history = [];
  #historyIndex = -1;
  #draft = '';
  #multiline = false;

  /**
   * @param {HTMLElement} root  the .term container
   * @param {import('../script/vm.js').ScriptVM} vm
   */
  constructor(root, vm) {
    this.root = root;
    this.vm = vm;

    this.logEl = root.querySelector('[data-term="log"]');
    this.input = root.querySelector('[data-term="input"]');
    this.ghost = root.querySelector('[data-term="ghost"]');
    this.tracker = root.querySelector('[data-term="tracker"]');
    this.pcEl = root.querySelector('[data-term="pc"]');
    this.barEl = root.querySelector('[data-term="bar"]');
    this.countEl = root.querySelector('[data-term="count"]');

    this.#loadHistory();
    this.#bindInput();
    this.#bindVm();
    this.banner();
  }

  /* ===================================================================
     Logging
     =================================================================== */

  /**
   * @param {string} text
   * @param {'in'|'ok'|'exec'|'warn'|'err'|'dim'} [level]
   */
  log(text, level = 'dim') {
    const line = document.createElement('div');
    line.className = `term__line term__line--${level}`;

    const now = new Date();
    const ts = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;

    const t = document.createElement('span');
    t.className = 'term__ts';
    t.textContent = ts;

    const m = document.createElement('span');
    m.className = 'term__msg';
    m.textContent = String(text);

    line.append(t, m);
    this.logEl.appendChild(line);

    while (this.logEl.childElementCount > MAX_LINES) this.logEl.firstElementChild.remove();

    // Only autoscroll when the user is already at the bottom — otherwise
    // reading back through a long run becomes impossible.
    const nearBottom = this.logEl.scrollHeight - this.logEl.scrollTop - this.logEl.clientHeight < 48;
    if (nearBottom) this.logEl.scrollTop = this.logEl.scrollHeight;
    return line;
  }

  clear() {
    this.logEl.replaceChildren();
  }

  banner() {
    this.log('SonicForge script terminal — type help() for the command list.', 'dim');
    this.log('play(440hz, 1s, sine)      loop(4, [ play(880,100), wait(150) ])', 'dim');
  }

  /* ===================================================================
     Input
     =================================================================== */

  #bindInput() {
    const input = this.input;

    input.addEventListener('input', () => this.#updateGhost());

    input.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'Enter':
          if (this.#multiline && !e.ctrlKey && !e.metaKey) return; // newline
          e.preventDefault();
          this.submit();
          break;

        case 'Tab':
          e.preventDefault();
          this.#complete();
          break;

        case 'ArrowUp':
          if (this.#multiline) return;
          e.preventDefault();
          this.#recall(-1);
          break;

        case 'ArrowDown':
          if (this.#multiline) return;
          e.preventDefault();
          this.#recall(1);
          break;

        case 'Escape':
          e.preventDefault();
          if (input.value) { input.value = ''; this.#updateGhost(); }
          else input.blur();
          break;

        case 'c':
          if (e.ctrlKey) {
            e.preventDefault();
            this.vm.stop();
            this.log('^C  execution halted', 'warn');
          }
          break;

        default:
          break;
      }
    });
  }

  /** Show the signature of the command currently being typed. */
  #updateGhost() {
    if (!this.ghost) return;
    const value = this.input.value;
    const head = /^\s*([a-z_][\w]*)\s*\(?/i.exec(value);
    if (!head) { this.ghost.textContent = ''; return; }

    const name = head[1].toLowerCase();
    const spec = COMMANDS[name];
    if (spec && value.length >= head[0].length) {
      // Render the remaining part of the signature as an inline ghost.
      this.ghost.textContent = ' '.repeat(value.length) + '  ' + spec.signature;
    } else {
      const match = COMMAND_NAMES.find((k) => k.startsWith(name) && k !== name);
      this.ghost.textContent = match ? value + match.slice(name.length) : '';
    }
  }

  #complete() {
    const value = this.input.value;
    const m = /([a-z_][\w]*)$/i.exec(value);
    if (!m) return;
    const partial = m[1].toLowerCase();
    const matches = COMMAND_NAMES.filter((k) => k.startsWith(partial));

    if (matches.length === 1) {
      this.input.value = value.slice(0, m.index) + matches[0] + '(';
      this.#updateGhost();
    } else if (matches.length > 1) {
      this.log(matches.join('   '), 'dim');
      // Extend to the longest common prefix so repeated Tab still makes progress.
      let prefix = matches[0];
      for (const k of matches) {
        while (!k.startsWith(prefix)) prefix = prefix.slice(0, -1);
      }
      this.input.value = value.slice(0, m.index) + prefix;
      this.#updateGhost();
    }
  }

  #recall(direction) {
    if (!this.#history.length) return;
    if (this.#historyIndex === -1 && direction === -1) this.#draft = this.input.value;

    this.#historyIndex += direction === -1 ? 1 : -1;
    this.#historyIndex = Math.max(-1, Math.min(this.#history.length - 1, this.#historyIndex));

    this.input.value = this.#historyIndex === -1
      ? this.#draft
      : this.#history[this.#history.length - 1 - this.#historyIndex];

    this.#updateGhost();
    requestAnimationFrame(() => {
      this.input.selectionStart = this.input.selectionEnd = this.input.value.length;
    });
  }

  submit() {
    const source = this.input.value.trim();
    if (!source) return;

    this.log(source, 'in');
    this.#push(source);
    this.input.value = '';
    this.#updateGhost();
    this.#historyIndex = -1;

    // Built-ins that never reach the VM.
    const bare = source.replace(/\(\s*\)\s*$/, '').toLowerCase();
    if (bare === 'help') return this.help();
    if (bare === 'clear' || bare === 'cls') return this.clear();
    if (bare === 'history') {
      this.#history.slice(-20).forEach((h, i) => this.log(`${i + 1}. ${h}`, 'dim'));
      return;
    }

    try {
      this.vm.run(source, { label: 'terminal' });
    } catch (err) {
      this.log(err.format ? err.format() : err.message, 'err');
    }
  }

  help(name = null) {
    if (name && COMMANDS[name]) {
      const c = COMMANDS[name];
      this.log(c.signature, 'ok');
      this.log(`  ${c.help}`, 'dim');
      this.log(`  e.g. ${c.example}`, 'dim');
      return;
    }
    this.log('Commands', 'ok');
    for (const key of COMMAND_NAMES) {
      const c = COMMANDS[key];
      this.log(`  ${c.signature}`, 'exec');
      this.log(`      ${c.help}`, 'dim');
    }
    this.log('  help  clear  history                 built-ins', 'exec');
    this.log('Units: 440hz 1.5khz 250ms 2s -12db 180deg. Notes work too: play(A4).', 'dim');
  }

  #push(source) {
    if (this.#history[this.#history.length - 1] === source) return;
    this.#history.push(source);
    if (this.#history.length > 100) this.#history.shift();
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(this.#history.slice(-60)));
    } catch {}
  }

  #loadHistory() {
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) this.#history = JSON.parse(raw).filter((s) => typeof s === 'string');
    } catch {
      this.#history = [];
    }
  }

  /** Switch between the single-line palette and a multi-line script pad. */
  setMultiline(on) {
    this.#multiline = !!on;
    const old = this.input;
    const next = document.createElement(on ? 'textarea' : 'input');
    next.className = 'term__input';
    next.dataset.term = 'input';
    next.value = old.value;
    if (on) {
      next.rows = 6;
      next.style.resize = 'vertical';
      next.style.padding = '8px 0';
      next.placeholder = 'Multi-line script — Ctrl+Enter to run';
      old.closest('.term__prompt').style.height = 'auto';
      old.closest('.term__prompt').style.alignItems = 'flex-start';
      old.closest('.term__prompt').style.paddingTop = '8px';
    } else {
      next.type = 'text';
      next.placeholder = 'play(440hz, 1s, sine)';
      old.closest('.term__prompt').style.height = '';
      old.closest('.term__prompt').style.alignItems = '';
      old.closest('.term__prompt').style.paddingTop = '';
    }
    old.replaceWith(next);
    this.input = next;
    this.#bindInput();
    next.focus();
    if (this.ghost) this.ghost.textContent = '';
    return this;
  }

  get multiline() {
    return this.#multiline;
  }

  /** Load text into the input without running it. */
  load(source) {
    if (!this.#multiline && /\n/.test(source.trim())) this.setMultiline(true);
    this.input.value = source.trim();
    this.input.focus();
    return this;
  }

  /* ===================================================================
     Execution tracker
     =================================================================== */

  #bindVm() {
    const vm = this.vm;

    vm.on('start', ({ label, count }) => {
      this.log(`▸ running ${label} — ${count} command${count === 1 ? '' : 's'}`, 'ok');
      this.tracker.hidden = false;
    });

    vm.on('tick', (snap) => this.#renderTracker(snap));

    vm.on('finish', ({ label }) => {
      this.tracker.hidden = true;
      this.log(`▪ ${label} finished`, 'ok');
    });

    vm.on('stop', () => {
      this.tracker.hidden = true;
      this.log('▪ stopped', 'warn');
    });

    vm.on('error', (err) => {
      this.tracker.hidden = true;
      this.log(err.format ? err.format() : err.message, 'err');
    });

    vm.on('log', ({ level, text }) => this.log(text, level));
  }

  #renderTracker(snap) {
    if (!snap.current) {
      this.pcEl.textContent = snap.state === VM_STATE.DRAINING ? 'draining' : '—';
      this.barEl.style.width = '0%';
      this.countEl.textContent = '';
      return;
    }

    const c = snap.current;
    const loop = c.iterations > 1 ? `  ↻ ${c.iteration}/${c.iterations}` : '';
    const depth = c.depth > 0 ? '│'.repeat(c.depth) + ' ' : '';
    this.pcEl.textContent = `${depth}${c.label}${loop}`;
    this.barEl.style.width = `${Math.round(snap.progress * 100)}%`;
    this.countEl.textContent = snap.remainMs > 0
      ? `${formatDuration(snap.remainMs)} │ ${formatDuration(snap.totalMs)}`
      : formatDuration(snap.totalMs);
  }
}
