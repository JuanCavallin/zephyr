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
import { importCredentials, parseEnvCredentials } from '../services/credentialImport.js';
import { verifyCredential } from '../services/credentialVerify.js';
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

credentialsRouter.post('/credentials/:providerId/verify', async (req, res) => {
  const id = provider(req);
  const secret = credentials.currentSecret(getLocalPrincipal(req), id);
  if (!secret) throw new HttpError(400, 'CREDENTIAL_MISSING', 'Save a key before verifying it.');
  res.json(await verifyCredential(id, secret));
});

// .env import. The client reads the file locally and sends its text; the preview
// returns only provider, variable name and last four characters.
const envText = z.string().max(64 * 1024);
const previewSchema = z.object({ text: envText }).strict();
const commitSchema = z
  .object({ text: envText, providerIds: z.array(z.string()).min(1).max(20) })
  .strict();

credentialsRouter.post('/credentials/import/env', validate(previewSchema), (req, res) => {
  const { text } = valid<z.infer<typeof previewSchema>>(req, 'body');
  const principal = getLocalPrincipal(req);
  const parsed = parseEnvCredentials(text);
  const configured = new Set(
    credentials
      .statuses(principal)
      .filter((status) => status.configured)
      .map((status) => status.providerId),
  );
  res.json({
    matches: parsed.matches.map((match) => ({
      providerId: match.providerId,
      envVar: match.envVar,
      last4: match.secret.slice(-4),
      replaces: configured.has(match.providerId),
    })),
    ignored: parsed.ignored,
  });
});

credentialsRouter.post(
  '/credentials/import/env/commit',
  validate(commitSchema),
  async (req, res) => {
    const { text, providerIds } = valid<z.infer<typeof commitSchema>>(req, 'body');
    const principal = getLocalPrincipal(req);
    const matches = new Map(parseEnvCredentials(text).matches.map((m) => [m.providerId, m]));
    const selected = [...new Set(providerIds)].map((id) => {
      const match = matches.get(id as CredentialProvider);
      if (!match) throw new HttpError(400, 'NOT_IN_FILE', 'The file has no key for ' + id + '.');
      return match;
    });
    // All or nothing; a failed write puts back exactly what was there before.
    res.json({
      providers: await persisted(() => importCredentials(credentials, principal, selected)),
    });
  },
);
