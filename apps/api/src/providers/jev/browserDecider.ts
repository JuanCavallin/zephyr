/**
 * The Jev browser decision — ONE evaluation request per browser step.
 *
 * ============================================================================
 * WE REACH JEV THROUGH THE VERCEL AI GATEWAY. There is exactly one route, and
 * this is it:
 *
 *     createGateway({ apiKey: AI_GATEWAY_API_KEY })
 *       .evaluationModel('typesafe-ai/jev')
 *     -> experimental_evaluate({ model, state, questions })
 *
 * NOT `@typesafe-ai/sdk`, and NOT the OpenAI-compatible chat-completions
 * endpoint. Person 2's `providers/jev/live.ts` established this route; this
 * file is the browser's caller on the same road, and it deliberately reuses
 * Person 2's `config.providers.jev` credential slot rather than inventing a
 * second one.
 *
 * WHAT JEV IS: a decision model. It answers TYPED QUESTIONS AGAINST STATE and
 * returns a choice or a probability, each with a distribution. It cannot
 * generate text. There is no prompt in this file and there must never be one —
 * `criteria` is the interface.
 *
 * SPECULATIVE FAN-OUT, the whole trick:
 *
 *     one request ─┬─ operation         CLICK | TYPE_TEXT | SELECT | SCROLL...
 *                  ├─ click_target      choice over click-eligible indices
 *                  ├─ type_text_target  choice over editable indices
 *                  └─ select_target     choice over dropdown indices
 *
 * We ask for the operation AND every target it might need, then discard the
 * heads that do not match the chosen operation. Two decisions, one round trip.
 * Person 2's `route()` uses the same shape — privacy + intelligence + one
 * boolean per tool, all batched — so this is the house pattern, not a local
 * invention.
 *
 * The trade is deliberate and NOT free: you pay for the discarded heads. It is
 * right here because latency on stage is worth more than fractions of a cent.
 * Narrow `allowedOperations` if a run ever needs the cost back.
 *
 * TIMEOUT: a browser step is interactive. `BROWSER_DECISION_TIMEOUT_MS`
 * (2000ms) bounds the call via an AbortSignal, and on timeout the caller's
 * deterministic fallback takes the step rather than stalling the demo.
 * ============================================================================
 */

import { createGateway, experimental_evaluate as evaluate } from 'ai';
import type { BrowserOperation, ElementRow, ElementTable } from '@htn/shared';
import type {
  BrowserDecider,
  BrowserDecision,
  BrowserDecisionRequest,
} from '../../core/tools/browserDecision.js';
import { eligibleRows, toCriteria, toState } from '../../core/tools/elementTable.js';
import { config } from '../../config.js';
import { credentials } from '../../services/credentials.js';
import { createDeterministicDecider } from '../../core/tools/browserDecision.js';
import { jevCostCents } from './live.js';

/** Same model id and gateway root Person 2's adapter uses. Keep them in step. */
const MODEL_ID = 'typesafe-ai/jev';
const DEFAULT_BASE_URL = 'https://ai-gateway.vercel.sh/v4/ai';

/** A `choice` answer's confidence is the probability mass on the chosen key. */
function probabilityForChoice(
  choice: string,
  probabilities: Record<string, number> | undefined,
): number {
  if (!probabilities) return 0;
  return probabilities[choice] ?? 0;
}

/** One browser step's Jev request, before anything is sent. */
export interface BrowserQuestionPlan {
  clickRows: ElementRow[];
  typeRows: ElementRow[];
  selectRows: ElementRow[];
  /** Every operation this page and step allow. Empty means nothing is possible. */
  viableOperations: BrowserOperation[];
  /** The only viable operation, when there is exactly one; it is then not asked. */
  presetOperation?: BrowserOperation;
  /** The `questions` for evaluate(). Empty when nothing is left to ask. */
  questions: Record<string, unknown>;
}

/**
 * The questions one browser step asks Jev. Pure, and exported so the browser
 * benchmark measures exactly the request this decider sends.
 */
