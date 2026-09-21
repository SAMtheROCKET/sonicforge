/**
 * SonicForge — application entry point.
 *
 * Brief:
 *   Nothing here contains audio logic, and nothing here builds an interface.
 *   This file creates the facade, arms the gesture that boots it, registers
 *   the service worker, and opens the door to the self-test. Everything else
 *   lives in js/app/, one module per panel.
 */

import { PRESETS } from './presets/presets.js';
import { showToast } from './ui/feedback.js';
import { registerServiceWorker } from './pwa.js';
import { createApp } from './app/facade.js';
import { bootApplication, armBootGesture } from './app/boot.js';

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Hosts on which the self-test hook is allowed to exist at all. */
const SELF_TEST_HOSTS_REGEX = /^(localhost|127\.0\.0\.1)$/;

/** Query parameter that opts into the self-test. */
const SELF_TEST_PARAM_STR = 'selftest';

/* ------------------------------------------------------------------------ */

const app_obj = createApp();

// Exposed for the test harness and for power users in the console.
window.SonicForge = app_obj;

armBootGesture(app_obj);

/**
 * Load and run the headless self-test, if this build is allowed to.
 *
 * Brief:
 *   Only ever active on localhost with an explicit ?selftest=1, so it cannot
 *   affect a deployed build: the module is not even fetched otherwise. It
 *   lets the real application be booted and audited by CI rather than by
 *   hand.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (none)
 */
function startSelfTestIfRequested() {
  const is_allowed_host_bool =
    SELF_TEST_HOSTS_REGEX.test(location.hostname);
  const is_requested_bool = new URLSearchParams(location.search)
    .has(SELF_TEST_PARAM_STR);

  if (!is_allowed_host_bool || !is_requested_bool) {
    return;
  }

  app_obj.__presets = PRESETS;
  import('./selftest.js')
    .then(({ runSelfTest }) =>
      runSelfTest(app_obj, { boot: () => bootApplication(app_obj) })
    )
    .catch((err) =>
      console.error('[SonicForge] self-test failed to load', err)
    );
}

startSelfTestIfRequested();

// Offline support. Skipped on localhost so the dev server is never shadowed
// by a cache-first worker.
registerServiceWorker(() => {
  showToast(
    'A new version of SonicForge is ready — reload to update.', 'ok', 0
  );
});
