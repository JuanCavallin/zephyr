/**
 * The benchmark task suite: graphs with ground-truth assertions, so every arm
 * (graph, B0, B1) is graded on the same answers.
 *
 * Rules every task here follows, so the suite runs unattended:
 *   - No step needs approval. Reads, typing and clicks on non-consequential
 *     controls only; nothing submits, sends, buys or writes to a real account.
 *   - Sites are stable sandboxes built for automation (books/quotes.toscrape.com,
 *     httpbin.org) or data the graph carries itself. No site that blocks bots.
 *   - Expected values were read off the live pages on 2026-10-17. If a site
 *     changes, the task fails loudly on every arm rather than drifting.
 *   - Outcome answers come from judge nodes, whose options are handed to the
 *     baselines as the answer fields (baselineTask.ts); the expected value never is.
 *
 * Each graph is written the way the product intends: deterministic tool nodes
 * for fetching (zero model tokens) and Jev only for the choices. That is the
 * claim under test, so the graphs are hand-authored rather than synthesised;
 * authoring time is not part of any measurement.
 */

import type { GraphAssertion } from '@htn/shared';

export interface SuiteTask {
  /** Stable key; the graph is found by its name, `Bench: <name>`. */
  key: string;
  name: string;
  /** The task statement. It is also the baselines' prompt. */
  description: string;
  nodes: unknown[];
  edges: { id: string; source: string; target: string; sourceHandle?: string }[];
  assertions: GraphAssertion[];
  variables: Record<string, unknown>;
}

const BOOKS = 'https://books.toscrape.com/';
const BOOK_PAGES = {
  attic: BOOKS + 'catalogue/a-light-in-the-attic_1000/index.html',
  velvet: BOOKS + 'catalogue/tipping-the-velvet_999/index.html',
  soumission: BOOKS + 'catalogue/soumission_998/index.html',
};
const THREE_BOOKS = ['A Light in the Attic', 'Tipping the Velvet', 'Soumission'];

function at(index: number): { x: number; y: number } {
  return { x: 260 * (index % 4), y: 160 * Math.floor(index / 4) };
}

function tool(id: string, label: string, toolId: string, args: Record<string, unknown>) {
  return { id, label, type: 'tool', config: { tool: toolId, args } };
}

function judge(id: string, label: string, question: string, options: string[], evidence: string) {
  return { id, label, type: 'judge', config: { question, options, evidence } };
}

function chain(...ids: string[]): SuiteTask['edges'] {
  return ids.slice(1).map((target, index) => ({
    id: 'e_' + ids[index] + '_' + target,
    source: ids[index]!,
    target,
  }));
}

function placed(nodes: Record<string, unknown>[]): unknown[] {
  return nodes.map((node, index) => ({ ...node, position: at(index) }));
}

function outcome(id: string, node: string, expected: string, description: string): GraphAssertion {
  return { id, description, scope: 'outcome', path: 'nodes.' + node + '.choice', expected };
}

/** Multi-page extraction, in the shape of "open the top stories and read each one". */
const bookstore: SuiteTask = {
  key: 'bookstore',
  name: 'Bench: bookstore catalogue',
  description:
    'Go to ' +
    BOOKS +
    ' and take the first three books on the front page (A Light in the Attic, Tipping the ' +
    'Velvet, Soumission). Open each book page and read its price, its category and the first ' +
    'paragraph of its description. Report which of the three is the most expensive, which one ' +
    'has a description written in French, and which one is in the Poetry category.',
  nodes: placed([
    tool('read_home', 'Read the front page', 'localbrowser.read', {
      url: BOOKS,
      instruction: 'The first three books on the front page and their prices',
    }),
    tool('read_attic', 'Read A Light in the Attic', 'localbrowser.read', {
      url: BOOK_PAGES.attic,
      instruction: 'Price, category and description',
    }),
    tool('read_velvet', 'Read Tipping the Velvet', 'localbrowser.read', {
      url: BOOK_PAGES.velvet,
      instruction: 'Price, category and description',
    }),
    tool('read_soumission', 'Read Soumission', 'localbrowser.read', {
      url: BOOK_PAGES.soumission,
      instruction: 'Price, category and description',
    }),
    judge(
      'priciest',
      'Most expensive',
      'Which of the three books is the most expensive?',
      THREE_BOOKS,
      'Front page:\n{{read_home.result.text}}',
    ),
    judge(
      'french',
      'French description',
      'Which of the three books has a description written in French?',
      THREE_BOOKS,
      'A Light in the Attic:\n{{read_attic.result.text}}\n\nTipping the Velvet:\n' +
        '{{read_velvet.result.text}}\n\nSoumission:\n{{read_soumission.result.text}}',
    ),
    judge(
      'poetry',
      'Poetry category',
      'Which of the three books is in the Poetry category?',
      THREE_BOOKS,
      'A Light in the Attic:\n{{read_attic.result.text}}\n\nTipping the Velvet:\n' +
        '{{read_velvet.result.text}}\n\nSoumission:\n{{read_soumission.result.text}}',
    ),
  ]),
  edges: [
    ...chain('read_home', 'priciest'),
    { id: 'e_attic_french', source: 'read_attic', target: 'french' },
    { id: 'e_velvet_french', source: 'read_velvet', target: 'french' },
    { id: 'e_soumission_french', source: 'read_soumission', target: 'french' },
    { id: 'e_attic_poetry', source: 'read_attic', target: 'poetry' },
    { id: 'e_velvet_poetry', source: 'read_velvet', target: 'poetry' },
    { id: 'e_soumission_poetry', source: 'read_soumission', target: 'poetry' },
  ],
  assertions: [
    outcome('a_priciest', 'priciest', 'Tipping the Velvet', 'Tipping the Velvet costs £53.74.'),
    outcome('a_french', 'french', 'Soumission', 'Soumission is described in French.'),
    outcome('a_poetry', 'poetry', 'A Light in the Attic', 'A Light in the Attic is Poetry.'),
  ],
  variables: {},
};

