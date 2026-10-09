import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Whether the dev server is reachable from other devices on the network.
 *
 * Off by default. Listening on every interface makes Windows Defender Firewall
 * ask for permission the first time, and exposes an unauthenticated dev server
 * (with Vite's own debug endpoints) to whatever network the laptop is on —
 * which is worth avoiding in a café.
 *
 * For phone testing on the same Wi-Fi, run `pnpm dev:lan` instead. The API
 * stays on loopback even then: the phone talks to this server only, and the
 * proxy below forwards /api to the API on the machine's own loopback.
 */
const LAN = process.env["LIBELLUM_LAN"] === "1";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind IPv4 explicitly: the default ("localhost") resolves to ::1 only on
    // some Windows setups, which makes http://127.0.0.1:5173 unreachable.
    host: LAN ? "0.0.0.0" : "127.0.0.1",
    port: 5173,
    // Proxy API calls to the local API server so the browser sees one origin.
    // This is why the API needs no CORS configuration at all, and why exposing
    // this port is enough to use the whole application from a phone.
    //
    // `changeOrigin` is deliberately left **off**. Turning it on rewrites the
    // Host header to the target, which makes the API see `127.0.0.1:3000`
    // while the browser's Origin says `192.168.0.184:5173` — and the API's
    // same-origin check then rejects every write as cross-site. The API should
    // see the host the client actually used.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
      },
    },
  },
});
