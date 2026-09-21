/**
 * Intent-driven presets.
 *
 * Brief:
 *   A preset is not a bag of slider positions. It is a stated goal plus the
 *   exact routine that achieves it. Each one either runs a script through
 *   the VM, for anything time-varying, or configures engine state directly,
 *   for anything steady-state, and several do both.
 *
 *   Presets that can plausibly damage hardware or hearing carry a safety
 *   block. The shell refuses to run those until the viewer confirms, and
 *   caps master gain for the duration.
 */

import { PRESETS_LIST as FLAME_PRESETS_LIST }
  from './flame-presets.js';
import { PRESETS_LIST as RECOVERY_PRESETS_LIST }
  from './recovery-presets.js';
import { PRESETS_LIST as FOCUS_PRESETS_LIST }
  from './focus-presets.js';
import { PRESETS_LIST as LAB_PRESETS_LIST }
  from './lab-presets.js';

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

/**
 * Silence everything, leaving a clean rack for a preset to configure.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (Promise<void>)
 */
async function clean(app_obj) {
  app_obj.vm.stop({ is_silent_bool: true });
  app_obj.rack.stopAllChannels();
  app_obj.noise.stop();
  await Promise.resolve();
}

/* =========================================================================
   Presets
   ========================================================================= */

/** Every preset, in group order. */
export const PRESETS = [
  ...FLAME_PRESETS_LIST,
  ...RECOVERY_PRESETS_LIST,
  ...FOCUS_PRESETS_LIST,
  ...LAB_PRESETS_LIST,
];

/** Index by id for fast lookup. */
export const PRESET_BY_ID = Object.freeze(
  Object.fromEntries(
    PRESETS.map((preset_obj) => [preset_obj.id, preset_obj])
  )
);

/**
 * Run a preset by id or by object.
 *
 * Brief:
 *   Script-backed presets are compiled and handed to the VM; apply-backed
 *   presets configure engine state directly. A preset may define both, in
 *   which case the state is configured first and the script then runs
 *   against it.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   preset_any (string|Object): A preset id, or the preset itself.
 *
 * Returns:
 *   (Promise<Object>): The preset that was run.
 *
 * Warning:
 *   Throws for an unknown id rather than doing nothing, so a typo in a
 *   preset reference fails where it is written.
 */
export async function runPreset(app_obj, preset_any) {
  const preset_obj = typeof preset_any === 'string'
    ? PRESET_BY_ID[preset_any]
    : preset_any;
  if (!preset_obj) {
    throw new Error(`Unknown preset: ${preset_any}`);
  }

  if (preset_obj.apply) {
    await preset_obj.apply(app_obj);
  }
  if (preset_obj.script) {
    await clean(app_obj);
    app_obj.runScript(preset_obj.script, { label_str: preset_obj.id });
  }
  return preset_obj;
}