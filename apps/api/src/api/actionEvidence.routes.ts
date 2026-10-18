import { Router } from 'express';
import { actionEvidenceStore } from '../services/actionEvidence.js';
import { requireLocalControl, assertRunAccess } from '../services/localControl.js';
import { store } from '../store/index.js';
import { HttpError, param } from './middleware/validate.js';

export const actionEvidenceRouter: Router = Router();
actionEvidenceRouter.use('/runs/:id/actions', requireLocalControl);
actionEvidenceRouter.use('/runs/:id/previews', requireLocalControl);

actionEvidenceRouter.get('/runs/:id/actions/:actionId/evidence', async (req, res) => {
  const runId = param(req, 'id');
  assertRunAccess(req, runId);
  if (!(await store.getRun(runId))) throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
  res.json({ evidence: actionEvidenceStore.list(runId, param(req, 'actionId')) });
});
actionEvidenceRouter.get('/runs/:id/previews/:ref', async (req, res) => {
  const runId = param(req, 'id');
  assertRunAccess(req, runId);
  if (!(await store.getRun(runId))) throw new HttpError(404, 'NOT_FOUND', 'Run not found.');
  const preview = actionEvidenceStore.preview(runId, param(req, 'ref'));
  if (!preview)
    throw new HttpError(
      404,
      'PREVIEW_UNAVAILABLE',
      'Preview is unavailable or expired; previews are not persisted across restarts.',
    );
  res.json({ preview });
});