export function planBrowserQuestions(
  table: ElementTable,
  allowedOperations?: readonly BrowserOperation[],
): BrowserQuestionPlan {
  const allowed = (op: BrowserOperation): boolean =>
    !allowedOperations || allowedOperations.includes(op);

  /* -- The operation head. Only offer what this page can actually do. ------ */
  const clickRows = allowed('CLICK') ? eligibleRows(table, 'CLICK') : [];
  const typeRows = allowed('TYPE_TEXT') ? eligibleRows(table, 'TYPE_TEXT') : [];
  const selectRows = allowed('SELECT') ? eligibleRows(table, 'SELECT') : [];

  const operationCriteria: Record<string, string> = {};
  if (clickRows.length > 0) operationCriteria.CLICK = 'Click one of the listed elements.';
  if (typeRows.length > 0) {
    // The label says so on purpose: this is the rule people get wrong.
    operationCriteria.TYPE_TEXT =
      'Type into one of the listed fields. A separate model supplies the text.';
  }
  if (selectRows.length > 0) operationCriteria.SELECT = 'Choose an option in a dropdown.';
  if (allowed('SCROLL_DOWN')) operationCriteria.SCROLL_DOWN = 'Scroll down to reveal more.';
  if (allowed('SCROLL_UP')) operationCriteria.SCROLL_UP = 'Scroll back up.';
  if (allowed('WAIT')) operationCriteria.WAIT = 'Wait for the page to settle.';
  if (allowed('DONE')) operationCriteria.DONE = 'The goal is already satisfied on this page.';
  if (allowed('BLOCKED')) {
    operationCriteria.BLOCKED = 'The goal cannot be progressed from this page.';
  }

  const viableOperations = Object.keys(operationCriteria) as BrowserOperation[];

  /**
   * ASK THE OPERATION ONLY WHEN IT IS GENUINELY IN DOUBT.
   *
   * A choice with one option is not a question — the SDK rejects it, and
   * asking it would burn a round trip to be told what we already know. But
   * "there is only one possible operation" does NOT mean there is nothing to
   * decide: we still need the TARGET.
   *
   * Getting this wrong is what made a constrained call (`allowedOperations:
   * ['TYPE_TEXT']`) return BLOCKED without ever contacting Jev — the caller
   * narrowing the operation accidentally suppressed the whole decision.
   */
  const askOperation = viableOperations.length > 1;
  const presetOperation = askOperation ? undefined : viableOperations[0];

  /* -- Speculative target heads, all in the SAME request. ------------------ */
  // `questions` is intentionally loosely typed: the heads are built
  // conditionally, so the key set is not statically known.
  const questions: Record<string, unknown> = {};

  if (askOperation) {
    questions.operation = {
      type: 'choice',
      instructions: 'What is the single best next action for the goal?',
      criteria: operationCriteria,
    };
  }

  // When the operation is already known, only its own head is worth asking —
  // the speculative heads exist to cover an operation we have not chosen yet.
  const wants = (op: BrowserOperation): boolean => askOperation || presetOperation === op;

  const clickCriteria = toCriteria(clickRows);
  if (wants('CLICK') && clickCriteria && Object.keys(clickCriteria).length > 1) {
    questions.click_target = {
      type: 'choice',
      instructions: 'Which element should be clicked?',
      criteria: clickCriteria,
    };
  }
  const typeCriteria = toCriteria(typeRows);
  if (wants('TYPE_TEXT') && typeCriteria && Object.keys(typeCriteria).length > 1) {
    questions.type_text_target = {
      type: 'choice',
      instructions: 'Which field should be typed into?',
      criteria: typeCriteria,
    };
  }
  const selectCriteria = toCriteria(selectRows);
  if (wants('SELECT') && selectCriteria && Object.keys(selectCriteria).length > 1) {
    questions.select_target = {
      type: 'choice',
      instructions: 'Which dropdown should be used?',
      criteria: selectCriteria,
    };
  }

  return {
    clickRows,
    typeRows,
    selectRows,
    viableOperations,
    ...(presetOperation ? { presetOperation } : {}),
    questions,
  };
}

export interface JevBrowserDeciderOptions {
  /** Bound for one decision. Default: BROWSER_DECISION_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Default 1. A browser step cannot afford the SDK's usual retry budget. */
  maxRetries?: number;
}

/**
 * Build the Jev browser decider, or `null` when Jev cannot be reached.
 *
 * Returning `null` rather than a throwing stub is deliberate: the caller then
 * uses the deterministic decider AND labels the run's decision source
 * truthfully, instead of presenting a string match as a model decision.
 */
