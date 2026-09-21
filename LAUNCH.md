# SonicForge — Launch Kit

Everything needed to launch. The strategy in one line: **lead with visual
proof of utility, not a feature list.** Nobody shares a tone generator. People
share a 3D spectrogram and a phone that spits water out of its speaker.

---

## What is already in `assets/`

These are built and committed. Everything below that is marked **to record** is
the part that needs a camera and a real speaker.

| File | Size | Use |
|---|---|---|
| `logo.svg` | 560x140 | Horizontal lockup. README header, press kit, site footer. |
| `logo-mark.svg` | 140x140 | Square mark alone. Avatars, favicons, app tiles. |
| `icon.svg` / `icon-512.png` | 512x512 | PWA icon, Product Hunt thumbnail, social avatar. |
| `og.png` | 1200x630 | Open Graph / Twitter card. Already wired into `index.html`. |
| `screenshot.png` | 1720x940 | Full interface, 3D view active. Gallery slot 3. |
| `ph-gallery.png` | 1270x760 | Product Hunt gallery frame, correct aspect. |
| `demo.gif` | 960x524, 1.9 MB | Interface in motion. README hero. |
| `interference.gif` | 820x686, 1.4 MB | 440 Hz vs 444 Hz, stereo legs separating, nulls marked. Gallery slot 4. |

The Product Hunt gallery accepts 1270x760. `ph-gallery.png` is already at that
size; the other stills need to be padded or re-shot to match before upload.

**Still to record:** the water-eject clip (slot 2) and the 45-second video.
Both need a phone, water and a camera, so they cannot be generated from the
build.

---

## The two hero assets

Everything else is supporting material. Get these two right.

### 1. The 3D spectrogram (the scroll-stopper)

This is what makes someone stop. It must be the **first frame** of the video
and the **first screenshot** in the gallery.

**Shot recipe**
1. Open SonicForge. Press `V` until the **3D** tab is active.
2. Run the **Beat Frequency Lab** preset (440 Hz + 444 Hz).
3. Drag to orbit so the surface is seen at about 30° — near-flat looks like a
   2D graph, near-overhead loses the depth.
4. Add channels 3 and 4 by hand, sweeping them with the dial, so ridges climb
   and cross the surface.
5. Record 6–8 seconds. Loop it.

**Why it works:** the ridges move *because the sound is moving*. The viewer
understands the connection with no caption.

### 2. Speaker water eject (the utility proof)

This is what makes someone *save* it. It is the one feature with an
immediately obvious, personally relevant use.

**Shot recipe**
1. Phone face-down on a towel, speaker visible, shot from a low angle.
2. Put a visible bead of water on the speaker grille.
3. Trigger **Hardware Recovery → Speaker Water Eject** on the laptop.
4. Show the safety dialog for one beat — it signals care, not friction.
5. Cut to the grille. The water visibly jumps and clears.

**Why it works:** it is a real problem with a visible before and after, in
under ten seconds, with nothing installed.

---

## Product Hunt

### Name
**SonicForge**

### Tagline (60 char limit)
> A 16-channel tone generator with a live 3D spectrogram

Alternatives:
- `Precision audio lab in your browser. No install, nothing uploaded.`
- `Eject water from your speaker. And 15 other frequency tools.`

### Description (260 char limit)

> Sixteen independent tone channels with real phase control, seven noise
> colours, microphone room calibration, a scriptable terminal, and a WebGL 3D
> spectrogram. Plus one-click speaker water eject and headphone burn-in.
> Entirely client-side — nothing is uploaded, and it works offline.

### First comment (the maker's note)

> Hi Product Hunt 👋
>
> I built SonicForge because every online tone generator is a slider and a
> play button, and I kept needing more than that.
>
> **The part I'd point at first:** two channels 180° apart cancel to *exact*
> silence. That sounds obvious, but `OscillatorNode` in the Web Audio API has
> no phase parameter — you genuinely cannot start two oscillators at a chosen
> phase offset. SonicForge builds each waveform from its Fourier coefficients
> and rotates every harmonic, so the phase is baked into the wave table. The
> test suite asserts the residual is `0.00e+0`.
>
> **The part people actually use:** the speaker water eject. One click, 165 Hz
> pulse train, water comes out. It's the "oh, I needed this" feature.
>
> **Some things I decided not to do:**
> - No Three.js. The 3D spectrogram is raw WebGL2, because a CDN dependency
>   would break the offline guarantee.
> - No QR library — the encoder is written from ISO/IEC 18004 and verified
>   against Chrome's BarcodeDetector.
> - No backend, no analytics, no account. The microphone opens only during a
>   calibration measurement and is released in a `finally` block.
>
> There are 111 assertions plus a 53-check application self-test, and nothing is mocked — the noise tests measure
> the real spectrum of a generated buffer, and the integration tests render
> audio through `OfflineAudioContext` and check the samples. Pink noise
> measures −3.05 dB/octave against a nominal −3.
>
> It's MIT licensed. Happy to answer anything about the DSP.

