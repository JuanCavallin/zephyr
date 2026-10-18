# Benchmark: graph vs baselines

Generated 2026-10-18T04:06:21.035Z against http://localhost:8911. Arms: graph, baseline, baseline_agent; 5 measured round(s) per task after 1 uncounted warm-up graph run(s); arms run one at a time in shuffled order.

Savings are medians of per-pair `1 - graph / baseline`, counted only where both runs passed every outcome assertion. Active time excludes time spent waiting on a person. Graph runs after the warm-up are hot (they reuse frozen decisions and remembered browser targets); baselines start cold every time.

## All tasks pooled

| Arm | Runs | Success | Median tokens | In / out | Model calls | Jev calls | Active p50 | Active p95 | Cost/success | Warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph (orchestrated) | 25 | 100% | 1,458 | 1,331 / 109 | 2 | 2 | 1.2 s | 9.4 s | 0.0074c | 15/25 |
| B0 · one call, no tools | 25 | 64% | 1,279 | 336 / 986 | 1 | 0 | 14.0 s | 18.3 s | 3.8439c | 0/25 |
| B1 · one agent, all tools | 25 | 40% | 92,405 | 92,017 / 435 | 5 | 1 | 22.6 s | 40.8 s | 53.4824c | 6/25 |

- vs B0 · one call, no tools: 16/25 pairs both succeeded; median token saving -33% (95% CI -132%..-20%), active time 67% (95% CI 49%..95%), cost 100% (95% CI 100%..100%). Graph-only wins 9, baseline-only wins 0.
- vs B1 · one agent, all tools: 10/25 pairs both succeeded; median token saving 98% (95% CI 97%..99%), active time 88% (95% CI 76%..98%), cost 100% (95% CI 100%..100%). Graph-only wins 15, baseline-only wins 0.

## Bench: bookstore catalogue

| Arm | Runs | Success | Median tokens | In / out | Model calls | Jev calls | Active p50 | Active p95 | Cost/success | Warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph (orchestrated) | 5 | 100% | 4,224 | 4,066 / 158 | 3 | 3 | 9.4 s | 12.2 s | 0.0171c | 0/5 |
| B0 · one call, no tools | 5 | 100% | 1,542 | 380 / 1,162 | 1 | 0 | 14.8 s | 19.7 s | 3.2045c | 0/5 |
| B1 · one agent, all tools | 5 | 100% | 159,350 | 158,155 / 1,195 | 7 | 1 | 38.8 s | 42.7 s | 29.8856c | 0/5 |

- vs B0 · one call, no tools: 5/5 pairs both succeeded; median token saving -174% (95% CI -186%..-132%), active time 35% (95% CI 21%..55%), cost 99% (95% CI 99%..100%). Graph-only wins 0, baseline-only wins 0.
- vs B1 · one agent, all tools: 5/5 pairs both succeeded; median token saving 97% (95% CI 97%..97%), active time 76% (95% CI 65%..78%), cost 100% (95% CI 100%..100%). Graph-only wins 0, baseline-only wins 0.

## Bench: case note triage

| Arm | Runs | Success | Median tokens | In / out | Model calls | Jev calls | Active p50 | Active p95 | Cost/success | Warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph (orchestrated) | 5 | 100% | 909 | 821 / 88 | 2 | 2 | 0.2 s | 0.3 s | 0.0034c | 0/5 |
| B0 · one call, no tools | 5 | 100% | 733 | 350 / 383 | 1 | 0 | 5.8 s | 6.8 s | 1.1075c | 0/5 |
| B1 · one agent, all tools | 5 | 0% | 977 | 939 / 38 | 1 | 1 | 14.6 s | 15.4 s | n/a | 0/5 |

- vs B0 · one call, no tools: 5/5 pairs both succeeded; median token saving -24% (95% CI -35%..-17%), active time 97% (95% CI 95%..97%), cost 100% (95% CI 100%..100%). Graph-only wins 0, baseline-only wins 0.
- vs B1 · one agent, all tools: 0/5 pairs both succeeded; median token saving n/a, active time n/a, cost n/a. Graph-only wins 5, baseline-only wins 0.

Failed runs: baseline_agent `run_482de9f256e14801` (succeeded, 0/2 assertions); baseline_agent `run_b1842d04608643b2` (succeeded, 0/2 assertions); baseline_agent `run_229c9101ad824610` (succeeded, 0/2 assertions); baseline_agent `run_36ad00a62de64ca3` (succeeded, 0/2 assertions); baseline_agent `run_48b13944449e4c49` (succeeded, 0/2 assertions).

## Bench: order dataset totals

