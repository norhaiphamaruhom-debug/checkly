// Minimal service worker: it exists so Checkly can be installed to a home
// screen. It deliberately does no caching - attendance data must always come
// fresh from the server, so every request goes straight to the network.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
    /* network only: let the browser handle the request normally */
});
