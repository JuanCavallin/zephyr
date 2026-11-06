/**
 * Integrations: everything the user can connect, in one place. Rail of categories,
 * then each category's list and detail. Status comes from GET /api/integrations;
 * secrets never reach the browser.
 */

import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { IntegrationsResponse } from '@htn/shared';
import { api } from '../lib/api';
import {
  categoryFromParam,
  countsByCategory,
  firstAttentionPath,
  summaryLine,
} from '../lib/integrations';
import { IntegrationRail } from '../components/integrations/IntegrationRail';
import { KeysCategory } from '../components/integrations/KeysCategory';
import { HarnessesCategory } from '../components/integrations/HarnessesCategory';
import {
  ConnectorsCategory,
  McpCategory,
  SystemCategory,
} from '../components/integrations/ConnectionSections';

export function Integrations() {
  const params = useParams();
  const category = categoryFromParam(params.kind);
  const [data, setData] = useState<IntegrationsResponse>();
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    try {
      setData(await api.integrations());
      setError('');
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Integration status unavailable.');
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const attention = data ? firstAttentionPath(data.items) : undefined;

  return (
    <div className="library-page integrations-page">
      <header className="library-heading">
        <div>
          <h1>Integrations</h1>
          <p>
            The keys, harnesses, MCP servers and connectors Zephyr can use. Secrets stay on this
            machine; this page only ever sees the last four characters.
          </p>
        </div>
        {data && (
          <p className="integrations-summary" role="status">
            {attention ? (
              <Link to={attention}>{summaryLine(data.summary)}</Link>
            ) : (
              summaryLine(data.summary)
            )}
          </p>
        )}
      </header>
      {error && (
        <p className="error-note" role="alert">
          {error}{' '}
          <button className="text-link" onClick={() => void reload()}>
            Retry
          </button>
        </p>
      )}
      <div className="integrations-layout">
        <IntegrationRail current={category} counts={data && countsByCategory(data.items)} />
        <div className="integrations-body">
          {category === 'keys' && (
            <KeysCategory selectedId={params.id} onChange={() => void reload()} />
          )}
          {category === 'harnesses' && (
            <HarnessesCategory items={data?.items ?? []} selectedId={params.id} />
          )}
          {category === 'mcp' && <McpCategory onChange={() => void reload()} />}
          {category === 'connectors' && <ConnectorsCategory />}
          {category === 'system' && <SystemCategory />}
        </div>
      </div>
    </div>
  );
}
