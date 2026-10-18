/**
 * Playbook registry.
 *
 * TO SHIP THE PRODUCT IDEA: write `<kind>.playbook.ts` next to this file and add
 * one line to PLAYBOOKS below. That is the whole server-side cost of the pivot.
 */

import type { Playbook } from './types.js';
import { agentPlaybook } from './agent.playbook.js';
import { baselinePlaybook } from './baseline.playbook.js';
import { baselineAgentPlaybook } from './baselineAgent.playbook.js';
import { demoPlaybook } from './demo.playbook.js';
import { graphPlaybook } from './graph.playbook.js';

// demo stays registered alongside graph deliberately: it is the fallback run
// that works even if graph execution breaks.
const PLAYBOOKS: Playbook<never>[] = [
  agentPlaybook as unknown as Playbook<never>,
  baselinePlaybook as unknown as Playbook<never>,
  baselineAgentPlaybook as unknown as Playbook<never>,
  demoPlaybook as unknown as Playbook<never>,
  graphPlaybook as unknown as Playbook<never>,
];

const byKind = new Map<string, Playbook<never>>(PLAYBOOKS.map((p) => [p.kind, p]));

export function getPlaybook(kind: string): Playbook<never> | undefined {
  return byKind.get(kind);
}

export function listPlaybooks(): { kind: string; title: string; directLaunch: boolean }[] {
  return [...byKind.values()].map((p) => ({
    kind: p.kind,
    title: p.title,
    // Explicit rather than optional on the wire, so the client never has to
    // guess what `undefined` means.
    directLaunch: p.directLaunch !== false,
  }));
}

export function hasPlaybook(kind: string): boolean {
  return byKind.has(kind);
}
