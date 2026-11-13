/* Full OpenAlgo Charts 2.7.2 terminal integration.
 * Deriv remains the live quote/history source; chart capabilities are owned by OpenAlgo.
 */
(async () => {
  "use strict";
  const VERSION = "2.7.2";
  const CDN = "https://cdn.jsdelivr.net/npm/openalgo-charts@" + VERSION + "/dist/";
  const root = document.getElementById("nativeChartHost");
  if (!root) return;

  const TICK_COUNTS = [1, 10, 25, 50, 100, 250, 500, 750, 1000, 2000, 5000, 10000, 25000, 50000, 100000];
  const TIME_INTERVALS = [
    "1s","2s","3s","5s","10s","15s","30s",
    "1m","2m","3m","4m","5m","10m","15m","20m","30m","45m",
    "1h","2h","3h","4h","6h","8h","12h",
    "1D","2D","3D","1W","2W","1M","2M","3M","6M","1Q","2Q","1Y"
  ];
  const TICK_INTERVALS = TICK_COUNTS.map(count => "T" + count);
  const ALL_INTERVALS = [...TICK_INTERVALS, ...TIME_INTERVALS];
  const DEFAULT_FAVORITES = ["T1","T100","T500","T1000","T5000","1s","5s","15s","1m","5m","15m","1h","4h","1D","1W","1M"];

  try {
    const base = await import(CDN + "openalgo-charts.mjs");
    const indicators = await import(CDN + "openalgo-charts.indicators.mjs");
    const drawings = await import(CDN + "openalgo-charts.draw.mjs");
    const transforms = await import(CDN + "openalgo-charts.transform.mjs");
    const profiles = await import(CDN + "openalgo-charts.profile.mjs");
    const trading = await import(CDN + "openalgo-charts.trade.mjs");
    const webgl = await import(CDN + "openalgo-charts.webgl.mjs");
    const widgetModule = await import(CDN + "openalgo-charts.widget.mjs");
    const workspaceModule = await import(CDN + "openalgo-charts.workspace.mjs");

    if (typeof widgetModule.createWidget !== "function") throw new Error("OpenAlgo Charts widget tier is unavailable.");
    if (typeof base.TickBarAggregator !== "function") throw new Error("OpenAlgo tick-bar engine is unavailable.");
    if (typeof indicators.registerBuiltinIndicators === "function") indicators.registerBuiltinIndicators();
    if (typeof drawings.registerBuiltinDrawingTools === "function") drawings.registerBuiltinDrawingTools();

    // Register real tick-count bars. These count incoming Deriv quote ticks, not trade volume.
    for (const count of TICK_COUNTS) {
      const code = "T" + count;
      if (!base.isKnownInterval(code)) base.registerInterval({ code, bucketing: { mode: "ticks", count } });
    }
    // Register calendar intervals that are not part of the base s/m/h/d/w grammar.
    for (const [code, unit, count] of [
      ["1M","month",1],["2M","month",2],["3M","month",3],["6M","month",6],
      ["1Q","quarter",1],["2Q","quarter",2],["1Y","year",1]
    ]) {
      if (!base.isKnownInterval(code)) base.registerInterval({ code, bucketing: { mode: "calendar", unit, count } });
    }

    const timeframePreferences = widgetModule.createTimeframePreferences({
      storage: (() => { try { return window.localStorage; } catch { return null; } })(),
      key: "deriv-accumulator-openalgo-timeframes-v1",
      defaults: DEFAULT_FAVORITES
    });

    let workspaces = null;
    try {
      if (workspaceModule.WorkspaceRepository && workspaceModule.createIndexedDbWorkspaceStorage && window.indexedDB) {
        workspaces = new workspaceModule.WorkspaceRepository(
          workspaceModule.createIndexedDbWorkspaceStorage(window.indexedDB),
          "deriv-accumulator-openalgo-workspaces"
        );
      }
    } catch (error) {
      console.warn("OpenAlgo workspace storage unavailable; chart-local persistence remains active.", error);
    }

    const widget = widgetModule.createWidget(root, {
      symbol: "R_10",
      exchange: "DERIV",
      interval: "T1",
      intervals: ALL_INTERVALS,
      timeframePreferences,
      ...(workspaces ? { workspaces } : {}),
      chartType: "area",
      theme: {
        ...base.darkTheme,
        background: "#000000",
        text: "#aab7c8",
        gridColor: "#1d2a3b",
        upColor: "#20bd88",
        downColor: "#ee5969"
      },
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Africa/Lagos",
      mobile: "auto",
      rail: true,
      topbar: false,
      indicators: true,
      statusline: true,
      bottombar: true,
      persist: "deriv-accumulator-openalgo-full-terminal-v2",
      drawingScope: "instrument",
      drawingToolbar: true,
      navigation: { mousePan: "both", defaultVisibleBars: 120 },
      renderer: "auto"
    });

    const chart = widget.chart;
    const lines = Object.create(null);
    let lastKey = "";
    let lastSignature = "";
    let lastCount = 0;
    let lastRawCount = 0;
    let ready = false;
    let pending = null;
    let activeSymbol = "R_10";
    let tickState = null;

    function removeLine(name) {
      if (!lines[name]) return;
      chart.removePrimitive(lines[name]);
      delete lines[name];
    }
    function syncLine(name, price, options) {
      if (!Number.isFinite(price)) { removeLine(name); return; }
      if (!lines[name]) {
        lines[name] = new base.PriceLine({ id: "accumulator-" + name, price, ...options });
        chart.addPrimitive(lines[name]);
      } else {
        lines[name].setPrice(price);
        const patch = { ...options }; delete patch.id;
        lines[name].setOptions(patch);
      }
    }

    function makeTickBars(ticks, interval, key) {
      const count = Number(String(interval).slice(1));
      if (!Number.isSafeInteger(count) || count < 1) return [];
      const reset = !tickState || tickState.key !== key || ticks.length < tickState.processed ||
        ticks.length > tickState.processed + 1;
      if (reset) {
        tickState = {
          key, processed: 0, bars: [],
          aggregator: new base.TickBarAggregator({ mode: "ticks", count }),
          lastBarTime: -Infinity, activeBarTime: null
        };
      }
      const state = tickState;
      for (let i = state.processed; i < ticks.length; i++) {
        const tick = ticks[i], time = Number(tick.time), price = Number(tick.price);
        if (!Number.isFinite(time) || !Number.isFinite(price)) continue;
        const update = state.aggregator.onTick({ time, price, qty: 1 });
        const bar = { ...update.bar };
        if (update.isNew || state.activeBarTime == null) {
          let barTime = Number(bar.time);
          if (!Number.isFinite(barTime)) barTime = time;
          // OpenAlgo requires unique, integer UTC-second bar keys. Tick bars have no fixed
          // duration, so monotonically nudge same-second boundaries to preserve every bar.
          if (barTime <= state.lastBarTime) barTime = state.lastBarTime + 1;
          state.activeBarTime = Math.floor(barTime);
          state.lastBarTime = state.activeBarTime;
        }
        bar.time = state.activeBarTime;
        const last = state.bars[state.bars.length - 1];
        if (last && last.time === bar.time) state.bars[state.bars.length - 1] = bar;
        else state.bars.push(bar);
      }
      state.processed = ticks.length;
      return state.bars;
    }

    function makeTimeBars(ticks, interval) {
      const resolved = base.resolveInterval(interval);
      const bucketing = resolved.bucketing;
      const bars = [];
      for (const tick of ticks || []) {
        const time = Number(tick.time), price = Number(tick.price);
        if (!Number.isFinite(time) || !Number.isFinite(price)) continue;
        const bucket = base.bucketStartOf(bucketing, time, widget.chart.timezone());
        const last = bars[bars.length - 1];
        if (!last || last.time !== bucket) {
          bars.push({ time: Math.floor(bucket), open: price, high: price, low: price, close: price });
        } else {
          last.high = Math.max(last.high, price);
          last.low = Math.min(last.low, price);
          last.close = price;
        }
      }
      return bars;
    }

    function applyData(ticks, meta = {}) {
      if (activeSymbol && widget.symbol() !== activeSymbol) {
        try { widget.setSymbol(activeSymbol, "DERIV"); } catch (error) { console.warn("OpenAlgo active market sync:", error); }
      }
      const interval = widget.interval();
      const key = String(meta.symbol || activeSymbol) + "|" + interval;
      const isTickInterval = /^T\d+$/i.test(interval);
      const candles = isTickInterval ? makeTickBars(ticks, interval, key) : makeTimeBars(ticks, interval);
      const tail = candles[candles.length - 1];
      const signature = key + "|" + candles.length + "|" +
        (tail ? [tail.time, tail.open, tail.high, tail.low, tail.close].join(":") : "");
      if (signature !== lastSignature) {
        const sameStream = key === lastKey && ticks.length === lastRawCount + 1 && lastCount > 0;
        if (!sameStream || !tail) {
          widget.series.setData(candles);
        } else {
          widget.series.update(tail);
        }
        lastSignature = signature;
        lastCount = candles.length;
        lastRawCount = ticks.length;
      }
      if (key !== lastKey) {
        if (candles.length) chart.timeScale.fitContent(Math.min(candles.length, 240));
        lastKey = key;
      }
      return { candleCount: lastCount, interval };
    }

    function applyPending() {
      if (!pending || !ready) return;
      const next = pending; pending = null;
      applyData(next.ticks, next.meta);
    }

    const api = {
      ready: true,
      widget,
      tiers: { base, indicators, drawings, transforms, profiles, trading, webgl, workspace: workspaceModule },
      setData(ticks, _intervalMinutes, meta = {}) {
        if (meta.symbol && meta.symbol !== activeSymbol) {
          activeSymbol = meta.symbol;
          if (ready) {
            try { widget.setSymbol(activeSymbol, "DERIV"); } catch (error) { console.warn("OpenAlgo symbol sync:", error); }
          }
          lastKey = ""; lastSignature = ""; lastCount = 0; lastRawCount = 0; tickState = null;
        }
        if (!ready) { pending = { ticks, meta }; return { candleCount: lastCount }; }
        return applyData(ticks, meta);
      },
      setOverlay(overlay, meta = {}) {
        if (!overlay) { removeLine("entry"); removeLine("barrier"); removeLine("live"); return; }
        const precision = Math.max(0, Math.min(8, Number(meta.precision ?? 2)));
        const value = input => input == null || input === "" ? NaN : Number(input);
        const entry = value(overlay.entrySpot), barrier = value(overlay.barrier), live = value(overlay.currentSpot);
        syncLine("entry", entry, { color: "#48a9ff", lineWidth: 2, lineStyle: "dashed", badge: "ENTRY", leftLabel: Number.isFinite(entry) ? entry.toFixed(precision) : "" });
        syncLine("barrier", barrier, { color: "#f0a44b", lineWidth: 2, lineStyle: "solid", badge: "BARRIER", leftLabel: Number.isFinite(barrier) ? barrier.toFixed(precision) : "" });
        syncLine("live", live, { color: "#f2f5fa", lineWidth: 1, lineStyle: "dotted", badge: "LIVE", leftLabel: Number.isFinite(live) ? live.toFixed(precision) : "" });
      },
      state() { return { candleCount: lastCount, interval: widget.interval(), symbol: widget.symbol(), chartTypes: base.registeredChartTypes(), indicators: base.registeredIndicators(), intervals: ALL_INTERVALS }; },
      reset() { chart.timeScale.fitContent(Math.max(1, lastCount)); },
      resize() { chart.applySize?.(); },
      destroy() {
        widget.layouts?.flush?.();
        widget.destroy();
        timeframePreferences.destroy();
        lastCount = 0; lastRawCount = 0; tickState = null; lastSignature = "";
      }
    };

    window.__openAlgoAccumulatorChart = api;
    window.dispatchEvent(new CustomEvent("openalgo-accumulator-chart-ready"));
    Promise.resolve(widget.ready).then(() => {
      ready = true;
      if (activeSymbol && widget.symbol() !== activeSymbol) {
        try { widget.setSymbol(activeSymbol, "DERIV"); } catch (error) { console.warn("OpenAlgo restored symbol sync:", error); }
      }
      applyPending();
      window.dispatchEvent(new CustomEvent("openalgo-accumulator-chart-restored"));
    }).catch(error => {
      console.warn("OpenAlgo saved chart state could not be restored:", error);
      ready = true; applyPending();
    });
  } catch (error) {
    console.error("OpenAlgo chart initialization failed:", error);
    window.__openAlgoChartError = error;
    const status = document.getElementById("nativeChartConnection");
    if (status) status.textContent = "CHART LIBRARY UNAVAILABLE";
    const empty = document.getElementById("nativeChartEmpty");
    if (empty) {
      empty.textContent = "OpenAlgo Charts could not load. Check the network connection and refresh.";
      empty.style.display = "grid";
    }
  }
})();
