import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/**
 * ⚠️ **The LAN server is HTTPS, and it has to be.**
 *
 * `getUserMedia`, `MediaRecorder`, `crypto.randomUUID` and service workers are
 * all *secure-context* APIs: a browser only defines them over HTTPS or on
 * `localhost`. Reached at `http://192.168.0.184:5173` — how a phone on the same
 * Wi-Fi reaches this machine — `navigator.mediaDevices` is simply `undefined`.
 *
 * That failure is not subtle, and it already cost real time twice. `crypto
 * .randomUUID` threw "not a function" on the same address, and speech recording
 * then showed "this browser does not support recording" on a phone that supports
 * it perfectly — **with no permission prompt, because there was no API to prompt
 * for.** Both sent the reader looking at the browser rather than at the URL.
 *
 * The certificate is self-signed and made by `pnpm dev:cert`. `docs/README.md`
 * explains the one-time trust step on a phone. It is written to a gitignored
 * directory, because a private key does not belong in a public repository even
 * when it is worthless.
 */
function httpsConfig(): { key: Buffer; cert: Buffer } | undefined {
  if (!LAN) return undefined;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const keyPath = path.join(here, ".certs", "dev-key.pem");
  const certPath = path.join(here, ".certs", "dev-cert.pem");

  try {
    return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
  } catch {
    /**
     * Missing certificate: **stay on HTTP rather than refusing to start.**
     *
     * A dev server that will not boot because of a certificate is worse than one
     * that boots without the secure-context features. Everything except recording
     * and offline still works, and the warning says exactly what to run.
     */
    console.warn(
      "\n⚠️  没有找到开发证书，局域网将以 http 启动。\n" +
        "    在手机上，录音与离线会不可用。运行 pnpm dev:cert 生成证书。\n",
    );
    return undefined;
  }
}

/**
 * The server options, with `https` present only when there is a certificate.
 *
 * Built as a value rather than inline because of a subtlety that cost a compile
 * error twice: under `exactOptionalPropertyTypes`, an optional property may be
 * *absent* or hold a value, but `{ https: undefined }` is neither — and a
 * conditional spread inside an object literal still leaves the key in the
 * inferred type as `… | undefined`. Choosing between two whole objects avoids the
 * question entirely, and reads as what it is: two configurations.
 */
function serverOptions(): Record<string, unknown> {
  const base = {
    // Bind IPv4 explicitly: the default ("localhost") resolves to ::1 only on
    // some Windows setups, which makes http://127.0.0.1:5173 unreachable.
    host: LAN ? "0.0.0.0" : "127.0.0.1",
    port: 5173,
    // Proxy API calls to the local API server so the browser sees one origin.
    // This is why the API needs no CORS configuration at all, and why exposing
    // this port is enough to use the whole application from a phone.
    //
    // `changeOrigin` is deliberately left **off**. Turning it on rewrites the
    // Host header to the target, which makes the API see `127.0.0.1:3000` while
    // the browser's Origin says `192.168.0.184:5173` — and the API's same-origin
    // check then rejects every write as cross-site. The API should see the host
    // the client actually used.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
      },
    },
  };

  const certificates = httpsConfig();

  return certificates === undefined ? base : { ...base, https: certificates };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: serverOptions(),
});
