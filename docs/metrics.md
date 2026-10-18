# Measured metrics

The numbers the README quotes about Zephyr's own performance and guarantees, and where each
one comes from. Browser figures were measured on 2026-10-09; the rest are read from the code
(values and line links checked on 2026-10-16).

## Browser: what Jev sees

The browser tools never hand Jev a page. They hand it an indexed table of the page's
interactive elements (at most 60 rows, labels cut at 80 characters), and Jev answers with a row
number; see [elementTable.ts](../apps/api/src/core/tools/elementTable.ts) and
[browserDecider.ts](../apps/api/src/providers/jev/browserDecider.ts). Across 13 live sites, the
full Jev request for one step compares like this:

| Compared with                                 | Median                 | Range across sites |
| --------------------------------------------- | ---------------------- | ------------------ |
| The page's raw DOM HTML                       | **98.5% fewer tokens** | 82.8%–99.9%        |
| A full Playwright accessibility-tree snapshot | **81.7% fewer tokens** | 60.9%–98.1%        |

The request stayed between 1,234 and 2,045 tokens (median 1,517) while raw DOM ranged from 8.5K
to 2.2M tokens. Counted in characters instead of tokens, the cut is 98.4%.

## Browser: snapshot and pre-action latency

| Step                    | Before                                  | After                     | Median speedup        |
| ----------------------- | --------------------------------------- | ------------------------- | --------------------- |
| Page snapshot           | 3,635 ms, a median 590 Playwright calls | 19 ms, one in-page script | **191x** (lowest 92x) |
| Pre-action target check | 19.8 ms, 4 calls                        | 1.19 ms, 1 call           | **15x** (lowest 9.4x) |

