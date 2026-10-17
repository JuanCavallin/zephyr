import { Router } from 'express';
import { approvalDecisionSchema, type ApprovalDecision } from '@htn/shared';
import { z } from 'zod';
import {
  correctBrowserTarget,
  decideApproval,
  getApproval,
} from '../services/approvals.service.js';
import { HttpError, param, valid, validate } from './middleware/validate.js';
import { assertRunAccess, requireLocalControl } from '../services/localControl.js';

export const approvalsRouter: Router = Router();

approvalsRouter.get('/approvals/:id', async (req, res) => {
  const approval = await getApproval(param(req, 'id'));
  if (!approval) throw new HttpError(404, 'NOT_FOUND', 'Approval not found');
  res.json({ approval });
});

/**
 * The human half of the risk gate. This is what unblocks a run that stopped
 * before an irreversible action: approve it, reject it, or revise the exact
 * payload (which is reauthorized in the service before anything runs).
 */
approvalsRouter.post(
  '/approvals/:id/decide',
  requireLocalControl,
  validate(approvalDecisionSchema),
  async (req, res) => {
    const body = valid<ApprovalDecision>(req, 'body');
    const pending = await getApproval(param(req, 'id'));
    if (!pending) throw new HttpError(404, 'NOT_FOUND', 'Approval not found');
    assertRunAccess(req, pending.runId);
    const approval = await decideApproval(param(req, 'id'), body);
    res.json({ approval });
  },
);

/**
 * Use a different element for a pending browser-target review. The choice is
 * remembered for later runs; the action is re-prepared and asks for approval
 * of the corrected element. Never clicks anything itself.
 */
approvalsRouter.post(
  '/approvals/:id/browser-target',
  requireLocalControl,
  validate(z.object({ index: z.number().int().min(1) })),
  async (req, res) => {
    const { index } = valid<{ index: number }>(req, 'body');
    const pending = await getApproval(param(req, 'id'));
    if (!pending) throw new HttpError(404, 'NOT_FOUND', 'Approval not found');
    assertRunAccess(req, pending.runId);
    const approval = await correctBrowserTarget(param(req, 'id'), index);
    res.json({ approval });
  },
);
