import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind IPv4 explicitly: the default ("localhost") resolves to ::1 only on
    // some Windows setups, which makes http://127.0.0.1:5173 unreachable.
    host: "127.0.0.1",
    port: 5173,
    // Proxy API calls to the local API server so the browser sees one origin.
    // This is why the API needs no CORS configuration at all.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
    },
  },
});
