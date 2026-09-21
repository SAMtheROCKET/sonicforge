/**
 * Intent-driven presets.
 *
 * A preset is not a bag of slider positions — it is a stated goal plus the
 * exact routine that achieves it. Each one either runs a script through the VM
 * (for anything time-varying) or configures engine state directly (for anything
 * steady-state), and several do both.
 *
 * Presets that can plausibly damage hardware or hearing carry a `safety` block.
 * The shell refuses to run those until the user confirms, and caps master gain
 * for the duration.
 */

import { VOCAL_BAND_HERTZ_DICT } from '../dsp/weighting.js';

/* =========================================================================
   Groups
   ========================================================================= */

export const GROUPS = Object.freeze([
  { id: 'flame', label: 'Flame & Infrasound', icon: 'bolt' },
  { id: 'recovery', label: 'Hardware Recovery', icon: 'droplet' },
  { id: 'focus', label: 'Focus & Acoustic Shielding', icon: 'shield' },
  { id: 'lab', label: 'Lab & Scientific', icon: 'flask' },
]);

/* =========================================================================
   Helper builders
   ========================================================================= */

/** Silence everything, then return a clean rack for the preset to configure. */
async function clean(app) {
  app.vm.stop({ is_silent_bool: true });
  app.rack.stopAllChannels();
  app.noise.stop();
  await Promise.resolve();
}

/* =========================================================================
   Presets
   ========================================================================= */

