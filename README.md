<div align="center">

# SonicForge

**Forge any frequency.**

A 16-channel precision tone generator, seven-colour noise lab, microphone room
calibration, a scriptable terminal and a real-time 3D spectrogram —
running entirely in your browser.

**No install · No account · Nothing uploaded · Works offline**

</div>

---

## What it is

Most online tone generators are a slider and a play button. SonicForge is the
tool you reach for when that is not enough:

| | |
|---|---|
| **16 independent channels** | Each with its own waveform, dBFS level, stereo position, **starting phase**, detune and glide. Run sixteen at once. |
| **Real phase control** | `OscillatorNode` has no phase parameter. SonicForge builds each wave from its Fourier coefficients and rotates every harmonic, so two channels 180° apart cancel to *exact silence* — not "quite quiet". |
| **Seven noise colours** | White, pink (Voss–McCartney), brown (Brownian integration), blue, violet, grey (inverse equal-loudness) and green. Any two cross-blend with an equal-power curve. |
| **Room auto-calibration** | Plays a 3-second sweep, listens with your microphone, and builds a 10-band correction curve. Measures the round-trip latency first — without that step the measurement lands on the wrong frequencies. |
| **3D spectrogram** | WebGL2 waterfall with vertex-texture displacement. X = time, Y = amplitude, Z = log frequency. Orbit and zoom. |
| **Interference view** | Analytic superposition of every audible channel, per stereo leg, with the individual contributions drawn as ghosts — so you can *see* cancellation, not just hear the result get quiet. |
| **Scriptable** | A small unit-aware language: `loop(4, [ play(440hz, 200ms), wait(100ms) ])`. Runs on the audio clock with lookahead scheduling, so it never drifts and never blocks the interface. |
| **Concert Mode** | Sync several devices with NTP-style clock alignment and a per-device phase offset, for real spatial-cancellation experiments. |

Frequency range is **0.05 Hz to just under Nyquist** — 24 kHz at the default
sample rate, **48 kHz** if you switch the context to 96 kHz.

---

## Run it locally

No build step, no dependencies. You only need a static server, because ES
modules cannot load from `file://`.

```bash
git clone https://github.com/<you>/sonicforge.git
cd sonicforge
python server/serve.py
```

```
  local     http://localhost:8080/
  network   http://192.168.1.20:8080/     <- open this on your phone
  tests     http://localhost:8080/tests.html
  relay     ws://192.168.1.20:8787        <- Concert Mode / LAN
```

Any static server works — `npx serve`, `php -S`, anything. The bundled
`server/serve.py` is pure standard library and additionally runs the optional
WebSocket relay used by Concert Mode's LAN tier.

---

## Deploy

The whole application is static. Both targets are configured and verified in
CI.

### GitHub Pages

Push to `main`. `.github/workflows/pages.yml` verifies the build and deploys
it. In **Settings → Pages**, set **Source** to **GitHub Actions**.

The workflow refuses to deploy if any HTML uses an absolute asset path,
because Pages serves a project site under `/repo-name/` and an absolute path
would resolve to the wrong place. Every path in this repo is relative, so it
works at a subpath or at a domain root without changes.

### Vercel

```bash
npx vercel deploy --prod
```

`vercel.json` sets the correct `text/javascript` MIME type for ES modules,
a `no-cache` policy on `sw.js` so updates are picked up, and a
`Permissions-Policy` that allows the microphone and denies everything else.

### After deploying

```bash
python tools/build_precache.py   # regenerate if you changed any file
```

The service worker precaches all 52 shipped files (~627 KB) so the app works
with no connection at all. It is deliberately **not** registered on
`localhost`, or a cache-first worker would serve your previous edit back on
every reload.

---

## Privacy

There is no backend. There is nothing to have a backend *for*.