/** Pagination: a Jev-picked click that later runs replay from target memory. */
const quotes: SuiteTask = {
  key: 'quotes',
  name: 'Bench: quotes pagination',
  description:
    'Go to https://quotes.toscrape.com/. Report which author has the most quotes on the first ' +
    'page, then click the Next link to go to page 2 and report who wrote the first quote there.',
  nodes: placed([
    tool('open_quotes', 'Open page 1', 'localbrowser.open', {
      url: 'https://quotes.toscrape.com/',
    }),
    tool('read_page1', 'Read page 1', 'localbrowser.extract', {
      sessionId: '{{open_quotes.result.sessionId}}',
      instruction: 'Every quote and its author on this page',
    }),
    tool('next_page', 'Go to page 2', 'localbrowser.click', {
      sessionId: '{{open_quotes.result.sessionId}}',
      goal: 'The "Next" pagination link to page 2',
    }),
    tool('read_page2', 'Read page 2', 'localbrowser.extract', {
      sessionId: '{{open_quotes.result.sessionId}}',
      instruction: 'Every quote and its author on this page',
    }),
    judge(
      'top_author',
      'Most quoted on page 1',
      'Which author has the most quotes on the first page?',
      ['Albert Einstein', 'Jane Austen', 'Marilyn Monroe', 'J.K. Rowling'],
      'Page 1:\n{{read_page1.result.text}}',
    ),
    judge(
      'page2_first',
      'First quote on page 2',
      'Who wrote the first quote on page 2?',
      ['Marilyn Monroe', 'J.K. Rowling', 'Albert Einstein', 'Jane Austen'],
      'Page 2:\n{{read_page2.result.text}}',
    ),
  ]),
  edges: [
    ...chain('open_quotes', 'read_page1', 'next_page', 'read_page2', 'page2_first'),
    { id: 'e_page1_top', source: 'read_page1', target: 'top_author' },
  ],
  assertions: [
    outcome(
      'a_top_author',
      'top_author',
      'Albert Einstein',
      'Einstein has three quotes on page 1.',
    ),
    outcome('a_page2_first', 'page2_first', 'Marilyn Monroe', 'Page 2 opens with Marilyn Monroe.'),
  ],
  variables: {},
};

/** Form fill without submitting: typed values and a click, all Jev-picked targets. */
const pizzaForm: SuiteTask = {
  key: 'pizza_form',
  name: 'Bench: pizza order form (no submit)',
  description:
    'Go to https://httpbin.org/forms/post, fill in the customer name "Test User", pick a medium ' +
    'pizza size, and type "ring the bell" in the delivery instructions, but do not submit it. ' +
    'Then report what the customer name and delivery instructions fields contain.',
  nodes: placed([
    tool('open_form', 'Open the form', 'localbrowser.open', {
      url: 'https://httpbin.org/forms/post',
    }),
    tool('type_name', 'Type the customer name', 'localbrowser.type', {
      sessionId: '{{open_form.result.sessionId}}',
      goal: 'Customer name field',
      text: 'Test User',
    }),
    tool('pick_medium', 'Pick a medium pizza', 'localbrowser.click', {
      sessionId: '{{open_form.result.sessionId}}',
      goal: 'The Medium pizza size option',
    }),
    tool('type_notes', 'Type delivery instructions', 'localbrowser.type', {
      sessionId: '{{open_form.result.sessionId}}',
      goal: 'Delivery instructions field',
      text: 'ring the bell',
    }),
    tool('inspect_form', 'Read the form back', 'localbrowser.inspect', {
      sessionId: '{{open_form.result.sessionId}}',
    }),
    judge(
      'fields',
      'Form contents',
      'What do the customer name and delivery instructions fields contain now?',
      [
        'Test User / ring the bell',
        'Test User / (empty)',
        '(empty) / ring the bell',
        '(empty) / (empty)',
      ],
      'Form controls with their current values:\n{{inspect_form.result.rows}}',
    ),
  ]),
  edges: chain('open_form', 'type_name', 'pick_medium', 'type_notes', 'inspect_form', 'fields'),
  assertions: [
    outcome(
      'a_fields',
      'fields',
      'Test User / ring the bell',
      'Both fields hold the typed values.',
    ),
  ],
  variables: {},
};

