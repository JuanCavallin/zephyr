import type { Capability, TextModelAdapter } from '@htn/shared';
import {config,type ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveAnthropic } from './live.js';
import { estimateCostCents } from './pricing.js';
import { mockGraphFor } from './mockGraphs.js';
import {
  DECOMPOSE_POLICY_RULE,
  heuristicPlan,
  requestFromPrompt,
} from '../../core/coordination/decompose.js';
import { heuristicDraft, LEARNING_DRAFT_POLICY_RULE } from '../../core/learning/draft.js';
import { credentials } from '../../services/credentials.js';

const CAPABILITIES: readonly Capability[] = ['text.model'];

export function create(cfg: ProviderConfig): TextModelAdapter {
  if (cfg.mode === 'live') return createLiveAnthropic(cfg, credentials);
  return createMock(cfg);
}

function createMock(cfg: ProviderConfig): TextModelAdapter {
  const base = mockBase('anthropic', CAPABILITIES, cfg.mode);
  return {
    ...base,
    async complete(input, ctx) {
      // ONE CALLER GETS A REAL DOCUMENT, not prose.
      //
      // Most mock completions are summaries, and returning a graph document to
      // those would be actively wrong. But graph synthesis parses the reply as
      // JSON, so prose fails it -- and that makes the app's front door (the
      // workspace composer) unusable with no API keys, which is exactly what
      // MOCK_ALL demo insurance is supposed to protect. Deterministic, so a
      // rehearsed demo is identical every time. See mockGraphs.ts.
      if (input.json && ctx.policyRule === 'graph-synthesis') {
        const graph = mockGraphFor(input.prompt, config.browser.backend);
        const jsonIn = Math.ceil((input.prompt.length + (input.system?.length ?? 0)) / 4);
        const jsonOut = Math.ceil(graph.length / 4);
        return mockCall(
          'anthropic',
          'complete',
          cfg.mode,
          ctx,
          () => ({ text: graph, tokensIn: jsonIn, tokensOut: jsonOut }),
          {
            tokensIn: jsonIn,
            tokensOut: jsonOut,
            estimatedCostCents: estimateCostCents(input.tier ?? 'standard', jsonIn, jsonOut),
          },
        );
      }

      // Task decomposition parses the reply too; the same deterministic-plan
      // argument as graph synthesis applies (see core/coordination/decompose.ts).
      if (input.json && ctx.policyRule === DECOMPOSE_POLICY_RULE) {
        const plan = JSON.stringify(heuristicPlan(requestFromPrompt(input.prompt)));
        const planIn = Math.ceil((input.prompt.length + (input.system?.length ?? 0)) / 4);
        const planOut = Math.ceil(plan.length / 4);
        return mockCall(
          'anthropic',
          'complete',
          cfg.mode,
          ctx,
          () => ({ text: plan, tokensIn: planIn, tokensOut: planOut }),
          {
            tokensIn: planIn,
            tokensOut: planOut,
            estimatedCostCents: estimateCostCents(input.tier ?? 'standard', planIn, planOut),
          },
        );
      }

      // The learning drafter parses the reply too (core/learning/draft.ts).
      if (input.json && ctx.policyRule === LEARNING_DRAFT_POLICY_RULE) {
        const draft = JSON.stringify(heuristicDraft(input.prompt));
        const draftIn = Math.ceil((input.prompt.length + (input.system?.length ?? 0)) / 4);
        const draftOut = Math.ceil(draft.length / 4);
        return mockCall(
          'anthropic',
          'complete',
          cfg.mode,
          ctx,
          () => ({ text: draft, tokensIn: draftIn, tokensOut: draftOut }),
          {
            tokensIn: draftIn,
            tokensOut: draftOut,
            estimatedCostCents: estimateCostCents(input.tier ?? 'standard', draftIn, draftOut),
          },
        );
      }

      const placeholders = (ctx.redactions ?? []).length;
      // Echoing the placeholder count proves, in the demo, that what reached the
      // "cloud" model was the redacted text and not the values.
      const text =
        'Mock summary (tier=' +
        (input.tier ?? 'standard') +
        ') of a ' +
        input.prompt.length +
        '-char prompt containing ' +
        placeholders +
        ' redacted span(s). Three line items require verification.';

      // Computed out here rather than inside `produce`, so the same numbers can
      // go on BOTH the data and the meta. meta is the half the egress ledger
      // reads; returning them only in data records nothing.
      const tokensIn = Math.ceil(input.prompt.length / 4);
      const tokensOut = Math.ceil(text.length / 4);

      return mockCall(
        'anthropic',
        'complete',
        cfg.mode,
        ctx,
        () => ({ text, tokensIn, tokensOut }),
        {
          tokensIn,
          tokensOut,
          estimatedCostCents: estimateCostCents(input.tier ?? 'standard', tokensIn, tokensOut),
        },
      );
    },
  };
}