- **Nothing is uploaded, ever.** No analytics, no telemetry, no CDN.
- **The microphone** is opened only while a calibration measurement runs and
  released in a `finally` block, so it is let go even if the measurement
  fails or you cancel it. No audio is recorded or stored — only a 96-point
  magnitude curve ever leaves the analyser, and that stays in your browser.
- **Your session** (channels, noise settings, calibration curve) is kept in
  `localStorage` on your own device.
- **Concert Mode** on the default tier uses `BroadcastChannel`, which never
  leaves your browser. The LAN tier talks to a relay *you* run; it forwards
  bytes and never inspects, stores or logs them.

---

## Architecture

Vanilla ES2022 modules. No framework, no bundler, no runtime dependency — the
app makes **zero network requests** once loaded, which is what makes the
offline guarantee real rather than aspirational.

```
index.html            application shell
tests.html            assertion suite (open it; it runs itself)

js/
  main.js             bootstrap and wiring
  pwa.js              service-worker registration

  util/               pure helpers, no audio knowledge
    numeric  amplitude  frequency  random  matrix4  events
    qr  qr-patterns  qr-masking  qr-error-correction

  dsp/                pure signal processing, unit-testable
    fourier           radix-2 FFT, forward and inverse
    weighting         A/C-weighting, inverse equal-loudness
    smoothing         fractional-octave smoothing, log resampling
    noise-synthesis   the generators
    noise-colours     the catalogue

  core/               the audio graph
    audio-engine      context lifecycle + master chain
    master-meter      the analyser taps
    calibration-equaliser   the ten correction bands
    gesture-unlock    autoplay-policy handling
    output-device     setSinkId routing
    tone-channel      one voice
    channel-rack      the sixteen, plus solo masking
    channel-serialisation   capture/restore (untrusted input)
    tuning            concert pitch, note maths
    waveforms         phase-rotated wave tables
    room-calibrator   measurement orchestration
    calibration-capture     microphone and stimulus
    calibration-analysis    response to correction curve

  script/             lexer -> parser -> VM -> commands
  viz/                glutil, waterfall (WebGL2), interference (2D)
  ui/                 dial, channels, terminal, panels, feedback, icons
  sync/               transport tiers, Concert Mode clock
  presets/            the intent-driven preset catalogue

tools/
  lint_style.py       enforces STYLE_GUIDE.md
  check_wiring.py     imports resolve, DOM ids exist, tokens defined
  build_precache.py   service-worker manifest
```

### Three decisions worth knowing about

**No Three.js.** The 3D spectrogram is raw WebGL2 — one shader program, one
indexed mesh, one streaming texture. Pulling a scene graph from a CDN to get
that would have cost the offline guarantee.

**The QR encoder is written from ISO/IEC 18004.** Concert Mode needs a phone
to join in one gesture, and a QR library would have been a network request.
It is ~1,100 lines across four modules and is verified end-to-end against
Chrome's `BarcodeDetector`.

**The scripting VM runs on two clocks.** A 25 ms wall-clock tick walks the
instruction list *ahead of real time*, scheduling audio against the sample
clock up to a 350 ms lookahead. Chaining `setTimeout` calls instead would
accumulate jitter until a sixteen-step loop sounded ragged.

---

## Testing

```bash
python server/serve.py
# open http://localhost:8080/tests.html
```

**159 assertions, no framework.** Nothing is mocked: the noise tests measure
the actual spectrum of a generated buffer, and the integration tests render
real audio through `OfflineAudioContext` and measure the samples.

Representative measured results:

```
PeriodicWave vs native sine        max sample difference  0.00e+0
180°-opposed sines                 residual peak          0.00e+0
90° phase rotation                 lag 32 samples (quarter period = 32)
pink noise slope                   -3.05 dB/octave  (nominal -3)
brown noise slope                  -5.57 dB/octave  (nominal -6)
blue noise slope                   +3.35 dB/octave  (nominal +3)
violet noise slope                 +6.30 dB/octave  (nominal +6)
Hann scalloping loss               -1.42 dB (theoretical worst case)
QR encoder                         version 5, 37x37, 50.4% dark
```

