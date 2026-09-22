/**
 * Laboratory and measurement presets.
 *
 * Brief:
 *   Demonstrations with a right answer: a cancellation that should
 *   reach silence, a beat that should land on a stated rate, a
 *   keypad that should match the Bell frequencies.
 */

/** Presets in this group, in the order they are listed. */
export const PRESETS_LIST = [
  /* ================= LAB & SCIENTIFIC ================================== */
  {
    id: 'resonance-sweep',
    group: 'lab',
    name: 'Resonance Detection',
    desc: 'Slow 20-300 Hz sweep for structural modes',
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
      app.log(
        'DTMF: 697/770/852/941 Hz rows × ' +
        '1209/1336/1477/1633 Hz columns.',
        'dim'
      );
      app.runScript(
        'dtmf("123A456B789C*0#D", 110ms, 70ms, ' +
        '-14db)',
        { label_str: 'dtmf-sweep' }
      );
    },
  },

  {
    id: 'phase-null',
    group: 'lab',
    name: 'Phase Cancellation Demo',
    desc: 'Two 300 Hz tones at 0° and 180° - watch them annihilate',
    icon: 'eye',
    tone: 'cyan',
    async apply(app) {
      await clean(app);
      const channel_a_obj = app.rack.getChannel(0);
      const channel_b_obj = app.rack.getChannel(1);

      const phase_plan_list = [
        [channel_a_obj, 0], [channel_b_obj, 180],
      ];
      for (const [channel_obj, phase_degrees_int] of phase_plan_list) {
        channel_obj.setWaveformName('sine');
        channel_obj.setFrequencyHertz(300);
        channel_obj.setGainDb(-14);
        channel_obj.setPanPosition(0);
        channel_obj.setPhaseDegrees(phase_degrees_int);
        channel_obj.start();
      }
      app.selectChannel?.(0);
      app.setVizMode?.('interference');
      app.log(
        'Channels 1 and 2 are 180° opposed at 300 Hz. ' +
        'Sweep channel 2’s phase ' +
        'and watch the summed trace collapse and return.',
        'ok'
      );
    },
  },

  {
    id: 'beat-frequency',
    group: 'lab',
    name: 'Beat Frequency Lab',
    desc: '440 Hz against 444 Hz - a 4 Hz beat',
    icon: 'activity',
    tone: 'cyan',
    async apply(app) {
      await clean(app);
      const channel_plan_list = [[0, 440], [1, 444]];
      for (const [index_int, frequency_hertz_float] of channel_plan_list) {
        const channel_obj = app.rack.getChannel(index_int);
        channel_obj.setWaveformName('sine');
        channel_obj.setFrequencyHertz(frequency_hertz_float);
        channel_obj.setGainDb(-16);
        channel_obj.setPanPosition(0);
        channel_obj.setPhaseDegrees(0);
        channel_obj.start();
      }
      app.selectChannel?.(1);
      app.setVizMode?.('interference');
      app.log(
        '440 Hz + 444 Hz → 4 Hz amplitude beat. Nudge channel 2 ' +
        'to change the rate.',
        'ok'
      );
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
