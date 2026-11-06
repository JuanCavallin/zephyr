import { Router } from 'express';
import { credentials } from '../services/credentials.js';
import { buildIntegrations } from '../services/integrations.service.js';
import { getLocalPrincipal, requireLocalControl } from '../services/localControl.js';
import { providers } from '../services/runtime.js';
import { store } from '../store/index.js';

export const integrationsRouter: Router = Router();

// Key status (incl. last four characters) is as private as /credentials.
integrationsRouter.use('/integrations', requireLocalControl);
integrationsRouter.get('/integrations', async (req, res) => {
  const [mcp, statuses] = await Promise.all([store.listMcpConnections(), providers.statuses()]);
  res.json(
    buildIntegrations({
      credentials: credentials.statuses(getLocalPrincipal(req)),
      mcp,
      providers: statuses,
    }),
  );
});