### Topics
`Audio` · `Web App` · `Developer Tools` · `Open Source` · `Design Tools`

### Gallery order

| # | Asset | Caption |
|---|---|---|
| 1 | 3D spectrogram, animated | "Every tone you play, in three dimensions" |
| 2 | Water eject, phone + water | "One click. Water out of your speaker." |
| 3 | Full interface | "Sixteen channels. Real phase. Nothing uploaded." |
| 4 | Interference view, 180° null | "Watch two tones cancel to exact silence" |
| 5 | Calibration curve | "Measures your room with your own microphone" |
| 6 | Terminal mid-run | "Scriptable, on the audio clock" |

---

## The 45-second demo video

| Time | Shot | On screen |
|---|---|---|
| 0:00–0:06 | **3D spectrogram, already moving.** No logo first. | — |
| 0:06–0:10 | Pull back to the full interface. | `SonicForge` |
| 0:10–0:18 | Water eject: dialog → grille → water jumps. | `Speaker water eject` |
| 0:18–0:26 | Interference view. Drag channel 2's phase 0° → 180°. Trace collapses. | `Two tones. Exact cancellation.` |
| 0:26–0:34 | Calibration: sweep plays, curve draws in. | `Measures your room` |
| 0:34–0:40 | Terminal: type `loop(4, [ play(880,100), wait(150) ])`, run it. | `Scriptable` |
| 0:40–0:45 | Back to the 3D view. URL card. | `No install · Nothing uploaded · Open source` |

**Audio:** use the app's own output. Do not put music over it — this is an
audio tool and the sound *is* the demo.

---

## Hacker News

Title:
> Show HN: SonicForge – 16-channel tone generator with a WebGL 3D spectrogram

HN wants the engineering, not the feature list. Lead the comment with:

1. Why `OscillatorNode` has no phase and what it takes to work around it.
2. The two-clock scheduler: lookahead scheduling on the sample clock.
3. Why the room calibration probes latency first — a 100 ms round trip is
   more than an octave of error at the top of an exponential sweep.
4. Writing a QR encoder from the ISO spec to avoid a CDN dependency.
5. The measured test numbers.

Expect to be asked: *why not Three.js*, *why no bundler*, *how accurate is the
calibration really*. Answer all three honestly — the calibration is a
single-position measurement smoothed to third-octave, which is useful for
correcting a speaker and is **not** a substitute for a proper acoustic survey.

---

## Reddit

Tailor per subreddit; a single cross-post reads as spam.

| Subreddit | Angle |
|---|---|
| `r/audiophile` | Room calibration and the 10-band correction curve. |
| `r/edmproduction` | Phase cancellation and the beat-frequency lab. |
| `r/DIY` `r/lifehacks` | Water eject only. Lead with the phone video. |
| `r/webdev` | Zero dependencies, raw WebGL2, hand-written QR encoder. |
| `r/physics` `r/chemistry` | Flame acoustics: Rubens tube, Rijke tube, candle flicker lock. |

---

## Pre-launch checklist

- [ ] Deploy and confirm the live URL loads
- [ ] Open the live URL on a phone — check the responsive layout
- [ ] Confirm the OG card renders (paste the link into Slack or Twitter)
- [ ] Run `tests.html` on the deployed URL — 111 green
- [ ] Go offline and reload — the service worker should serve the app
- [ ] Record both hero assets
- [ ] Set the repo description and topics
- [ ] Confirm `LICENSE` is present
- [ ] Answer the first three comments within the hour

---

## Positioning

**Against NCH / Szynalski / Tonal.fm**

Do not attack them. They are fine at what they do. Position on the gap:

> Those are tone generators. This is a frequency lab that happens to start
> with a tone generator.

The credible differentiators, in order of how much anyone cares:

1. **You can see it.** 3D spectrogram and interference view.
2. **It does something for you.** Water eject, burn-in, room calibration.
3. **It is honest about privacy.** No upload, no account, works offline.
4. **It is serious underneath.** Real phase control, measured noise slopes,
   latency-corrected calibration, 164 assertions across two suites.

Lead with 1 and 2. Keep 3 and 4 for the people who ask — and some will.
