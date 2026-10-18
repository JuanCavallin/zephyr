# Demo guide

Judging is a **live demo, not a pitch deck**. Criteria: originality, user experience,
technical complexity, wow factor. This is the script. Sponsor-specific variations are in
[SPONSORS.md](SPONSORS.md).

## The one-sentence pitch

> Agents today are a black box with your credentials. Zephyr sits between any agent and the
> world: a tiny decision model picks the model, the tools and the moment to stop — and
> nothing irreversible or private leaves without policy saying yes.

## Setup (10 minutes before)

```bash
pnpm install
cp .env.example .env      # then paste keys; every key is optional
pnpm dev                  # api :8787, web :5173
```

1. Open `http://localhost:8787/api/providers`. Confirm which providers are `live` + healthy.
   That list decides which acts below are live and which are mock. Say so out loud; the UI does.
2. Run the **Demo run** playbook once and leave the finished run open in a tab. That is the
   fallback if the venue network dies: stored runs replay from SQLite offline.
3. If the network is already bad, set `MOCK_ALL=true` and restart. Everything still runs.
4. Keep to **one live Hermes run at a time** — the model gateway correlates requests to the
   single active session and fails closed when that is ambiguous.
5. Do not restart the API while an approval is pending; the waiter is in-process.

## The 3-minute script

### Act 1 — Ask for something (30 s)

On `/`, switch the composer from **Preview mode** (a labelled, synthetic walkthrough) to
**Run as agent task**, type a plain goal and send:

> Send an email to judge@example.com saying: Zephyr demo is ready

The UI navigates straight to the live run. Nothing is hard-coded to this sentence.

### Act 2 — Watch it decide (60 s)

Point at the trace as it streams (SSE, replayable):

- **Jev narrows the tools.** `control.decided · select_tool_families → select_tools`: from
  the whole registry down to a handful, with a calibrated confidence. Low confidence falls
  back to a deterministic rule, and the card says which one made the call.
- **Jev picks the route.** `schedule.decided`: privacy (`private`/`cloud`) × intelligence
  (`low`/`high`) → local Ollama, cheap cloud, or frontier. The model that _actually_ served
  the call is shown from `model.lifecycle`, not guessed.
- **The harness never sees the rest.** Hermes talks only to Zephyr's own `/v1` model gateway
  and `/mcp` tool gateway. It cannot reach a tool it was not handed.

### Act 3 — The gate (45 s)

The agent proposes the exact send. The run **pauses**:

- The approval panel shows the proposed action verbatim: recipient, body, reversibility
  (`irreversible`), risk class, and the policy rule that stopped it.
- With GPTZero live, outbound text written in your name is scored first; a high AI
  probability can only _add_ a human check, never remove one.
- Approve → `tool.lifecycle: succeeded`. Reject → it never leaves. Edit the payload →
  it is re-authorized before release (revisions may only narrow the action).

### Act 4 — Prove it (45 s)

- **Egress ledger:** every outbound call, its destination, the _class_ of data it carried,
  and the rule that allowed it. Sensitive spans were replaced with `[[PII_n]]` before any
  cloud call — point at the placeholders in the Claude step.
- **Compare:** on `/graphs`, open the demo workflow and press **Run + compare to baseline**. It runs the
  supervised graph and a single-LLM-call baseline (B0) side by side **on the same task** — the
  baseline is sent the graph's own prompt, inputs and source text — then opens `/compare`:
  active time (human wait shown separately), tokens, cost, assertions. **Run + compare to both
  baselines** adds B1: one frontier agent with every tool and no Jev routing, the fair
  "no orchestration" control (a full agent run — it costs real money in live mode).
- **Benchmarks (`/benchmarks`):** every graph-vs-baseline run pooled. Success rate, cost per
  success, and the paired cost saving with a 95% interval — counted only on pairs where both
  sides succeeded. A `≥` cost is a lower bound (some call had no known price). Mock runs are
  hidden unless you tick the box; their numbers are not real. For a measured result rather than
  an anecdote, run `pnpm --filter @htn/api benchmark -- --graph <id> --repeats 5` first.
- **Pause / resume / cancel** from the run header. When the completion judge says `blocked`,
  the run pauses for you instead of failing.

## Alternative opening: build the workflow first (works with mock Hermes)

Composer mode **Build a workflow** → describe the job ("Check our vendor portals for overdue
invoices and email me a summary"). Zephyr drafts a **graph** and opens it in the editor; nothing
has run. Point at what was left to runtime (the agent and decision nodes), tune a node in the
inspector (model tier, temperature, budgets), or tell the chat panel to change the graph — it
edits the open workflow and bumps its version. Then **Run graph** for the live trace, or
**Run + compare to baseline** for the cost/latency comparison. After a few runs, press
**Suggest an improvement**: Zephyr critiques that workflow's own run history and opens a
_forked_ proposal with the reasons in a banner — the original is untouched and nothing runs. Each send from `/` starts a new
workflow; **+ New task** in the editor opens an empty one.

## Backup path: the Demo run playbook (works with zero keys)

`/runs` → **Demo run**. It exercises every subsystem in ~40 s: load case file → local PII
redaction → redacted cloud summary → delegated agent subtask → **3-worker swarm** (three
browser sessions) → Jev adjudication → irreversible action blocked on approval.

Use this when Hermes is not installed on the demo machine: with mock Hermes the free-form
agent never proposes a tool call, so the completion judge correctly reports `blocked` and
the run pauses. That is the system working, but it is not the email demo.

## What is live on which machine

Full key-by-key setup, installs and a pre-flight checklist: **[DEMO-KEYS.md](DEMO-KEYS.md)**.

| Capability          | Needs                                                                     |
| ------------------- | ------------------------------------------------------------------------- |
| Jev decisions       | `AI_GATEWAY_API_KEY`, `JEV_MODE=live`                                     |
| Cloud browser       | `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`                           |
| Private browser     | Chrome installed, `LOCALBROWSER_MODE=live`, `LOCALBROWSER_CHANNEL=chrome` |
| Real agent (Hermes) | `uv` + a `hermes-agent` checkout at `HERMES_CWD` **on that machine**      |
| Email via Composio  | `COMPOSIO_API_KEY`, `COMPOSIO_AUTH_CONFIG_ID`, Gmail connected            |
| Model routes        | `GEMINI_API_KEY` for tool turns / Ollama running                           |
| Outbound-text check | `GPTZERO_API_KEY`, `GPTZERO_MODE=live`                                    |

`HERMES_CWD` is an absolute path, so a shared `.env` will not work across laptops. If the
path does not exist the API logs a warning and downgrades Hermes to mock.

## Questions judges ask

- **"Isn't this just a wrapper?"** The harness is swappable and untrusted. The value is the
  layer it cannot bypass: exact-action authorization, egress accounting, and a decision
  model that costs milliseconds instead of a frontier call per routing choice.
- **"Why Jev instead of an LLM?"** It cannot generate text, so it cannot be prompt-injected
  into inventing an action. It returns an index into options Zephyr built, with calibrated
  confidence we can threshold. And "Jev is safe" still never skips `authorize_action`.
- **"What happens when Jev is wrong or down?"** A bounded time budget (2 s for a browser step), then a deterministic fallback;
  every decision card shows its source. Policy, not Jev, has the final say.
- **"What is mock right now?"** Read it off the provider badges. Never bluff this one.