export function createJevBrowserDecider(
  options: JevBrowserDeciderOptions = {},
): BrowserDecider | null {
  const cfg = config.providers.jev;
  if (cfg.mode !== 'live' || (credentials.source === 'operator' && !cfg.apiKey)) return null;
  const deterministic = createDeterministicDecider();

  const timeoutMs = options.timeoutMs ?? config.browser.decisionTimeoutMs;
  const maxRetries = credentials.source === 'user' ? 0 : (options.maxRetries ?? 1);

  return async (request: BrowserDecisionRequest): Promise<BrowserDecision> => {
    const { table, goal, allowedOperations, signal } = request;
    if (request.localOnly) return deterministic(request);
    // Missing user Jev keys use the bounded, truthfully labeled deterministic matcher.
    // Without a trusted run binding, do not spend any user's credential.
    if (credentials.source === 'user' && !request.credentialRunId) return deterministic(request);
    const credential = await credentials.resolve({
      runId: request.credentialRunId ?? 'browser-operator',
      providerId: 'jev',
      purpose: 'decision',
    });
    if (!credential) return deterministic(request);
    const model = createGateway({
      apiKey: credential.secret,
      baseURL: cfg.baseUrl ?? DEFAULT_BASE_URL,
    }).evaluationModel(MODEL_ID);

    const { clickRows, typeRows, selectRows, viableOperations, presetOperation, questions } =
      planBrowserQuestions(table, allowedOperations);

    // Nothing at all is possible here. Only now is BLOCKED the right answer.
    if (viableOperations.length === 0) {
      return {
        operation: 'BLOCKED',
        confidence: 0,
        source: 'jev',
        rationale: 'No operation was possible on this page, so Jev was not asked.',
      };
    }

    // Operation known AND only one eligible target: there is nothing left to
    // ask. Answer locally rather than making a pointless round trip.
    if (Object.keys(questions).length === 0) {
      const soleRow =
        presetOperation === 'CLICK'
          ? clickRows[0]
          : presetOperation === 'TYPE_TEXT'
            ? typeRows[0]
            : presetOperation === 'SELECT'
              ? selectRows[0]
              : undefined;
      return {
        operation: presetOperation ?? 'BLOCKED',
        ...(soleRow ? { index: soleRow.index } : {}),
        confidence: 1,
        cacheable: Boolean(soleRow),
        source: 'jev',
        rationale:
          'Only one ' +
          presetOperation +
          ' target existed' +
          (soleRow ? ' ("' + soleRow.label + '")' : '') +
          ', so no question was needed.',
      };
    }

    // Bound the call ourselves and chain the caller's signal, so Person 1's
    // cancel endpoint still aborts a pending decision.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    const startedAt = Date.now();
    try {
      const result = await evaluate({
        model,
        // Cast at the vendor boundary: the SDK wants an indexable JSON object,
        // and `BrowserState` is a named shape on purpose so the rest of the
        // codebase cannot put arbitrary keys in it.
        state: toState(table, goal) as unknown as Parameters<typeof evaluate>[0]['state'],
        questions: questions as Parameters<typeof evaluate>[0]['questions'],
        maxRetries,
        abortSignal: controller.signal,
      });

      /* -- Use the matching head; discard the rest. ------------------------ */
      // When the operation was never in doubt it was not asked, so take the
      // preset rather than reading an answer that does not exist.
      const opAnswer = presetOperation ? undefined : result.answers.operation;
      const operation = (presetOperation ??
        (opAnswer?.type === 'choice' ? opAnswer.choice : 'BLOCKED')) as BrowserOperation;

      const targetKey =
        operation === 'CLICK'
          ? 'click_target'
          : operation === 'TYPE_TEXT'
            ? 'type_text_target'
            : operation === 'SELECT'
              ? 'select_target'
              : undefined;

      const targetAnswer = targetKey ? result.answers[targetKey] : undefined;

      // A single-eligible-row head is never asked (a one-option choice is not
      // a question), so fall back to that row rather than failing the step.
      const soleRow =
        operation === 'CLICK'
          ? clickRows[0]
          : operation === 'TYPE_TEXT'
            ? typeRows[0]
            : operation === 'SELECT'
              ? selectRows[0]
              : undefined;

      const chosen = targetAnswer?.type === 'choice' ? targetAnswer.choice : undefined;
      const index = chosen !== undefined ? Number(chosen) : soleRow?.index;

      // A preset operation is certain by construction — it was the only one
      // possible — so it must not drag the combined confidence to zero.
      const operationConfidence = presetOperation
        ? 1
        : opAnswer?.type === 'choice'
          ? probabilityForChoice(opAnswer.choice, opAnswer.probabilities)
          : 0;
      const targetConfidence =
        targetAnswer?.type === 'choice'
          ? probabilityForChoice(targetAnswer.choice, targetAnswer.probabilities)
          : 1;

      // The WEAKER of the two decisions. Reporting the operation's confidence
      // alone would hide a coin flip between two buttons, which is exactly the
      // case the escalation rule exists for.
      const confidence = Math.min(operationConfidence, targetConfidence);

      const probabilities =
        targetAnswer?.type === 'choice' ? targetAnswer.probabilities : undefined;

      return {
        operation,
        ...(index !== undefined && Number.isFinite(index) ? { index } : {}),
        confidence,
        ...(probabilities ? { probabilities } : {}),
        source: 'jev',
        usage: {
          destination: (cfg.baseUrl ?? DEFAULT_BASE_URL) + '/evaluation-model',
          model: MODEL_ID,
          latencyMs: Date.now() - startedAt,
          tokensIn: result.usage?.inputTokens,
          tokensOut: result.usage?.outputTokens,
          estimatedCostCents: jevCostCents(result.usage, result.providerMetadata),
        },
        rationale:
          'Jev chose ' +
          operation +
          (index !== undefined ? ' on [' + index + ']' : '') +
          ' (p=' +
          confidence.toFixed(2) +
          ').',
      };
    } catch {
      throw new Error('Jev browser evaluation failed; deterministic matching will be used.');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
