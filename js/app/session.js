/**
 * Session persistence.
 *
 * Brief:
 *   The rack, the noise settings, the master level, the concert pitch and
 *   the visualiser mode survive a reload. Sources deliberately do not: a
 *   page refresh must never start playing a 12 kHz tone at whatever the
 *   volume happened to be.
 */

import { TUNING_OBJ } from '../core/tuning.js';
import { paintUnipolarRange } from '../ui/channels.js';
import { formatDb } from '../util/amplitude.js';
import { findElement } from './dom.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** localStorage key holding the saved session. */
const STORE_KEY_STR = 'sonicforge.session';

/** Schema version; a mismatch is treated as no saved session at all. */
const SCHEMA_VERSION_INT = 1;

/** How long changes settle before they are written, in milliseconds. */
const PERSIST_DEBOUNCE_MS_INT = 600;

/** Starting point on a first run. */
const FIRST_RUN_HERTZ_FLOAT = 440;
const FIRST_RUN_GAIN_DB_FLOAT = -18;

/* ------------------------------------------------------------------------ */

/** Pending debounced write, if any. */
let persist_timer_int = null;

/**
 * Write the current session to local storage.
 *
 * Brief:
 *   Wrapped because localStorage throws outright in some private
 *   browsing modes rather than merely failing to store.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function persist(app_obj) {
  try {
    localStorage.setItem(STORE_KEY_STR, JSON.stringify({
      v: SCHEMA_VERSION_INT,
      a4: TUNING_OBJ.referenceHertz,
      masterDb: app_obj.engine.masterLevelDb,
      channels: app_obj.rack.toJSON(),
      noise: app_obj.noise.toJSON(),
      viz: app_obj.ui.visualiser?.mode_str,
    }));
  } catch {
    // Storage unavailable; the session simply will not survive a reload.
  }
}

/**
 * Schedule a write once changes stop arriving.
 *
 * Brief:
 *   Dragging a slider emits a change per frame; writing on each would
 *   serialise the whole rack sixty times a second.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function persistSoon(app_obj) {
  clearTimeout(persist_timer_int);
  persist_timer_int = setTimeout(
    () => persist(app_obj), PERSIST_DEBOUNCE_MS_INT
  );
}

/**
 * Configure a sensible starting point on a first run.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
function applyFirstRunDefaults(app_obj) {
  const channel_obj = app_obj.rack.getChannel(0);
  channel_obj.setFrequencyHertz(FIRST_RUN_HERTZ_FLOAT);
  channel_obj.setGainDb(FIRST_RUN_GAIN_DB_FLOAT);
  app_obj.syncUi();
}

/**
 * Restore the master level from a saved session.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *   master_db_float (number): The saved level, in dBFS.
 *
 * Returns:
 *   (none)
 */
function restoreMasterLevel(app_obj, master_db_float) {
  app_obj.engine.masterLevelDb = master_db_float;
  const gain_el = findElement('master-gain');
  gain_el.value = String(master_db_float);
  findElement('master-db').textContent = `${formatDb(master_db_float)} dB`;
  paintUnipolarRange(gain_el);
}

/**
 * Restore a saved session, or fall back to first-run defaults.
 *
 * Brief:
 *   A schema mismatch is treated as no session at all rather than
 *   partially applied, because a half-restored rack is harder to
 *   diagnose than an empty one.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 *
 * Warning:
 *   Sources are forced stopped using the keys the deserialisers actually
 *   read. Writing a differently named key here silently restores whatever
 *   was playing, which is exactly what this must not do.
 */
export function restoreSession(app_obj) {
  let saved_obj = null;
  try {
    saved_obj = JSON.parse(localStorage.getItem(STORE_KEY_STR) ?? 'null');
  } catch {
    saved_obj = null;
  }

  if (!saved_obj || saved_obj.v !== SCHEMA_VERSION_INT) {
    applyFirstRunDefaults(app_obj);
    app_obj.ui.header?.sync();
    return;
  }

  if (Number.isFinite(saved_obj.a4)) {
    TUNING_OBJ.referenceHertz = saved_obj.a4;
  }
  if (Number.isFinite(saved_obj.masterDb)) {
    restoreMasterLevel(app_obj, saved_obj.masterDb);
  }

  if (Array.isArray(saved_obj.channels)) {
    app_obj.rack.fromJSON(saved_obj.channels.map((channel_state_obj) => ({
      ...channel_state_obj,
      is_enabled_bool: false,
    })));
  }
  if (saved_obj.noise) {
    app_obj.noise.fromJSON({
      ...saved_obj.noise,
      is_running_bool: false,
    });
  }
  if (saved_obj.viz) {
    app_obj.setVizMode(saved_obj.viz);
  }

  app_obj.syncUi();
  app_obj.ui.header?.sync();
  app_obj.log('Previous session restored (sources left stopped).', 'dim');
}

/**
 * Persist on the two events that reliably precede a page going away.
 *
 * Brief:
 *   beforeunload does not fire on mobile Safari when an app is swiped away;
 *   pagehide does. Both are registered because neither alone is enough.
 *
 * Arguments:
 *   app_obj (Object): The application facade.
 *
 * Returns:
 *   (none)
 */
export function bindSessionPersistence(app_obj) {
  window.addEventListener('beforeunload', () => persist(app_obj));
  window.addEventListener('pagehide', () => persist(app_obj));
}
