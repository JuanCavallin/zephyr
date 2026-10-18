import { Router } from 'express';
import { z } from 'zod';
import {
  CREDENTIAL_PROVIDERS,
  credentials,
  type CredentialProvider,
} from '../services/credentials.js';
import {
  establishLocalControl,
  getLocalPrincipal,
  requireLocalControl,
} from '../services/localControl.js';
import { HttpError, param, validate, valid } from './middleware/validate.js';

export const credentialsRouter = Router();
credentialsRouter.post('/credentials/session', (req, res) => {
  establishLocalControl(req, res);
  res.json({ principal: 'local-user', lifetime: 'process' });
});
credentialsRouter.use('/credentials', requireLocalControl);
credentialsRouter.get('/credentials', (req, res) => {
  res.json({
    source: credentials.source,
    browserSource: credentials.browserSource,
    lifetime: 'process',
    providers: credentials.statuses(getLocalPrincipal(req)),
  });
});

const schema = z
  .object({
    secret: z.string().min(1).max(8192),
    metadata: z
      .object({
        projectId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9_-]+$/),
      })
      .strict()
      .optional(),
  })
  .strict();
function provider(req: Parameters<typeof param>[0]): CredentialProvider {
  const id = param(req, 'providerId');
  if (!Object.hasOwn(CREDENTIAL_PROVIDERS, id))
    throw new HttpError(400, 'UNSUPPORTED_PROVIDER', 'Unsupported credential provider.');
  return id as CredentialProvider;
}
credentialsRouter.put('/credentials/:providerId', validate(schema), (req, res) => {
  const value = valid<z.infer<typeof schema>>(req, 'body');
  res.json({
    provider: credentials.put(getLocalPrincipal(req), provider(req), value.secret, value.metadata),
  });
});
credentialsRouter.delete('/credentials/:providerId', (req, res) => {
  res.json({ provider: credentials.remove(getLocalPrincipal(req), provider(req)) });
});
