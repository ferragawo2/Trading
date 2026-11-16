import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/algo-engine.js';

const engine = globalThis.DerivAccumulatorAlgoEngine;

function trackerFor(rate = 0.01) {
  return engine.createTracker({ symbol: 'BOOM1000', growthRate: rate });
}

function seedWatchStat(tracker, stat = 16) {
  tracker.observeCount(stat, 'seed-run');
  tracker.observeCount(0, 'match-run');
  assert.equal(tracker.snapshot().watchStat, stat);
  assert.equal(tracker.snapshot().state, engine.STATES.WAITING_FOR_MATCH);
}

test('Watch Stats are strictly greater than 15 and strictly less than 45', () => {
  assert.equal(engine.isQualifyingWatchStat(15), false);
  assert.equal(engine.isQualifyingWatchStat(16), true);
  assert.equal(engine.isQualifyingWatchStat(44), true);
  assert.equal(engine.isQualifyingWatchStat(45), false);
});

test('the tracker prepares a quote before 15, arms at 15, and exits after two actual contract ticks', () => {
  const tracker = trackerFor();
  seedWatchStat(tracker, 16);

  assert.deepEqual(tracker.observeCount(13, 'match-run').map(action => action.type), ['PREPARE_QUOTE']);
  assert.deepEqual(tracker.observeCount(14, 'match-run'), []);
  assert.deepEqual(tracker.observeCount(15, 'match-run').map(action => action.type), ['ARM_ENTRY']);
  assert.equal(tracker.markBuySubmitted('buy-1'), true);
  assert.equal(tracker.snapshot().state, engine.STATES.BUY_PENDING);

  // The proposal's count reaching 16 does not itself close the contract.
  assert.deepEqual(tracker.observeCount(16, 'match-run'), []);
  assert.deepEqual(tracker.confirmBuy('contract-1').map(action => action.type), ['CONTRACT_OPEN']);
  assert.deepEqual(tracker.observeCount(17, 'match-run'), []);
  assert.deepEqual(tracker.observeCount(18, 'match-run'), []);

  assert.deepEqual(tracker.observeContractUpdate({
    contract_id: 'contract-1',
    entry_spot_time: 100,
    current_spot_time: 100,
    is_valid_to_sell: false,
  }), []);
  assert.deepEqual(tracker.observeContractUpdate({
    contract_id: 'contract-1',
    current_spot_time: 101,
    is_valid_to_sell: false,
  }), []);
  const twoTicks = tracker.observeContractUpdate({
    contract_id: 'contract-1',
    current_spot_time: 102,
    is_valid_to_sell: false,
  });
  assert.deepEqual(twoTicks, []);
  assert.equal(tracker.snapshot().ticksAfterEntry, 2);
  assert.equal(tracker.snapshot().closeWhenSellable, true);

  // It waits if Deriv has not yet marked the contract sellable, then closes
  // on the first update that says selling is allowed.
  const close = tracker.observeContractUpdate({
    contract_id: 'contract-1',
    current_spot_time: 102,
    is_valid_to_sell: true,
  });
  assert.equal(close[0].type, 'CLOSE_CONTRACT');
  assert.equal(close[0].ticksAfterEntry, 2);
  assert.equal(tracker.snapshot().state, engine.STATES.CLOSE_PENDING);

  tracker.markCloseFailed('temporary sell error');
  assert.equal(tracker.snapshot().state, engine.STATES.IN_TRADE);
  const retry = tracker.observeContractUpdate({
    contract_id: 'contract-1',
    current_spot_time: 102,
    is_valid_to_sell: true,
  });
  assert.equal(retry[0].type, 'CLOSE_CONTRACT');

  const settled = tracker.observeContractUpdate({
    contract_id: 'contract-1',
    is_sold: true,
    status: 'sold',
  });
  assert.equal(settled[0].type, 'CONTRACT_SETTLED');
  assert.equal(tracker.snapshot().state, engine.STATES.WAITING_FOR_RUN_END);
});

test('a non-qualifying cut while waiting clears the old Watch Stat', () => {
  const tracker = trackerFor(0.02);
  seedWatchStat(tracker, 16);

  tracker.observeCount(8, 'match-run');
  tracker.observeCount(0, 'following-run');
  assert.equal(tracker.snapshot().watchStat, null);
  assert.equal(tracker.snapshot().state, engine.STATES.OBSERVING);

  // A later qualifying cut becomes the new Watch Stat.
  tracker.observeCount(22, 'following-run');
  tracker.observeCount(0, 'next-run');
  assert.equal(tracker.snapshot().watchStat, 22);
  assert.equal(tracker.snapshot().state, engine.STATES.WAITING_FOR_MATCH);
});

test('an armed but unsent entry is cancelled when its sequence cuts before the target', () => {
  const tracker = trackerFor(0.03);
  seedWatchStat(tracker, 16);
  tracker.observeCount(15, 'match-run');
  assert.equal(tracker.snapshot().state, engine.STATES.ARMED);

  tracker.observeCount(0, 'next-run');
  assert.equal(tracker.snapshot().state, engine.STATES.OBSERVING);
  assert.equal(tracker.snapshot().watchStat, null);
  assert.equal(tracker.markBuySubmitted('must-not-buy'), false);
});

