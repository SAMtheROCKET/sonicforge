/**
 * Flame and infrasound presets.
 *
 * Brief:
 *   Flames respond to acoustic velocity, not pressure. In a tube,
 *   place the flame at a velocity antinode, which is a pressure
 *   node, where the flames sit lowest rather than highest. Getting
 *   this backwards is the single most common reason people report
 *   no effect.
 */

/** Presets in this group, in the order they are listed. */
export const PRESETS_LIST = [
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
        'This runs a loud, long tone to move air hard enough to ' +
        'disturb a flame.<br><br>' +
        '• <b>Remove headphones.</b> This is a speaker routine.<br>' +
        '• Keep the flame clear of anything flammable and never ' +
        'leave it unattended.<br>' +
        '• Sustained levels above ~85 dB damage hearing. Wear ' +
        'protection or leave the room ' +
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
        'Extinguishing a flame acoustically needs real sound ' +
        'pressure at 30–60 Hz. ' +
        'This will be <b>physically uncomfortable</b> and needs a ' +
        'subwoofer or a large driver — ' +
        'a laptop speaker produces nothing useful in this band.<br><br>' +
        '• <b>Headphones off.</b> At this level in-ear playback ' +
        'is dangerous.<br>' +
        '• Hearing protection recommended.<br>' +
        '• Small flame only, on a non-flammable surface, nothing ' +
        'combustible nearby.<br><br>' +
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
        'A Rubens tube is a perforated pipe full of flammable ' +
        'gas with a row ' +
        'of flames on top_hertz_float. ' +
        'Build and operate it only if you already know how.<br><br>' +
        '• Purge and leak-test before lighting.<br>' +
        '• Ventilate the space.<br>' +
        '• Keep the gas supply reachable and have extinguishing ' +
        'means at hand.<br><br>' +
        'SonicForge only produces the tone — everything else is your ' +
        'rig’s responsibility.',
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
        'Driving a premixed flame can push it toward flashback or ' +
        'liftoff. Keep the burner ' +
        'on a stable non-flammable surface, keep the gas control ' +
        'within reach, and do not ' +
        'leave it running unattended.<br><br>Master output will be ' +
        'capped at −8 dBFS.',
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
        'Direct infrasound: your speaker almost certainly cannot ' +
        'reproduce this. ' +
        'A laptop driver rolls off below ~400 Hz; a bookshelf ' +
        'speaker below ~50 Hz. ' +
        'If nothing moves, that is the transducer, not the signal — use ' +
        'Candle Flicker Lock instead.',
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
        { label_str: 'infrasound' }
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
      const nyquist_hertz_float = app.engine.nyquistHertz;

      if (nyquist_hertz_float < 22000) {
        app.log(
          `This context runs at ${app.engine.sampleRateHertz} Hz, ` +
          `so nothing above ${nyquist_hertz_float.toFixed(0)} Hz ` +
          'can exist. ' +
          'Switch the sample rate to 96 kHz in the header and reload.',
          'err'
        );
        return;
      }

      const top_hertz_float =
        Math.min(nyquist_hertz_float - 1000, 48000);
      app.log(
        `Sweeping 20 kHz → ${(top_hertz_float / 1000).toFixed(0)} kHz. ` +
        'Most speakers produce nothing above ~22 kHz — ' +
        'a piezo tweeter is required for real ultrasonic output.',
        'warn'
      );
      app.runScript(
        `sweep(20khz, ${Math.round(top_hertz_float)}hz, ` +
        '12s, exponential, sine, -14db)\n' +
        'print("Check the 3D view: if the trace stops before the top, ' +
        'your output path is band-limited.")',
        { label_str: 'ultrasonic' }
      );
    },
  },
];
