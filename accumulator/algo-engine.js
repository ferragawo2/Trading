(() => {
  "use strict";

  const MIN_WATCH_STAT = 16;
  const MAX_WATCH_STAT = 44;
  const DEFAULT_QUOTE_MAX_AGE_MS = 12000;
  const ALL_RATES = [0.01, 0.02, 0.03, 0.04, 0.05];

  let config = null;
  let callbacks = {};
  let running = false;
  let trackers = new Map();
  let contracts = new Map();
  let eventHistory = [];

  const rateKey = rate => Number(rate).toFixed(2);
  const validWatchStat = value =>
    Number.isInteger(value) && value > 15 && value < 45;

  function createTracker(rate, initialCurrent = null) {
    return {
      rate,
      current: Number.isInteger(initialCurrent) ? initialCurrent : null,
      watchStat: null,
      status: "LEARNING",
      message: "Waiting for a completed qualifying run",
      runNumber: 0,
      lastCompletedStat: null,
      quote: null,
      quoteInFlight: false,
      quoteAttempts: 0,
      activeContractId: null,
      expectedEntryStat: null,
      signalCount: null,
      lastProfit: null,
      lastError: "",
      runEndedWhileOpen: false,
      updatedAt: Date.now()
    };
  }

  function log(message, rate = null) {
    const item = { time: Date.now(), rate, message: String(message) };
    eventHistory.unshift(item);
    eventHistory = eventHistory.slice(0, 40);
    try { callbacks.onLog?.(item); } catch (error) { console.warn("Algo log callback:", error); }
  }

  function snapshot() {
    const activeRates = config
      ? (config.aggressive ? ALL_RATES : ALL_RATES.slice(0, 4))
      : [];
    return {
      running,
      config: config ? { ...config } : null,
      activeRates,
      trackers: activeRates.map(rate => ({ ...(trackers.get(rateKey(rate)) || createTracker(rate)) })),
      contracts: Array.from(contracts.values()).map(item => ({ ...item })),
      eventHistory: eventHistory.slice(0, 20),
      openContractCount: contracts.size,
      maxConcurrentExposure: config ? config.stake * activeRates.length : 0
    };
  }

  function emit() {
    try { callbacks.onChange?.(snapshot()); } catch (error) { console.warn("Algo UI callback:", error); }
  }

  function getTracker(rate) {
    return trackers.get(rateKey(rate)) || null;
  }

  function requestQuoteIfNeeded(tracker) {
    if (!running || tracker.status !== "WAIT_MATCH" || tracker.quote ||
        tracker.quoteInFlight || tracker.quoteAttempts >= 2 ||
        !Number.isInteger(tracker.current) || !Number.isInteger(tracker.watchStat)) return;

    // Prepare the two-tick proposal before the final pre-entry count.
    if (tracker.current < tracker.watchStat - 3 || tracker.current >= tracker.watchStat - 1) return;

    tracker.quoteAttempts += 1;
    tracker.quoteInFlight = true;
    tracker.message = "Preparing an Accumulator quote for a 2-tick hold";
    tracker.updatedAt = Date.now();
    try {
      callbacks.onQuoteRequest?.(tracker.rate, { ...config }, { runNumber: tracker.runNumber, watchStat: tracker.watchStat, quoteAttempt: tracker.quoteAttempts });
    } catch (error) {
      tracker.quoteInFlight = false;
      tracker.lastError = error?.message || String(error);
      tracker.message = "Quote request failed";
      log(tracker.lastError, tracker.rate);
    }
  }

  function quoteIsFresh(tracker) {
    return Boolean(
      tracker.quote &&
      tracker.quote.id &&
      Number.isFinite(tracker.quote.askPrice) &&
      Date.now() - tracker.quote.receivedAt <= (config?.quoteMaxAgeMs || DEFAULT_QUOTE_MAX_AGE_MS)
    );
  }

  function tryEntry(tracker) {
    if (!running || tracker.status !== "WAIT_MATCH" || tracker.current !== tracker.watchStat - 1) return;
    if (tracker.quote && !quoteIsFresh(tracker)) tracker.quote = null;

    if (!tracker.quote && !tracker.quoteInFlight && tracker.quoteAttempts < 2) {
      // A final attempt is allowed while the count is still one tick before target.
      tracker.quoteAttempts += 1;
      tracker.quoteInFlight = true;
      tracker.message = "Requesting final entry quote";
      try { callbacks.onQuoteRequest?.(tracker.rate, { ...config }, { runNumber: tracker.runNumber, watchStat: tracker.watchStat, quoteAttempt: tracker.quoteAttempts }); }
      catch (error) {
        tracker.quoteInFlight = false;
        tracker.lastError = error?.message || String(error);
      }
    }

    if (!quoteIsFresh(tracker)) {
      if (tracker.quoteInFlight) {
        tracker.status = "WAITING_QUOTE";
        tracker.message = "At the entry count; waiting for the prepared quote";
      } else {
        tracker.status = "MISSED_ENTRY";
        tracker.message = "Entry skipped: no fresh quote was ready before the target tick";
        tracker.lastError = tracker.lastError || "No fresh two-tick proposal";
        log(tracker.message, tracker.rate);
      }
      tracker.updatedAt = Date.now();
      emit();
      return;
    }

    const quote = { ...tracker.quote };
    tracker.status = "ENTRY_PENDING";
    tracker.expectedEntryStat = tracker.watchStat;
    tracker.signalCount = tracker.current;
    tracker.message = "Entry sent to Deriv; verifying actual entry";
    tracker.updatedAt = Date.now();
    tracker.quote = null;
    log("Entry requested from count " + tracker.signalCount +
      " for expected entry stat " + tracker.expectedEntryStat, tracker.rate);

    try {
      callbacks.onBuyRequest?.(tracker.rate, quote, {
        symbol: config.symbol,
        accountId: config.accountId,
        stake: config.stake,
        expectedEntryStat: tracker.expectedEntryStat,
        signalCount: tracker.signalCount,
        runNumber: tracker.runNumber,
        aggressive: config.aggressive
      });
    } catch (error) {
      tracker.status = "MISSED_ENTRY";
      tracker.lastError = error?.message || String(error);
      tracker.message = "Entry request failed; waiting for this run to finish";
      log(tracker.lastError, tracker.rate);
    }
    emit();
  }

  function start(nextConfig, initialStats = {}, nextCallbacks = {}) {
    if (contracts.size) {
      return { ok: false, error: "Wait for existing Algo contracts to settle before starting a new cycle." };
    }
    const stake = Number(nextConfig?.stake);
    if (!Number.isFinite(stake) || stake <= 0) {
      return { ok: false, error: "Enter a valid positive Algo stake." };
    }
    if (!nextConfig?.symbol || !nextConfig?.accountId || !nextConfig?.currency) {
      return { ok: false, error: "Connect a Deriv account and select a market before starting Algo." };
    }

    callbacks = nextCallbacks || {};
    config = {
      symbol: String(nextConfig.symbol),
      accountId: String(nextConfig.accountId),
      accountMode: nextConfig.accountMode || "demo",
      currency: String(nextConfig.currency),
      stake,
      aggressive: nextConfig.aggressive === true,
      quoteMaxAgeMs: Number(nextConfig.quoteMaxAgeMs) || DEFAULT_QUOTE_MAX_AGE_MS
    };

    trackers = new Map();
    const activeRates = config.aggressive ? ALL_RATES : ALL_RATES.slice(0, 4);
    activeRates.forEach(rate => {
      const saved = initialStats[rateKey(rate)];
      const current = Number.isInteger(saved?.current) ? saved.current : null;
      trackers.set(rateKey(rate), createTracker(rate, current));
    });
    running = true;
    eventHistory = [];
    log("Algo started on " + config.symbol + " · " +
      (config.aggressive ? "Aggressive · 1%–5%" : "Normal · 1%–4%") +
      " · stake " + stake + " " + config.currency);
    emit();
    return { ok: true, snapshot: snapshot() };
  }

  function stop(reason = "Stopped by user") {
    if (!running) return { ok: true, snapshot: snapshot() };
    running = false;
    trackers.forEach(tracker => {
      tracker.quote = null;
      tracker.quoteInFlight = false;
      if (tracker.activeContractId) {
        tracker.message = "New entries paused; existing contract is being monitored";
      } else {
        tracker.status = "STOPPED";
        tracker.message = "Paused · no new entries";
      }
      tracker.updatedAt = Date.now();
    });
    log(reason);
    emit();
    return { ok: true, snapshot: snapshot() };
  }

  function onStats({ symbol, rate, current }) {
    if (!running || !config || String(symbol) !== config.symbol) return;
    const tracker = getTracker(rate);
    const value = Number(current);
    if (!tracker || !Number.isInteger(value) || value < 0) return;

    const previous = tracker.current;
    if (previous === null) {
      tracker.current = value;
      tracker.updatedAt = Date.now();
      emit();
      return;
    }
    if (value === previous) return;

    const cutDetected = value < previous;
    if (cutDetected) {
      tracker.runNumber += 1;
      tracker.quote = null;
      tracker.quoteInFlight = false;
      tracker.quoteAttempts = 0;

      if (tracker.status === "OPEN" || tracker.status === "ENTRY_PENDING") {
        tracker.runEndedWhileOpen = true;
        tracker.lastCompletedStat = previous;
        tracker.current = value;
        tracker.message = "Counting run cut; preserving its final stat until contract settles";
        tracker.updatedAt = Date.now();
        emit();
        return;
      }

      tracker.lastCompletedStat = previous;
      tracker.current = value;
      tracker.expectedEntryStat = null;
      tracker.signalCount = null;
      tracker.quote = null;
      tracker.quoteInFlight = false;
      tracker.quoteAttempts = 0;

      if (validWatchStat(previous)) {
        tracker.runEndedWhileOpen = false;
        tracker.watchStat = previous;
        tracker.status = "WAIT_MATCH";
        tracker.message = "Saved " + previous + "; waiting for the next run to reach " + previous;
        tracker.lastError = "";
        log("Saved next watch stat " + previous, tracker.rate);
      } else {
        tracker.runEndedWhileOpen = false;
        tracker.watchStat = null;
        tracker.status = "LEARNING";
        tracker.message = "Completed stat " + previous + " is outside 16–44; ignoring it";
      }

      tracker.updatedAt = Date.now();
      emit();
      return;
    }

    tracker.current = value;
    tracker.updatedAt = Date.now();

    if (tracker.status === "WAIT_MATCH") {
      if (value >= tracker.watchStat) {
        tracker.status = "MISSED_ENTRY";
        tracker.quote = null;
        tracker.quoteInFlight = false;
        tracker.message = "Target count passed without a confirmed entry; no late purchase";
        tracker.lastError = "Entry timing window missed";
        log(tracker.message, tracker.rate);
      } else {
        requestQuoteIfNeeded(tracker);
        if (value === tracker.watchStat - 1) tryEntry(tracker);
      }
    } else if (tracker.status === "WAITING_QUOTE") {
      if (value >= tracker.watchStat) {
        tracker.status = "MISSED_ENTRY";
        tracker.quote = null;
        tracker.quoteInFlight = false;
        tracker.message = "Target tick passed before a quote arrived; no late purchase";
        tracker.lastError = "Quote arrived too late";
        log(tracker.message, tracker.rate);
      }
    }

    emit();
  }

  function onQuote(rate, proposal, requestContext = null) {
    const tracker = getTracker(rate);
    if (!tracker || !running || !config || !proposal) return;
    if (requestContext && (requestContext.runNumber !== tracker.runNumber || requestContext.watchStat !== tracker.watchStat)) return;
    if (!["WAIT_MATCH", "WAITING_QUOTE"].includes(tracker.status) || tracker.current >= tracker.watchStat) return;
    tracker.quoteInFlight = false;
    const askPrice = Number(proposal.ask_price);
    const proposalId = proposal.id;
    if (!proposalId || !Number.isFinite(askPrice) || askPrice <= 0) {
      tracker.lastError = "Deriv returned an invalid proposal";
      tracker.message = "Invalid proposal; waiting for the next run";
      tracker.updatedAt = Date.now();
      emit();
      return;
    }
    tracker.quote = {
      id: proposalId,
      askPrice,
      spot: Number.isFinite(Number(proposal.spot)) ? Number(proposal.spot) : null,
      spotTime: Number.isFinite(Number(proposal.spot_time)) ? Number(proposal.spot_time) : null,
      subscriptionId: proposal.subscriptionId || null,
      requestId: Number.isInteger(Number(proposal.requestId)) ? Number(proposal.requestId) : null,
      receivedAt: Date.now()
    };
    tracker.lastError = "";
    tracker.message = "Fresh Accumulator quote ready";
    tracker.updatedAt = Date.now();

    if (tracker.status === "WAITING_QUOTE" && tracker.current === tracker.watchStat - 1) {
      tracker.status = "WAIT_MATCH";
      tryEntry(tracker);
      return;
    }
    emit();
  }

  function quoteFailed(rate, message, requestContext = null) {
    const tracker = getTracker(rate);
    if (!tracker) return;
    if (requestContext && (requestContext.runNumber !== tracker.runNumber || requestContext.watchStat !== tracker.watchStat)) return;
    tracker.quoteInFlight = false;
    tracker.lastError = String(message || "Deriv quote request failed");
    tracker.message = "Quote unavailable; waiting for a safe entry window";
    tracker.updatedAt = Date.now();
    if (tracker.status === "WAITING_QUOTE") {
      tracker.status = "MISSED_ENTRY";
      tracker.message = "Entry skipped because Deriv did not return a quote in time";
    }
    log(tracker.lastError, tracker.rate);
    emit();
  }

  function buySucceeded(rate, contract) {
    const tracker = getTracker(rate);
    if (!tracker || !contract?.contractId) return;
    const contractId = String(contract.contractId);
    tracker.activeContractId = contractId;
    tracker.status = "OPEN";
    tracker.lastError = "";
    tracker.message = "Contract open · expected entry stat " + tracker.expectedEntryStat;
    tracker.updatedAt = Date.now();
    contracts.set(contractId, {
      contractId,
      rate: tracker.rate,
      symbol: config?.symbol || contract.symbol || "",
      expectedEntryStat: tracker.expectedEntryStat,
      signalCount: tracker.signalCount,
      lastCompletedStat: tracker.lastCompletedStat,
      stake: config?.stake ?? contract.stake ?? null,
      accountId: config?.accountId || contract.accountId || "",
      profit: null,
      status: "OPEN",
      entrySpotTime: null,
      lastContractSpotTime: null,
      ticksAfterEntry: 0,
      closeRequested: false,
      closeWhenSellable: false,
      openedAt: Date.now()
    });
    log("Deriv confirmed contract " + contractId, tracker.rate);
    emit();
  }

  function buyFailed(rate, message) {
    const tracker = getTracker(rate);
    if (!tracker) return;
    tracker.activeContractId = null;
    tracker.status = "MISSED_ENTRY";
    tracker.quote = null;
    tracker.quoteInFlight = false;
    tracker.lastError = String(message || "Deriv rejected the purchase");
    tracker.message = "Purchase failed; no retry in this counting run";
    tracker.updatedAt = Date.now();
    log(tracker.lastError, tracker.rate);
    emit();
  }

  function restoreContract(contract) {
    if (!contract?.contractId || !Number.isFinite(Number(contract.rate))) return;
    const contractId = String(contract.contractId);
    const rate = Number(contract.rate);
    let tracker = getTracker(rate);
    if (!tracker) {
      tracker = createTracker(rate, null);
      trackers.set(rateKey(rate), tracker);
    }
    tracker.activeContractId = contractId;
    tracker.status = "OPEN";
    tracker.expectedEntryStat = Number.isInteger(contract.expectedEntryStat) ? contract.expectedEntryStat : null;
    tracker.signalCount = Number.isInteger(contract.signalCount) ? contract.signalCount : null;
    tracker.lastCompletedStat = Number.isInteger(contract.lastCompletedStat) ? contract.lastCompletedStat : tracker.lastCompletedStat;
    tracker.message = "Restored open contract · reconciling with Deriv";
    contracts.set(contractId, {
      contractId,
      rate,
      symbol: contract.symbol || "",
      expectedEntryStat: tracker.expectedEntryStat,
      signalCount: tracker.signalCount,
      lastCompletedStat: tracker.lastCompletedStat,
      stake: Number(contract.stake) || null,
      accountId: contract.accountId || "",
      profit: Number.isFinite(Number(contract.profit)) ? Number(contract.profit) : null,
      status: "OPEN",
      entrySpotTime: Number.isFinite(Number(contract.entrySpotTime)) ? Number(contract.entrySpotTime) : null,
      lastContractSpotTime: Number.isFinite(Number(contract.lastContractSpotTime)) ? Number(contract.lastContractSpotTime) : null,
      ticksAfterEntry: Math.max(0, Number(contract.ticksAfterEntry) || 0),
      closeRequested: contract.closeRequested === true,
      closeWhenSellable: contract.closeWhenSellable === true,
      openedAt: Number(contract.openedAt) || Date.now()
    });
    emit();
  }

  function onContractUpdate(contractId, contract) {
    const key = String(contractId || contract?.contract_id || "");
    const item = contracts.get(key);
    if (!item) return false;
    const profit = contract?.profit === null || contract?.profit === undefined || contract?.profit === ""
      ? NaN : Number(contract.profit);
    if (Number.isFinite(profit)) item.profit = profit;
    const entryRaw = contract?.entry_spot_time;
    const currentRaw = contract?.current_spot_time;
    const entryTime = entryRaw === null || entryRaw === undefined || entryRaw === "" ? NaN : Number(entryRaw);
    const currentTime = currentRaw === null || currentRaw === undefined || currentRaw === "" ? NaN : Number(currentRaw);
    if (Number.isFinite(entryTime)) item.entrySpotTime = entryTime;
    if (Number.isFinite(currentTime)) {
      if (item.entrySpotTime === null && Number.isFinite(entryTime)) item.entrySpotTime = entryTime;
      if (item.entrySpotTime !== null && currentTime > item.entrySpotTime &&
          currentTime !== item.lastContractSpotTime) {
        item.ticksAfterEntry += 1;
      }
      item.lastContractSpotTime = currentTime;
    }
    const sold = contract?.is_sold === true || Number(contract?.is_sold) === 1 ||
      contract?.is_expired === true || Number(contract?.is_expired) === 1 ||
      contract?.is_open === false ||
      ["won", "lost", "sold", "expired"].includes(String(contract?.status || "").toLowerCase());
    const trackerForUpdate = getTracker(item.rate);
    if (trackerForUpdate && !sold && String(trackerForUpdate.activeContractId) === key) {
      trackerForUpdate.message = "Contract active · " + Math.min(2, item.ticksAfterEntry) + "/2 post-entry ticks";
      trackerForUpdate.updatedAt = Date.now();
    }
    const canSell = contract?.is_valid_to_sell === true || Number(contract?.is_valid_to_sell) === 1;
    if (!sold && item.ticksAfterEntry >= 2) item.closeWhenSellable = true;
    if (!sold && item.closeWhenSellable && canSell && !item.closeRequested) {
      item.closeRequested = true;
      if (trackerForUpdate) {
        trackerForUpdate.message = "Two contract ticks completed · sending close request";
        trackerForUpdate.updatedAt = Date.now();
      }
      log("Two contract ticks completed; requesting early close for contract " + key, item.rate);
      try {
        callbacks.onSellRequest?.(key, {
          rate: item.rate,
          symbol: item.symbol,
          accountId: item.accountId,
          ticksAfterEntry: item.ticksAfterEntry,
          entrySpotTime: item.entrySpotTime
        });
      } catch (error) {
        item.closeRequested = false;
        item.lastError = error?.message || String(error);
        log("Automatic close request failed: " + item.lastError, item.rate);
      }
    }
    item.status = sold ? (contract?.status || "SETTLED") : (contract?.status || "OPEN");
    if (sold) {
      contracts.delete(key);
      const tracker = getTracker(item.rate);
      if (tracker && String(tracker.activeContractId) === key) {
        tracker.activeContractId = null;
        tracker.expectedEntryStat = null;
        tracker.signalCount = null;
        tracker.lastProfit = Number.isFinite(profit) ? profit : tracker.lastProfit;
        tracker.quote = null;
        tracker.quoteInFlight = false;
        if (!running) {
          tracker.status = "STOPPED";
          tracker.message = "Contract settled · Algo remains paused";
        } else if (tracker.runEndedWhileOpen) {
          tracker.runEndedWhileOpen = false;
          const completed = tracker.lastCompletedStat;
          if (validWatchStat(completed)) {
            tracker.watchStat = completed;
            if (Number.isInteger(tracker.current) && tracker.current >= completed - 1) {
              tracker.status = "MISSED_ENTRY";
              tracker.message = "The next run already passed the entry point while the previous contract was open";
            } else {
              tracker.status = "WAIT_MATCH";
              tracker.message = "Saved " + completed + "; waiting for the next run to reach " + completed;
              requestQuoteIfNeeded(tracker);
            }
            tracker.lastError = "";
            log("Saved next watch stat " + completed, tracker.rate);
          } else {
            tracker.watchStat = null;
            tracker.status = "LEARNING";
            tracker.message = "Completed stat " + completed + " is outside 16–44; learning the next run";
          }
        } else {
          tracker.status = "WAIT_RUN_END";
          tracker.message = "Contract settled · waiting for this counting run to finish";
        }
        tracker.updatedAt = Date.now();
      }
      log("Contract " + key + " settled" +
        (Number.isFinite(profit) ? " · P/L " + profit.toFixed(2) : ""), item.rate);
    }
    emit();
    return sold;
  }

  function sellFailed(contractId, message) {
    const item = contracts.get(String(contractId));
    if (!item) return;
    item.closeRequested = false;
    item.closeWhenSellable = true;
    item.lastError = String(message || "Automatic close request failed");
    const tracker = getTracker(item.rate);
    if (tracker) {
      tracker.message = "Two ticks completed · waiting to retry close";
      tracker.updatedAt = Date.now();
    }
    log(item.lastError, item.rate);
    emit();
  }

  function setCallbacks(nextCallbacks = {}) {
    callbacks = { ...callbacks, ...(nextCallbacks || {}) };
    emit();
  }

  function getSnapshot() {
    return snapshot();
  }

  window.DerivAccumulatorAlgoEngine = {
    start,
    stop,
    onStats,
    onQuote,
    quoteFailed,
    buySucceeded,
    buyFailed,
    restoreContract,
    onContractUpdate,
    sellFailed,
    setCallbacks,
    getSnapshot,
    hasOpenContracts: () => contracts.size > 0,
    isRunning: () => running
  };
})();