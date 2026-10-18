import express, { type Express } from 'express';
import { config } from './config.js';
import { mountRoutes } from './api/index.js';
import { errorHandler, notFoundHandler } from './api/middleware/error.js';
import { requestContext } from './api/middleware/requestContext.js';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');

  // DO NOT ADD compression() HERE. gzip buffering silently breaks SSE and the
  // symptom looks like a hung backend. See api/stream.routes.ts.

  app.use(express.json({ limit: '2mb' }));
  app.use(requestContext);

  // In dev the Vite proxy serves /api from the same origin, so CORS is not
  // needed. This header exists only for the case where the web app is served
  // from somewhere else (a deployed build pointed at a local api).
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', config.webOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Last-Event-ID, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  mountRoutes(app);

  // Express 5 uses path-to-regexp v8: a bare '*' throws at boot. Use '/*splat'.
  app.use('/*splat', notFoundHandler);
  app.use(errorHandler);

  return app;
}
