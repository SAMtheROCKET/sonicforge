# SonicForge — Build Tracker

**Stack:** vanilla ES2022 modules · Web Audio API · raw WebGL2 (no Three.js CDN) · zero runtime dependencies · 100% client-side.

**Deploy:** GitHub Pages + Vercel (both configs shipped). Fully static — no server required for any core feature.

Status key: `[ ]` todo · `[~]` built, not yet verified · `[x]` done + tested · `[!]` blocked / needs user input

---

## Phase 0 — Foundation
- [x] P0.1 Directory scaffold + deploy configs (Pages workflow, vercel.json, .nojekyll)
- [x] P0.2 `serve.py` — stdlib static server + WebSocket relay (dev only, optional)
- [x] P0.3 Design tokens + glassmorphism CSS system (`theme.css`, `components.css`)
- [x] P0.4 `util/events.js`, `util/math.js` (clamp/lerp/log-map + mat4 for WebGL)

## Phase 1 — DSP primitives (pure, unit-testable)
- [x] P1.1 `dsp/fft.js` — iterative radix-2 Cooley–Tukey, forward + inverse, in-place
- [x] P1.2 `dsp/weighting.js` — A/C-weighting, inverse equal-loudness, fractional-octave smoothing
- [x] P1.3 `dsp/noise-shapes.js` — Voss–McCartney (pink), Brownian integration (brown),
      spectral-shaping IFFT path (white/blue/violet/grey/green), seamless-loop conditioning
- [x] P1.4 `core/tuning.js` — A4 offset, MIDI↔Hz, note parsing, cents deviation
- [x] P1.5 `core/waveforms.js` — analytic harmonic tables + phase-rotated PeriodicWave cache

## Phase 2 — Core engine
- [x] P2.1 `core/engine.js` — resilient AudioContext, gesture unlock, master chain, telemetry
- [x] P2.2 `core/channel.js` — 16 channels: osc routing, dBFS gain, pan, phase, glide, mute/solo
- [x] P2.3 `core/noise.js` — global noise generator, 7 colours, A/B hybrid blend, shaping filter
- [x] P2.4 Master A4 recalibration propagating to every note selector

## Phase 3 — Smart hardware auto-calibration
- [x] P3.1 `core/calibration.js` — getUserMedia capture w/ AGC/NS/AEC disabled
- [x] P3.2 1 kHz latency probe + 3 s log sweep, synchronous capture, noise-floor gating
- [x] P3.3 Delta computation: measured vs ideal, ⅓-octave smoothing, confidence scoring
- [x] P3.4 10-band BiquadFilterNode compensation array, apply/bypass, export/import JSON

## Phase 4 — Scripting terminal
- [x] P4.1 `script/lexer.js` + `script/parser.js` — unit-aware tokens, JSON array form
- [x] P4.2 `script/vm.js` — non-blocking VM, lookahead scheduling on the audio clock
- [x] P4.3 `script/commands.js` — play / sweep / wait / loop + 11 more
- [x] P4.4 `ui/terminal.js` — palette, history, autocomplete, live block tracker + ms countdown

## Phase 5 — 3D visualisation
- [x] P5.1 `viz/glutil.js` — shader/program/texture helpers, orbit controls
- [x] P5.2 `viz/waterfall.js` — WebGL2 3D spectrogram, vertex-texture displacement, 2D fallback
- [x] P5.3 `viz/interference.js` — phase-cancellation field + goniometer + beat detection

## Phase 6 — Presets
- [x] P6.1 Hardware Recovery: water eject, 3-tier burn-in, micro-vibration, polarity
- [x] P6.2 Focus & Acoustic Shielding: brown⇄pink hybrid shaped against the 300–3400 Hz vocal band
- [x] P6.3 Lab & Scientific: resonance detection, room modes, DTMF, phase-null, beat lab, hearing range

## Phase 7 — Concert Mode
- [x] P7.1 `sync/transport.js` — BroadcastChannel / WebSocket relay / WebRTC manual pairing
- [x] P7.2 NTP-style clock offset estimation with outlier rejection
- [x] P7.3 Room-code handshake + `util/qr.js` (ISO 18004 encoder, written from spec)
- [x] P7.4 Per-node 0–360° phase offset mapping

## Phase 8 — Shell & UX
- [x] P8.1 `index.html` modular glass grid layout
- [x] P8.2 `ui/dial.js` — infinite log-domain rotational dial + direct numeric entry
- [x] P8.3 `ui/channels.js`, `ui/panels.js`, `ui/feedback.js`, `ui/icons.js`
- [x] P8.4 Keyboard shortcuts, localStorage persistence, responsive layout

## Phase 9 — Rigorous testing
- [x] P9.1 `tests.html` — assertion harness (no framework), grouped suites, pass/fail table
- [x] P9.2 Unit suites: FFT, weighting, noise slopes, tuning, waveforms, lexer/parser/commands, QR, transport
- [x] P9.3 Integration suite: real audio rendered through OfflineAudioContext
- [x] P9.4 Live Chrome pass: run the suite, open the app, exercise every module, read the console
- [x] P9.5 Fix-and-reverify loop until all suites are green and the console is clean

