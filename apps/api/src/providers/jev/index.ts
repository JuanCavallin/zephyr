import type {
  ActionPolicy,
  Capability,
  CompletionStatus,
  DecisionAdapter,
  IntelligenceLevel,
  ModelRoute,
  PrivacyRoute,
  ToolDescriptor,
} from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveJev } from './live.js';
import { credentials } from '../../services/credentials.js';

const CAPABILITIES: readonly Capability[] = ['decision'];

export function create(cfg: ProviderConfig): DecisionAdapter {
  if (cfg.mode === 'live') return createLiveJev(cfg, credentials);
  return createMock(cfg);
}

function pickPrivacy(task: string, context?: string): PrivacyRoute {
  return /resume|résumé|\bcv\b|private|secret|patient|medical|financial|credential|local.only/i.test(
    task + ' ' + (context ?? ''),
  )
    ? 'private'
    : 'cloud';
}

function pickIntelligence(task: string): IntelligenceLevel {
  return task.length < 160 ? 'low' : 'high';
}

/** ~4 chars per token. Good enough for a mock; live Jev would report real counts. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function overlapScore(state: string, candidate: string): number {
  const stateWords = words(state);
  const candidateWords = words(candidate);
  let overlap = 0;
  for (const word of candidateWords) {
    if (stateWords.has(word)) overlap += 1;
  }
  return overlap;
}

function mockModelChoice(task: string, candidates: ModelRoute[]): ModelRoute | undefined {
  const complex = pickIntelligence(task) === 'high';
  return [...candidates].sort((a, b) => {
    const aRank = a.costTier === 'frontier' ? 2 : a.costTier === 'standard' ? 1 : 0;
    const bRank = b.costTier === 'frontier' ? 2 : b.costTier === 'standard' ? 1 : 0;
    return complex ? bRank - aRank : aRank - bRank;
  })[0];
}

function mockToolChoices(
  task: string,
  candidates: ToolDescriptor[],
  maxTools: number,
): ToolDescriptor[] {
  const ranked = candidates
    .map((tool, index) => ({
      tool,
      index,
      score: overlapScore(task, `${tool.id} ${tool.family} ${tool.description}`),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const matching = ranked.filter((candidate) => candidate.score > 0);
  return (matching.length > 0 ? matching : ranked).slice(0, maxTools).map(({ tool }) => tool);
}

function createMock(cfg: ProviderConfig): DecisionAdapter {
  const base = mockBase('jev', CAPABILITIES, cfg.mode);
  return {
    ...base,
    async decide(input, ctx) {
      // Jev is a model call in reality, so the mock must report tokens or it
      // shows up as a free step in the analytics rollup. Deliberately NO
      // estimatedCostCents: Jev's real pricing is not known to us (see
      // providers/jev/live.ts), and inventing a number is worse than omitting it.
      const tokensIn = estimateTokens(input.question + (input.evidence ?? ''));
      return mockCall(
        'jev',
        'decide',
        cfg.mode,
        ctx,
        () => ({
          // Always the first option. Deterministic on purpose: a demo you rehearse
          // must take the same branch every time, and playbooks are written so that
          // options[0] is the path worth showing (the one that hits the approval gate).
          choice: input.options[0] ?? 'unknown',
          confidence: 0.82,
          rationale: 'Mock decision over ' + input.options.length + ' option(s).',
        }),
        { tokensIn, tokensOut: 24 },
      );
    },
    async selectModel(input, ctx) {
      const tokensIn = estimateTokens(
        input.state.taskSummary + input.candidates.map((candidate) => candidate.id).join(' '),
      );
      return mockCall(
        'jev',
        'select_model',
        cfg.mode,
        ctx,
        () => {
          const selected = mockModelChoice(input.state.taskSummary, input.candidates);
          if (!selected) throw new Error('selectModel requires at least one candidate.');
          return {
            selectedRouteId: selected.id,
            confidence: 0.84,
            probabilities: Object.fromEntries(
              input.candidates.map((candidate) => [
                candidate.id,
                candidate.id === selected.id
                  ? 0.84
                  : 0.16 / Math.max(1, input.candidates.length - 1),
              ]),
            ),
            reasonCodes: ['mock-model-selection'],
          };
        },
        { tokensIn, tokensOut: 16 },
      );
    },
    async selectToolFamilies(input, ctx) {
      const selectedFamilies = input.candidateFamilies.filter(
        (family) => overlapScore(input.state.taskSummary, family) > 0,
      );
      const selected =
        selectedFamilies.length > 0 ? selectedFamilies : input.candidateFamilies.slice(0, 2);
      return mockCall(
        'jev',
        'select_tool_families',
        cfg.mode,
        ctx,
        () => ({
          selectedFamilies: selected,
          confidences: Object.fromEntries(
            input.candidateFamilies.map((family) => [
              family,
              selected.includes(family) ? 0.8 : 0.2,
            ]),
          ),
          reasonCodes: ['mock-tool-family-selection'],
        }),
        {
          tokensIn: estimateTokens(input.state.taskSummary + input.candidateFamilies.join(' ')),
          tokensOut: 16,
        },
      );
    },
    async selectTools(input, ctx) {
      const maxTools = Math.max(0, Math.min(input.maxTools ?? 8, input.candidates.length));
      const selected = mockToolChoices(input.state.taskSummary, input.candidates, maxTools);
      return mockCall(
        'jev',
        'select_tools',
        cfg.mode,
        ctx,
        () => ({
          selectedToolIds: selected.map((tool) => tool.id),
          confidences: Object.fromEntries(
            input.candidates.map((tool) => [tool.id, selected.includes(tool) ? 0.79 : 0.21]),
          ),
          reasonCodes: ['mock-tool-selection'],
        }),
        {
          tokensIn: estimateTokens(
            input.state.taskSummary + input.candidates.map((tool) => tool.description).join(' '),
          ),
          tokensOut: 24,
        },
      );
    },
    async recommendActionPolicy(input, ctx) {
      let policy: ActionPolicy = 'auto';
      if (input.descriptor.baselineEffect === 'unknown') policy = 'deny';
      else if (input.descriptor.baselineEffect === 'destructive') policy = 'ask_user';
      else if (input.descriptor.baselineEffect === 'write') policy = 'verify';
      return mockCall(
        'jev',
        'recommend_action_policy',
        cfg.mode,
        ctx,
        () => ({
          policy,
          confidence: 0.86,
          probabilities: { [policy]: 0.86 },
          reasonCodes: ['mock-action-policy', `effect-${input.descriptor.baselineEffect}`],
        }),
        {
          tokensIn: estimateTokens(input.action.operation + input.descriptor.description),
          tokensOut: 12,
        },
      );
    },
    async judgeCompletion(input, ctx) {
      const checkpoint = input.checkpoint;
      let status: CompletionStatus = 'done';
      if (checkpoint.pendingApprovalIds.length > 0) status = 'blocked';
      else if (
        checkpoint.outstandingRequirements.length > 0 ||
        checkpoint.steps.some((step) => step.required && step.status !== 'succeeded')
      ) {
        status = checkpoint.budget.stepsRemaining > 0 ? 'continue' : 'blocked';
      }
      return mockCall(
        'jev',
        'judge_completion',
        cfg.mode,
        ctx,
        () => ({
          status,
          confidence: 0.88,
          probabilities: { [status]: 0.88 },
          reasonCodes: ['mock-completion-judgment'],
          suggestedNextStepId:
            status === 'continue'
              ? checkpoint.steps.find((step) => step.required && step.status !== 'succeeded')?.id
              : undefined,
        }),
        { tokensIn: estimateTokens(input.sanitizedState.taskSummary), tokensOut: 16 },
      );
    },
    async route(input, ctx) {
      const tokensIn = estimateTokens(input.task + input.availableTools.join(' '));
      return mockCall(
        'jev',
        'route',
        cfg.mode,
        ctx,
        () => {
          const privacy = pickPrivacy(input.task, input.context);
          const intelligence = pickIntelligence(input.task);
          const modelTier =
            privacy === 'private' ? 'local' : intelligence === 'low' ? 'cheap' : 'frontier';
          // Deterministic slice, not random, so a rehearsed demo shows the same
          // reduction every time — this is the M2 headline number (50+ -> 3-8).
          const exposedTools = input.availableTools.slice(
            0,
            Math.min(3, input.availableTools.length),
          );
          return {
            privacy,
            intelligence,
            privacyConfidence: 0.8,
            intelligenceConfidence: 0.8,
            modelTier,
            exposedTools,
            confidence: 0.78,
            rationale:
              'Mock route: exposed ' +
              exposedTools.length +
              ' of ' +
              input.availableTools.length +
              ' candidate tool(s), tier=' +
              modelTier +
              '.',
          };
        },
        { tokensIn, tokensOut: 32 },
      );
    },
  };
}
