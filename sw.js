/**
 * SonicForge service worker: offline support for a fully static app.
 *
 * Brief:
 *   SonicForge already makes no network requests while running - every
 *   module, font stack and icon is local. Caching the shell therefore makes
 *   it genuinely usable with no connection at all, which matters for the
 *   audience most likely to want it: someone in a workshop, a rehearsal
 *   room, or a lab bench with no usable wifi.
 *
 *   Strategy is cache-first with background revalidation. The app has no
 *   server state, so a slightly stale module is never wrong - it is simply
 *   the previous deploy, and the next load picks up the new one.
 */

/* eslint-env serviceworker */

importScripts('./precache-manifest.js');

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------ */

/** Manifest written by tools/build_precache.py. */
const PRECACHE_MANIFEST_DICT = self.__SONICFORGE_PRECACHE ?? {
  version: 'dev',
  files: [],
};

/** Cache name, versioned by the manifest's content hash. */
const CACHE_NAME_STR = `sonicforge-${PRECACHE_MANIFEST_DICT.version}`;

/** Document served when a navigation cannot be fulfilled. */
const APP_SHELL_PATH_STR = './index.html';

/* ------------------------------------------------------------------------ */

/**
 * Populate the cache with the application shell on install.
 *
 * Brief:
 *   Files are added individually rather than with addAll, because addAll
 *   rejects the whole install if any single request fails. One missing
 *   asset should not leave a user with no offline support at all.
 */
self.addEventListener('install', (install_event) => {
  install_event.waitUntil(
    (async () => {
      const cache_obj = await caches.open(CACHE_NAME_STR);

      await Promise.all(
        PRECACHE_MANIFEST_DICT.files.map(async (path_str) => {
          try {
            await cache_obj.add(new Request(path_str, { cache: 'reload' }));
          } catch {
            // A single unreachable asset must not fail the install.
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

/**
 * Drop caches from previous versions and take control immediately.
 */
self.addEventListener('activate', (activate_event) => {
  activate_event.waitUntil(
    (async () => {
      const cache_names_list = await caches.keys();

      await Promise.all(
        cache_names_list
          .filter(
            (name_str) =>
              name_str.startsWith('sonicforge-') &&
              name_str !== CACHE_NAME_STR
          )
          .map((name_str) => caches.delete(name_str))
      );

      await self.clients.claim();
    })()
  );
});

/**
 * Serve same-origin GET requests from cache, refreshing in the background.
 *
 * Brief:
 *   Navigations fall back to the cached shell so a deep link still opens
 *   offline. Anything that is neither cached nor reachable fails normally,
 *   which is the honest outcome.
 */
self.addEventListener('fetch', (fetch_event) => {
  const request_obj = fetch_event.request;

  if (request_obj.method !== 'GET') {
    return;
  }

  const request_url_obj = new URL(request_obj.url);
  if (request_url_obj.origin !== self.location.origin) {
    return;
  }

  fetch_event.respondWith(respondFromCacheFirst(request_obj));
});

/**
 * Resolve a request from cache, revalidating in the background.
 *
 * Arguments:
 *   request_obj (Request): The request to satisfy.
 *
 * Returns:
 *   (Promise<Response>): A cached or freshly fetched response.
 *
 * Warning:
 *   Only successful, basic-type responses are cached. Caching an opaque or
 *   error response would poison the cache until the next deploy.
 */
async function respondFromCacheFirst(request_obj) {
  const cache_obj = await caches.open(CACHE_NAME_STR);
  const cached_response = await cache_obj.match(request_obj, {
    ignoreSearch: true,
  });

  const network_promise = fetch(request_obj)
    .then((network_response) => {
      const is_cacheable_bool =
        network_response &&
        network_response.status === 200 &&
        network_response.type === 'basic';

      if (is_cacheable_bool) {
        cache_obj.put(request_obj, network_response.clone());
      }
      return network_response;
    })
    .catch(() => null);

  if (cached_response) {
    return cached_response;
  }

  const network_response = await network_promise;
  if (network_response) {
    return network_response;
  }

  if (request_obj.mode === 'navigate') {
    const shell_response = await cache_obj.match(APP_SHELL_PATH_STR);
    if (shell_response) {
      return shell_response;
    }
  }

  return Response.error();
}
