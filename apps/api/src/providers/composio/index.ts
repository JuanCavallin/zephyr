import type { Capability, ToolboxAdapter, ToolboxToolDefinition } from '@htn/shared';
import type { ProviderConfig } from '../../config.js';
import { mockBase, mockCall } from '../_mock.js';
import { createLiveComposio } from './live.js';

const CAPABILITIES: readonly Capability[] = ['toolbox'];

const TOOLS: ToolboxToolDefinition[] = [
  {
    name: 'GMAIL_SEND_EMAIL',
    description: 'Send an email through a connected Gmail account',
    version: 'mock-1',
    toolkit: 'gmail',
    connectedAccountId: 'mock:gmail',
    inputSchema: {
      type: 'object',
      properties: {
        recipient_email: { type: 'string' },
        subject: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['recipient_email', 'subject', 'body'],
      additionalProperties: false,
    },
    requiredScopes: ['https://www.googleapis.com/auth/gmail.send'],
  },
  {
    name: 'forms.submit',
    description: 'Mock submit a correction request; no external form is changed',
    version: 'mock-1',
    toolkit: 'forms',
    connectedAccountId: 'mock:forms',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'sheets.append',
    description: 'Mock append a ledger row; no external spreadsheet is changed',
    version: 'mock-1',
    toolkit: 'sheets',
    connectedAccountId: 'mock:sheets',
    inputSchema: {
      type: 'object',
      properties: { row: { type: 'string' } },
      required: ['row'],
      additionalProperties: false,
    },
  },
  {
    name: 'calendar.create',
    description: 'Mock create a calendar event; no external calendar is changed',
    version: 'mock-1',
    toolkit: 'calendar',
    connectedAccountId: 'mock:calendar',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'MICROSOFT_WORD_UPDATE_DOCUMENT',
    description: 'Mock revise a Word paragraph; no Microsoft resource is changed',
    version: 'mock-1',
    toolkit: 'microsoft_word',
    connectedAccountId: 'mock:office',
    inputSchema: {
      type: 'object',
      properties: {
        document_id: { type: 'string' },
        content: { type: 'string', maxLength: 24000 },
        expectedVersion: { type: 'string' },
      },
      required: ['document_id', 'content', 'expectedVersion'],
      additionalProperties: false,
    },
  },
  {
    name: 'MICROSOFT_EXCEL_UPDATE_RANGE',
    description: 'Mock revise Excel cells; no Microsoft resource is changed',
    version: 'mock-1',
    toolkit: 'microsoft_excel',
    connectedAccountId: 'mock:office',
    inputSchema: {
      type: 'object',
      properties: {
        spreadsheet_id: { type: 'string' },
        range: { type: 'string' },
        values: {
          type: 'array',
          items: {
            type: 'array',
            items: {
              anyOf: [
                { type: 'string' },
                { type: 'number' },
                { type: 'boolean' },
                { type: 'null' },
              ],
            },
          },
        },
        expectedVersion: { type: 'string' },
      },
      required: ['spreadsheet_id', 'range', 'values', 'expectedVersion'],
      additionalProperties: false,
    },
  },
];

export function create(cfg: ProviderConfig): ToolboxAdapter {
  if (cfg.mode === 'live') return createLiveComposio(cfg);
  return createMock(cfg);
}

function createMock(cfg: ProviderConfig): ToolboxAdapter {
  const base = mockBase('composio', CAPABILITIES, cfg.mode);
  return {
    ...base,
    async listTools(ctx) {
      return mockCall('composio', 'listTools', cfg.mode, ctx, () => TOOLS);
    },
    async searchTools(input, ctx) {
      return mockCall('composio', 'searchTools', cfg.mode, ctx, () => {
        const terms = input.query
          .toLowerCase()
          .split(/\s+/)
          .filter((term) => term.length > 2);
        const toolkits = new Set((input.toolkits ?? []).map((toolkit) => toolkit.toLowerCase()));
        return TOOLS.filter((tool) => {
          const toolkit = 'toolkit' in tool && typeof tool.toolkit === 'string' ? tool.toolkit : '';
          if (toolkits.size > 0 && !toolkits.has(toolkit)) return false;
          const text = (tool.name + ' ' + tool.description).toLowerCase();
          return terms.length === 0 || terms.some((term) => text.includes(term));
        }).slice(0, input.limit ?? 24);
      });
    },
    async connectUrl(app, ctx) {
      return mockCall('composio', 'connectUrl', cfg.mode, ctx, () => ({
        url: 'https://example.invalid/oauth/' + encodeURIComponent(app),
      }));
    },
    async callTool(input, ctx) {
      return mockCall('composio', 'callTool', cfg.mode, ctx, () => ({
        tool: input.name,
        status: 'mock_completed',
        successful: true,
        receivedArgs: Object.keys(input.args),
      }));
    },
  };
}
