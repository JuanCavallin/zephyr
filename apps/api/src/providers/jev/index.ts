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

const NEGATION = /\b(never|not|no|don't|dont|avoid|stop|without)\b/i;
const FILLER = new Set(
  'a an the and or of to in on for with by be is are use uses using prefer prefers over than it its this that when always never not no don dont t avoid stop without'.split(' '),
);

/** Words that carry meaning, without filler or negations. */
function contentWords(value: string): Set<string> {
  return new Set([...words(value)].filter((w) => !FILLER.has(w) && w.length > 1));
}

/** Overlap coefficient of content words, 0..1. */
function contentSimilarity(a: string, b: string): number {
  const wa = contentWords(a);
  const wb = contentWords(b);
  if (wa.size === 0 || wb.size === 0) return 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared += 1;
  return shared / Math.min(wa.size, wb.size);
}

function negates(text: string): boolean {
  return NEGATION.test(text);
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
    async scoreFiles(input, ctx) {
      // Deterministic: share of the file's path/summary words that appear in the task.
      return mockCall(
        'jev',
        'score_files',
        cfg.mode,
        ctx,
        () => ({
          scores: Object.fromEntries(
            input.files.map((file) => {
              const candidate = file.path.replace(/[/\\._-]+/g, ' ') + ' ' + file.summary;
              const size = Math.max(1, words(candidate).size);
              return [file.path, Math.min(1, overlapScore(input.task, candidate) / Math.min(size, 6))];
            }),
          ),
          reasonCodes: ['mock-file-relevance'],
        }),
        {
          tokensIn: estimateTokens(input.task + input.files.map((f) => f.path + f.summary).join(' ')),
          tokensOut: 4 * input.files.length,
        },
      );
    },
    async scoreTests(input, ctx) {
      // Deterministic: a test whose summary names a changed path is central; else
      // the share of changed-path words it shares.
      return mockCall(
        'jev',
        'score_tests',
        cfg.mode,
        ctx,
        () => ({
          scores: Object.fromEntries(
            input.tests.map((test) => {
              const text = test.id + ' ' + test.summary;
              if (input.changed.some((path) => text.includes(path))) return [test.id, 0.9];
              const candidate = text.replace(/[/\\._-]+/g, ' ');
              const changed = input.changed.join(' ').replace(/[/\\._-]+/g, ' ');
              const size = Math.max(1, words(candidate).size);
              return [test.id, Math.min(0.6, overlapScore(changed, candidate) / Math.min(size, 6))];
            }),
          ),
          reasonCodes: ['mock-test-relevance'],
        }),
        {
          tokensIn: estimateTokens(input.changed.join(' ') + input.tests.map((t) => t.id + t.summary).join(' ')),
          tokensOut: 4 * input.tests.length,
        },
      );
    },
    async judgeCodingCompletion(input, ctx) {
      let status: CompletionStatus = 'done';
      const canContinue = input.turns < input.maxTurns;
      if (input.pendingApprovals > 0) status = 'blocked';
      else if (input.tests && input.tests.failed > 0) status = canContinue ? 'continue' : 'blocked';
      else if (input.diff.files === 0) status = canContinue ? 'continue' : 'blocked';
      return mockCall(
        'jev',
        'judge_coding_completion',
        cfg.mode,
        ctx,
        () => ({
          status,
          confidence: 0.86,
          probabilities: { [status]: 0.86 },
          reasonCodes: ['mock-coding-completion'],
        }),
        { tokensIn: estimateTokens(input.task) + 24, tokensOut: 8 },
      );
    },
    async routeTask(input, ctx) {
      // Deterministic score per candidate: success rate, minus load, plus a tier fit
      // (escalate after two failures, design preferences for UI, cheap for small).
      const tierRank = { local: 0, cheap: 1, standard: 2, frontier: 3 } as const;
      const scores = input.candidates.map((c) => {
        const rate = (c.history.done + 1) / (c.history.done + c.history.failed + 2);
        let fit = 0;
        if (c.assignee.kind === 'agent') {
          const rank = tierRank[c.assignee.tier];
          if (input.task.failures >= 2) fit = rank;
          else if (input.task.ui) fit = c.designPreferences;
          else fit = input.task.writeScope.length <= 2 ? 3 - rank : rank === 2 ? 2 : 0;
        } else fit = input.task.failures >= 2 ? 3.5 : -2;
        return { key: c.key, score: rate + fit - 0.25 * c.load };
      });
      const exp = scores.map((s) => Math.exp(s.score));
      const total = exp.reduce((a, b) => a + b, 0) || 1;
      const probabilities = Object.fromEntries(scores.map((s, i) => [s.key, exp[i]! / total]));
      const top = scores.reduce((a, b) => (b.score > a.score ? b : a), scores[0]!);
      return mockCall(
        'jev',
        'route_task',
        cfg.mode,
        ctx,
        () => ({
          choice: top.key,
          confidence: probabilities[top.key] ?? 0,
          probabilities,
          reasonCodes: ['mock-route-task'],
        }),
        { tokensIn: estimateTokens(input.task.title) + 12 * input.candidates.length, tokensOut: 4 },
      );
    },
    async judgeFlaky(input, ctx) {
      // Deterministic: a test that has passed and failed without this diff touching
      // it flips; a test the diff touches is almost certainly a real failure.
      const passes = input.history.filter((o) => o === 'pass').length;
      const flips = input.history.slice(1).filter((o, i) => o !== input.history[i]).length;
      const flaky =
        input.touchedByDiff || input.history.length < 2 || passes === 0
          ? 0.05
          : Math.min(0.95, 0.3 + flips / input.history.length);
      return mockCall(
        'jev',
        'judge_flaky',
        cfg.mode,
        ctx,
        () => ({ flakyProbability: flaky, reasonCodes: ['mock-flaky-history'] }),
        { tokensIn: estimateTokens(input.test) + input.history.length, tokensOut: 4 },
      );
    },
    async scoreLearningCandidate(input, ctx) {
      // Deterministic: support grows with the evidence; the closest entry by content
      // words is a duplicate, or a contradiction when exactly one of them negates.
      const support = input.evidence.length === 0 ? 0.2 : Math.min(0.95, 0.55 + 0.15 * (input.evidence.length - 1));
      let best: { id: string; similarity: number; negated: boolean } | undefined;
      for (const entry of input.entries) {
        const similarity = contentSimilarity(input.candidate.text, entry.text);
        if (!best || similarity > best.similarity) best = { id: entry.id, similarity, negated: negates(entry.text) };
      }
      const related = best && best.similarity >= 0.6 ? best : undefined;
      const relation = !related ? 'new' : related.negated !== negates(input.candidate.text) ? 'contradicts' : 'duplicate';
      return mockCall(
        'jev',
        'score_learning_candidate',
        cfg.mode,
        ctx,
        () => ({
          support,
          relation,
          ...(related ? { entryId: related.id } : {}),
          confidence: related ? Math.max(0.6, related.similarity) : 0.8,
          reasonCodes: ['mock-learning-candidate'],
        }),
        {
          tokensIn: estimateTokens(input.candidate.text + input.evidence.join(' ') + input.entries.map((e) => e.text).join(' ')),
          tokensOut: 8,
        },
      );
    },
    async scoreKnowledge(input, ctx) {
      // Deterministic: share of the entry's content words that appear in the task or paths.
      const state = input.task + ' ' + input.paths.join(' ').replace(/[/\\._-]+/g, ' ');
      return mockCall(
        'jev',
        'score_knowledge',
        cfg.mode,
        ctx,
        () => ({
          scores: Object.fromEntries(
            input.entries.map((entry) => {
              const content = contentWords(entry.text);
              const stateWords = contentWords(state);
              let hits = 0;
              for (const w of content) if (stateWords.has(w)) hits += 1;
              return [entry.id, Math.min(1, hits / Math.max(1, Math.min(content.size, 4)))];
            }),
          ),
          reasonCodes: ['mock-knowledge-relevance'],
        }),
        {
          tokensIn: estimateTokens(state + input.entries.map((e) => e.text).join(' ')),
          tokensOut: 4 * input.entries.length,
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
