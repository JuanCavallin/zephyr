/**
 * Render an `EvidenceBundle` to markdown for a PR body (step 6).
 *
 * The header (run, diff stat + hash, test result, usage) is always emitted whole.
 * Sections follow in a fixed order; when the body would exceed the host's limit
 * (GitHub: 65,536 characters), each section gets a fair share of the room left and
 * the ones larger than their share are cut line by line, with a note on each cut (or
 * named as omitted when not even one line fits). The header is never truncated, and
 * `evidence.json` stays the complete record.
 */

import type { EvidenceBundle } from '@htn/shared';

/** GitHub's pull request body limit, in characters. */
export const GITHUB_BODY_LIMIT = 65_536;

export interface RenderOptions {
  /** Character limit for the whole body. Default GITHUB_BODY_LIMIT. */
  limit?: number;
  /** Where the full bundle lives, named in truncation notes. */
  evidencePath?: string;
}

interface Section {
  title: string;
  lines: string[];
}

export function renderEvidence(bundle: EvidenceBundle, options: RenderOptions = {}): string {
  const limit = options.limit ?? GITHUB_BODY_LIMIT;
  const where = options.evidencePath ?? 'evidence.json';
  const header = renderHeader(bundle);
  const footer = `\n---\n_Full record: \`${where}\` (bundle \`${bundle.id}\`)._\n`;
  const sections = renderSections(bundle);
  const blocks = sections.map((s) => block(s.title, s.lines));

  // Fair share: smallest sections first; each takes its whole size if that fits its
  // share of what is left, otherwise it is cut to its share. One large section (a
  // long test list) can never push the small ones (approvals, usage) out.
  let remaining = limit - header.length - footer.length;
  const rendered = new Array<string>(sections.length).fill('');
  const order = sections.map((_, i) => i).sort((a, b) => blocks[a]!.length - blocks[b]!.length);
  order.forEach((i, k) => {
    const share = Math.floor(remaining / (order.length - k));
    const full = blocks[i]!;
    const text = full.length <= share ? full : (truncated(sections[i]!, share, where) ?? omitted(sections[i]!, share, where));
    rendered[i] = text;
    remaining -= text.length;
  });
  return header + rendered.join('') + footer;
}

function renderHeader(b: EvidenceBundle): string {
  const t = b.tests.after;
  const verdict = t.failed > 0 ? `**${t.failed} failing**` : t.passed > 0 ? 'all passing' : 'no tests ran';
  const before = b.tests.before
    ? ` (before: ${b.tests.before.passed} passed, ${b.tests.before.failed} failed)`
    : '';
  const u = b.usage;
  const lines = [
    '## Zephyr evidence',
    '',
    `Run \`${b.runId}\`${b.taskId ? ` · task \`${b.taskId}\`` : ''} · ${b.createdAt}`,
    '',
    `- **Diff:** ${b.diff.files} file${b.diff.files === 1 ? '' : 's'}, +${b.diff.insertions} −${b.diff.deletions} · \`${b.diff.hash}\``,
    `- **Tests:** ${t.passed} passed, ${t.failed} failed, ${t.skipped} skipped — ${verdict}${before}`,
    `- **Protected-path approvals:** ${b.protectedPathApprovals.length}`,
    `- **Tokens:** ${u.tokensIn} in, ${u.tokensOut} out, ${u.cacheReadTokens} cache read, ${u.cacheWriteTokens} cache write · ${formatCents(u.costCents)} · ${formatMs(u.wallMs)}`,
    `- **Egress:** ${b.egress.calls} call${b.egress.calls === 1 ? '' : 's'} to ${b.egress.destinations.length} destination${b.egress.destinations.length === 1 ? '' : 's'}`,
    '',
  ];
  return lines.join('\n');
}

