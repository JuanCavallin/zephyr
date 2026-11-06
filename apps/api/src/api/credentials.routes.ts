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
    lifetime: credentials.persisted ? 'persisted' : 'process',
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
/** Validation stays a 400; a storage failure is a 500 that names what happened. */
async function persisted<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.message.startsWith('Provide a non-empty'))
      throw new HttpError(400, 'INVALID_CREDENTIAL', error.message);
    throw new HttpError(
      500,
      'CREDENTIAL_NOT_PERSISTED',
      'The key could not be saved to the local vault; nothing was changed.',
    );
  }
}
credentialsRouter.put('/credentials/:providerId', validate(schema), async (req, res) => {
  const value = valid<z.infer<typeof schema>>(req, 'body');
  const id = provider(req);
  res.json({
    provider: await persisted(() =>
      credentials.save(getLocalPrincipal(req), id, value.secret, value.metadata),
    ),
  });
});
credentialsRouter.delete('/credentials/:providerId', async (req, res) => {
  const id = provider(req);
  res.json({ provider: await persisted(() => credentials.delete(getLocalPrincipal(req), id)) });
});