## Phase 10 — Ship
- [x] P10.1 README: run, deploy to Pages, deploy to Vercel, architecture map
- [x] P10.2 Service worker (offline), OG image, `tailwind.config.js` token export
- [x] P10.3 Launch kit: Product Hunt copy angled at the 3D visualiser + water eject

## Phase 11 — Infrasound, ultrasound & flame acoustics  *(added at user request)*
- [x] P11.1 Nyquist-derived frequency limits everywhere + selectable sample rate (44.1 / 48 / 96 / 192 kHz)
- [x] P11.2 High-resolution analyser (32768-point FFT) so sub-20 Hz tones are actually visible
- [x] P11.3 `am()` command — amplitude-modulated carrier, the only way real speakers deliver an infrasonic envelope
- [x] P11.4 Flame Acoustics preset group: candle flicker lock, extinction sweep, Rubens tube stepper,
      premixed wrinkle sweep, Rijke tube finder, ultrasonic sweep
- [x] P11.5 Physics + safety notes in the README (SPL, hearing protection, open flame)

## Phase 12 — Full-repo refactor to the house style  *(added at user request)*
Baseline measured by `tools/lint_style.py`: **1,776 violations / 30 files / 10,464 lines**.
Rules: OOP structure, `<meaning>_<dtype>` names, verb-first typed functions, full docstrings
(Title/Brief/Arguments/Returns/Warning), UPPER_SNAKE constants after imports, <=50 LOC per
function, <=100 LOC entry point, <=79 char lines. Applies to **every** language in the repo.

- [x] P12.0 `STYLE_GUIDE.md` + `tools/lint_style.py` enforcing every machine-checkable rule
- [x] P12.1 `js/util/` — events, math, qr
- [x] P12.2 `js/dsp/` — fft, weighting, noise-shapes
- [x] P12.3 `js/core/` — tuning, waveforms, engine, channel, noise, calibration
- [x] P12.4 `js/script/` — lexer, parser, vm, commands
- [x] P12.5 `js/viz/` — glutil, waterfall, interference (fixed: dead goniometer)
- [x] P12.6 `js/ui/` — icons, feedback, dial, channels, terminal;
      panels split into calibration-panel + concert-panel
      (fixed: dead row frequency field, dead calibration readout,
      Concert sync tone ignoring the selected channel)
- [x] P12.7a `js/script/vm.js`
- [x] P12.7b `js/script/commands.js` — split into arguments,
      runtime, voice and the registry (fixed: dead set() alias)
- [x] P12.7c `js/sync/` — transport + signal-codec + concert
      (fixed: dead phase slider, dropped node phase offset)
- [x] P12.7d `js/presets/` — split by group
      (fixed: noise blend slot, Tinnitus Notch frequency)
- [x] P12.8 `main.js` split into js/app — entry point 33 code lines of 100
      (fixed: reload restarted audio, add-tone lost the waveform)
- [x] P12.8b `selftest.js` split into a harness + five check modules
- [x] P12.9a Python — serve.py split into four modules, linter split in two
- [x] P12.9b CSS — clean; one data URI documented as unwrappable
- [x] P12.9c HTML — tests.html fully wrapped; index.html down to 9 lines,
      all metadata or provably unbreakable. Verified by diffing rendered
      geometry of all 111 ids before and after (STYLE_GUIDE 4.1)
- [x] P12.10 Lint is zero across 76 JS and 8 Python files; suites green at
      115 unit + 65 app, 0 console errors

---

## P13 — Ship

- [x] P13.1 Public repo at `github.com/SAMtheROCKET/sonicforge`
- [x] P13.2 GitHub Pages live at `samtherocket.github.io/sonicforge/`
- [x] P13.3 All 61 deployed files verified byte-identical to the commit
- [x] P13.4 Repo description, homepage and 12 topics set
- [x] P13.5 Brand marks — logo, square mark, PWA icon, 512px raster
- [x] P13.6 Captures — demo.gif, interference.gif, screenshot.png, ph-gallery.png
- [x] P13.7 README rewritten around the visuals and why the tool exists
- [x] P13.8 Launch kit updated with the asset inventory
- [x] P13.9 Social card made absolute; manifest icon set corrected
- [ ] P13.10 Scan the Concert Mode QR with a real phone (cannot be done headlessly)
- [ ] P13.11 Confirm the service worker offline-serves on HTTPS (needs the live site)
- [ ] P13.12 Record the water-eject clip and the 45-second demo video
- [ ] P13.13 Optional: enable the CI workflow from `ci/` (needs `workflow` token scope)
- [ ] P13.14 Vercel deploy as the second target

---

## Open questions
| # | Question | Status |
|---|----------|--------|
| Q1 | Brand name | **SonicForge** |
| Q2 | Deploy target | **GitHub Pages + Vercel** |
| Q3 | Concert Mode transport | **Tiered: BroadcastChannel → relay → WebRTC** |
| Q4 | Testing depth | **Unit harness + live Chrome** |
| Q5 | Mic privacy copy — never uploaded, never stored, stream released on completion | implemented, awaiting confirmation |
| Q6 | Water-eject safety interlock (confirm dialog + −6 dBFS cap) | implemented on by default |
| Q7 | GitHub repo name (affects Pages base path; all paths are relative so either works) | **sonicforge** |
| Q8 | Flame rig: candle only, or butane burner / Rubens tube too? Changes which presets lead. | pending |
