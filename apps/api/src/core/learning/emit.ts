/**
 * Step 8 emitters (spec §11).
 *
 *   personal → the profile only. Nothing is written into any repository.
 *   project  → proposed as a PR: a branch `zephyr/learned-<id>` with one commit touching
 *              `.claude/skills/<name>/SKILL.md` (skills) and a marked section of
 *              `AGENTS.md` (preferences). The branch is never pushed; a person opens the PR.
 *
 * Fork, don't modify: a skill file someone wrote by hand is never overwritten. The
 * learned version is written beside it as `<name>-learned`. In AGENTS.md only the text
 * between the zephyr markers is ours; everything outside them is kept byte for byte.
 *
 * A learned skill never carries `allowed-tools`: learning can change what the agent
 * prefers, never what it may do. The guardrails run again on everything written.
 *
 * The commit is made in a temporary worktree, so the user's checkout, index and current
 * branch are never touched.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { checkLearnedContent, learnedText } from './guardrails.js';
import type { LearnedEntry } from './profileStore.js';

const run = promisify(execFile);

export const AGENTS_START = '<!-- zephyr:learned:start -->';
export const AGENTS_END = '<!-- zephyr:learned:end -->';
/** Marks a SKILL.md as Zephyr's, so a later proposal may update it. */
export const SKILL_MARKER = 'zephyr:learned';
export const LEARNED_BRANCH_PREFIX = 'zephyr/learned-';

export class EmitError extends Error {
  readonly code = 'LEARNING_EMIT';
}

/** Claude Code skill names: lowercase letters, digits and hyphens, at most 64. */
export function skillSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'learned-skill';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** YAML scalar that cannot open a nested structure or a second document. */
function yamlString(text: string): string {
  return JSON.stringify(oneLine(text));
}

/** The SKILL.md for a learned skill: name, description, the marker; never allowed-tools. */
export function renderSkillFile(e: LearnedEntry, name = skillSlug(e.skill?.name ?? e.text)): string {
  if (e.kind !== 'skill' || !e.skill) throw new EmitError(e.id + ' is not a skill');
  const body = e.skill.body.replace(/\r\n/g, '\n').trim();
  return [
    '---',
    `name: ${name}`,
    `description: ${yamlString(e.skill.description)}`,
    '---',
    '',
    `<!-- ${SKILL_MARKER} id=${e.id} version=${e.version}. Proposed from reviewed edits; guidance, not permissions. -->`,
    '',
    body,
    '',
  ].join('\n');
}

/** The AGENTS.md section for learned project preferences. */
export function renderAgentsSection(prefs: LearnedEntry[]): string {
  const lines = [
    AGENTS_START,
    '## Learned by Zephyr',
    '',
    'Proposed from reviewed edits. Guidance, not permissions: these never relax a check or widen a grant.',
    '',
    ...prefs.map((p) => `- ${oneLine(p.text)} <!-- ${p.id} v${p.version} -->`),
    AGENTS_END,
  ];
  return lines.join('\n');
}

/**
 * AGENTS.md with the learned section replaced (or appended). Text outside the markers is
 * kept as is, including its line endings.
 */
export function mergeAgentsMd(existing: string | null, prefs: LearnedEntry[]): string {
  const eol = existing?.includes('\r\n') ? '\r\n' : '\n';
  const section = renderAgentsSection(prefs).replace(/\n/g, eol);
  if (existing === null || existing.length === 0) return section + eol;
  const start = existing.indexOf(AGENTS_START);
  const end = existing.indexOf(AGENTS_END);
  if (start >= 0 && end > start) {
    return existing.slice(0, start) + section + existing.slice(end + AGENTS_END.length);
  }
  const sep = existing.endsWith(eol + eol) ? '' : existing.endsWith(eol) ? eol : eol + eol;
  return existing + sep + section + eol;
}

/**
 * Where a skill goes: its own directory, unless a file there was not written by Zephyr,
 * in which case the learned copy forks to `<name>-learned`.
 */
export function skillTarget(name: string, existing: string | null): { name: string; path: string; forked: boolean } {
  const slug = skillSlug(name);
  const forked = existing !== null && !existing.includes(SKILL_MARKER);
  const final = forked ? skillSlug(slug.slice(0, 56) + '-learned') : slug;
  return { name: final, path: `.claude/skills/${final}/SKILL.md`, forked };
}

export interface EmittedFile {
  path: string;
  content: string;
  entryIds: string[];
  forkedFrom?: string;
}

