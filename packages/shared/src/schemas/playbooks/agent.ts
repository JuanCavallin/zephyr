import { z } from 'zod';

export const agentInputSchema = z.object({
  goal: z.string().trim().min(1).max(12_000),
  context: z.unknown().optional(),
  /** Optional user/UI-provided redacted version used for cloud routing decisions. */
  sanitizedGoal: z.string().trim().min(1).max(12_000).optional(),
  dataLabels: z
    .array(z.enum(['public', 'private', 'secret', 'local_only']))
    .min(1)
    .optional(),
  /** Accepted for older clients and ignored: an agent task is one Hermes run. */
  maxTurns: z.number().int().min(1).max(5).default(3),
});

export type AgentInput = z.infer<typeof agentInputSchema>;
