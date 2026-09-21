/**
 * Progressive-web-app registration.
 *
 * Brief:
 *   Registers the service worker that makes SonicForge usable offline, and
 *   tells the application when a newer deploy is waiting so it can offer a
 *   reload rather than silently serving stale code forever.
 *
 *   Registration is skipped on localhost. A cache-first worker in front of
 *   the development server would serve the previous edit back on every
 *   reload, which turns every change into a debugging session.
 */

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Path to the worker, relative so subpath hosting works unchanged. */
const SERVICE_WORKER_PATH_STR = './sw.js';

/** Hostnames treated as development, where caching is unhelpful. */
const DEVELOPMENT_HOSTS_TUPLE = Object.freeze([
  'localhost',
  '127.0.0.1',
  '',
]);

/* ------------------------------------------------------------------------ */

/**
 * Report whether this page is being served from a development host.
 *
 * Brief:
 *   Used to suppress service-worker registration locally, where a
 *   cache-first worker would serve the previous edit back on every reload.
 *
 * Arguments:
 *   (none)
 *
 * Returns:
 *   (boolean): True when the origin is local.
 */
export function isDevelopmentHost() {
  return DEVELOPMENT_HOSTS_TUPLE.includes(location.hostname);
}

/**
 * Register the service worker and watch for a newer version.
 *
 * Brief:
 *   A waiting worker means a new deploy is cached and ready. Rather than
 *   activating it under the user's feet - which would swap modules while
 *   audio is running - the callback lets the interface offer a reload.
 *
 * Arguments:
 *   on_update_available_fn (Function): Called when a new version is ready.
 *
 * Returns:
 *   (Promise<ServiceWorkerRegistration>): The registration, or null when
 *   service workers are unavailable or this is a development host.
 *
 * Warning:
 *   Never registers on localhost, so offline behaviour must be verified
 *   against a real deployment or a non-local hostname.
 */
export async function registerServiceWorker(on_update_available_fn = null) {
  const is_supported_bool = 'serviceWorker' in navigator;
  if (!is_supported_bool || isDevelopmentHost()) {
    return null;
  }

  try {
    const registration_obj = await navigator.serviceWorker.register(
      SERVICE_WORKER_PATH_STR
    );

    if (registration_obj.waiting && on_update_available_fn) {
      on_update_available_fn(registration_obj);
    }

    registration_obj.addEventListener('updatefound', () => {
      const installing_worker_obj = registration_obj.installing;
      if (!installing_worker_obj) {
        return;
      }

      installing_worker_obj.addEventListener('statechange', () => {
        const is_update_ready_bool =
          installing_worker_obj.state === 'installed' &&
          navigator.serviceWorker.controller;

        if (is_update_ready_bool && on_update_available_fn) {
          on_update_available_fn(registration_obj);
        }
      });
    });

    return registration_obj;
  } catch {
    // Offline support is a bonus, never a requirement. Failing to register
    // must not affect the running application in any way.
    return null;
  }
}
