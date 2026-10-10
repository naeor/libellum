/**
 * The service worker: what makes the app open at all with no network.
 *
 * ⚠️ **Without this, none of the rest of the offline work matters.** The query
 * cache lives in IndexedDB and the app reads it happily — but only once the app
 * itself has loaded, and `index.html`, the JavaScript and the CSS all arrive over
 * the network. Offline, the browser shows its own error page and never runs a line
 * of this project's code.
 *
 * **Two caches, and the split is the whole design.**
 *
 *  * **The shell** — the HTML, the built JS and CSS, the icons. These live at URLs
 *    that never change and whose contents only change on a deploy. Cached first and
 *    served from the cache, refreshed in the background.
 *  * **`/api` responses** — deliberately **never cached here**. The ledger's data
 *    is cached by the query cache, which understands what it is caching: it knows
 *    which queries are worth keeping and which are stale, and it can be cleared on
 *    sign-out. A second copy in the service worker would be a cache that knows none
 *    of that, would survive a logout, and would disagree with the first one about
 *    what the server said.
 *
 * **Stale-while-revalidate for the shell, because this is a local-first program.**
 * The user's own device is the fast path and the network is the correction. An
 * app that waits for the network to draw its own buttons is the thing this project
 * exists not to be.
 *
 * Written as plain JavaScript with no build step, and precaching only `index.html`
 * plus the manifest: the hashed asset names are not known here, and guessing them
 * would produce a service worker that fails to install. Everything else is cached
 * on first use, which for a single-page app is the first load.
 */

const VERSION = "libellum-v1";

/** The shell cache. Bumping `VERSION` abandons the old one. */
const SHELL = `${VERSION}-shell`;

/**
 * What to have ready before the first offline launch.
 *
 * `index.html` is not optional: without it there is nothing to run. The rest is
 * filled in by the fetch handler as the user navigates, which costs nothing on a
 * fast connection and needs no list of hashed filenames here.
 *
 * ⚠️ **Only files that exist.** An earlier version listed a manifest that this
 * project does not have; the per-file `catch` below made that harmless, but a
 * precache list that names things nobody has is a list that stops being read.
 * When a manifest is added, it belongs here.
 */
const PRECACHE = ["/", "/index.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);

      /**
       * Added one at a time, so a single missing file does not fail the install.
       *
       * `addAll` rejects the whole batch if any request fails, and a service worker
       * that fails to install leaves the app with **no** offline support and no
       * obvious reason why. A missing manifest is not a reason to lose the shell.
       */
      await Promise.all(
        PRECACHE.map((path) =>
          cache.add(path).catch(() => {
            // Not fatal: the fetch handler will cache it on first use.
          }),
        ),
      );

      // Take over as soon as possible, so the first launch after a deploy is the
      // one that gets the fix.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();

      await Promise.all(
        names
          .filter((name) => !name.startsWith(VERSION))
          .map((name) => caches.delete(name)),
      );

      // Start controlling pages that are already open, rather than waiting for the
      // next navigation.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  // Only GETs. A cached POST would be a write that silently did not happen.
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Another origin: not ours to cache.
  if (url.origin !== self.location.origin) return;

  /**
   * ⚠️ **`/api` is never cached here.** See the note at the top: the query cache
   * owns the ledger's data, and a second copy that survives sign-out would be a
   * privacy problem as well as a correctness one.
   */
  if (url.pathname.startsWith("/api/")) return;

  /**
   * A navigation: serve the shell if the network is unavailable.
   *
   * `index.html` is what a single-page app needs for *any* route, so the fallback
   * is that file rather than the requested path — a cached copy of `/stats` would
   * be a stale document, where the shell plus the client router does the right
   * thing.
   */
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL);
          void cache.put("/index.html", response.clone());
          return response;
        } catch {
          const cached = (await caches.match("/index.html")) ?? (await caches.match("/"));

          if (cached !== undefined) return cached;

          /**
           * Nothing cached and no network — the very first visit was offline.
           *
           * A plain-text answer rather than the browser's default error page,
           * because this one can say something true and useful.
           */
          return new Response(
            "这个应用还没有在离线状态下打开过，所以本地没有可用的副本。请连接网络后再打开一次。",
            { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } },
          );
        }
      })(),
    );

    return;
  }

  /**
   * Everything else: the cache first, refreshed in the background.
   *
   * The background refresh is what keeps the app from being permanently stuck on
   * the version it first saw, without making the user wait for the network on every
   * load.
   */
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);

      const fromNetwork = fetch(request)
        .then(async (response) => {
          // `basic` means same-origin and complete; an opaque response is not
          // something worth keeping.
          if (response.ok && response.type === "basic") {
            const cache = await caches.open(SHELL);
            void cache.put(request, response.clone());
          }

          return response;
        })
        .catch(() => undefined);

      if (cached !== undefined) return cached;

      const response = await fromNetwork;

      if (response !== undefined) return response;

      return new Response("", { status: 504 });
    })(),
  );
});
