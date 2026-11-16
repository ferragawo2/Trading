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
    constructor({ symbol, growthRate, minExclusive = 15, maxExclusive = 45 } = {}) {
      if (!symbol || typeof symbol !== 'string') throw new TypeError('A market symbol is required.');
      if (!GROWTH_RATES.includes(Number(growthRate))) throw new RangeError('Growth rate must be 1%, 2%, 3%, 4%, or 5%.');
      if (!Number.isInteger(minExclusive) || !Number.isInteger(maxExclusive) || minExclusive >= maxExclusive) {
        throw new RangeError('A valid Watch Stat range is required.');
      }
      this.symbol = symbol;
      this.growthRate = Number(growthRate);
      this.minExclusive = minExclusive;
      this.maxExclusive = maxExclusive;
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
      this.entrySignalExpired = false;
      this.quoteRequestedForSequence = null;
      this.ticksAfterEntry = 0;
      this.entrySpotTime = null;
      this.lastContractSpotTime = null;
      this.closeWhenSellable = false;
      this.closeRequested = false;
      this.lastAction = 'Waiting for a qualifying completed run';
      this.lastCompletedStat = null;
      this.completedRuns = 0;
      this.trades = 0;
    }

    seedFromCompletedStat(stat) {
      if (this._busy() || this.state === STATES.ARMED || this.state === STATES.BUY_PENDING) return false;
      if (!isQualifyingWatchStat(stat, this.minExclusive, this.maxExclusive)) return false;
      this.lastCompletedStat = stat;
      this.watchStat = stat;
      this.entryTarget = stat;
      this.exitTarget = stat;
      this.state = STATES.WAITING_FOR_MATCH;
      this.lastAction = 'Restored Watch Stat ' + stat + '; waiting for the next matching run';
      return true;
    }

    skipArmedEntry(reason = 'Entry skipped; waiting for the counting run to finish') {
      if (this.state !== STATES.ARMED) return false;
      this.watchStat = null;
      this.entryTarget = null;
      this.exitTarget = null;
      this.state = STATES.WAITING_FOR_RUN_END;
      this.lastAction = String(reason);
      return true;
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
        ticksAfterEntry: this.ticksAfterEntry,
        closeWhenSellable: this.closeWhenSellable,
        closeRequested: this.closeRequested,
        lastAction: this.lastAction,
        lastCompletedStat: this.lastCompletedStat,
        completedRuns: this.completedRuns,
        trades: this.trades,
      };
    }

    _busy() {
      return [STATES.BUY_PENDING, STATES.IN_TRADE, STATES.CLOSE_PENDING].includes(this.state);
    }

    _saveOrClearWatch(stat, reason) {
      this.lastCompletedStat = stat;
      this.completedRuns += 1;
      this.entryTarget = null;
      this.exitTarget = null;
      this.quoteRequestedForSequence = null;

      if (isQualifyingWatchStat(stat, this.minExclusive, this.maxExclusive)) {
        this.watchStat = stat;
        this.entryTarget = stat;
        this.exitTarget = stat;
        this.state = STATES.WAITING_FOR_MATCH;
        this.lastAction = 'Watch Stat ' + stat + ' saved; waiting for the next run to reach ' + stat;
      } else {
        this.watchStat = null;
        this.state = STATES.OBSERVING;
        this.lastAction = reason || ('Completed stat ' + stat + ' is outside the qualifying range');
      }
    }

    _completeCurrentRun() {
      if (!Number.isInteger(this.lastCount)) return null;
      const completed = this.lastCount;

      // A submitted buy or a live position owns the tracker until Deriv confirms settlement.
      // A cut observed while busy is deliberately not used as a new Watch Stat.
      if (this._busy()) {
        if (this.state === STATES.BUY_PENDING) this.entrySignalExpired = true;
        this.lastCompletedStat = completed;
        this.completedRuns += 1;
        this.lastAction = this.state === STATES.BUY_PENDING
          ? 'Run cut while buy was in flight; late fills will be closed as soon as sellable'
          : 'Run cut while contract was active; waiting for contract settlement';
        return completed;
      }

      if (this.state === STATES.PAUSED) {
        this._saveOrClearWatch(completed, 'Run completed while paused; waiting to resume');
        this.state = STATES.PAUSED;
        return completed;
      }

      if (this.state === STATES.ARMED) {
        this.lastAction = 'Entry arm cancelled: run ended before the matching stat';
      } else if (this.state === STATES.WAITING_FOR_RUN_END) {
        this.lastAction = 'Post-trade counting run completed';
      }

      this._saveOrClearWatch(completed);
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
        this.quoteRequestedForSequence = null;
      } else if (this.lastCount !== null && count < this.lastCount) {
        const completed = this._completeCurrentRun();
        if (completed !== null) actions.push({ type: 'RUN_COMPLETED', stat: completed });
        this.sequenceNumber += 1;
        this.lastCount = null;
        this.quoteRequestedForSequence = null;
      }

      if (suppliedSequence !== null) this.sequenceId = suppliedSequence;
      this.currentCount = count;

      if (this.state === STATES.WAITING_FOR_MATCH && this.watchStat !== null) {
        const preEntryCount = this.watchStat - 1;

        // Quote preparation is deliberately earlier than the final pre-entry tick.
        if (count >= this.watchStat - 3 && count < preEntryCount &&
            this.quoteRequestedForSequence !== this.sequenceNumber) {
          this.quoteRequestedForSequence = this.sequenceNumber;
          actions.push({
            type: 'PREPARE_QUOTE',
            watchStat: this.watchStat,
            count,
            growthRate: this.growthRate,
            sequenceNumber: this.sequenceNumber,
          });
        }

        if (count === preEntryCount) {
          this.state = STATES.ARMED;
          this.lastAction = 'Entry armed at ' + count + '; buy must be submitted before ' + this.watchStat;
          actions.push({
            type: 'ARM_ENTRY',
            watchStat: this.watchStat,
            expectedEntryStat: this.watchStat,
            count,
            growthRate: this.growthRate,
            sequenceNumber: this.sequenceNumber,
          });
        } else if (count >= this.watchStat) {
          this.state = STATES.WAITING_FOR_RUN_END;
          this.watchStat = null;
          this.entryTarget = null;
          this.exitTarget = null;
          this.lastAction = 'Matching count passed without a timely buy; no late entry';
          actions.push({ type: 'MISSED_ENTRY', observedStat: count });
        }
      } else if (this.state === STATES.ARMED && this.watchStat !== null && count >= this.watchStat) {
        // An arm that has not yet submitted a buy is cancelled at the matching tick.
        this.state = STATES.WAITING_FOR_RUN_END;
        this.watchStat = null;
        this.entryTarget = null;
        this.exitTarget = null;
        this.lastAction = 'Unsubmitted entry cancelled: matching count arrived before the buy was sent';
        actions.push({ type: 'CANCEL_ARMED_ENTRY', observedStat: count });
      }

      this.lastCount = count;
      return actions;
    }

    markBuySubmitted(requestId = null) {
      if (this.state !== STATES.ARMED || this.entrySignalExpired ||
          !Number.isInteger(this.watchStat) || this.currentCount !== this.watchStat - 1) return false;
      this.state = STATES.BUY_PENDING;
      this.buyRequestId = requestId;
      this.lastAction = 'Buy request sent from the pre-entry count; waiting for Deriv confirmation';
      return true;
    }

    confirmBuy(contractId) {
      if (contractId === null || contractId === undefined || contractId === '') {
        throw new TypeError('A confirmed Deriv contract ID is required.');
      }
      if (![STATES.BUY_PENDING, STATES.ARMED].includes(this.state)) return [];
      this.contractId = String(contractId);
      this.trades += 1;
      this.ticksAfterEntry = 0;
      this.entrySpotTime = null;
      this.lastContractSpotTime = null;
      this.closeWhenSellable = this.entrySignalExpired;
      this.closeRequested = false;
      this.state = STATES.IN_TRADE;
      this.lastAction = this.entrySignalExpired
        ? 'Late buy confirmed after the signal expired; closing as soon as Deriv permits'
        : 'Contract ' + contractId + ' confirmed; monitoring two post-entry ticks';
      return [{ type: 'CONTRACT_OPEN', contractId: this.contractId, late: this.entrySignalExpired }];
    }

    observeContractUpdate(contract = {}) {
      if (!this.contractId || ![STATES.IN_TRADE, STATES.CLOSE_PENDING].includes(this.state)) return [];
      const actions = [];
      const entryTime = contract.entry_spot_time === null || contract.entry_spot_time === undefined || contract.entry_spot_time === ''
        ? NaN : Number(contract.entry_spot_time);
      const currentTime = contract.current_spot_time === null || contract.current_spot_time === undefined || contract.current_spot_time === ''
        ? NaN : Number(contract.current_spot_time);

      if (Number.isFinite(entryTime)) this.entrySpotTime = entryTime;
      if (Number.isFinite(currentTime)) {
        if (this.entrySpotTime === null) {
          this.entrySpotTime = currentTime;
        } else if (currentTime > this.entrySpotTime && currentTime !== this.lastContractSpotTime) {
          this.ticksAfterEntry += 1;
        }
        this.lastContractSpotTime = currentTime;
      }

      const sold = contract.is_sold === true || Number(contract.is_sold) === 1 ||
        contract.is_expired === true || Number(contract.is_expired) === 1 ||
        contract.is_open === false ||
        ['won', 'lost', 'sold', 'expired'].includes(String(contract.status || '').toLowerCase());

      if (sold) {
        this.confirmNaturalSettlement();
        actions.push({ type: 'CONTRACT_SETTLED', contractId: String(contract.contract_id || this.contractId) });
        return actions;
      }

      if (this.ticksAfterEntry >= 2) this.closeWhenSellable = true;
      const canSell = contract.is_valid_to_sell === true || Number(contract.is_valid_to_sell) === 1;
      if (this.closeWhenSellable && canSell && !this.closeRequested) {
        this.closeRequested = true;
        this.state = STATES.CLOSE_PENDING;
        this.lastAction = 'Two post-entry ticks completed; sending automatic close';
        actions.push({
          type: 'CLOSE_CONTRACT',
          contractId: this.contractId,
          ticksAfterEntry: this.ticksAfterEntry,
        });
      } else if (this.closeWhenSellable && !canSell) {
        this.lastAction = 'Two post-entry ticks completed; waiting for Deriv to make the contract sellable';
      } else {
        this.lastAction = 'Contract active · ' + Math.min(2, this.ticksAfterEntry) + '/2 post-entry ticks';
      }
      return actions;
    }

    markCloseSubmitted(requestId = null) {
      if (this.state !== STATES.CLOSE_PENDING) return false;
      this.closeRequestId = requestId;
      return true;
    }

    markCloseFailed(message = 'Automatic close request failed') {
      if (!this.contractId) return false;
      this.closeRequested = false;
      this.closeWhenSellable = true;
      this.state = STATES.IN_TRADE;
      this.lastAction = String(message) + '; close will retry on the next sellable update';
      return true;
    }

    confirmNaturalSettlement() {
      if (![STATES.IN_TRADE, STATES.CLOSE_PENDING].includes(this.state)) return false;
      this.contractId = null;
      this.buyRequestId = null;
      this.closeRequestId = null;
      this.closeRequested = false;
      this.closeWhenSellable = false;
      this.entrySignalExpired = false;
      this.watchStat = null;
      this.entryTarget = null;
      this.exitTarget = null;
      this.quoteRequestedForSequence = null;
      this.state = STATES.WAITING_FOR_RUN_END;
      this.lastAction = 'Contract settled; waiting for the current counting run to finish';
      return true;
    }

    buyFailed(message = 'Deriv rejected the purchase') {
      if (this.state !== STATES.BUY_PENDING) return false;
      this.buyRequestId = null;
      this.entrySignalExpired = false;
      this.watchStat = null;
      this.entryTarget = null;
      this.exitTarget = null;
      this.state = STATES.WAITING_FOR_RUN_END;
      this.lastAction = String(message) + '; no second buy attempt in this run';
      return true;
    }

    restoreContract(record = {}) {
      if (!record.contractId) throw new TypeError('A contract ID is required to restore an open position.');
      this.contractId = String(record.contractId);
      this.watchStat = Number.isInteger(record.watchStat) ? record.watchStat : this.watchStat;
      this.entryTarget = this.watchStat;
      this.exitTarget = this.watchStat;
      this.ticksAfterEntry = Math.max(0, Number(record.ticksAfterEntry) || 0);
      this.entrySpotTime = Number.isFinite(Number(record.entrySpotTime)) ? Number(record.entrySpotTime) : null;
      this.lastContractSpotTime = Number.isFinite(Number(record.lastContractSpotTime)) ? Number(record.lastContractSpotTime) : null;
      this.closeWhenSellable = record.closeWhenSellable === true || this.ticksAfterEntry >= 2;
      // A pre-refresh sell request cannot be assumed to have completed.
      // Reconcile against the live Deriv contract and retry if it is still sellable.
      this.closeRequested = false;
      this.closeRequestId = null;
      this.state = STATES.IN_TRADE;
      this.lastAction = 'Restored open contract; reconciling its live status with Deriv';
      return this.snapshot();
    }

    pause(reason = 'Paused by user') {
      if (this._busy()) {
        this.lastAction = 'New entries paused; existing contract/request still requires management: ' + reason;
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

  function createTrackerSet(symbol, { aggressive = false, minExclusive = 15, maxExclusive = 45 } = {}) {
    const rates = aggressive ? GROWTH_RATES : GROWTH_RATES.slice(0, 4);
    return rates.map(growthRate => createTracker({ symbol, growthRate, minExclusive, maxExclusive }));
  }

  return Object.freeze({
    GROWTH_RATES,
    STATES,
    Tracker,
    createTracker,
    createTrackerSet,
    isQualifyingWatchStat,
    normalizeTicksStayedIn,
  });
});