/** The middle rung: Jev picks one tool (frozen after the first run), then a typed answer. */
const orderDataset: SuiteTask = {
  key: 'order_dataset',
  name: 'Bench: order dataset totals',
  description:
    'Read the synthetic public order dataset public-order-v1 (prices in CAD integer cents). ' +
    'Report the order total including shipping, and which SKU has the larger line total ' +
    '(quantity times unit price).',
  nodes: placed([
    {
      id: 'load_orders',
      label: 'Load the order dataset',
      type: 'dispatch',
      config: {
        goal: 'Read the synthetic public order dataset public-order-v1.',
        candidateTools: ['agentos.benchmark_fixture', 'agentos.runtime_status'],
      },
    },
    judge(
      'total',
      'Order total',
      'What is the order total including shipping? Each line is quantity times unitPriceCents; ' +
        'add shippingCents. 100 cents is 1 CAD.',
      ['CAD 41.50', 'CAD 46.50', 'CAD 51.50', 'CAD 56.50'],
      'Order dataset:\n{{load_orders.result}}',
    ),
    judge(
      'larger_line',
      'Larger line total',
      'Which SKU has the larger line total (quantity times unitPriceCents)?',
      ['A', 'B'],
      'Order dataset:\n{{load_orders.result}}',
    ),
  ]),
  edges: [
    { id: 'e_load_total', source: 'load_orders', target: 'total' },
    { id: 'e_load_line', source: 'load_orders', target: 'larger_line' },
  ],
  assertions: [
    outcome('a_total', 'total', 'CAD 51.50', '2 x 12.00 + 3 x 7.50 + 5.00 shipping.'),
    outcome('a_larger_line', 'larger_line', 'A', 'A is 24.00, B is 22.50.'),
    {
      id: 'p_dispatch',
      description: 'Jev dispatched to the dataset tool.',
      scope: 'pipeline',
      path: 'nodes.load_orders.tool',
      expected: 'agentos.benchmark_fixture',
    },
  ],
  variables: {},
};

const CASE_NOTE =
  'Applicant Avery Chen, SIN 046 454 286, phone 519-555-0142, email avery.chen@example.edu, ' +
  'disputes three line items on invoice 8812.';

/** Privacy: PII is pinned locally, and only the redacted note reaches Jev. */
const caseNote: SuiteTask = {
  key: 'case_note',
  name: 'Bench: case note triage',
  description:
    'Here is a case note: "' +
    CASE_NOTE +
    '" Summarise it for a reviewer: which invoice is disputed, and how many line items.',
  nodes: placed([
    {
      id: 'note',
      label: 'Case note',
      type: 'fetch',
      config: { source: 'inline://case-note', text: CASE_NOTE },
    },
    {
      id: 'redact_note',
      label: 'Pin personal data locally',
      type: 'redact',
      config: { field: 'case_note', text: '{{note.text}}' },
    },
    judge(
      'invoice',
      'Disputed invoice',
      'Which invoice does the applicant dispute?',
      ['4417', '8812', '2286'],
      '{{redact_note.redacted}}',
    ),
    judge(
      'line_items',
      'Disputed line items',
      'How many line items does the applicant dispute?',
      ['one', 'two', 'three'],
      '{{redact_note.redacted}}',
    ),
  ]),
  edges: [
    ...chain('note', 'redact_note', 'invoice'),
    { id: 'e_redact_items', source: 'redact_note', target: 'line_items' },
  ],
  assertions: [
    outcome('a_invoice', 'invoice', '8812', 'Invoice 8812 is disputed.'),
    outcome('a_line_items', 'line_items', 'three', 'Three line items are disputed.'),
    {
      id: 'p_pii',
      description: 'SIN, phone and email were pinned locally rather than sent.',
      scope: 'pipeline',
      path: 'nodes.redact_note.spans',
      expected: '3',
    },
  ],
  variables: {},
};

export const BENCHMARK_SUITE: readonly SuiteTask[] = [
  bookstore,
  quotes,
  pizzaForm,
  orderDataset,
  caseNote,
];
