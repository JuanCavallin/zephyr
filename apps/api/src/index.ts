import { createApp } from './app.js';
import { config, logConfigSummary } from './config.js';
import { flushObservability, initObservability } from './lib/observability.js';
import { seedGraphs } from './services/graphs.service.js';
import { store } from './store/index.js';
import { initializeRuntimeProviders, recoverInterruptedRuns } from './services/runtime.js';

async function main(): Promise<void> {
  // Before anything else emits, so the boot sequence itself is traced. Returns
  // false and changes nothing when SENTRY_DSN is unset.
  initObservability({
    dsn: config.sentry.dsn,
    environment: config.env,
    tracesSampleRate: config.sentry.tracesSampleRate,
    release: config.sentry.release,
  });

  logConfigSummary();

  // SQLite performs schema setup at construction; memory hydrate is a no-op.
  await store.hydrate();
  await recoverInterruptedRuns();

  // So the canvas is never empty on a cold start. Never overwrites an edit.
  await seedGraphs();

  await initializeRuntimeProviders();

  const app = createApp();
  const server = app.listen(config.port, '127.0.0.1', () => {
    console.log('[api] listening on http://localhost:' + config.port);
    console.log('[api] health:    http://localhost:' + config.port + '/api/health');
    console.log('[api] providers: http://localhost:' + config.port + '/api/providers');
  });

  const shutdown = (signal: string): void => {
    console.log('[api] ' + signal + ' received, closing');
    server.close(() => {
      void flushObservability().finally(() => {
        if ('close' in store && typeof store.close === 'function') store.close();
        process.exit(0);
      });
    });
    // Do not let a hung SSE connection block the exit.
    setTimeout(() => process.exit(0), 2000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

void main();
