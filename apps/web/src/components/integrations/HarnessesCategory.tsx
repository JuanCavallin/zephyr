/**
 * Harnesses, read-only: the agent runtimes the API host has configured and whether
 * each passes its health check. Configuration lives in the API's .env.
 */

import type { IntegrationItem } from '@htn/shared';
import { statusGlyph } from '../../lib/integrations';
import { StatusMark } from './KeysCategory';

const STATUS_LABEL: Record<IntegrationItem['status'], string> = {
  connected: 'Connected',
  needs_attention: 'Needs you',
  error: 'Error',
  available: 'Mock',
  disabled: 'Disabled',
};

export function HarnessesCategory({
  items,
  selectedId,
}: {
  items: IntegrationItem[];
  selectedId?: string;
}) {
  const harnesses = items.filter((item) => item.kind === 'harness');
  return (
    <section className="integration-list integration-list--wide" aria-labelledby="harness-title">
      <header className="integration-list-head">
        <h2 id="harness-title">Harnesses</h2>
      </header>
      <ul className="integration-rows">
        {harnesses.map((item) => {
          const glyph = statusGlyph(item.status);
          return (
            <li
              key={item.id}
              className={
                'integration-row integration-row--static integration-row--' +
                glyph +
                (item.id === selectedId ? ' is-focused' : '')
              }
            >
              <StatusMark glyph={glyph} />
              <span className="integration-row-name">{item.name}</span>
              <span className="integration-row-detail">{STATUS_LABEL[item.status]}</span>
              {(item.reason || item.status === 'available') && (
                <span className="integration-row-reason">
                  {item.reason ??
                    'Running scripted mock. Set its mode to live in .env to use the real harness.'}
                  {item.fix ? ' ' + item.fix : ''}
                </span>
              )}
            </li>
          );
        })}
      </ul>
      <p className="inline-note">
        Harnesses run on the API host. Configure them in .env (HERMES_CWD, CLAUDECODE_MODE), then
        restart the API.
      </p>
    </section>
  );
}