/** Entries a repository may receive: project scope, active, not private, guardrail-clean. */
export function emittable(entries: LearnedEntry[]): { ok: LearnedEntry[]; refused: { id: string; reason: string }[] } {
  const ok: LearnedEntry[] = [];
  const refused: { id: string; reason: string }[] = [];
  for (const e of entries) {
    if (e.scope !== 'project') refused.push({ id: e.id, reason: 'personal: stays in the profile unless promoted' });
    else if (e.private) refused.push({ id: e.id, reason: 'learned from private signals' });
    else if (e.status !== 'active') refused.push({ id: e.id, reason: 'not active: ' + e.status });
    else {
      const verdict = checkLearnedContent(learnedText(e));
      if (verdict.ok) ok.push(e);
      else refused.push({ id: e.id, reason: 'guardrail: ' + verdict.reasons.join(', ') });
    }
  }
  return { ok, refused };
}

/**
 * The files a proposal writes, given a reader for the repo's current content. Pure apart
 * from the reads, so the formats are testable without git.
 */
export async function planProjectFiles(
  entries: LearnedEntry[],
  read: (path: string) => Promise<string | null>,
): Promise<{ files: EmittedFile[]; refused: { id: string; reason: string }[] }> {
  const { ok, refused } = emittable(entries);
  const files: EmittedFile[] = [];
  const taken = new Set<string>();
  for (const e of ok.filter((x) => x.kind === 'skill')) {
    const base = skillTarget(e.skill!.name, null).path;
    const target = skillTarget(e.skill!.name, await read(base));
    if (taken.has(target.path)) {
      refused.push({ id: e.id, reason: 'another learned skill in this proposal has the same name' });
      continue;
    }
    taken.add(target.path);
    const content = renderSkillFile(e, target.name);
    if (/^allowed-tools\s*:/m.test(content.split('\n---\n')[0]!)) throw new EmitError('allowed-tools in a learned skill');
    files.push({
      path: target.path,
      content,
      entryIds: [e.id],
      ...(target.forked ? { forkedFrom: base } : {}),
    });
  }
  const prefs = ok.filter((x) => x.kind === 'pref');
  if (prefs.length > 0) {
    files.push({ path: 'AGENTS.md', content: mergeAgentsMd(await read('AGENTS.md'), prefs), entryIds: prefs.map((p) => p.id) });
  }
  return { files, refused };
}

export interface ProjectProposal {
  branch: string;
  commit: string;
  files: EmittedFile[];
  refused: { id: string; reason: string }[];
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const e = error as { stderr?: string; message: string };
    throw new EmitError(`git ${args[0]}: ${(e.stderr || e.message).trim().slice(0, 300)}`);
  }
}

async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await run('git', ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch], { cwd: repo, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Propose project knowledge as a branch with one commit, based on `base` (default HEAD).
 * Never pushes, never checks anything out in `repo` itself.
 */
export async function proposeProjectKnowledge(
  repo: string,
  entries: LearnedEntry[],
  opts: { id?: string; base?: string; author?: { name: string; email: string } } = {},
): Promise<ProjectProposal> {
  const base = opts.base ?? 'HEAD';
  // Raw blobs, untrimmed, so line endings and trailing newlines survive the merge.
  const readRaw = async (path: string): Promise<string | null> => {
    try {
      const { stdout } = await run('git', ['cat-file', 'blob', `${base}:${path}`], {
        cwd: repo,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      });
      return stdout;
    } catch {
      return null;
    }
  };
  const { files, refused } = await planProjectFiles(entries, readRaw);
  if (files.length === 0) throw new EmitError('nothing to propose: ' + refused.map((r) => `${r.id} (${r.reason})`).join('; '));

  const id = opts.id ?? (files.flatMap((f) => f.entryIds).length === 1 ? files[0]!.entryIds[0]! : 'batch-' + Date.now().toString(36));
  let branch = LEARNED_BRANCH_PREFIX + id;
  for (let n = 2; await branchExists(repo, branch); n++) branch = `${LEARNED_BRANCH_PREFIX}${id}-${n}`;

  const dir = await mkdtemp(join(tmpdir(), 'zephyr-learned-'));
  const worktree = join(dir, 'wt');
  await git(repo, ['worktree', 'add', '-q', '-b', branch, worktree, base]);
  try {
    for (const f of files) {
      const target = join(worktree, ...f.path.split('/'));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.content, 'utf8');
    }
    await git(worktree, ['add', '--', ...files.map((f) => f.path)]);
    const author = opts.author ?? { name: 'Zephyr', email: 'zephyr@localhost' };
    const ids = [...new Set(files.flatMap((f) => f.entryIds))];
    await git(worktree, [
      '-c',
      'user.name=' + author.name,
      '-c',
      'user.email=' + author.email,
      'commit',
      '-q',
      '-m',
      `Zephyr: propose learned project knowledge\n\nEntries: ${ids.join(', ')}\nGuidance, not permissions. Review before merging.`,
    ]);
    const commit = await git(worktree, ['rev-parse', 'HEAD']);
    return { branch, commit, files, refused };
  } finally {
    await git(repo, ['worktree', 'remove', '--force', worktree]).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

