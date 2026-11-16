(function attachAccumulatorAlgoEngine(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.DerivAccumulatorAlgoEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAccumulatorAlgoEngine() {
  'use strict';

  const GROWTH_RATES = Object.freeze([0.01, 0.02, 0.03, 0.04, 0.05]);
  const STATES = Object.freeze({
    OBSERVING: 'OBSERVING',
    WAITING_FOR_MATCH: 'WAITING_FOR_MATCH',
    ARMED: 'ARMED',
    BUY_PENDING: 'BUY_PENDING',
    IN_TRADE: 'IN_TRADE',
    CLOSE_PENDING: 'CLOSE_PENDING',
    WAITING_FOR_RUN_END: 'WAITING_FOR_RUN_END',
    PAUSED: 'PAUSED',
  });

  function isQualifyingWatchStat(value, minExclusive = 15, maxExclusive = 45) {
    return Number.isInteger(value) && value > minExclusive && value < maxExclusive;
  }

  function normalizeTicksStayedIn(raw) {
    if (!Array.isArray(raw)) return null;
    const values = raw.map(value => {
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim() !== '') return Number(value);
      return NaN;
    });
    if (!values.length || values.some(value => !Number.isInteger(value) || value < 0)) return null;
    return values;
  }

  class Tracker {
    constructor({ symbol, growthRate, minExclusive = 15, maxExclusive = 45, exitOffset = 2 } = {}) {
      if (!symbol || typeof symbol !== 'string') throw new TypeError('A market symbol is required.');
      if (!GROWTH_RATES.includes(Number(growthRate))) throw new RangeError('Growth rate must be 1%, 2%, 3%, 4%, or 5%.');
      if (!Number.isInteger(exitOffset) || exitOffset < 1) throw new RangeError('Exit offset must be a positive integer.');
      this.symbol = symbol;
      this.growthRate = Number(growthRate);
      this.minExclusive = minExclusive;
      this.maxExclusive = maxExclusive;
      this.exitOffset = exitOffset;
      this.state = STATES.OBSERVING;
      this.watchStat = null;
      this.currentCount = null;
      this.lastCount = null;
      this.sequenceId = null;
      this.sequenceNumber = 0;
      this.contractId = null;
      this.buyRequestId = null;
      this.closeRequestId = null;
      this.entryTarget = null;
      this.exitTarget = null;
      this.entryConfirmedAtCount = null;
      this.entrySignalExpired = false;
      this.lastAction = 'Waiting for a qualifying completed run';
      this.lastCompletedStat = null;
      this.completedRuns = 0;
      this.trades = 0;
      this.closeRequested = false;
    }

    snapshot() {
      return {
        symbol: this.symbol,
        growthRate: this.growthRate,
        state: this.state,
        watchStat: this.watchStat,
        currentCount: this.currentCount,
        sequenceId: this.sequenceId,
        sequenceNumber: this.sequenceNumber,
        contractId: this.contractId,
        entryTarget: this.entryTarget,
        exitTarget: this.exitTarget,
        entrySignalExpired: this.entrySignalExpired,
        lastAction: this.lastAction,
        lastCompletedStat: this.lastCompletedStat,
        completedRuns: this.completedRuns,
        trades: this.trades,
      };
    }

    _seedFromCompletedRun(stat) {
      this.lastCompletedStat = stat;
      this.completedRuns += 1;
      if (isQualifyingWatchStat(stat, this.minExclusive, this.maxExclusive)) {
        this.watchStat = stat;
        this.entryTarget = stat;
        this.exitTarget = stat + this.exitOffset;
        this.state = STATES.WAITING_FOR_MATCH;
        this.lastAction = 'Watch Stat ' + stat + ' saved; waiting for the next matching run';
      } else if (this.state !== STATES.WAITING_FOR_MATCH || this.watchStat === null) {
        this.watchStat = null;
        this.entryTarget = null;
        this.exitTarget = null;
        this.state = STATES.OBSERVING;
        this.lastAction = 'Completed stat ' + stat + ' is outside the qualifying range';
      } else {
        this.lastAction = 'Completed stat ' + stat + ' did not match Watch Stat ' + this.watchStat + '; retaining the watch';
      }
    }

    _completeCurrentRun() {
      if (!Number.isInteger(this.lastCount)) return null;
      const completed = this.lastCount;
      if (this.state === STATES.ARMED) {
        this.state = this.watchStat === null ? STATES.OBSERVING : STATES.WAITING_FOR_MATCH;
        this.lastAction = 'Entry arm cancelled: run ended before ' + this.watchStat;
        if (isQualifyingWatchStat(completed, this.minExclusive, this.maxExclusive)) this._seedFromCompletedRun(completed);
      } else if (this.state === STATES.BUY_PENDING) {
        this.entrySignalExpired = true;
        this.lastAction = 'Entry signal expired while the buy request was in flight; reconciling Deriv response';
      } else if (this.state === STATES.WAITING_FOR_RUN_END) {
        this._seedFromCompletedRun(completed);
      } else if (this.state === STATES.WAITING_FOR_MATCH) {
        if (isQualifyingWatchStat(completed, this.minExclusive, this.maxExclusive)) {
          this._seedFromCompletedRun(completed);
        } else {
          this.completedRuns += 1;
          this.lastCompletedStat = completed;
          this.lastAction = 'Run ended at ' + completed + '; waiting for a qualifying run';
        }
      } else if (this.state === STATES.OBSERVING) {
        this._seedFromCompletedRun(completed);
      }
      return completed;
    }

    observeCount(count, sequenceId = null) {
      if (!Number.isInteger(count) || count < 0) return [];
      const actions = [];
      const suppliedSequence = sequenceId === null || sequenceId === undefined ? null : String(sequenceId);

      if (suppliedSequence !== null && this.sequenceId !== null && suppliedSequence !== this.sequenceId) {
        const completed = this._completeCurrentRun();
        if (completed !== null) actions.push({ type: 'RUN_COMPLETED', stat: completed });
        this.lastCount = null;
        this.sequenceNumber += 1;
      } else if (this.lastCount !== null && count < this.lastCount) {
        const completed = this._completeCurrentRun();
        if (completed !== null) actions.push({ type: 'RUN_COMPLETED', stat: completed });
        this.sequenceNumber += 1;
        this.lastCount = null;
      }

      if (suppliedSequence !== null) this.sequenceId = suppliedSequence;
      this.currentCount = count;

      if (this.state === STATES.IN_TRADE && this.exitTarget !== null && count >= this.exitTarget && !this.closeRequested) {
        this.closeRequested = true;
        this.state = STATES.CLOSE_PENDING;
        this.lastAction = 'Exit requested at stat ' + count + '; target was ' + this.exitTarget;
        actions.push({ type: 'CLOSE_CONTRACT', contractId: this.contractId, targetStat: this.exitTarget, observedStat: count, late: count > this.exitTarget });
      } else if (this.state === STATES.WAITING_FOR_MATCH && this.watchStat !== null && count === this.watchStat - 1) {
        this.state = STATES.ARMED;
        this.lastAction = 'Entry armed before matching stat ' + this.watchStat;
        actions.push({ type: 'ARM_ENTRY', watchStat: this.watchStat, expectedEntryStat: this.watchStat, sequenceNumber: this.sequenceNumber });
      } else if (this.state === STATES.WAITING_FOR_MATCH && this.watchStat !== null && count >= this.watchStat) {
        this.lastAction = 'Missed pre-entry arm for stat ' + this.watchStat + '; no late buy';
        this.state = STATES.WAITING_FOR_RUN_END;
        this.watchStat = null;
        this.entryTarget = null;
        this.exitTarget = null;
        actions.push({ type: 'MISSED_ENTRY', observedStat: count });
      }

      this.lastCount = count;
      return actions;
    }

    markBuySubmitted(requestId = null) {
      if (this.state !== STATES.ARMED) return false;
      this.state = STATES.BUY_PENDING;
      this.buyRequestId = requestId;
      this.lastAction = 'Buy request sent to Deriv; waiting for confirmation';
      return true;
    }

    confirmBuy(contractId, observedCount = this.currentCount) {
      if (contractId === null || contractId === undefined || contractId === '') throw new TypeError('A confirmed Deriv contract ID is required.');
      if (this.state !== STATES.BUY_PENDING && this.state !== STATES.ARMED) return [];
      this.contractId = contractId;
      this.trades += 1;
      this.entryConfirmedAtCount = Number.isInteger(observedCount) ? observedCount : null;
      this.closeRequested = false;
      if (this.entrySignalExpired || (Number.isInteger(observedCount) && this.exitTarget !== null && observedCount >= this.exitTarget)) {
        this.state = STATES.CLOSE_PENDING;
        this.closeRequested = true;
        this.lastAction = 'Late buy confirmed after its entry window; immediately requesting contract closure';
        return [{ type: 'CLOSE_CONTRACT', contractId, targetStat: this.exitTarget, observedStat: observedCount, late: true }];
      }
      this.state = STATES.IN_TRADE;
      this.lastAction = 'Contract ' + contractId + ' confirmed; exit target ' + this.exitTarget;
      return [{ type: 'CONTRACT_OPEN', contractId, exitTarget: this.exitTarget }];
    }

    confirmClose() {
      if (this.state !== STATES.CLOSE_PENDING) return false;
      this.contractId = null;
      this.buyRequestId = null;
      this.closeRequestId = null;
      this.closeRequested = false;
      this.entrySignalExpired = false;
      this.watchStat = null;
      this.entryTarget = null;
      this.exitTarget = null;
      this.state = STATES.WAITING_FOR_RUN_END;
      this.lastAction = 'Contract closed; waiting for the current counting run to finish';
      return true;
    }

    confirmNaturalSettlement() {
      if (![STATES.IN_TRADE, STATES.CLOSE_PENDING].includes(this.state)) return false;
      this.contractId = null;
      this.buyRequestId = null;
      this.closeRequestId = null;
      this.closeRequested = false;
      this.entrySignalExpired = false;
      this.watchStat = null;
      this.entryTarget = null;
      this.exitTarget = null;
      this.state = STATES.WAITING_FOR_RUN_END;
      this.lastAction = 'Contract settled; waiting for the current counting run to finish';
      return true;
    }

    pause(reason = 'Paused by user') {
      if (this.state === STATES.BUY_PENDING || this.state === STATES.IN_TRADE || this.state === STATES.CLOSE_PENDING) {
        this.lastAction = 'Pause requested; existing contract/request still requires management: ' + reason;
        return false;
      }
      this.state = STATES.PAUSED;
      this.lastAction = reason;
      return true;
    }

    resume() {
      if (this.state !== STATES.PAUSED) return false;
      this.state = this.watchStat === null ? STATES.OBSERVING : STATES.WAITING_FOR_MATCH;
      this.lastAction = 'Resumed';
      return true;
    }
  }

  function createTracker(options) {
    return new Tracker(options);
  }

  function createTrackerSet(symbol, { aggressive = false, minExclusive = 15, maxExclusive = 45, exitOffset = 2 } = {}) {
    const rates = aggressive ? GROWTH_RATES : GROWTH_RATES.slice(0, 4);
    return rates.map(growthRate => createTracker({ symbol, growthRate, minExclusive, maxExclusive, exitOffset }));
  }

  return Object.freeze({ GROWTH_RATES, STATES, Tracker, createTracker, createTrackerSet, isQualifyingWatchStat, normalizeTicksStayedIn });
});