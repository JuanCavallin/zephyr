import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';
import { HttpError } from '../api/middleware/validate.js';
import { credentials, LOCAL_PRINCIPAL } from './credentials.js';

const COOKIE_NAME = 'agentos_local_control';
const token = randomBytes(32).toString('hex');

function loopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(hostname.toLowerCase());
}

export function validateLocalRequest(req: Request): void {
  const address = req.socket.remoteAddress;
  if (!address || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    throw new HttpError(
      403,
      'LOCAL_ONLY',
      'Credential and control requests require a local connection.',
    );
  }
  let requestOrigin: URL;
  try {
    requestOrigin = new URL(req.protocol + '://' + req.get('host'));
  } catch {
    throw new HttpError(403, 'INVALID_ORIGIN', 'Invalid local request host.');
  }
  if (!loopback(requestOrigin.hostname))
    throw new HttpError(403, 'INVALID_ORIGIN', 'Control requests require a loopback host.');
  const origin = req.get('origin');
  if (origin) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new HttpError(403, 'INVALID_ORIGIN', 'Invalid request origin.');
    }
    if (
      !loopback(parsed.hostname) ||
      (parsed.origin !== config.webOrigin && parsed.origin !== requestOrigin.origin)
    ) {
      throw new HttpError(403, 'INVALID_ORIGIN', 'Origin is not allowed for local control.');
    }
  }
  if (req.get('sec-fetch-site') === 'cross-site')
    throw new HttpError(403, 'INVALID_ORIGIN', 'Cross-site control requests are denied.');
}

/** The setup response only sets an HttpOnly capability; no secret appears in JSON. */
export function establishLocalControl(req: Request, res: Response): void {
  validateLocalRequest(req);
  // Browser setup needs Origin to reject navigation/form-triggered requests.
  if (!req.get('origin'))
    throw new HttpError(403, 'INVALID_ORIGIN', 'Authenticated setup requires an Origin header.');
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure,
    path: '/api',
    maxAge: 8 * 60 * 60 * 1000,
  });
  res.setHeader('Cache-Control', 'no-store');
}

export function getLocalPrincipal(req: Request): string {
  validateLocalRequest(req);
  const cookie = req
    .get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(COOKIE_NAME + '='))
    ?.slice(COOKIE_NAME.length + 1);
  if (
    !cookie ||
    Buffer.byteLength(cookie) !== Buffer.byteLength(token) ||
    !timingSafeEqual(Buffer.from(cookie), Buffer.from(token))
  ) {
    throw new HttpError(
      401,
      'CONTROL_AUTH_REQUIRED',
      'Establish a local control session before this request.',
    );
  }
  return LOCAL_PRINCIPAL;
}

export const requireLocalControl: RequestHandler = (req, res, next) => {
  try {
    getLocalPrincipal(req);
    res.setHeader('Cache-Control', 'no-store');
    next();
  } catch (error) {
    next(error);
  }
};

export function assertRunAccess(req: Request, runId: string): string {
  const principal = getLocalPrincipal(req);
  if (credentials.principalForRun(runId) !== principal)
    throw new HttpError(403, 'RUN_ACCESS_DENIED', 'Run belongs to another principal.');
  return principal;
}
