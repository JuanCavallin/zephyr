// Holds `pnpm dev`'s web half until the API answers /api/health, so Vite's proxy
// never hits ECONNREFUSED while the API is still loading. Gives up after a
// timeout and lets Vite start anyway; a dead API is then visible in the api log.
const port = process.env.PORT ?? '8787';
const url = `http://127.0.0.1:${port}/api/health`;
const timeoutMs = Number(process.env.WAIT_FOR_API_MS ?? 90_000);
const deadline = Date.now() + timeoutMs;

while (Date.now() < deadline) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    if (res.ok) {
      console.log(`[wait-for-api] ${url} is up`);
      process.exit(0);
    }
  } catch {
    // not listening yet
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}
console.warn(`[wait-for-api] ${url} not up after ${timeoutMs}ms; starting web anyway`);
