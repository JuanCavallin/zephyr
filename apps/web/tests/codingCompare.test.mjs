import assert from 'node:assert/strict';
import test from 'node:test';
import { comparabilityNote, headline, modeNote, savingsLabel, spreadLabel, verdictNote } from '../src/lib/codingCompare.ts';

const spread = (median, p25 = median, p75 = median) => ({ median, p25, p75 });
const metrics = (total, cost) => ({
  inputTokens: spread(total * 0.9),
  outputTokens: spread(total * 0.1),
  cacheReadTokens: spread(0),
  cacheWriteTokens: spread(0),
  totalTokens: spread(total, total * 0.8, total * 1.2),
  costUsd: spread(cost),
  wallMs: spread(60_000),
  approvals: spread(0),
  stuckBlocks: spread(0),
});
const arm = (id, extra = {}) => ({
  arm: id,
  label: id,
  purpose: '',
  diffFromVanilla: [],
  runs: 6,
  passed: 6,
  passRate: 1,
  networkExcluded: 0,
  metrics: metrics(14000, 0.2),
  comparability: 'baseline',
  noise: 0,
  ...extra,
});
const report = (arms, mode = 'mock') => ({
  protocol: 'zephyr-coding-benchmark-v1',
  mode,
  generatedAt: 't',
  minRunsPerCell: 3,
  tasks: ['t1', 't2'],
  arms,
  cells: [],
  levers: [],
});

test('spreads show the median and the interquartile range', () => {
  assert.equal(spreadLabel(spread(14200, 12000, 16000), 'tokens'), '14k (12k–16k)');
  assert.equal(spreadLabel(spread(0.123, 0.1, 0.15), 'usd'), '$0.12 ($0.10–$0.15)');
  assert.equal(spreadLabel(spread(65_000), 'ms'), '65.0s');
  assert.equal(spreadLabel(spread(0.0093, 0.0088, 0.0098), 'usd'), '$0.0093 ($0.0088–$0.0098)');
});

test('savings appear only for comparable arms', () => {
  assert.equal(savingsLabel(arm('vanilla')), null);
  assert.equal(savingsLabel(arm('supervised', { comparability: 'insufficient' })), null);
  assert.equal(
    savingsLabel(
      arm('supervised', {
        comparability: 'comparable',
        savings: { totalTokens: 0.42, inputTokens: 0.5, costUsd: 0.31, wallMs: -0.05, tasks: 2 },
      }),
    ),
    '42% fewer tokens · 31% lower cost · 5% slower, paired over 2 tasks',
  );
});

test('the headline never claims a saving the report does not support', () => {
  const vanilla = arm('vanilla');
  const comparable = arm('supervised', {
    comparability: 'comparable',
    savings: { totalTokens: 0.4, inputTokens: 0.4, costUsd: 0.4, wallMs: 0.1, tasks: 2 },
  });
  assert.equal(headline(report([vanilla, comparable])).claim, '40% fewer tokens at the same pass rate');

  const worse = arm('supervised', { comparability: 'not_comparable', passRate: 0.5 });
  const h = headline(report([vanilla, worse]));
  assert.equal(h.claim, null);
  assert.match(h.reason, /pass rate/);

  const thin = arm('supervised', { comparability: 'insufficient', runs: 2 });
  assert.match(headline(report([vanilla, thin])).reason, /3 runs per task/);

  assert.match(headline(report([vanilla])).reason, /No supervised runs/);
  assert.match(headline(report([], 'empty')).reason, /No runs/);
});

test('mode notes keep mock numbers from reading as real cost', () => {
  assert.match(modeNote('mock'), /scripted harness/);
  assert.match(modeNote('mixed'), /mix/);
  assert.equal(modeNote('live'), null);
});

test('comparability and lever verdicts read in plain words', () => {
  assert.match(comparabilityNote(arm('loo-L1', { comparability: 'not_comparable', passRate: 0.5, noise: 0.2 })), /below/);
  assert.equal(comparabilityNote(arm('vanilla')), 'Baseline');
  assert.match(verdictNote({ arm: 'loo-L1', lever: 'L1', verdict: 'harmful', passWith: 0.5, passWithout: 1, noise: 0.2 }), /hurts/);
  assert.match(verdictNote({ arm: 'loo-L1', lever: 'L1', verdict: 'insufficient', passWith: 1, passWithout: 1, noise: 0 }), /Not enough/);
});
