import type { DataLabel, Json, ToolDescriptor } from '@htn/shared';
import { BROWSER_EXECUTOR_REF } from './browser.js';
import type { ToolRegistration } from './registry.js';

type BrowserProviderId = 'localbrowser' | 'browserbase' | 'browserless';
type BrowserOperation =
  'open' | 'search' | 'read' | 'extract' | 'inspect' | 'click' | 'type' | 'submit' | 'close';

interface OperationSpec {
  operation: BrowserOperation;
  description: string;
  effect: ToolDescriptor['baselineEffect'];
  reversibility: ToolDescriptor['reversibility'];
  interactionMode: NonNullable<ToolDescriptor['interactionMode']>;
  schema: Json;
}

const objectSchema = (properties: Record<string, Json>, required: string[] = []): Json => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const sessionProperty = { type: 'string', minLength: 1 } as const;
const urlProperty = { type: 'string', minLength: 1 } as const;
const textProperty = { type: 'string', minLength: 1 } as const;

/** "Args: sessionId*, goal*, text*" -- the exact field names, required ones starred. */
function argsSummary(schema: Json): string {
  const s = schema as { properties?: Record<string, unknown>; required?: string[] };
  const names = Object.keys(s.properties ?? {});
  if (names.length === 0) return 'Args: none.';
  const required = new Set(s.required ?? []);
  return 'Args: ' + names.map((n) => n + (required.has(n) ? '*' : '')).join(', ') + ' (* required).';
}

const OPERATIONS: readonly OperationSpec[] = [
  {
    operation: 'open',
    description: 'Open a browser session, optionally at a starting URL.',
    effect: 'read',
    reversibility: 'reversible',
    interactionMode: 'resource_management',
    schema: objectSchema({ url: urlProperty }),
  },
  {
    operation: 'search',
    description: 'Search the public web and return a concise result.',
    effect: 'read',
    reversibility: 'reversible',
    interactionMode: 'research',
    schema: objectSchema({ query: textProperty, url: urlProperty }, ['query']),
  },
  {
    operation: 'read',
    description:
      'Read a page as bounded research evidence in a disposable browser session; does not continue or modify another page.',
    effect: 'read',
    reversibility: 'reversible',
    interactionMode: 'research',
    schema: objectSchema({ url: urlProperty, instruction: textProperty }, ['url', 'instruction']),
  },
  {
    operation: 'extract',
    description: 'Extract requested information from a browser page.',
    effect: 'read',
    reversibility: 'reversible',
    interactionMode: 'interactive',
    schema: objectSchema(
      { sessionId: sessionProperty, url: urlProperty, instruction: textProperty },
      ['instruction'],
    ),
  },
  {
    operation: 'inspect',
    description: 'Inspect the indexed interactive controls on a browser page.',
    effect: 'read',
    reversibility: 'reversible',
    interactionMode: 'interactive',
    schema: objectSchema({ sessionId: sessionProperty }, ['sessionId']),
  },
  {
    operation: 'click',
    description: 'Click the page control that best matches a specific goal.',
    effect: 'write',
    reversibility: 'recoverable',
    interactionMode: 'interactive',
    schema: objectSchema({ sessionId: sessionProperty, goal: textProperty }, ['sessionId', 'goal']),
  },
  {
    operation: 'type',
    description: 'Type an exact value into the page field that best matches a goal.',
    effect: 'write',
    reversibility: 'recoverable',
    interactionMode: 'interactive',
    schema: objectSchema(
      {
        sessionId: sessionProperty,
        goal: textProperty,
        text: textProperty,
      },
      ['sessionId', 'goal', 'text'],
    ),
  },
  {
    operation: 'submit',
    description: 'Click a submit control; this irreversible action always requires approval.',
    effect: 'write',
    reversibility: 'irreversible',
    interactionMode: 'interactive',
    schema: objectSchema({ sessionId: sessionProperty, goal: textProperty }, ['sessionId', 'goal']),
  },
  {
    operation: 'close',
    description: 'Close and release a browser session.',
    effect: 'read',
    reversibility: 'reversible',
    interactionMode: 'resource_management',
    schema: objectSchema({ sessionId: sessionProperty }, ['sessionId']),
  },
];

export interface BrowserDescriptorOptions {
  localAvailable: boolean;
  browserbaseAvailable: boolean;
  browserlessAvailable?: boolean;
  /** Each backend's effective mode, recorded as its descriptors' `executionMode`. */
  modes?: Partial<Record<BrowserProviderId, 'live' | 'mock'>>;
}

export function browserToolRegistrations(options: BrowserDescriptorOptions): ToolRegistration[] {
  const modes = options.modes ?? {};
  return [
    ...build(
      'localbrowser',
      ['public', 'private', 'secret', 'local_only'],
      options.localAvailable,
      modes.localbrowser,
    ),
    ...build('browserbase', ['public', 'private'], options.browserbaseAvailable, modes.browserbase),
    ...(options.browserlessAvailable === undefined
      ? []
      : build(
          'browserless',
          ['public', 'private'],
          options.browserlessAvailable,
          modes.browserless,
        )),
  ];
}

function build(
  providerId: BrowserProviderId,
  allowedDataLabels: DataLabel[],
  available: boolean,
  executionMode: 'live' | 'mock' | undefined,
): ToolRegistration[] {
  return OPERATIONS.map((spec) => {
    const id = providerId + '.' + spec.operation;
    return {
      descriptor: {
        id,
        version: '2',
        providerId,
        family: 'browser',
        interactionMode: spec.interactionMode,
        description: spec.description + ' ' + argsSummary(spec.schema),
        inputSchemaRef: 'agentos://schemas/' + id + '/2',
        transport: providerId === 'localbrowser' ? 'local' : 'http',
        baselineEffect: spec.effect,
        reversibility: spec.reversibility,
        requiredScopes: [],
        allowedDataLabels,
        availability: available ? 'available' : 'unavailable',
        executorRef: BROWSER_EXECUTOR_REF,
        ...(providerId !== 'localbrowser'
          ? { credentialRef: providerId.toUpperCase() + '_API_KEY' }
          : {}),
        ...(executionMode ? { executionMode } : {}),
      },
      wireName: providerId + '_' + spec.operation,
      inputSchema: spec.schema,
    };
  });
}

export function browserbaseDescriptorsAreSafe(registrations: readonly ToolRegistration[]): boolean {
  return registrations
    .filter((registration) => registration.descriptor.providerId === 'browserbase')
    .every(
      (registration) =>
        !registration.descriptor.allowedDataLabels.includes('secret') &&
        !registration.descriptor.allowedDataLabels.includes('local_only'),
    );
}
