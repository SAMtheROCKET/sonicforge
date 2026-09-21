/**
 * Hardware recovery presets.
 *
 * Brief:
 *   Routines that do something physical to a device: clearing water
 *   from a speaker grille, settling a new driver, checking polarity.
 *   All of them run loud, and all of them carry a safety block.
 */

/** Presets in this group, in the order they are listed. */
export const PRESETS_LIST = [
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
        'This drives the speaker at high amplitude around 165 Hz ' +
        'to physically push water out of the grille. ' +
        'Take your device out of its case, point the speaker ' +
        'downward, and <b>remove headphones now</b> — ' +
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
      app.log(
        'Polarity: a correctly wired driver pushes OUT on ' +
        'the first pulse.',
        'dim'
      );
      app.runScript(
        `loop(8, [ play(55hz, 90ms, impulse, -10db), wait(400ms) ])`,
        { label_str: 'polarity' }
      );
    },
  },
];