| Arm | Runs | Success | Median tokens | In / out | Model calls | Jev calls | Active p50 | Active p95 | Cost/success | Warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph (orchestrated) | 5 | 100% | 1,098 | 992 / 106 | 2 | 2 | 0.3 s | 0.4 s | 0.0042c | 5/5 |
| B0 · one call, no tools | 5 | 20% | 1,365 | 336 / 1,029 | 1 | 0 | 15.6 s | 18.3 s | 14.2400c | 0/5 |
| B1 · one agent, all tools | 5 | 100% | 73,201 | 72,776 / 426 | 4 | 1 | 20.9 s | 24.7 s | 25.2666c | 0/5 |

- vs B0 · one call, no tools: 1/5 pairs both succeeded; median token saving 20%, active time 98%, cost 100%. Graph-only wins 4, baseline-only wins 0.
- vs B1 · one agent, all tools: 5/5 pairs both succeeded; median token saving 99% (95% CI 98%..99%), active time 98% (95% CI 98%..99%), cost 100% (95% CI 100%..100%). Graph-only wins 0, baseline-only wins 0.

Failed runs: baseline `run_0148188fcb984727` (succeeded, 1/2 assertions); baseline `run_fc5657e8c547429e` (succeeded, 1/2 assertions); baseline `run_33debeb6cb804351` (succeeded, 1/2 assertions); baseline `run_a89d7f6cf720484d` (succeeded, 1/2 assertions).

## Bench: pizza order form (no submit)

| Arm | Runs | Success | Median tokens | In / out | Model calls | Jev calls | Active p50 | Active p95 | Cost/success | Warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph (orchestrated) | 5 | 100% | 1,458 | 1,331 / 127 | 2 | 2 | 1.2 s | 1.2 s | 0.0056c | 5/5 |
| B0 · one call, no tools | 5 | 0% | 1,104 | 280 / 824 | 1 | 0 | 12.8 s | 13.9 s | n/a | 0/5 |
| B1 · one agent, all tools | 5 | 0% | 140,195 | 139,763 / 447 | 6 | 1 | 23.2 s | 26.8 s | n/a | 3/5 |

- vs B0 · one call, no tools: 0/5 pairs both succeeded; median token saving n/a, active time n/a, cost n/a. Graph-only wins 5, baseline-only wins 0.
- vs B1 · one agent, all tools: 0/5 pairs both succeeded; median token saving n/a, active time n/a, cost n/a. Graph-only wins 5, baseline-only wins 0.

Failed runs: baseline `run_9fe9561093e54452` (succeeded, 0/1 assertions); baseline_agent `run_2a51fd19e36d4005` (cancelled, 0/1 assertions, completion not verified); baseline `run_1bf09be5dbc74ce4` (succeeded, 0/1 assertions); baseline_agent `run_9605bdea4dfa4c2c` (cancelled, 0/1 assertions, completion not verified); baseline_agent `run_446da4d1c2664e32` (cancelled, 0/1 assertions, completion not verified); baseline `run_a2b97a4460a34c04` (succeeded, 0/1 assertions); baseline `run_c68a2a17da2349c3` (succeeded, 0/1 assertions); baseline_agent `run_68fbfaa09c55479a` (cancelled, 0/1 assertions, completion not verified); baseline `run_710672832e4f4680` (succeeded, 0/1 assertions); baseline_agent `run_8d01127ab4694cf8` (cancelled, 0/1 assertions, completion not verified).

## Bench: quotes pagination

| Arm | Runs | Success | Median tokens | In / out | Model calls | Jev calls | Active p50 | Active p95 | Cost/success | Warm |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Graph (orchestrated) | 5 | 100% | 1,731 | 1,622 / 109 | 2 | 2 | 5.0 s | 5.1 s | 0.0068c | 5/5 |
| B0 · one call, no tools | 5 | 100% | 1,447 | 307 / 1,140 | 1 | 0 | 14.6 s | 16.2 s | 2.9555c | 0/5 |
| B1 · one agent, all tools | 5 | 0% | 92,405 | 92,017 / 397 | 5 | 1 | 23.5 s | 27.1 s | n/a | 3/5 |

- vs B0 · one call, no tools: 5/5 pairs both succeeded; median token saving -20% (95% CI -35%..-4%), active time 66% (95% CI 62%..69%), cost 100% (95% CI 100%..100%). Graph-only wins 0, baseline-only wins 0.
- vs B1 · one agent, all tools: 0/5 pairs both succeeded; median token saving n/a, active time n/a, cost n/a. Graph-only wins 5, baseline-only wins 0.

Failed runs: baseline_agent `run_c0a87b319b3b429e` (cancelled, 0/2 assertions, completion not verified); baseline_agent `run_a4e47c51afc141e6` (cancelled, 0/2 assertions, completion not verified); baseline_agent `run_95b49cc7af6a4e3a` (cancelled, 0/2 assertions, completion not verified); baseline_agent `run_49dbb6f66f654ac1` (cancelled, 0/2 assertions, completion not verified); baseline_agent `run_fec4b4de6dfe4b14` (cancelled, 0/2 assertions, completion not verified).