function renderSections(b: EvidenceBundle): Section[] {
  const sections: Section[] = [];
  const selected = b.tests.selected;
  sections.push({
    title: `Tests selected (${selected.length})`,
    lines: selected.length
      ? [
          '| Test | Score | Chosen by |',
          '| --- | --- | --- |',
          ...selected.map((s) => `| \`${cell(s.id)}\` | ${s.score === undefined ? '—' : s.score.toFixed(2)} | ${s.fallback ? 'fallback (ran every candidate)' : 'Jev'} |`),
        ]
      : ['_No tests selected._'],
  });
  sections.push({
    title: 'Tests added and modified',
    lines: [
      ...b.tests.added.map((p) => `- added \`${p}\``),
      ...b.tests.modified.map((p) => `- modified \`${p}\``),
    ].concat(b.tests.added.length + b.tests.modified.length ? [] : ['_None._']),
  });
  sections.push({
    title: `Protected-path approvals (${b.protectedPathApprovals.length})`,
    lines: b.protectedPathApprovals.length
      ? b.protectedPathApprovals.map((a) => `- \`${a.path}\` — approval \`${a.approvalId}\``)
      : ['_None._'],
  });
  sections.push({
    title: `Checkpoints (${b.checkpoints.length})`,
    lines: b.checkpoints.length
      ? b.checkpoints.map((c, i) => `${i + 1}. \`${c.ref}\` — turn \`${c.turnId}\` at ${c.at}`)
      : ['_None._'],
  });
  sections.push({ title: 'Usage', lines: usageTable(b) });
  sections.push({
    title: 'Egress destinations',
    lines: b.egress.destinations.length ? b.egress.destinations.map((d) => `- \`${d}\``) : ['_None._'],
  });
  if (b.walkthrough) {
    sections.push({
      title: 'UI walkthrough',
      lines: [
        `Preview: ${b.walkthrough.previewUrl}`,
        '',
        ...b.walkthrough.steps.map(
          (s, i) => `${i + 1}. ${s.description}${s.screenshotUrl ? ` ([screenshot](${s.screenshotUrl}))` : ''}`,
        ),
      ],
    });
  }
  return sections;
}

function usageTable(b: EvidenceBundle): string[] {
  const rows: [string, keyof EvidenceBundle['usage'], (n: number) => string][] = [
    ['Tokens in (uncached)', 'tokensIn', String],
    ['Tokens out', 'tokensOut', String],
    ['Cache read', 'cacheReadTokens', String],
    ['Cache write', 'cacheWriteTokens', String],
    ['Cost', 'costCents', formatCents],
    ['Wall time', 'wallMs', formatMs],
  ];
  if (!b.baseline) {
    return ['| Metric | This run |', '| --- | --- |', ...rows.map(([label, k, f]) => `| ${label} | ${f(b.usage[k])} |`)];
  }
  const base = b.baseline;
  return [
    '| Metric | This run | Baseline |',
    '| --- | --- | --- |',
    ...rows.map(([label, k, f]) => `| ${label} | ${f(b.usage[k])} | ${f(base[k])} |`),
  ];
}

function block(title: string, lines: string[]): string {
  return `\n### ${title}\n\n${lines.join('\n')}\n`;
}

/** As many whole lines of the section as fit in `room`, plus a cut note; null if none fit. */
function truncated(section: Section, room: number, where: string): string | null {
  const head = `\n### ${section.title}\n\n`;
  const note = (n: number) => `_… ${n} more line${n === 1 ? '' : 's'} cut for size; see \`${where}\`._\n`;
  let body = '';
  let kept = 0;
  for (const line of section.lines) {
    const next = body + line + '\n';
    if (head.length + next.length + note(section.lines.length - kept - 1).length > room) break;
    body = next;
    kept += 1;
  }
  if (kept === 0) return null;
  return head + body + note(section.lines.length - kept);
}

/** The section's title and an omission note, or nothing when even that does not fit. */
function omitted(section: Section, room: number, where: string): string {
  const text = `\n### ${section.title}\n\n_Omitted for size; see \`${where}\`._\n`;
  return text.length <= room ? text : '';
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function formatCents(cents: number): string {
  return '$' + (cents / 100).toFixed(cents > 0 && cents < 100 ? 4 : 2);
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  return s < 120 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