The first line matters more than it looks. The entire phase feature depends
on Web Audio evaluating a `PeriodicWave` as `Σ real·cos + imag·sin`, and a
silently inverted sign convention would be very hard to notice by ear. So it
is asserted against the browser's own oscillator.

There is also an application self-test — 48 checks that boot the real app,
exercise every module and audit the layout:

```bash
# on localhost only
open http://localhost:8080/index.html?selftest=1
```

Both suites can run headlessly and POST their results back to the dev server,
which is how they are run in CI.

---

## Flame, infrasound and ultrasound

SonicForge will happily synthesise a perfect 7 Hz sine. **Your speaker will
not reproduce it.** A laptop driver rolls off below ~400 Hz; a bookshelf
speaker below ~50 Hz. If nothing moves, that is the transducer, not the
signal.

The workaround is the `am()` command: amplitude-modulate an audible carrier
at the infrasonic rate. A 200 Hz carrier with an 11 Hz envelope delivers an
**11 Hz forcing** that a flame responds to, while the speaker only ever has
to reproduce 200 Hz.

| Effect | Band | Notes |
|---|---|---|
| Candle flicker lock-in | **9–15 Hz** | A candle's buoyancy-driven flicker is already ~10–13 Hz. Drive near it and the flicker phase-locks. Use `am()`. |
| Flame extinction by sound | **30–60 Hz** | Needs a subwoofer and real SPL. |
| Rubens tube standing waves | **50–250 Hz** | λ = c/f. At 150 Hz, λ ≈ 2.3 m. |
| Premixed front wrinkling | **100–600 Hz** | Best visible band for a butane burner. |
| Rijke / thermoacoustic | **f = c/2L or c/4L** | ~170–340 Hz for a 0.5–1 m tube. |
| Ultrasound | **>20 kHz** | Needs a 96 kHz context *and* a piezo tweeter. |

> **Flames respond to acoustic velocity, not pressure.** Put the flame at a
> velocity antinode, which is a *pressure node* — in a Rubens tube that is
> where the flames are **shortest**, not tallest. Getting this backwards is
> the most common reason people report "no effect".

### Safety

- Sustained levels above ~85 dB damage hearing. The loud presets cap master
  output and require confirmation, but they cannot measure your room.
- **Take headphones off** before any speaker routine. The water-eject and
  extinction presets are genuinely unsafe in-ear.
- Never leave an open flame unattended. A Rubens tube is a pipe full of
  flammable gas — build and operate one only if you already know how.

---

## Keyboard

| | |
|---|---|
| `Space` | Play / stop everything |
| `Esc` | Panic — immediate silence |
| `/` | Focus the script terminal |
| `1`–`9` | Toggle that channel |
| `↑` `↓` | Select previous / next channel |
| `M` `S` | Mute / solo the selected channel |
| `N` | Toggle the noise generator |
| `V` | Cycle the visualiser |

On the dial: **Shift** for fine, **Alt** for coarse, **Ctrl** to snap to
semitones. In the terminal: **Tab** completes, **↑** recalls history,
**Ctrl+C** halts.

---

## Contributing

`STYLE_GUIDE.md` is the contract, and it is machine-enforced:

```bash
python tools/lint_style.py          # whole repo
python tools/lint_style.py js/core  # one directory
python tools/check_wiring.py        # imports and DOM references
```

In short: one responsibility per module, `<meaning>_<dtype>` variable names,
verb-first function names, full docstrings on every export, `UPPER_SNAKE`
constants after the imports, ≤50 code lines per function, ≤79 characters per
line.

The style conversion is in progress — the maths, DSP, audio-graph and
scripting layers are fully converted; `ui/`, `viz/` and the `main.js`
decomposition are not yet. `lint_style.py --summary` prints the current
count.

---

## Licence

MIT.