**Before** is the shape each step replaced, re-implemented in the benchmark. The snapshot read
every element with separate Playwright calls (visibility, tag, role, type, aria-label, text,
placeholder, title: about 8 per element, for up to 60 visible elements), as the comment in
[browserPage.ts](../apps/api/src/providers/browserPage.ts#L63-L65) records. The target check
made 4 calls: `count`, `isVisible`, `isEnabled` and an `elementFromPoint` probe, as in
`localbrowser/live.ts` at commit `fea5826`.
**After** is the code every browser adapter runs today: `COLLECT_ROWS` and
`validateTargetScript` in
[browserPage.ts](../apps/api/src/providers/browserPage.ts#L67-L139). The benchmark imports
both, and the Jev request it measures comes from the decider's own `planBrowserQuestions`.

## Per-site results

Tokens per page, sorted by raw DOM size.

| Site                  | Interactive elements |   Raw DOM | Accessibility tree | Jev request | Snapshot before | Snapshot after | Speedup |
| --------------------- | -------------------: | --------: | -----------------: | ----------: | --------------: | -------------: | ------: |
| cnn.com               |                  319 | 2,199,162 |             14,871 |       1,768 |        9,338 ms |          37 ms |    252x |
| theverge.com          |                  325 |   583,314 |             20,116 |       1,864 |        7,124 ms |          34 ms |    210x |
| en.wikipedia.org      |                2,235 |   525,991 |             71,708 |       1,330 |       14,927 ms |         126 ms |    118x |
| github.com            |                  249 |   196,710 |             13,347 |       1,653 |        5,204 ms |          19 ms |    274x |
| espn.com              |                  151 |   167,107 |              8,800 |       1,517 |        8,503 ms |          34 ms |    250x |
| apple.com             |                  157 |   141,350 |              4,682 |       1,400 |        3,635 ms |          19 ms |    191x |
| bbc.com               |                  118 |   119,695 |              7,998 |       2,045 |        2,291 ms |          16 ms |    143x |
| microsoft.com         |                  105 |   103,810 |              5,407 |       1,597 |       15,368 ms |           9 ms |   1708x |
| ycombinator.com       |                  248 |    59,408 |              6,730 |       1,234 |        3,255 ms |          14 ms |    232x |
| developer.mozilla.org |                  530 |    34,173 |              7,149 |       1,360 |        3,350 ms |          29 ms |    116x |
| python.org            |                  148 |    15,159 |              4,739 |       1,532 |        1,923 ms |          21 ms |     92x |
| news.ycombinator.com  |                  231 |    11,758 |             10,080 |       1,370 |        1,897 ms |          11 ms |    172x |
| docs.python.org       |                   78 |     8,510 |              3,752 |       1,466 |        1,099 ms |           6 ms |    183x |

Amazon and Reddit served bot walls ("Sorry! Something went wrong!", "Prove your humanity") and
are left out of every median. The raw data, those two rows included, is in
[metrics/browser-benchmark-2026-10-09.json](metrics/browser-benchmark-2026-10-09.json).

## Method and limits

- **Setup.** Zephyr's own local-browser adapter drove installed Chrome 154, headless, through
  playwright-core 1.63 on Node 22.21 and a Windows 11 laptop. Each page got its load event, up
  to 6 s of network idle and 1.5 s more before measuring.
- **Tokens.** Counted with `o200k_base` (tiktoken 0.14). Jev's own tokenizer is not public, so
  token counts are a proxy; the character counts agree.
- **Timing.** "After" is the median of 5 adapter snapshots, "before" the median of 3
  per-element passes. The target check used 20 visible targets × 3 rounds.
- **Local Chrome only.** Browserbase was not measured. There every removed call is a network
  round trip, so the saving should be larger, but no number is claimed for it.
- **Snapshot step only.** These are not end-to-end task times.
- **Machine-dependent.** Absolute times vary between machines and runs; an earlier 7-site run
  gave a 127x median snapshot speedup.

## Rerun it

```bash
pnpm bench:browser          # needs Chrome; writes .data/bench-browser/ (gitignored)
pip install tiktoken
python apps/api/scripts/bench-browser-tokens.py .data/bench-browser
```

`BENCH_PAGES=https://a.example/,https://b.example/` limits the page list. The scripts are
[bench-browser.ts](../apps/api/scripts/bench-browser.ts) and
[bench-browser-tokens.py](../apps/api/scripts/bench-browser-tokens.py).

## Read from the code

| Claim                                         | Value                                                                                                                 | Where                                                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tools Jev exposes per task                    | At most 8, each with probability ≥ 0.5                                                                                | [jev/live.ts](../apps/api/src/providers/jev/live.ts#L25-L26), [L644–L647](../apps/api/src/providers/jev/live.ts#L644-L647), [decisions/service.ts](../apps/api/src/core/decisions/service.ts#L103)            |
| Composio candidates per task                  | At most 24 (`COMPOSIO_DISCOVERY_LIMIT`)                                                                               | [config.ts](../apps/api/src/config.ts#L118)                                                                                                                                                                   |
| Tool catalog behind them                      | 1,000+ tools; Composio lists [1,500+ apps](https://composio.dev)                                                      | [README providers table](../README.md#providers)                                                                                                                                                              |
| Model routing                                 | Privacy (private, cloud) × intelligence (low, high) picks a local, cheap or frontier route                            | [jev/live.ts](../apps/api/src/providers/jev/live.ts#L566-L632)                                                                                                                                                |
| Jev confidence floor                          | 0.7; below it a deterministic rule decides                                                                            | [decisions/service.ts](../apps/api/src/core/decisions/service.ts#L102)                                                                                                                                        |
| Browser decision budget                       | 2 s, then the deterministic fallback                                                                                  | [config.ts](../apps/api/src/config.ts#L102)                                                                                                                                                                   |
| Exact-action broker                           | 14 error codes, every one fails closed                                                                                | [broker.ts](../apps/api/src/core/tools/broker.ts#L33-L47)                                                                                                                                                     |
| Irreversible actions, e.g. `GMAIL_SEND_EMAIL` | At least `ask_user`, never automatic; a revision is re-validated and re-authorized, and cannot change the destination | [register.ts](../apps/api/src/providers/composio/register.ts#L49-L56), [decisions/service.ts](../apps/api/src/core/decisions/service.ts#L72-L74), [broker.ts](../apps/api/src/core/tools/broker.ts#L323-L391) |
| Test assertions run in CI                     | 942 across 29 test files: the 24 API check scripts in `check:all` and 5 web test files                                | the command below                                                                                                                                                                                             |

```bash
grep -ohE '\bassert(\.[a-zA-Z]+)?\(' \
  apps/api/scripts/{graph-schema,graph-synthesis,graph-context,graph-scopes,graph-critique,benchmark,jev-decisions,agent-single-run,model-gateway,mcp-gateway,mcp-connections,sqlite-store,tool-broker,composio-catalog,browser-tools,content-check,gemini-backend,anthropic-backend,credentials,search,browser-integration,browser-http,action-workspace,authoring-mock}.check.ts \
  apps/web/tests/*.test.mjs | wc -l     # 942
```