export const PRESETS = [
  /* ================= FLAME & INFRASOUND ===============================
     Flames respond to acoustic VELOCITY, not pressure. In a tube, place the
     flame at a velocity antinode — which is a pressure NODE, where the flames
     sit lowest, not highest. Getting this backwards is the single most common
     reason people report "no effect".
     ==================================================================== */
  {
    id: 'candle-flicker-lock',
    group: 'flame',
    name: 'Candle Flicker Lock',
    desc: 'AM sweep 8–16 Hz — phase-locks a candle’s natural flicker',
    icon: 'bolt',
    tone: 'warn',
    safety: {
      title: 'Open flame + sustained high output',
      body:
        'This runs a loud, long tone to move air hard enough to disturb a flame.<br><br>' +
        '• <b>Remove headphones.</b> This is a speaker routine.<br>' +
        '• Keep the flame clear of anything flammable and never leave it unattended.<br>' +
        '• Sustained levels above ~85 dB damage hearing. Wear protection or leave the room ' +
        'and let the camera record.<br><br>' +
        'Master output will be capped at −8 dBFS.',
      confirm: 'I understand — run it',
      capDb: -8,
    },
    script: `
      # A candle's buoyancy-driven flicker sits near 10-13 Hz. A speaker cannot
      # reproduce 10 Hz, so the forcing is delivered as a 10 Hz ENVELOPE on a
      # 180 Hz carrier the speaker can actually move air with.
      print("Place the candle 10-30 cm from the driver, out of the direct draught.")
      print("Record at 120-240 fps. Watch for the flicker locking to the envelope.")

      print("Stage 1 - 8 Hz envelope")
      am(180hz, 8hz, 8s, 100%, -9db)
      print("Stage 2 - 10 Hz envelope")
      am(180hz, 10hz, 8s, 100%, -9db)
      print("Stage 3 - 12 Hz envelope  <- lock-in is usually here")
      am(180hz, 12hz, 10s, 100%, -9db)
      print("Stage 4 - 14 Hz envelope")
      am(180hz, 14hz, 8s, 100%, -9db)
      print("Stage 5 - 16 Hz envelope")
      am(180hz, 16hz, 8s, 100%, -9db)
      print("Note the stage where the flicker stopped being random. That is the lock band.")
    `,
  },

  {
    id: 'flame-extinction',
    group: 'flame',
    name: 'Flame Extinction Sweep',
    desc: '30–60 Hz — the band that strips a small flame out',
    icon: 'droplet',
    tone: 'warn',
    safety: {
      title: 'Loud low frequencies near an open flame',
      body:
        'Extinguishing a flame acoustically needs real sound pressure at 30–60 Hz. ' +
        'This will be <b>physically uncomfortable</b> and needs a subwoofer or a large driver — ' +
        'a laptop speaker produces nothing useful in this band.<br><br>' +
        '• <b>Headphones off.</b> At this level in-ear playback is dangerous.<br>' +
        '• Hearing protection recommended.<br>' +
        '• Small flame only, on a non-flammable surface, nothing combustible nearby.<br><br>' +
        'Master output will be capped at −6 dBFS.',
      confirm: 'Run extinction sweep',
      capDb: -6,
    },
    script: `
      # Extinction works by acoustic velocity separating the flame from its fuel.
      # Effectiveness peaks where the driver actually moves air, typically 30-60 Hz.
      print("Flame 5-15 cm from the driver. Expect it to bend before it goes out.")
      loop(2, [
        sweep(30hz, 60hz, 6s, linear, sine, -5db),
        wait(500ms),
        sweep(60hz, 30hz, 6s, linear, sine, -5db),
        wait(500ms)
      ])
      print("If it only bent, move closer or raise the level. If nothing moved,")
      print("your driver has no output below 60 Hz - check with the 3D view.")
    `,
  },

  {
    id: 'rubens-tube',
    group: 'flame',
    name: 'Rubens Tube Stepper',
    desc: 'Stepped 60–240 Hz — walks standing-wave nodes along the tube',
    icon: 'ruler',
    tone: 'warn',
    safety: {
      title: 'Rubens tube — gas and flame',
      body:
        'A Rubens tube is a perforated pipe full of flammable gas with a row of flames on top. ' +
        'Build and operate it only if you already know how.<br><br>' +
        '• Purge and leak-test before lighting.<br>' +
        '• Ventilate the space.<br>' +
        '• Keep the gas supply reachable and have extinguishing means at hand.<br><br>' +
        'SonicForge only produces the tone — everything else is your rig’s responsibility.',
      confirm: 'My rig is ready',
      capDb: -8,
    },
    script: `
      # Node spacing is half a wavelength: lambda = c/f, c ~ 343 m/s in air.
      #   60 Hz -> 5.72 m   (a long tube shows one node)
      #  120 Hz -> 2.86 m
      #  240 Hz -> 1.43 m   (a 2 m tube shows ~3 nodes)
      # Flames are SHORTEST at pressure nodes, which are velocity antinodes.
      print("Each tone holds 6 s. Photograph the flame profile at every step.")
      print(" 60 Hz - half-wavelength 2.86 m")
      play(60hz, 6s, sine, -8db)
      print(" 90 Hz - half-wavelength 1.91 m")
      play(90hz, 6s, sine, -8db)
      print("120 Hz - half-wavelength 1.43 m")
      play(120hz, 6s, sine, -8db)
      print("150 Hz - half-wavelength 1.14 m")
      play(150hz, 6s, sine, -8db)
      print("180 Hz - half-wavelength 0.95 m")
      play(180hz, 6s, sine, -8db)
      print("240 Hz - half-wavelength 0.71 m")
      play(240hz, 6s, sine, -8db)
      print("The frequency giving the crispest nodes is your tube's resonance.")
    `,
  },

  {
    id: 'premixed-wrinkle',
    group: 'flame',
    name: 'Premixed Front Wrinkle',
    desc: '100–600 Hz sweep — corrugates a butane burner’s flame front',
    icon: 'activity',
    tone: 'warn',
    safety: {
      title: 'Butane burner under acoustic forcing',
      body:
        'Driving a premixed flame can push it toward flashback or liftoff. Keep the burner ' +
        'on a stable non-flammable surface, keep the gas control within reach, and do not ' +
        'leave it running unattended.<br><br>Master output will be capped at −8 dBFS.',
      confirm: 'Burner is set up',
      capDb: -8,
    },
    script: `
      # A premixed flame front is already unstable (Darrieus-Landau). Acoustic
      # forcing selects a wrinkle wavelength, which is what the camera sees.
      # The response band is far higher than for a diffusion flame.
      print("Burner 10-20 cm from the driver, lean-to-neutral mixture.")
      print("Slow sweep - watch for the front breaking into regular cells.")
      loop(2, [ sweep(100hz, 600hz, 14s, exponential, sine, -8db), wait(800ms) ])

      print("Now holding discrete tones so you can photograph a stable pattern.")
      play(150hz, 5s, sine, -8db)
      play(250hz, 5s, sine, -8db)
      play(400hz, 5s, sine, -8db)
      play(600hz, 5s, sine, -8db)
      print("Cell size scales with 1/f. Compare the 150 Hz and 600 Hz frames.")
    `,
  },

  {
    id: 'rijke-finder',
    group: 'flame',
    name: 'Rijke Tube Finder',
    desc: 'Locates a tube’s thermoacoustic resonance by sweep',
    icon: 'flask',
    tone: 'cyan',
    script: `
      # A Rijke tube self-excites at its acoustic fundamental once a heat source
      # sits about a quarter of the way up. Open-open: f = c/2L. Open-closed: f = c/4L.
      #   0.5 m open-open -> 343 Hz     1.0 m open-open -> 172 Hz
      #   0.5 m open-closed -> 172 Hz   1.0 m open-closed -> 86 Hz
      print("Sweeping 60 -> 700 Hz. Listen for the tube ringing on by itself.")
      loop(3, [ sweep(60hz, 700hz, 12s, exponential, sine, -16db), wait(1s) ])
      print("Where the tube kept sounding after the tone passed is its resonance.")
      print("Measure your tube and check it against f = c/2L with c = 343 m/s.")
    `,
  },

  {
    id: 'infrasound-direct',
    group: 'flame',
    name: 'Direct Infrasound 1–20 Hz',
    desc: 'True sub-audible sweep — needs a real subwoofer',
    icon: 'activity',
    tone: 'violet',
    async apply(app) {
      await clean(app);
      app.log(
        'Direct infrasound: your speaker almost certainly cannot reproduce this. ' +
        'A laptop driver rolls off below ~400 Hz; a bookshelf speaker below ~50 Hz. ' +
        'If nothing moves, that is the transducer, not the signal — use Candle Flicker Lock instead.',
        'warn'
      );
      app.runScript(
        `
        print("1 -> 20 Hz over 40 s. Watch the 3D view: the tone IS being generated.")
        sweep(1hz, 20hz, 40s, exponential, sine, -4db)
        print("Holding discrete infrasonic tones.")
        play(5hz, 8s, sine, -4db)
        play(10hz, 8s, sine, -4db)
        play(15hz, 8s, sine, -4db)
        play(20hz, 8s, sine, -4db)
        print("Seen in the spectrogram but heard nothing and saw no flame motion?")
        print("That is a speaker limit. Switch to the AM approach.")
        `,
        { label: 'infrasound' }
      );
    },
  },

  {
    id: 'ultrasonic-sweep',
    group: 'flame',
    name: 'Ultrasonic 20–48 kHz',
    desc: 'Above hearing — requires a 96 kHz context',
    icon: 'bolt',
    tone: 'violet',
    async apply(app) {
      await clean(app);
      const nyq = app.engine.nyquistHertz;

      if (nyq < 22000) {
        app.log(
          `This context runs at ${app.engine.sampleRateHertz} Hz, so nothing above ${nyq.toFixed(0)} Hz can exist. ` +
          'Switch the sample rate to 96 kHz in the header and reload.',
          'err'
        );
        return;
      }

      const top = Math.min(nyq - 1000, 48000);
      app.log(
        `Sweeping 20 kHz → ${(top / 1000).toFixed(0)} kHz. Most speakers produce nothing above ~22 kHz — ` +
        'a piezo tweeter is required for real ultrasonic output.',
        'warn'
      );
      app.runScript(
        `sweep(20khz, ${Math.round(top)}hz, 12s, exponential, sine, -14db)\n` +
        `print("Check the 3D view: if the trace stops before the top, your output path is band-limited.")`,
        { label: 'ultrasonic' }
      );
    },
  },

  /* ================= HARDWARE RECOVERY ================================ */
  {
    id: 'water-eject',
    group: 'recovery',
    name: 'Speaker Water Eject',
    desc: '165 Hz pulse train, rising — expels trapped water',
    icon: 'droplet',
    tone: 'warn',
    safety: {
      title: 'Water ejection uses high excursion',
      body:
        'This drives the speaker at high amplitude around 165 Hz to physically push water out of the grille. ' +
        'Take your device out of its case, point the speaker downward, and <b>remove headphones now</b> — ' +
        'at this level, in-ear playback is genuinely unsafe.<br><br>' +
        'Master output will be capped at −6 dBFS for the routine.',
      confirm: 'Eject water',
      capDb: -6,
    },
    script: `
      # Stage 1 — low-amplitude priming pulses break surface tension
      print("Stage 1/3 — priming")
      loop(6, [ burst(165hz, 1, 240ms, 90ms, -18db) ])

      # Stage 2 — the main ejection train, the frequency most phone
      # transducers show peak cone excursion at
      print("Stage 2/3 — ejection")
      loop(14, [ burst(165hz, 1, 300ms, 70ms, -7db) ])

      # Stage 3 — a short sweep shakes loose whatever the fixed tone missed
      print("Stage 3/3 — clearing sweep")
      loop(3, [ sweep(120hz, 220hz, 700ms, exponential, sine, -9db), wait(120ms) ])
      print("Complete. Wipe the grille and repeat if audio is still muffled.")
    `,
  },

  {
    id: 'burn-in',
    group: 'recovery',
    name: 'Headphone Burn-In',
    desc: 'Three-tier transducer conditioning loop',
    icon: 'headphones',
    tone: 'cyan',
    script: `
      # Tier 1 — broadband excursion at conservative level
      print("Tier 1/3 — pink noise conditioning")
      noise(pink, -20db, 45s)

      # Tier 2 — full-band sweeps exercise the whole diaphragm travel
      print("Tier 2/3 — full-band sweeps")
      loop(6, [ sweep(20hz, 20khz, 6s, exponential, sine, -16db), wait(250ms) ])

      # Tier 3 — low-frequency excursion, where suspension actually loosens
      print("Tier 3/3 — low-frequency excursion")
      loop(8, [ sweep(25hz, 120hz, 2.5s, exponential, sine, -13db), wait(200ms) ])
      hush()
      print("Cycle complete (~2.5 min). Repeat for longer conditioning.")
    `,
  },

  {
    id: 'micro-vibration',
    group: 'recovery',
    name: 'Micro-Vibration Test',
    desc: 'Stepped 20–120 Hz to surface rattles and loose panels',
    icon: 'activity',
    tone: 'cyan',
    script: `
      print("Stepping 20 → 120 Hz. Listen for buzz that outlasts the tone.")
      loop(1, [
        play(20hz, 1.4s, sine, -12db),  play(25hz, 1.4s, sine, -12db),
        play(31.5hz, 1.4s, sine, -12db), play(40hz, 1.4s, sine, -12db),
        play(50hz, 1.4s, sine, -12db),  play(63hz, 1.4s, sine, -12db),
        play(80hz, 1.4s, sine, -12db),  play(100hz, 1.4s, sine, -12db),
        play(120hz, 1.4s, sine, -12db)
      ])
      print("If a tone buzzed, that band is your resonance. Note the frequency.")
    `,
  },

  {
    id: 'polarity',
    group: 'recovery',
    name: 'Driver Polarity Check',
    desc: 'Asymmetric pulse — reveals a miswired speaker',
    icon: 'bolt',
    tone: 'cyan',
    async apply(app) {
      await clean(app);
      app.log('Polarity: a correctly wired driver pushes OUT on the first pulse.', 'dim');
      app.runScript(
        `loop(8, [ play(55hz, 90ms, impulse, -10db), wait(400ms) ])`,
        { label: 'polarity' }
      );
    },
  },

  /* ================= FOCUS & ACOUSTIC SHIELDING ======================== */
  {
    id: 'deep-focus',
    group: 'focus',
    name: 'Deep Focus',
    desc: 'Brown–pink hybrid, weighted under the voice band',
    icon: 'shield',
    tone: 'violet',
    async apply(app) {
      await clean(app);
      const n = app.noise;
      await n.setColour('brown', 'A');
      await n.setColour('pink', 'B');
      await n.setBlendRatio(0.3);
      n.setShapeFilter({ type: 'lowpass', freq: 6500, q: 0.6 });
      n.setShieldDb(3);
      n.setGainDb(-26);
      n.setPanPosition(0);
      await n.start();
      app.log('Deep Focus: 70 % brown / 30 % pink, gently rolled off above 6.5 kHz.', 'ok');
    },
  },

  {
    id: 'voice-shield',
    group: 'focus',
    name: 'Conversation Shield',
    desc: `Masking energy concentrated across ${VOCAL_BAND_HERTZ_DICT.lower_hertz_float}–${VOCAL_BAND_HERTZ_DICT.upper_hertz_float} Hz`,
    icon: 'users',
    tone: 'violet',
    async apply(app) {
      await clean(app);
      const n = app.noise;
      await n.setColour('pink', 'A');
      await n.setColour('brown', 'B');
      await n.setBlendRatio(0.42);
      // Speech intelligibility lives in the 300–3400 Hz band; raising the
      // masker there beats simply turning everything up, which just makes
      // the room louder without improving the masking ratio.
      n.setShapeFilter({ type: 'off' });
      n.setShieldDb(9);
      n.setGainDb(-22);
      await n.start();
      app.log(
        `Conversation Shield: +9 dB emphasis centred on ${VOCAL_BAND_HERTZ_DICT.centre_hertz_float} Hz — masks speech, not the whole room.`,
        'ok'
      );
    },
  },

  {
    id: 'sleep-drift',
    group: 'focus',
    name: 'Sleep Drift',
    desc: 'Deep brown, low-passed to 420 Hz',
    icon: 'layers',
    tone: 'violet',
    async apply(app) {
      await clean(app);
      const n = app.noise;
      await n.setColour('brown', 'A');
      await n.setBlendRatio(0);
      n.setShapeFilter({ type: 'lowpass', freq: 420, q: 0.5 });
      n.setShieldDb(-4);
      n.setGainDb(-28);
      await n.start();
      app.log('Sleep Drift: brown noise below 420 Hz. Nothing above the rumble.', 'ok');
    },
  },

  {
    id: 'tinnitus-notch',
    group: 'focus',
    name: 'Tinnitus Notch',
    desc: 'Notches the selected channel’s frequency out of white noise',
    icon: 'tune',
    tone: 'violet',
    async apply(app) {
      await clean(app);
      const f = app.selectedChannel?.freq ?? 6000;
      const n = app.noise;
      await n.setColour('white', 'A');
      await n.setBlendRatio(0);
      n.setShapeFilter({ type: 'notch', freq: f, q: 4.5 });
      n.setShieldDb(0);
      n.setGainDb(-26);
      await n.start();
      app.log(
        `Tinnitus Notch: white noise with a notch at ${f.toFixed(1)} Hz. ` +
        'Set the dial to your tinnitus pitch first, then re-apply.',
        'ok'
      );
    },
  },

  /* ================= LAB & SCIENTIFIC ================================== */
  {
    id: 'resonance-sweep',
    group: 'lab',
    name: 'Resonance Detection',
    desc: 'Slow 20–300 Hz sweep for structural modes',
    icon: 'ruler',
    tone: 'cyan',
    script: `
      print("Slow sweep 20 → 300 Hz. Mark every frequency that rings or rattles.")
      loop(3, [ sweep(20hz, 300hz, 12s, exponential, sine, -14db), wait(600ms) ])
      print("Repeat with the structure loaded/unloaded to confirm the mode.")
    `,
  },

  {
    id: 'room-modes',
    group: 'lab',
    name: 'Room Mode Probe',
    desc: 'Stepped axial modes for a typical 3×4×5 m room',
    icon: 'grid',
    tone: 'cyan',
    script: `
      # Axial modes f = c/2L for L = 5 m, 4 m, 3 m and their first harmonics
      print("Walk the room during each tone. Loud spots are pressure maxima.")
      loop(1, [
        play(34.3hz, 4s, sine, -14db), play(42.9hz, 4s, sine, -14db),
        play(57.2hz, 4s, sine, -14db), play(68.6hz, 4s, sine, -14db),
        play(85.8hz, 4s, sine, -14db), play(114.3hz, 4s, sine, -14db)
      ])
      print("Bass traps belong at the corners where all three modes meet.")
    `,
  },

  {
    id: 'dtmf-dialer',
    group: 'lab',
    name: 'DTMF Dialer',
    desc: 'Bell-standard dual-tone keypad array',
    icon: 'phone',
    tone: 'cyan',
    async apply(app) {
      await clean(app);
      app.openDtmf?.();
      app.log('DTMF: 697/770/852/941 Hz rows × 1209/1336/1477/1633 Hz columns.', 'dim');
      app.runScript('dtmf("123A456B789C*0#D", 110ms, 70ms, -14db)', { label: 'dtmf-sweep' });
    },
  },

  {
    id: 'phase-null',
    group: 'lab',
    name: 'Phase Cancellation Demo',
    desc: 'Two 300 Hz tones at 0° and 180° — watch them annihilate',
    icon: 'eye',
    tone: 'cyan',
    async apply(app) {
      await clean(app);
      const a = app.rack.getChannel(0);
      const b = app.rack.getChannel(1);

      for (const [ch, phase] of [[a, 0], [b, 180]]) {
        ch.setWaveformName('sine');
        ch.setFrequencyHertz(300);
        ch.setGainDb(-14);
        ch.setPanPosition(0);
        ch.setPhaseDegrees(phase);
        ch.start();
      }
      app.selectChannel?.(0);
      app.setVizMode?.('interference');
      app.log(
        'Channels 1 and 2 are 180° opposed at 300 Hz. Sweep channel 2’s phase ' +
        'and watch the summed trace collapse and return.',
        'ok'
      );
    },
  },

  {
    id: 'beat-frequency',
    group: 'lab',
    name: 'Beat Frequency Lab',
    desc: '440 Hz against 444 Hz — a 4 Hz beat',
    icon: 'activity',
    tone: 'cyan',
    async apply(app) {
      await clean(app);
      const pairs = [[0, 440], [1, 444]];
      for (const [i, f] of pairs) {
        const ch = app.rack.getChannel(i);
        ch.setWaveformName('sine');
        ch.setFrequencyHertz(f);
        ch.setGainDb(-16);
        ch.setPanPosition(0);
        ch.setPhaseDegrees(0);
        ch.start();
      }
      app.selectChannel?.(1);
      app.setVizMode?.('interference');
      app.log('440 Hz + 444 Hz → 4 Hz amplitude beat. Nudge channel 2 to change the rate.', 'ok');
    },
  },

  {
    id: 'hearing-range',
    group: 'lab',
    name: 'Hearing Range Test',
    desc: 'Stepped octaves, 125 Hz → 16 kHz',
    icon: 'ruler',
    tone: 'cyan',
    script: `
      print("Each tone is 2 s. Note the first one you cannot hear.")
      loop(1, [
        print("125 Hz"),   play(125hz, 2s, sine, -20db),   wait(400ms),
        print("250 Hz"),   play(250hz, 2s, sine, -20db),   wait(400ms),
        print("500 Hz"),   play(500hz, 2s, sine, -20db),   wait(400ms),
        print("1 kHz"),    play(1khz, 2s, sine, -20db),    wait(400ms),
        print("2 kHz"),    play(2khz, 2s, sine, -20db),    wait(400ms),
        print("4 kHz"),    play(4khz, 2s, sine, -20db),    wait(400ms),
        print("8 kHz"),    play(8khz, 2s, sine, -20db),    wait(400ms),
        print("12 kHz"),   play(12khz, 2s, sine, -20db),   wait(400ms),
        print("14 kHz"),   play(14khz, 2s, sine, -20db),   wait(400ms),
        print("16 kHz"),   play(16khz, 2s, sine, -20db)
      ])
      print("Most adults lose 16 kHz by 40. This is not a clinical audiogram.")
    `,
  },
];

/** Index by id for fast lookup. */
export const PRESET_BY_ID = Object.freeze(
  Object.fromEntries(PRESETS.map((p) => [p.id, p]))
);

/**
 * Run a preset. Script-backed presets are compiled and handed to the VM;
 * `apply`-backed presets configure state directly. A preset may define both.
 *
 * @param {*} app
 * @param {string|object} preset  id or preset object
 */
export async function runPreset(app, preset) {
  const p = typeof preset === 'string' ? PRESET_BY_ID[preset] : preset;
  if (!p) throw new Error(`Unknown preset: ${preset}`);

  if (p.apply) await p.apply(app);

  if (p.script) {
    await clean(app);
    app.runScript(p.script, { label: p.id });
  }
  return p;
}
