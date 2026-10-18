import { defineConfig, createLogger } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// While the API restarts (tsx watch reloads on every edit) an open tab keeps polling
// and reconnecting its SSE stream, and Vite prints a stack trace per request. Collapse
// those into one line per outage so a real error is not buried.
// The API the dev server proxies to. Overridable so a second UI can point at an
// API on another port without touching the one on :8787.
const apiTarget = process.env.API_PROXY_TARGET ?? 'http://localhost:8787';

const logger = createLogger();
const baseError = logger.error.bind(logger);
let apiDownSince = 0;
let lastRefused = 0;
let lastNotice = 0;
logger.error = (message, options) => {
  if (message.includes('http proxy error') && message.includes('ECONNREFUSED')) {
    const now = Date.now();
    // A gap with no refusals means the API came back; start a fresh outage.
    if (now - lastRefused > 15_000) apiDownSince = now;
    lastRefused = now;
    if (now - lastNotice > 10_000) {
      lastNotice = now;
      logger.warn(
        `[web] API at ${apiTarget} is not accepting connections (down ${Math.round((now - apiDownSince) / 1000)}s). ` +
          'Normal while it restarts; if it persists, check the [api] log for a crash.',
      );
    }
    return;
  }
  baseError(message, options);
};

export default defineConfig({
  customLogger: logger,
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      // Same-origin in dev, so there is no CORS to configure and SSE passes
      // straight through. Do NOT set ws:true here — it breaks the SSE route.
      '/api': { target: apiTarget, changeOrigin: true },
    },
  },
});
