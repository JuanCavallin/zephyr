import type {
  BrowserAdapter,
  BrowserBackend,
  BrowserPerformResult,
  BrowserViewer,
  ElementRow,
  ElementTable,
  ProviderCallContext,
  ProviderResult,
} from '@htn/shared';
import { needsTarget } from '@htn/shared';
import type { ProviderConfig } from '../config.js';
import { mockBase, mockCall } from './_mock.js';
import { browserLocation } from './browserSafety.js';

const ROWS: readonly Omit<ElementRow, 'index'>[] = [
  { role: 'textbox', label: 'Search', clickable: true, editable: true, selectable: false },
  { role: 'button', label: 'Search', clickable: true, editable: false, selectable: false },
  { role: 'link', label: 'Sign in', clickable: true, editable: false, selectable: false },
  { role: 'combobox', label: 'Region', clickable: true, editable: false, selectable: true },
  { role: 'button', label: 'Accept cookies', clickable: true, editable: false, selectable: false },
];

/** Full deterministic session lifecycle. Never invents a live stream or executes network I/O. */
export function createMockBrowser(id: BrowserBackend, cfg: ProviderConfig): BrowserAdapter {
  const sessions = new Map<string, { url: string; snapshot?: ElementTable }>();
  const base = mockBase(id, id === 'localbrowser' ? ['browser.local'] : ['browser'], cfg.mode);
  function bad<T>(op: string, message: string): ProviderResult<T> {
    return {
      ok: false,
      error: { code: 'BAD_INPUT', message, retryable: message === 'stale_snapshot' },
      meta: { provider: id, op, mode: cfg.mode, latencyMs: 0, destination: 'mock://' + id },
    };
  }
  const call = <T>(op: string, ctx: ProviderCallContext, produce: () => T) =>
    mockCall(id, op, cfg.mode, ctx, produce);
  return {
    ...base,
    async openSession(input, ctx) {
      return call('openSession', ctx, () => {
        const sessionId = id + '_' + Math.random().toString(36).slice(2, 10);
        sessions.set(sessionId, { url: input.startUrl ?? 'about:blank' });
        return { sessionId, interactive: false, simulated: true };
      });
    },
    async act(input, ctx) {
      const session = sessions.get(input.sessionId);
      if (!session) return bad('act', 'Unknown sessionId');
      return call('act', ctx, () => {
        session.url = /^https?:/.test(input.instruction)
          ? input.instruction
          : session.url + '#mock-action';
        session.snapshot = undefined;
        return { url: browserLocation(session.url), simulated: true };
      });
    },
    async extract<T>(input: { sessionId: string; instruction: string }, ctx: ProviderCallContext) {
      const session = sessions.get(input.sessionId);
      if (!session) return bad<T>('extract', 'Unknown sessionId');
      return call<T>(
        'extract',
        ctx,
        () =>
          ({
            url: browserLocation(session.url),
            title: 'Mock browser page',
            text: 'Simulated research evidence. No external page was read.',
            simulated: true,
          }) as T,
      );
    },
    async snapshot(input, ctx) {
      const session = sessions.get(input.sessionId);
      if (!session) return bad<ElementTable>('snapshot', 'Unknown sessionId');
      return call('snapshot', ctx, () => {
        const rows = ROWS.slice(0, input.maxElements ?? ROWS.length).map((row, i) => ({
          ...row,
          index: i + 1,
        }));
        const table: ElementTable = {
          sessionId: input.sessionId,
          snapshotId: 'mock_snap_' + Math.random().toString(36).slice(2, 10),
          url: browserLocation(session.url),
          title: 'Mock browser page',
          capturedAt: new Date().toISOString(),
          rows,
          totalInteractive: ROWS.length,
          truncated: rows.length < ROWS.length,
        };
        session.snapshot = table;
        return table;
      });
    },
    async perform(input, ctx) {
      const session = sessions.get(input.sessionId);
      if (!session) return bad<BrowserPerformResult>('perform', 'Unknown sessionId');
      if (needsTarget(input.operation)) {
        if (session.snapshot?.snapshotId !== input.snapshotId)
          return bad('perform', 'stale_snapshot');
        const row = session.snapshot.rows.find((item) => item.index === input.index);
        if (!row) return bad('perform', 'unknown_index');
        if (
          !(input.operation === 'CLICK'
            ? row.clickable
            : input.operation === 'TYPE_TEXT'
              ? row.editable
              : row.selectable)
        )
          return bad('perform', 'wrong_operation');
      }
      return call('perform', ctx, () => {
        const navigated = input.operation === 'CLICK';
        if (navigated) session.url += '#mock-clicked';
        session.snapshot = undefined;
        return {
          operation: input.operation,
          index: input.index,
          url: browserLocation(session.url),
          navigated,
        };
      });
    },
    async viewer(input, ctx) {
      const session = sessions.get(input.sessionId);
      if (!session) return bad('viewer', 'Unknown sessionId');
      return call<BrowserViewer>('viewer', ctx, () => ({
        providerId: id,
        mode: cfg.mode,
        kind: 'none',
        owner: 'agent',
        revision: 0,
        phase: 'agent_running',
        pageUrl: browserLocation(session.url),
        interactive: false,
        canWatch: false,
        canControl: false,
        width: 1280,
        height: 720,
        simulated: true,
        reason: 'Mock session: element table and lifecycle are simulated; no live browser exists.',
      }));
    },
    async liveView(sessionId, ctx) {
      if (!sessions.has(sessionId)) return bad('liveView', 'Unknown sessionId');
      return call('liveView', ctx, () => ({
        pageUrl: browserLocation(sessions.get(sessionId)!.url),
        interactive: false,
      }));
    },
    async invalidateSnapshot(sessionId, ctx) {
      const session = sessions.get(sessionId);
      if (!session) return bad('invalidateSnapshot', 'Unknown sessionId');
      return call('invalidateSnapshot', ctx, () => {
        session.snapshot = undefined;
        return null;
      });
    },
    async revokeControl(_sessionId, ctx) {
      return call('revokeControl', ctx, () => null);
    },
    async closeSession(sessionId, ctx) {
      return call('closeSession', ctx, () => {
        sessions.delete(sessionId);
        return null;
      });
    },
  };
}