test('an armed entry cannot be sent after the matching count has already arrived', () => {
  const tracker = trackerFor(0.04);
  seedWatchStat(tracker, 16);
  tracker.observeCount(15, 'match-run');
  const actions = tracker.observeCount(16, 'match-run');

  assert.equal(actions[0].type, 'CANCEL_ARMED_ENTRY');
  assert.equal(tracker.snapshot().state, engine.STATES.WAITING_FOR_RUN_END);
  assert.equal(tracker.markBuySubmitted('late'), false);
});

test('a buy already sent cannot be locally cancelled; a late fill is closed immediately when sellable', () => {
  const tracker = trackerFor(0.05);
  seedWatchStat(tracker, 16);
  tracker.observeCount(15, 'match-run');
  assert.equal(tracker.markBuySubmitted('buy-2'), true);

  // The run cuts while the buy request is still in flight.
  tracker.observeCount(0, 'next-run');
  assert.equal(tracker.snapshot().entrySignalExpired, true);
  tracker.confirmBuy('late-contract');

  const close = tracker.observeContractUpdate({
    contract_id: 'late-contract',
    entry_spot_time: 200,
    current_spot_time: 200,
    is_valid_to_sell: true,
  });
  assert.equal(close[0].type, 'CLOSE_CONTRACT');
  assert.equal(close[0].ticksAfterEntry, 0);
  assert.equal(tracker.snapshot().state, engine.STATES.CLOSE_PENDING);
});

test('a pending buy that is acknowledged after the matching count is marked late', () => {
  const tracker = trackerFor();
  seedWatchStat(tracker, 16);
  tracker.observeCount(15, 'match-run');
  tracker.markBuySubmitted('buy-3');
  tracker.observeCount(16, 'match-run');
  tracker.observeCount(17, 'match-run');

  tracker.confirmBuy('late-contract-2');
  assert.equal(tracker.snapshot().closeWhenSellable, true);
  const close = tracker.observeContractUpdate({
    contract_id: 'late-contract-2',
    entry_spot_time: 300,
    current_spot_time: 300,
    is_valid_to_sell: true,
  });
  assert.equal(close[0].type, 'CLOSE_CONTRACT');
});

test('after a contract settles, the tracker waits for the current run to finish before relearning', () => {
  const tracker = trackerFor();
  seedWatchStat(tracker, 16);
  tracker.observeCount(15, 'match-run');
  tracker.markBuySubmitted('buy-4');
  tracker.confirmBuy('contract-4');
  tracker.observeCount(16, 'match-run');
  tracker.observeContractUpdate({ contract_id: 'contract-4', entry_spot_time: 400, current_spot_time: 400 });
  tracker.observeContractUpdate({ contract_id: 'contract-4', current_spot_time: 401 });
  tracker.observeContractUpdate({ contract_id: 'contract-4', current_spot_time: 402, is_sold: true });

  tracker.observeCount(12, 'match-run');
  assert.equal(tracker.snapshot().state, engine.STATES.WAITING_FOR_RUN_END);
  tracker.observeCount(0, 'after-settlement-run');
  assert.equal(tracker.snapshot().watchStat, 12 === 16 ? 16 : null);
  assert.equal(tracker.snapshot().state, engine.STATES.OBSERVING);
});

test('trackers keep their Watch Stats independent', () => {
  const one = trackerFor(0.01);
  const two = trackerFor(0.02);
  seedWatchStat(one, 16);
  seedWatchStat(two, 23);
  assert.equal(one.snapshot().watchStat, 16);
  assert.equal(two.snapshot().watchStat, 23);
});

test('a qualifying completed non-match refreshes that tracker Watch Stat', () => {
  const tracker = trackerFor(0.03);
  seedWatchStat(tracker, 16);
  tracker.observeCount(20, 'match-run');
  tracker.observeCount(0, 'new-run');
  assert.equal(tracker.snapshot().watchStat, 20);
});

test('contract restoration resumes monitoring without creating a new entry', () => {
  const tracker = trackerFor(0.04);
  tracker.restoreContract({
    contractId: 'restored-1',
    watchStat: 16,
    ticksAfterEntry: 1,
    entrySpotTime: 500,
    lastContractSpotTime: 501,
  });
  assert.equal(tracker.snapshot().state, engine.STATES.IN_TRADE);
  assert.equal(tracker.snapshot().contractId, 'restored-1');
  const close = tracker.observeContractUpdate({
    contract_id: 'restored-1',
    current_spot_time: 502,
    is_valid_to_sell: true,
  });
  assert.equal(close[0].type, 'CLOSE_CONTRACT');
});

test('tick stats payload normalization rejects malformed values', () => {
  assert.deepEqual(engine.normalizeTicksStayedIn(['16', 8, '0']), [16, 8, 0]);
  assert.equal(engine.normalizeTicksStayedIn([16, -1]), null);
  assert.equal(engine.normalizeTicksStayedIn('16'), null);
});

test('tracker set creates four standard trackers and adds the fifth only in aggressive mode', () => {
  assert.deepEqual(engine.createTrackerSet('BOOM1000').map(tracker => tracker.growthRate), [0.01, 0.02, 0.03, 0.04]);
  assert.deepEqual(engine.createTrackerSet('BOOM1000', { aggressive: true }).map(tracker => tracker.growthRate), [0.01, 0.02, 0.03, 0.04, 0.05]);
});
