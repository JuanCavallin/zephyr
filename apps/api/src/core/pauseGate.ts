/**
 * Cooperative pause/resume.
 *
 * Deliberately NOT an AbortSignal. Aborting is cancellation — it unwinds the
 * run and it cannot be undone. Pausing has to leave everything exactly where it
 * is so that resuming continues the same run, so the only thing that can
 * implement it is the run itself choosing to wait.
 *
 * So this is a latch the orchestrator checks at every safe point (step
 * boundaries and outer-loop turns). Pausing mid-flight inside a provider call
 * is intentionally impossible: the remote side has already been asked to do the
 * work, and a "pause" that let a half-finished external call land would be a
 * lie. The observable effect is that pausing takes effect at the next boundary.
 *
 * Latches live in memory, like approval waiters, and for the same reason: a
 * paused run is meaningless once the process holding it is gone.
 */

interface Latch {
  /** Resolves when the run is resumed. */
  promise: Promise<void>;
  release: () => void;
  /** Set when a paused run is cancelled, so waiters unwind rather than hang. */
  released: boolean;
  /**
   * When the first checkpoint actually parked on this latch. Unset while the
   * run is still draining (`pausing`): that time was real work, and analytics
   * must only exclude the stretch where nothing ran. See PauseSpan.
   */
  heldAt?: string;
}

const latches = new Map<string, Latch>();

/** True when this call is the one that paused the run. */
export function pauseRun(runId: string): boolean {
  if (latches.has(runId)) return false;
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  latches.set(runId, { promise, release, released: false });
  return true;
}

/** True when this call is the one that resumed the run. */
export function resumeRun(runId: string): boolean {
  const latch = latches.get(runId);
  if (!latch) return false;
  latches.delete(runId);
  latch.released = true;
  latch.release();
  return true;
}

/** When the current pause actually took hold, or undefined if it has not yet. */
export function pauseHeldSince(runId: string): string | undefined {
  return latches.get(runId)?.heldAt;
}

export function isPaused(runId: string): boolean {
  return latches.has(runId);
}

export function pausedCount(): number {
  return latches.size;
}

/**
 * The checkpoint. Returns immediately unless the run is paused.
 *
 * `onPause` fires only when the caller actually has to wait, so the status
 * write and SSE event happen once, at the boundary where the pause really took
 * effect — not when the button was clicked.
 */
export async function waitWhilePaused(
  runId: string,
  signal?: AbortSignal,
  onPause?: () => Promise<void>,
): Promise<void> {
  const latch = latches.get(runId);
  if (!latch) return;
  if (signal?.aborted) return;

  latch.heldAt ??= new Date().toISOString();
  await onPause?.();

  await Promise.race([
    latch.promise,
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => resolve(), { once: true });
    }),
  ]);

  // Cancelling a paused run drops the latch so a later resume cannot revive it.
  if (signal?.aborted) latches.delete(runId);
}

/** Drop any latch for a run that has finished, so the map cannot leak. */
export function clearPause(runId: string): void {
  const latch = latches.get(runId);
  if (!latch) return;
  latches.delete(runId);
  latch.release();
}
