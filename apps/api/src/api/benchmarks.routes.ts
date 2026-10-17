/**
 * Graph vs baseline across every stored run — the Benchmarks page's data.
 *
 *   GET /api/benchmarks              live runs only
 *   GET /api/benchmarks?includeMock=1  mocked runs included (numbers not real)
 *   GET /api/benchmarks?warmth=cold    graph runs that reused nothing (or =warm)
 */

import { Router } from 'express';
import { benchmarkReport } from '../services/benchmark.service.js';

export const benchmarksRouter: Router = Router();

benchmarksRouter.get('/benchmarks', async (req, res) => {
  const includeMocked = /^(1|true|yes)$/i.test(String(req.query.includeMock ?? ''));
  const warmth =
    req.query.warmth === 'cold' || req.query.warmth === 'warm' ? req.query.warmth : 'all';
  res.json(await benchmarkReport(includeMocked, warmth));
});
