/**
 * Focus and acoustic shielding presets.
 *
 * Brief:
 *   Masking rather than volume. Speech intelligibility lives in a
 *   narrow band, so raising the masker there beats turning
 *   everything up, which only makes the room louder.
 */

import { VOCAL_BAND_HERTZ_DICT } from '../dsp/weighting.js';

/** Presets in this group, in the order they are listed. */
export const PRESETS_LIST = [
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
      const noise_obj = app.noise;
      await noise_obj.setColour('brown', 'primary');
      await noise_obj.setColour('pink', 'secondary');
      await noise_obj.setBlendRatio(0.3);
      noise_obj.setShapeFilter({ type: 'lowpass', freq: 6500, q: 0.6 });
      noise_obj.setShieldDb(3);
      noise_obj.setGainDb(-26);
      noise_obj.setPanPosition(0);
      await noise_obj.start();
      app.log(
        'Deep Focus: 70 % brown / 30 % pink, gently rolled off ' +
        'above 6.5 kHz.',
        'ok'
      );
    },
  },

  {
    id: 'voice-shield',
    group: 'focus',
    name: 'Conversation Shield',
    desc: 'Masking energy concentrated across ' +
      `${VOCAL_BAND_HERTZ_DICT.lower_hertz_float}–` +
      `${VOCAL_BAND_HERTZ_DICT.upper_hertz_float} Hz`,
    icon: 'users',
    tone: 'violet',
    async apply(app) {
      await clean(app);
      const noise_obj = app.noise;
      await noise_obj.setColour('pink', 'primary');
      await noise_obj.setColour('brown', 'secondary');
      await noise_obj.setBlendRatio(0.42);
      // Speech intelligibility lives in the 300–3400 Hz band; raising the
      // masker there beats simply turning everything up, which just makes
      // the room louder without improving the masking ratio.
      noise_obj.setShapeFilter({ type: 'off' });
      noise_obj.setShieldDb(9);
      noise_obj.setGainDb(-22);
      await noise_obj.start();
      app.log(
        'Conversation Shield: +9 dB emphasis centred on ' +
        `${VOCAL_BAND_HERTZ_DICT.centre_hertz_float} Hz — ` +
        'masks speech, not the whole room.',
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
      const noise_obj = app.noise;
      await noise_obj.setColour('brown', 'primary');
      await noise_obj.setBlendRatio(0);
      noise_obj.setShapeFilter({ type: 'lowpass', freq: 420, q: 0.5 });
      noise_obj.setShieldDb(-4);
      noise_obj.setGainDb(-28);
      await noise_obj.start();
      app.log(
        'Sleep Drift: brown noise below 420 Hz. Nothing ' +
        'above the rumble.',
        'ok'
      );
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
      const notch_hertz_float =
        app.selectedChannel?.frequency_hertz_float ?? 6000;
      const noise_obj = app.noise;
      await noise_obj.setColour('white', 'primary');
      await noise_obj.setBlendRatio(0);
      noise_obj.setShapeFilter({
        type: 'notch', freq: notch_hertz_float, q: 4.5,
      });
      noise_obj.setShieldDb(0);
      noise_obj.setGainDb(-26);
      await noise_obj.start();
      app.log(
        'Tinnitus Notch: white noise with a notch at ' +
        `${notch_hertz_float.toFixed(1)} Hz. ` +
        'Set the dial to your tinnitus pitch first, then re-apply.',
        'ok'
      );
    },
  },
];
