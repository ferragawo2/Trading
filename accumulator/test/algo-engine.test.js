import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/algo-engine.js';

const engine = globalThis.DerivAccumulatorAlgoEngine;

test('qualifying Watch Stats are strictly greater than 15 and less than 45', () => {
  assert.equal(engine.isQualifyingWatchStat(15), false);
  assert.equal(engine.isQualifyingWatchStat(16), true);
  assert.equal(engine.isQualifyingWatchStat(44), true);
  assert.equal(engine.isQualifyingWatchStat(45), false);
});

test('tracker arms at 15, opens at confirmed buy, and requests exit at 18', () => {
  const tracker = engine.createTracker({ symbol: 'BOOM1000', growthRate: 0.01 });
  tracker.observeCount(16, 'run-1');
  tracker.observeCount(0, 'run-2');
  assert.equal(tracker.snapshot().watchStat, 16);
  assert.equal(tracker.snapshot().state, engine.STATES.WAITING_FOR_MATCH);
  assert.deepEqual(tracker.observeCount(15, 'run-2').map(x => x.type), ['ARM_ENTRY']);
  assert.equal(tracker.markBuySubmitted('buy-1'), true);
  assert.deepEqual(tracker.confirmBuy('contract-1', 15).map(x => x.type), ['CONTRACT_OPEN']);
  assert.equal(tracker.snapshot().state, engine.STATES.IN_TRADE);
  assert.deepEqual(tracker.observeCount(16, 'run-2'), []);
  assert.deepEqual(tracker.observeCount(17, 'run-2'), []);
  const exit = tracker.observeCount(18, 'run-2');
  assert.equal(exit[0].type, 'CLOSE_CONTRACT');
  assert.equal(exit[0].late, false);
  assert.equal(tracker.snapshot().state, engine.STATES.CLOSE_PENDING);
  assert.equal(tracker.confirmClose(), true);
  assert.equal(tracker.snapshot().state, engine.STATES.WAITING_FOR_RUN_END);
});

test('a run that ends before the matching count does not trade', () => {
  const tracker = engine.createTracker({ symbol: 'BOOM1000', growthRate: 0.02 });
  tracker.observeCount(16, 'run-1');
  assert.deepEqual(tracker.observeCount(8, 'run-2').map(x => x.type), ['RUN_COMPLETED']);
  assert.deepEqual(tracker.observeCount(0, 'run-3').map(x => x.type), ['RUN_COMPLETED']);
  assert.equal(tracker.snapshot().state, engine.STATES.WAITING_FOR_MATCH);
  assert.equal(tracker.snapshot().watchStat, 16);
});

test('an armed but unsent entry is disarmed when its run cuts', () => {
  const tracker = engine.createTracker({ symbol: 'BOOM1000', growthRate: 0.03 });
  tracker.observeCount(16, 'run-1');
  tracker.observeCount(0, 'run-2');
  assert.equal(tracker.observeCount(15, 'run-2')[0].type, 'ARM_ENTRY');
  assert.deepEqual(tracker.observeCount(0, 'run-3').map(x => x.type), ['RUN_COMPLETED']);
  assert.equal(tracker.snapshot().state, engine.STATES.WAITING_FOR_MATCH);
  assert.equal(tracker.snapshot().watchStat, 16);
});

test('a buy already sent cannot be locally cancelled; late confirmation is immediately closed', () => {
  const tracker = engine.createTracker({ symbol: 'BOOM1000', growthRate: 0.04 });
  tracker.observeCount(16, 'run-1');
  tracker.observeCount(0, 'run-2');
  tracker.observeCount(15, 'run-2');
  tracker.markBuySubmitted('buy-2');
  tracker.observeCount(0, 'run-3');
  assert.equal(tracker.snapshot().entrySignalExpired, true);
  const result = tracker.confirmBuy('late-contract', 0);
  assert.equal(result[0].type, 'CLOSE_CONTRACT');
  assert.equal(result[0].late, true);
});

test('trackers keep their Watch Stats independent', () => {
  const one = engine.createTracker({ symbol: 'BOOM1000', growthRate: 0.01 });
  const two = engine.createTracker({ symbol: 'BOOM1000', growthRate: 0.02 });
  one.observeCount(16, 'one-run');
  one.observeCount(0, 'one-run-next');
  two.observeCount(23, 'two-run');
  two.observeCount(0, 'two-run-next');
  assert.equal(one.snapshot().watchStat, 16);
  assert.equal(two.snapshot().watchStat, 23);
});

test('a completed qualifying non-match refreshes that tracker Watch Stat', () => {
  const tracker = engine.createTracker({ symbol: 'BOOM1000', growthRate: 0.05 });
  tracker.observeCount(35, 'run-1');
  tracker.observeCount(0, 'run-2');
  tracker.observeCount(20, 'run-2');
  tracker.observeCount(0, 'run-3');
  assert.equal(tracker.snapshot().watchStat, 20);
});

test('tick stats payload normalization rejects malformed values', () => {
  assert.deepEqual(engine.normalizeTicksStayedIn(['16', 8, '0']), [16, 8, 0]);
  assert.equal(engine.normalizeTicksStayedIn([16, -1]), null);
  assert.equal(engine.normalizeTicksStayedIn('16'), null);
});

test('tracker set creates four standard trackers and enables the fifth only in aggressive mode', () => {
  assert.deepEqual(engine.createTrackerSet('BOOM1000').map(t => t.growthRate), [0.01, 0.02, 0.03, 0.04]);
  assert.deepEqual(engine.createTrackerSet('BOOM1000', { aggressive: true }).map(t => t.growthRate), [0.01, 0.02, 0.03, 0.04, 0.05]);
});