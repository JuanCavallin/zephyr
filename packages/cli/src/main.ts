/**
 * `zephyr` command line. Every command but `summary` and `templates` talks to a running
 * Zephyr over its HTTP API (default http://127.0.0.1:8787, override with --api or
 * ZEPHYR_API).
 */

import { parseArgs } from 'node:util';
import { TASK_TEMPLATE_IDS, isTaskTemplateId, taskTemplate, type TaskTemplateId } from '@htn/shared';

const TEMPLATES = TASK_TEMPLATE_IDS.map(taskTemplate);
import { ApiClient, ApiError, DEFAULT_API } from './api.js';
import { installHook, uninstallHook } from './hook.js';
import { formatBoard, runTask } from './run.js';
import { evidencePath, formatSummary, summaryFromFile } from './summary.js';
import { DEFAULT_WEB, repoRoot, up } from './up.js';

export const HELP = `zephyr — run coding agents under Zephyr

Usage
  zephyr up [--no-open] [--check]          detect harnesses and keys, start Zephyr, open the board
  zephyr run "<task>" [options]            plan a board for the task and start it
      --template <id>                      preset policy, budget and concurrency (see: zephyr templates)
      --concurrency <1-8>                  override the template's concurrency
      --plan                               create the board but do not start it
      --private                            keep the task on local models
      --base <ref>                         branch or commit to start from
  zephyr templates                         list task templates
  zephyr hook install [--cwd <dir>]        point Claude Code in <dir> at Zephyr (observed mode)
  zephyr hook uninstall [--cwd <dir>]      remove Zephyr's hooks from <dir>
  zephyr summary <runId | evidence.json>   summarize a task from its evidence bundle

Global options
  --api <url>    Zephyr API (default ${DEFAULT_API}, or ZEPHYR_API)
  --web <url>    Zephyr web UI (default ${DEFAULT_WEB}, or ZEPHYR_WEB)
`;

export interface MainIo {
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

const defaultIo: MainIo = {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
  env: process.env,
};

export function formatTemplates(): string {
  const width = Math.max(...TEMPLATES.map((t) => t.id.length));
  return TEMPLATES.map(
    (t) =>
      `${t.id.padEnd(width)}  ${t.explain}\n${' '.repeat(width + 2)}concurrency ${t.concurrency}, ` +
      `${t.budget.maxTurns} turns, ${Math.round(t.budget.maxTokens / 1000)}k tokens` +
      (t.autoMergeGreen ? ', auto-merges green tasks' : ''),
  ).join('\n');
}

export async function main(argv: string[], io: MainIo = defaultIo): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    io.out(HELP);
    return cmd ? 0 : 1;
  }
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: rest,
      allowPositionals: true,
      options: {
        api: { type: 'string' },
        web: { type: 'string' },
        template: { type: 'string' },
        concurrency: { type: 'string' },
        plan: { type: 'boolean' },
        private: { type: 'boolean' },
        base: { type: 'string' },
        cwd: { type: 'string' },
        title: { type: 'string' },
        'no-open': { type: 'boolean' },
        check: { type: 'boolean' },
      },
    }));
  } catch (err) {
    io.err((err as Error).message);
    return 2;
  }
  const apiBase = (values.api as string | undefined) ?? io.env.ZEPHYR_API ?? DEFAULT_API;
  const web = (values.web as string | undefined) ?? io.env.ZEPHYR_WEB ?? DEFAULT_WEB;
  const api = new ApiClient({ base: apiBase, ...(io.fetch ? { fetch: io.fetch } : {}) });

  try {
    switch (cmd) {
      case 'up':
        return await up({ api: apiBase, web, open: !values['no-open'], check: Boolean(values.check), log: io.out });

      case 'run': {
        const request = positionals.join(' ').trim();
        if (!request) {
          io.err('zephyr run needs a task, e.g. zephyr run "add a dark mode toggle"');
          return 2;
        }
        const template = values.template as string | undefined;
        if (template !== undefined && !isTaskTemplateId(template)) {
          io.err(`Unknown template "${template}". One of: ${TEMPLATES.map((t) => t.id).join(', ')}`);
          return 2;
        }
        let concurrency: number | undefined;
        if (values.concurrency !== undefined) {
          concurrency = Number(values.concurrency);
          if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) {
            io.err('--concurrency must be a whole number from 1 to 8');
            return 2;
          }
        }
        if (!(await api.healthy())) {
          io.err(`Zephyr is not running at ${apiBase}. Start it with: zephyr up`);
          return 1;
        }
        const result = await runTask(api, {
          request,
          ...(template ? { template: template as TaskTemplateId } : {}),
          ...(concurrency !== undefined ? { concurrency } : {}),
          plan: Boolean(values.plan),
          private: Boolean(values.private),
          ...(values.base ? { base: values.base as string } : {}),
        });
        io.out(formatBoard(result, web));
        return 0;
      }

      case 'templates':
        io.out(formatTemplates());
        return 0;

      case 'hook': {
        const sub = positionals[0];
        const cwd = (values.cwd as string | undefined) ?? process.cwd();
        if (sub === 'install') {
          if (!(await api.healthy())) {
            io.err(`Zephyr is not running at ${apiBase}. Start it with: zephyr up`);
            return 1;
          }
          const r = await installHook(api, { cwd, ...(values.title ? { title: values.title as string } : {}) });
          io.out(
            `${r.replaced ? 'Replaced' : 'Installed'} Zephyr hooks in ${r.path} (run ${r.runId}).\n` +
              'Start Claude Code in that directory as usual; its tool calls now go through Zephyr.\n' +
              `Watch it at ${web.replace(/\/+$/, '')}/runs/${encodeURIComponent(r.runId)}`,
          );
          return 0;
        }
        if (sub === 'uninstall') {
          const r = uninstallHook(cwd);
          io.out(r.removed ? `Removed Zephyr hooks from ${r.path}.` : `No Zephyr hooks in ${r.path}.`);
          return 0;
        }
        io.err('Usage: zephyr hook install|uninstall [--cwd <dir>]');
        return 2;
      }

      case 'summary': {
        const arg = positionals[0];
        if (!arg) {
          io.err('Usage: zephyr summary <runId | path/to/evidence.json>');
          return 2;
        }
        io.out(formatSummary(summaryFromFile(evidencePath(arg, repoRoot()))));
        return 0;
      }

      default:
        io.err(`Unknown command "${cmd}".\n\n${HELP}`);
        return 2;
    }
  } catch (err) {
    io.err(err instanceof ApiError ? err.message : `zephyr ${cmd}: ${(err as Error).message}`);
    return 1;
  }
}
