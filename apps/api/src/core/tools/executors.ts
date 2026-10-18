import type {
  ActionPreview,
  DataLabel,
  Json,
  ProviderCallContext,
  ToolAction,
  ToolDescriptor,
} from '@htn/shared';

export interface ToolExecutionOutput {
  output: Json;
  /** Compact text only. Raw tool output never enters canonical session state or SSE. */
  summary: string;
  /** Sensitivity of the executor output; these labels can only tighten session policy. */
  dataLabels: DataLabel[];
  /** Deliberately prepared text that may be returned to a remote model when labels allow it. */
  sanitizedSummary?: string;
  /** Bounded untrusted data for the LOCAL harness. Actual model dispatch must enforce these labels. Never persisted or streamed. */
  modelOutput?: Json;
  /** Required when AgentOS policy says the result needs verification. */
  verified?: boolean;
  /** Stronger than provider acknowledgement: resulting state was independently read back. */
  evidenceVerified?: boolean;
  executionMode?: 'live' | 'mock';
  /** Private bounded preview, stored locally; never put in model output or SSE. */
  executedPreview?: ActionPreview;
}

export function modelToolText(result: ToolExecutionOutput): string {
  const summary = result.sanitizedSummary ?? result.summary;
  if (result.modelOutput !== undefined) {
    const serialized = JSON.stringify({ summary, result: result.modelOutput });
    if (Buffer.byteLength(serialized) <= 6000) return serialized;
  }
  return summary;
}

export interface ToolExecutor {
  readonly ref: string;
  /** Pure/local resolution performed before authorization. No network calls here. */
  destinationFor(input: { descriptor: ToolDescriptor; arguments: Json }): string | undefined;
  execute(action: ToolAction, ctx: ProviderCallContext): Promise<ToolExecutionOutput>;
  /** Read-only preparation; never performs the proposed mutation. */
  prepareReview?(
    action: ToolAction,
    ctx: ProviderCallContext,
  ): Promise<{ review: Json; requiresApproval: boolean }>;
  discardPrepared?(actionId: string): void;
  validateResourceVersion?(action: ToolAction, ctx: ProviderCallContext): Promise<void>;
}

/** Only throw before side effects: the broker re-reviews inside the same call. */
export class PreparedActionReviewRequiredError extends Error {
  readonly code = 'ACTION_REVIEW_REQUIRED';
  constructor(message = 'The target changed; a fresh review is required.') {
    super(message);
    this.name = 'PreparedActionReviewRequiredError';
  }
}

export interface ToolExecutorRegistry {
  resolve(executorRef: string): ToolExecutor | null;
}

export class InMemoryToolExecutorRegistry implements ToolExecutorRegistry {
  private readonly executors = new Map<string, ToolExecutor>();

  register(executor: ToolExecutor): void {
    if (!executor.ref.trim()) throw new Error('Tool executor ref is required.');
    if (this.executors.has(executor.ref)) {
      throw new Error('Tool executor already registered: ' + executor.ref);
    }
    this.executors.set(executor.ref, executor);
  }

  unregister(executorRef: string): boolean {
    return this.executors.delete(executorRef);
  }

  resolve(executorRef: string): ToolExecutor | null {
    return this.executors.get(executorRef) ?? null;
  }
}
