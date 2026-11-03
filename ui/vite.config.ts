import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

declare const process: { env: Record<string, string | undefined> };

// In dev mode (scripts/dev.mjs) the server is rebuilt on every change and
// touches this file when the new one is up, which reloads every open page.
function serverReload(): Plugin {
  const file = process.env.DEV_RELOAD_FILE;
  const same = (a: string, b: string) => a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
  return {
    name: "server-reload",
    configureServer(server) {
      if (!file) return;
      server.watcher.add(file);
      server.watcher.on("change", (changed) => {
        if (same(changed, file)) server.ws.send({ type: "full-reload" });
      });
    },
  };
}

// Builds into dist, which the server serves. In dev mode the API goes to
// the server dev mode runs.
export default defineConfig({
  plugins: [react(), serverReload()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    modulePreload: { polyfill: false },
  },
  server: {
    proxy: { "/api": { target: process.env.API_TARGET ?? "http://127.0.0.1:7070", changeOrigin: true } },
  },
});
